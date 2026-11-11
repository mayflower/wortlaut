"""One loaded Parakeet model and one non-cancellable inference at a time."""

import hashlib
import math
import os
import secrets
import tempfile
import threading
import wave
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

DEFAULT_MODEL_REPO = "nvidia/parakeet-tdt-0.6b-v3"
DEFAULT_MODEL_FILENAME = "parakeet-tdt-0.6b-v3.nemo"
DEFAULT_MODEL_REVISION = "541d1f99c6b0c3cd0b11a95167540bb8edefd82b"
KNOWN_MODEL_CHECKPOINTS = {
    DEFAULT_MODEL_REPO: (DEFAULT_MODEL_FILENAME, DEFAULT_MODEL_REVISION),
    "primeline/parakeet-primeline": (
        "2_95_WER.nemo",
        "3f1a9bcb611dfeda53fe74fe5f1a3d5701e8023e",
    ),
}
MODEL_REVISION = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", DEFAULT_MODEL_REVISION)
MAX_BYTES = 16000 * 2 * 32
lock = threading.Lock()
model = None
accelerator_failed = threading.Event()


def _clamp_confidence(value) -> float | None:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(score):
        return None
    return max(0.0, min(1.0, score))


def _configure_decoding_confidence(loaded) -> None:
    if not (hasattr(loaded, "cfg") and hasattr(loaded, "change_decoding_strategy")):
        return
    decoding_cfg = getattr(loaded.cfg, "decoding", None)
    if decoding_cfg is None:
        return
    from omegaconf import open_dict

    with open_dict(decoding_cfg):
        decoding_cfg.preserve_alignments = True
        decoding_cfg.compute_timestamps = True
        if "confidence_cfg" not in decoding_cfg or decoding_cfg.confidence_cfg is None:
            decoding_cfg.confidence_cfg = {}
        decoding_cfg.confidence_cfg.preserve_frame_confidence = True
        decoding_cfg.confidence_cfg.preserve_token_confidence = True
        decoding_cfg.confidence_cfg.preserve_word_confidence = False
        decoding_cfg.confidence_cfg.exclude_blank = True
        decoding_cfg.confidence_cfg.aggregation = "mean"
        decoding_cfg.confidence_cfg.tdt_include_duration = False
        # Unscaled maximum token probability. Tsallis-exp (alpha 0.33) over the
        # 8193-token multilingual vocabulary pushed clear German speech to a
        # median below 0.25; max_prob keeps it near 0.9 and noise near 0.3-0.5.
        decoding_cfg.confidence_cfg.method_cfg = {"name": "max_prob", "alpha": 1.0}
    loaded.change_decoding_strategy(decoding_cfg, verbose=False)


def _extract_word_confidences(hypothesis, words: list[dict]) -> list[float | None]:
    if not words:
        return []
    direct_wc = getattr(hypothesis, "word_confidence", None)
    if isinstance(direct_wc, (list, tuple)) and len(direct_wc) == len(words):
        return [_clamp_confidence(c) for c in direct_wc]

    token_confs = getattr(hypothesis, "token_confidence", None)
    timestamp_map = getattr(hypothesis, "timestamp", None)
    char_offsets = timestamp_map.get("char", []) if isinstance(timestamp_map, dict) else []
    if not isinstance(token_confs, (list, tuple)) or not token_confs:
        return [None] * len(words)

    parsed_tc = [_clamp_confidence(c) for c in token_confs]
    valid_tc = [c for c in parsed_tc if c is not None]
    if not valid_tc:
        return [None] * len(words)

    if not isinstance(char_offsets, list) or len(char_offsets) != len(parsed_tc):
        fallback = sum(valid_tc) / len(valid_tc)
        return [fallback] * len(words)

    results: list[float | None] = []
    tok_idx = 0
    total_tokens = len(char_offsets)
    for w_idx, w in enumerate(words):
        use_offset = "start_offset" in w and "end_offset" in w
        w_start = float(w["start_offset"] if use_offset else w["start"])
        w_end = float(w["end_offset"] if use_offset else w["end"])
        next_start = None
        if w_idx + 1 < len(words):
            nw = words[w_idx + 1]
            next_key = "start_offset" if (use_offset and "start_offset" in nw) else "start"
            next_start = float(nw[next_key])
        target_chars = max(1, len(str(w.get("word") or "").replace(" ", "")))

        while tok_idx < total_tokens:
            c = char_offsets[tok_idx]
            c_end = float(c.get("end_offset" if use_offset else "end", 0.0))
            c_text = str(c.get("char") or "")
            if c_end < w_start - 1e-6 or not c_text.strip():
                if c_end <= w_start + 1e-6 and (c_end < w_start - 1e-6 or not c_text.strip()):
                    tok_idx += 1
                    continue
            break

        matched_non_space: list[float] = []
        matched_any: list[float] = []
        built_chars = 0
        while tok_idx < total_tokens:
            c = char_offsets[tok_idx]
            c_start = float(c.get("start_offset" if use_offset else "start", 0.0))
            c_end = float(c.get("end_offset" if use_offset else "end", c_start))
            if c_start > w_end + 1e-6 or c_end > w_end + 1e-6:
                break
            if (
                next_start is not None
                and c_start >= next_start - 1e-6
                and built_chars >= target_chars
                and (matched_non_space or matched_any)
            ):
                break
            c_text = str(c.get("char") or "")
            tc_val = parsed_tc[tok_idx]
            if tc_val is not None:
                matched_any.append(tc_val)
                if c_text.strip():
                    matched_non_space.append(tc_val)
            built_chars += len(c_text.replace(" ", ""))
            tok_idx += 1

        chosen = matched_non_space or matched_any
        if chosen:
            results.append(sum(chosen) / len(chosen))
        else:
            results.append(sum(valid_tc) / len(valid_tc))
    return results


