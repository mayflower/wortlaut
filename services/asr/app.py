"""One loaded Parakeet model and one non-cancellable inference at a time."""

import hashlib
import os
import secrets
import tempfile
import threading
import wave
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

DEFAULT_MODEL_REPO = "primeline/parakeet-primeline"
DEFAULT_MODEL_FILENAME = "2_95_WER.nemo"
DEFAULT_MODEL_REVISION = "3f1a9bcb611dfeda53fe74fe5f1a3d5701e8023e"
MODEL_REVISION = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", DEFAULT_MODEL_REVISION)
MAX_BYTES = 16000 * 2 * 32
lock = threading.Lock()
model = None
accelerator_failed = threading.Event()


def load_model():
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
    repo = os.environ.get("WORTLAUT_ASR_MODEL_REPO", DEFAULT_MODEL_REPO).strip()
    explicit_name = os.environ.get("WORTLAUT_ASR_MODEL_FILENAME", "").strip()
    explicit_rev = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip()
    if repo == DEFAULT_MODEL_REPO or explicit_name:
        name = explicit_name or DEFAULT_MODEL_FILENAME
        revision = explicit_rev or (DEFAULT_MODEL_REVISION if repo == DEFAULT_MODEL_REPO else None)
        filename = hf_hub_download(repo, name, revision=revision)
        loaded = nemo_asr.models.ASRModel.restore_from(filename, map_location=device)
    else:
        loaded = nemo_asr.models.ASRModel.from_pretrained(model_name=repo, map_location=device)
    loaded.freeze()
    loaded.eval()
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
            return {
                "job_id": identifier,
                "pcm_sha256": hashlib.sha256(pcm).hexdigest(),
                "text": hypothesis.text,
                "words": [
                    {"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
                    for w in words
                ],
            }
    except torch.AcceleratorError:
        # An unusable CUDA/MPS client must stop receiving more jobs. The
        # liveness probe replaces only this process, not shared GPU services.
        accelerator_failed.set()
        raise HTTPException(503, "GPU unavailable") from None
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
