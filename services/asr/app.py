"""One loaded Qwen3-ASR model and one non-cancellable inference at a time."""

import base64
import binascii
import hashlib
import math
import os
import re
import secrets
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

DEFAULT_MODEL_REPO = "Qwen/Qwen3-ASR-1.7B-hf"
DEFAULT_MODEL_REVISION = "bcd2b5b7f32b480ab5790554cfa8347f246a14f3"
DEFAULT_ASR_LANGUAGES = "German,English"
MODEL_REPO = os.environ.get("WORTLAUT_ASR_MODEL_REPO", "").strip() or DEFAULT_MODEL_REPO
MODEL_REVISION = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip() or DEFAULT_MODEL_REVISION
RATE = 16000
PAD_SAMPLES = int(0.3 * RATE)
MIN_SPEECH_LANG_PROB = 0.02
SHORT_CLIP_MAX_SECONDS = 2.5
SHORT_CLIP_PRIMARY_PRIOR_NATS = 1.5
MAX_BYTES = RATE * 2 * 32
# Generation budget: the language prefix plus a generous speech rate. A
# transcript that reaches the budget without an end token is reported as
# truncated, which is how a decoder loop shows up.
PREFIX_TOKENS = 24
TOKENS_PER_SECOND = 10
ASR_TEXT_MARKER = "<asr_text>"
END_MARKER = "<|im_end|>"
SPACE_MARKER = "Ġ"  # Byte-level BPE marker for a leading space.
LATIN_SCRIPT_LANGUAGES = frozenset(
    {
        "German",
        "English",
        "French",
        "Spanish",
        "Italian",
        "Dutch",
        "Portuguese",
        "Danish",
        "Swedish",
        "Norwegian",
        "Polish",
        "Czech",
        "Turkish",
    }
)
_ASCII_BPE_TOKEN_RE = re.compile(r"^[\x21-\x7e\u0120\u010a]+$")
_DISALLOWED_SCRIPT_RE = re.compile(
    r"[\u0400-\u052f\u0600-\u06ff\u0900-\u0dff\u0e00-\u0eff"
    r"\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u3400-\u4dbf"
    r"\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uffef]"
)
lock = threading.Lock()
model = None
accelerator_failed = threading.Event()


def parse_allowed_languages(raw: str | None) -> tuple[str, ...] | None:
    value = DEFAULT_ASR_LANGUAGES if raw is None else raw.strip()
    if not value or value.lower() in ("*", "all", "auto"):
        return None
    langs = tuple(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))
    return langs or None