def load_model():
    global MODEL_REVISION
    import nemo.collections.asr as nemo_asr
    import torch
    from huggingface_hub import hf_hub_download

    allow_cpu = os.environ.get("WORTLAUT_ASR_ALLOW_CPU", "").lower() in ("1", "true", "yes")
    if torch.cuda.is_available():
        device = "cuda"
    elif allow_cpu:
        device = "cpu"
    else:
        raise RuntimeError("Parakeet service requires an NVIDIA GPU")
    repo = (
        os.environ.get("WORTLAUT_ASR_MODEL_REPO", DEFAULT_MODEL_REPO).strip()
        or DEFAULT_MODEL_REPO
    )
    explicit_name = os.environ.get("WORTLAUT_ASR_MODEL_FILENAME", "").strip()
    explicit_rev = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip()
    known = KNOWN_MODEL_CHECKPOINTS.get(repo)
    if known or explicit_name:
        name = explicit_name or known[0]
        revision = explicit_rev or (known[1] if known else None)
        filename = hf_hub_download(repo, name, revision=revision)
        loaded = nemo_asr.models.ASRModel.restore_from(filename, map_location=device)
        MODEL_REVISION = revision or f"{repo}:{name}"
    else:
        loaded = nemo_asr.models.ASRModel.from_pretrained(model_name=repo, map_location=device)
        MODEL_REVISION = explicit_rev or repo
    loaded.freeze()
    loaded.eval()
    _configure_decoding_confidence(loaded)
    return loaded


@asynccontextmanager
async def lifespan(app):
    global model
    if not os.environ.get("WORTLAUT_ASR_TOKEN"):
        raise RuntimeError("ASR credential missing")
    model = await run_in_threadpool(load_model)
    yield


app = FastAPI(title="wortlaut Parakeet", lifespan=lifespan)


@app.get("/health/ready")
def ready():
    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable; process restart required")
    if model is None:
        raise HTTPException(503, "Model loading")
    return {"status": "ready", "model_revision": MODEL_REVISION}


@app.get("/health/live")
def live():
    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable; process restart required")
    return {"status": "alive"}


def infer(pcm, identifier):
    import torch

    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable")
    if not lock.acquire(blocking=False):
        raise HTTPException(429, "Inference busy", headers={"Retry-After": "5"})
    try:
        if accelerator_failed.is_set():
            raise HTTPException(503, "GPU unavailable")
        # The lock belongs to the synchronous inference thread. Disconnecting
        # the HTTP client never releases it while CUDA is still working.
        with tempfile.TemporaryDirectory(prefix="wortlaut-asr-") as directory:
            filename = directory + "/input.wav"
            with wave.open(filename, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(pcm)
            with torch.inference_mode():
                hypothesis = model.transcribe(
                    [filename], batch_size=1, timestamps=True, return_hypotheses=True, verbose=False
                )[0]
            words = hypothesis.timestamp.get("word", [])
            confidences = _extract_word_confidences(hypothesis, words)
            serialized_words = []
            for w, conf in zip(words, confidences, strict=False):
                item = {"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
                if conf is not None:
                    item["confidence"] = round(conf, 4)
                serialized_words.append(item)
            return {
                "job_id": identifier,
                "pcm_sha256": hashlib.sha256(pcm).hexdigest(),
                "text": hypothesis.text,
                "words": serialized_words,
            }
    except torch.AcceleratorError:
        # An unusable CUDA/MPS client must stop receiving more jobs. The
        # liveness probe replaces only this process, not shared GPU services.
        accelerator_failed.set()
        raise HTTPException(503, "GPU unavailable") from None
    except torch.OutOfMemoryError:
        # The GPU is shared; a transient allocation failure leaves this CUDA
        # client usable. Release cached blocks and let the job retry later.
        torch.cuda.empty_cache()
        raise HTTPException(503, "GPU memory exhausted", headers={"Retry-After": "30"}) from None
    finally:
        lock.release()


@app.post("/v1/transcribe")
async def transcribe(
    request: Request,
    authorization: str | None = Header(default=None),
    x_job_id: str = Header(min_length=64, max_length=64),
):
    token = os.environ.get("WORTLAUT_ASR_TOKEN", "")
    if not token or not secrets.compare_digest(authorization or "", "Bearer " + token):
        raise HTTPException(401, "Invalid ASR credential")
    if any(c not in "0123456789abcdef" for c in x_job_id):
        raise HTTPException(400, "Invalid job identifier")
    pcm = bytearray()
    async for part in request.stream():
        pcm.extend(part)
        if len(pcm) > MAX_BYTES:
            raise HTTPException(413, "Audio exceeds segment limit")
    if not pcm or len(pcm) % 2:
        raise HTTPException(400, "Expected mono PCM16/16kHz")
    return await run_in_threadpool(infer, bytes(pcm), x_job_id)
