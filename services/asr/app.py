"""One loaded Qwen3-ASR model and one non-cancellable inference at a time."""

import hashlib
import math
import os
import secrets
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

DEFAULT_MODEL_REPO = "Qwen/Qwen3-ASR-1.7B-hf"
DEFAULT_MODEL_REVISION = "bcd2b5b7f32b480ab5790554cfa8347f246a14f3"
MODEL_REPO = os.environ.get("WORTLAUT_ASR_MODEL_REPO", "").strip() or DEFAULT_MODEL_REPO
MODEL_REVISION = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip() or DEFAULT_MODEL_REVISION
RATE = 16000
MAX_BYTES = RATE * 2 * 32
# Generation budget: the language prefix plus a generous speech rate. A
# transcript that reaches the budget without an end token is reported as
# truncated, which is how a decoder loop shows up.
PREFIX_TOKENS = 24
TOKENS_PER_SECOND = 10
ASR_TEXT_MARKER = "<asr_text>"
END_MARKER = "<|im_end|>"
SPACE_MARKER = "Ġ"  # Byte-level BPE marker for a leading space.
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


def assemble_words(tokens: list[str], probs: list[float], to_text) -> list[dict]:
    """Group generated transcript tokens into words with mean token probability.

    `tokens` are raw byte-level BPE tokens after the `<asr_text>` marker. A token
    starting with the space marker opens a new word; punctuation and subword
    pieces join the current word. `to_text` turns a token group into text.
    """
    groups: list[tuple[list[str], list[float]]] = []
    for token, prob in zip(tokens, probs, strict=True):
        if token == END_MARKER:
            break
        if not groups or token.startswith(SPACE_MARKER):
            groups.append(([], []))
        groups[-1][0].append(token)
        groups[-1][1].append(prob)
    words = []
    for group_tokens, group_probs in groups:
        text = to_text(group_tokens).strip()
        if not text:
            continue
        valid = [p for p in (_clamp_confidence(p) for p in group_probs) if p is not None]
        item = {"word": text}
        if valid:
            item["confidence"] = round(sum(valid) / len(valid), 4)
        words.append(item)
    return words


class QwenASR:
    def __init__(self, processor, network):
        self.processor = processor
        self.network = network
        self.tokenizer = processor.tokenizer

    def transcribe(self, audio) -> dict:
        import torch

        duration = len(audio) / RATE
        budget = PREFIX_TOKENS + math.ceil(duration * TOKENS_PER_SECOND)
        # The Qwen3-ASR processor defaults to 16 kHz audio, the rate we send.
        inputs = self.processor.apply_transcription_request(audio=audio)
        inputs = inputs.to(self.network.device, self.network.dtype)
        with torch.inference_mode():
            out = self.network.generate(
                **inputs,
                max_new_tokens=budget,
                do_sample=False,
                output_scores=True,
                return_dict_in_generate=True,
            )
            probs = (
                self.network.compute_transition_scores(
                    out.sequences, out.scores, normalize_logits=True
                )[0]
                .exp()
                .tolist()
            )
        generated = out.sequences[0, inputs["input_ids"].shape[1] :].tolist()
        tokens = self.tokenizer.convert_ids_to_tokens(generated)
        parsed = self.processor.decode([generated], return_format="parsed")[0]
        language = parsed.get("language")
        text = " ".join(str(parsed.get("transcription") or "").split())
        truncated = END_MARKER not in tokens
        words = []
        if ASR_TEXT_MARKER in tokens:
            start = tokens.index(ASR_TEXT_MARKER) + 1
            words = assemble_words(
                tokens[start:], probs[start:], self.tokenizer.convert_tokens_to_string
            )
        if " ".join(w["word"] for w in words) != text:
            # Token grouping must reproduce the parsed transcript exactly;
            # otherwise keep the words and leave confidence unknown.
            words = [{"word": word} for word in text.split()]
        return {
            "text": text,
            "language": language if isinstance(language, str) and language != "None" else None,
            "words": words,
            "truncated": truncated,
        }


def load_model():
    import torch
    from transformers import AutoModelForMultimodalLM, AutoProcessor

    allow_cpu = os.environ.get("WORTLAUT_ASR_ALLOW_CPU", "").lower() in ("1", "true", "yes")
    if torch.cuda.is_available():
        device, dtype = "cuda", torch.bfloat16
    elif allow_cpu:
        device, dtype = "cpu", torch.float32
    else:
        raise RuntimeError("Qwen3-ASR service requires an NVIDIA GPU")
    processor = AutoProcessor.from_pretrained(MODEL_REPO, revision=MODEL_REVISION)
    network = AutoModelForMultimodalLM.from_pretrained(
        MODEL_REPO, revision=MODEL_REVISION, dtype=dtype
    )
    network.to(device)
    network.eval()
    return QwenASR(processor, network)


@asynccontextmanager
async def lifespan(app):
    global model
    if not os.environ.get("WORTLAUT_ASR_TOKEN"):
        raise RuntimeError("ASR credential missing")
    model = await run_in_threadpool(load_model)
    yield


app = FastAPI(title="wortlaut Qwen3-ASR", lifespan=lifespan)


@app.get("/health/ready")
def ready():
    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable; process restart required")
    if model is None:
        raise HTTPException(503, "Model loading")
    return {"status": "ready", "model": MODEL_REPO, "model_revision": MODEL_REVISION}


@app.get("/health/live")
def live():
    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable; process restart required")
    return {"status": "alive"}


def infer(pcm, identifier):
    import numpy as np
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
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        result = model.transcribe(audio)
        return {"job_id": identifier, "pcm_sha256": hashlib.sha256(pcm).hexdigest(), **result}
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