def apply_language_step_gate(
    scores,
    allowed_lang_ids: dict[str, int],
    none_token_id: int | None,
    germanic_kin_ids: tuple[int, ...] = (),
    *,
    duration: float | None = None,
    primary_language: str | None = None,
):
    """Gate and constrain Qwen3-ASR's step-1 language token distribution.

    At step 1 (after `language`), Qwen3-ASR predicts the spoken language or
    `None`. Breaths, coughs, and mic clicks place >85% probability on CJK
    tokens and emit filler hallucinations (`嗯。`, `はい。`). When the acoustic
    probability mass on allowed languages (plus continental West-Germanic
    neighbors for short German interjections) is below `MIN_SPEECH_LANG_PROB`,
    selecting `None` suppresses the non-speech hallucination cleanly.
    """
    import torch

    probs = torch.softmax(scores.float(), dim=-1)
    p_allowed = sum(float(probs[0, tid]) for tid in allowed_lang_ids.values())
    p_kin = sum(float(probs[0, tid]) for tid in germanic_kin_ids)
    if p_allowed + p_kin < MIN_SPEECH_LANG_PROB and none_token_id is not None:
        masked = torch.full_like(scores, float("-inf"))
        masked[:, none_token_id] = scores[:, none_token_id]
        return masked

    adjusted = scores.clone()
    german_id = allowed_lang_ids.get("German")
    if german_id is not None and p_kin > 0.0:
        p_de = max(float(probs[0, german_id]), 1e-12)
        adjusted[0, german_id] = scores[0, german_id] + math.log(1.0 + p_kin / p_de)

    if (
        duration is not None
        and duration < SHORT_CLIP_MAX_SECONDS
        and primary_language
        and primary_language in allowed_lang_ids
        and len(allowed_lang_ids) > 1
    ):
        # Tilt relative odds among allowed languages toward primary_language
        # while preserving total allowed-language probability mass vs `None`.
        max_a = max(float(adjusted[0, tid]) for tid in allowed_lang_ids.values())
        w_before = sum(
            math.exp(float(adjusted[0, tid]) - max_a) for tid in allowed_lang_ids.values()
        )
        prim_id = allowed_lang_ids[primary_language]
        adjusted[0, prim_id] = adjusted[0, prim_id] + SHORT_CLIP_PRIMARY_PRIOR_NATS
        max_b = max(float(adjusted[0, tid]) for tid in allowed_lang_ids.values())
        w_after = sum(
            math.exp(float(adjusted[0, tid]) - max_b) for tid in allowed_lang_ids.values()
        )
        if w_before > 0.0 and w_after > 0.0:
            norm_shift = (max_a + math.log(w_before)) - (max_b + math.log(w_after))
            for tid in allowed_lang_ids.values():
                adjusted[0, tid] = adjusted[0, tid] + norm_shift

    masked = torch.full_like(adjusted, float("-inf"))
    keep = list(allowed_lang_ids.values())
    if none_token_id is not None:
        keep.append(none_token_id)
    masked[:, keep] = adjusted[:, keep]
    return masked


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
    def __init__(self, processor, network, allowed_languages=...):
        self.processor = processor
        self.network = network
        self.tokenizer = processor.tokenizer
        raw_langs = (
            os.environ.get("WORTLAUT_ASR_LANGUAGES")
            if allowed_languages is ...
            else allowed_languages
        )
        self.allowed_languages = parse_allowed_languages(raw_langs)
        self.language_token_id = self._language_marker_token_id()
        self.none_token_id = self._first_lang_token_id("None")
        self.allowed_lang_ids = (
            {
                lang: tid
                for lang in self.allowed_languages
                if (tid := self._first_lang_token_id(lang)) is not None
            }
            if self.allowed_languages
            else {}
        )
        self.germanic_kin_ids = (
            tuple(
                tid
                for kin in ("Dutch", "Danish")
                if kin not in self.allowed_lang_ids
                and (tid := self._first_lang_token_id(kin)) is not None
            )
            if "German" in self.allowed_lang_ids
            else ()
        )
        self.end_token_id = self._end_marker_token_id()
        self.forbidden_script_token_ids = self._build_forbidden_script_token_ids()
        self._forbidden_tensor_cache: dict[str, object] = {}

    def _end_marker_token_id(self) -> int | None:
        if hasattr(self.tokenizer, "convert_tokens_to_ids"):
            tid = self.tokenizer.convert_tokens_to_ids(END_MARKER)
            return tid if isinstance(tid, int) and tid >= 0 else None
        return None

    def _build_forbidden_script_token_ids(self) -> list[int]:
        if (
            not self.allowed_languages
            or not all(lang in LATIN_SCRIPT_LANGUAGES for lang in self.allowed_languages)
            or not hasattr(self.tokenizer, "get_vocab")
            or not hasattr(self.tokenizer, "convert_tokens_to_string")
        ):
            return []
        forbidden: list[int] = []
        for tok, tid in self.tokenizer.get_vocab().items():
            if not isinstance(tok, str) or not isinstance(tid, int) or tid < 0:
                continue
            if _ASCII_BPE_TOKEN_RE.match(tok) or (tok.startswith("<|") and tok.endswith("|>")):
                continue
            if tok == ASR_TEXT_MARKER:
                continue
            piece = self.tokenizer.convert_tokens_to_string([tok])
            if piece and (
                _DISALLOWED_SCRIPT_RE.search(piece)
                or (
                    "\ufffd" in piece
                    and len(tok) <= 2
                    and 0xE3 <= ord(tok[0]) <= 0xED
                )
            ):
                forbidden.append(tid)
        return sorted(set(forbidden))

    def _first_lang_token_id(self, lang: str) -> int | None:
        if hasattr(self.tokenizer, "encode"):
            ids = self.tokenizer.encode(" " + lang, add_special_tokens=False)
            return ids[0] if ids else None
        if hasattr(self.tokenizer, "convert_tokens_to_ids"):
            tid = self.tokenizer.convert_tokens_to_ids(SPACE_MARKER + lang)
            return tid if isinstance(tid, int) and tid >= 0 else None
        return None

    def _language_marker_token_id(self) -> int | None:
        if hasattr(self.tokenizer, "encode"):
            ids = self.tokenizer.encode("language", add_special_tokens=False)
            return ids[0] if ids else None
        if hasattr(self.tokenizer, "convert_tokens_to_ids"):
            tid = self.tokenizer.convert_tokens_to_ids("language")
            return tid if isinstance(tid, int) and tid >= 0 else None
        return None

    def transcribe(
        self,
        audio,
        *,
        context_prompt: str | None = None,
        primary_language: str | None = None,
    ) -> dict:
        import numpy as np
        import torch

        duration = len(audio) / RATE
        budget = PREFIX_TOKENS + math.ceil(duration * TOKENS_PER_SECOND)
        clean_prompt = " ".join((context_prompt or "").split())[:600] or None
        # 0.3 s of silence on each boundary prevents Qwen3-ASR's Conv2d audio
        # frontend from clipping segment-initial or segment-final words.
        padded = np.pad(audio, (PAD_SAMPLES, PAD_SAMPLES)) if len(audio) else audio
        if hasattr(self.processor, "apply_chat_template") and callable(self.processor):
            messages = []
            if clean_prompt is not None:
                messages.append(
                    {"role": "system", "content": [{"type": "text", "text": clean_prompt}]}
                )
            messages.append({"role": "user", "content": [{"type": "audio", "audio": padded}]})
            conversations = [messages]
            prompt = self.processor.apply_chat_template(
                conversations, tokenize=False, add_generation_prompt=True
            )
            inputs = self.processor(text=prompt, audio=[padded], return_tensors="pt")
        elif clean_prompt is not None:
            inputs = self.processor.apply_transcription_request(audio=padded, prompt=clean_prompt)
        else:
            inputs = self.processor.apply_transcription_request(audio=padded)
        if hasattr(inputs, "items") and any(
            hasattr(v, "is_floating_point") for v in inputs.values()
        ):
            inputs = {
                k: v.to(
                    device=self.network.device,
                    dtype=self.network.dtype if v.is_floating_point() else None,
                )
                if hasattr(v, "to")
                else v
                for k, v in inputs.items()
            }
        else:
            inputs = inputs.to(self.network.device, self.network.dtype)

        prompt_len = inputs["input_ids"].shape[1]
        gen_kwargs = {}
        if self.allowed_lang_ids or self.forbidden_script_token_ids:
            lang_marker_id = self.language_token_id
            allowed_ids = self.allowed_lang_ids
            none_id = self.none_token_id
            kin_ids = self.germanic_kin_ids
            end_id = self.end_token_id
            forbidden_ids = self.forbidden_script_token_ids

            def gate_step(input_ids, scores):
                step_pos = input_ids.shape[1] - prompt_len
                if (
                    allowed_ids
                    and step_pos == 1
                    and (lang_marker_id is None or int(input_ids[0, -1]) == lang_marker_id)
                ):
                    return apply_language_step_gate(
                        scores,
                        allowed_ids,
                        none_id,
                        kin_ids,
                        duration=duration,
                        primary_language=primary_language,
                    )
                if (
                    none_id is not None
                    and end_id is not None
                    and step_pos >= 3
                    and int(input_ids[0, prompt_len + 1]) == none_id
                ):
                    masked = torch.full_like(scores, float("-inf"))
                    masked[:, end_id] = scores[:, end_id]
                    return masked
                if forbidden_ids and step_pos >= 2:
                    if hasattr(torch, "tensor") and hasattr(scores, "device"):
                        dev_key = str(scores.device)
                        idx = self._forbidden_tensor_cache.get(dev_key)
                        if idx is None:
                            idx = torch.tensor(
                                forbidden_ids, dtype=torch.long, device=scores.device
                            )
                            self._forbidden_tensor_cache[dev_key] = idx
                    else:
                        idx = forbidden_ids
                    masked = scores.clone()
                    masked[:, idx] = float("-inf")
                    return masked
                return scores

            gen_kwargs["logits_processor"] = [gate_step]

        with torch.inference_mode():
            out = self.network.generate(
                **inputs,
                max_new_tokens=budget,
                do_sample=False,
                output_scores=True,
                return_dict_in_generate=True,
                **gen_kwargs,
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
        if language == "None" or (
            len(tokens) >= 2
            and tokens[0] == "language"
            and tokens[1] in (SPACE_MARKER + "None", "None")
        ):
            return {
                "text": "",
                "language": None,
                "words": [],
                "truncated": False,
            }
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


def infer(
    pcm,
    identifier,
    context_prompt: str | None = None,
    primary_language: str | None = None,
):
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
        result = model.transcribe(
            audio,
            context_prompt=context_prompt,
            primary_language=primary_language,
        )
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


def _decode_context_header(raw_b64: str | None) -> str | None:
    if not raw_b64:
        return None
    if len(raw_b64) > 2048:
        raise HTTPException(400, "Context prompt exceeds limit")
    try:
        decoded = base64.b64decode(raw_b64.encode("ascii"), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        raise HTTPException(400, "Invalid context prompt encoding") from None
    cleaned = " ".join(decoded.split())[:600]
    return cleaned or None


@app.post("/v1/transcribe")
async def transcribe(
    request: Request,
    authorization: str | None = Header(default=None),
    x_job_id: str = Header(min_length=64, max_length=64),
    x_asr_context_b64: str | None = Header(default=None, max_length=2048),
    x_primary_language: str | None = Header(default=None, max_length=64),
):
    token = os.environ.get("WORTLAUT_ASR_TOKEN", "")
    if not token or not secrets.compare_digest(authorization or "", "Bearer " + token):
        raise HTTPException(401, "Invalid ASR credential")
    if any(c not in "0123456789abcdef" for c in x_job_id):
        raise HTTPException(400, "Invalid job identifier")
    context_prompt = _decode_context_header(x_asr_context_b64)
    primary_lang = (x_primary_language or "").strip()[:64] or None
    pcm = bytearray()
    async for part in request.stream():
        pcm.extend(part)
        if len(pcm) > MAX_BYTES:
            raise HTTPException(413, "Audio exceeds segment limit")
    if not pcm or len(pcm) % 2:
        raise HTTPException(400, "Expected mono PCM16/16kHz")
    return await run_in_threadpool(
        infer, bytes(pcm), x_job_id, context_prompt, primary_lang
    )
