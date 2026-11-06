# asr

## Overview
FastAPI GPU inference service wrapping a single loaded NVIDIA Parakeet (`nvidia/parakeet-tdt-0.6b-v3`) NeMo ASR model to perform synchronous mono PCM16/16kHz speech-to-text transcription with word-level timestamps.

## Interface
- `[app.py:app]`: `FastAPI(title="wortlaut Parakeet", lifespan=lifespan)` application instance.
- `[app.py:MODEL_REVISION]`: Pinned Hugging Face model revision `"541d1f99c6b0c3cd0b11a95167540bb8edefd82b"`.
- `[app.py:MAX_BYTES]`: Maximum accepted PCM payload size (`16000 * 2 * 32` bytes, i.e., 32 seconds of 16kHz 16-bit mono audio).
- `[app.py:load_model]`: Downloads `parakeet-tdt-0.6b-v3.nemo` from `nvidia/parakeet-tdt-0.6b-v3` at `MODEL_REVISION` and restores it onto CUDA in frozen evaluation mode.
- `[app.py:lifespan]`: FastAPI lifespan context manager validating `WORTLAUT_ASR_TOKEN` and loading the model in a worker threadpool.
- `[app.py:ready]`: `GET /health/ready` endpoint returning `{"status": "ready", "model_revision": MODEL_REVISION}` or `HTTPException(503)` while loading or after a GPU failure.
- `[app.py:live]`: `GET /health/live` endpoint returning `{"status": "alive"}` or `HTTPException(503)` when `accelerator_failed` is set.
- `[app.py:infer]`: Synchronous inference helper serializing PCM bytes to a temporary WAV file and running `model.transcribe(..., batch_size=1, timestamps=True, return_hypotheses=True)`.
- `[app.py:transcribe]`: `POST /v1/transcribe` endpoint accepting streamed mono PCM16/16kHz bytes with `Authorization: Bearer <token>` and a 64-character hex `X-Job-ID` header.

## Invariants
- `[app.py:lifespan]`: `WORTLAUT_ASR_TOKEN` must be set in the environment at startup or `RuntimeError("ASR credential missing")` is raised.
- `[app.py:load_model]`: `torch.cuda.is_available()` must be `True` or `RuntimeError("Parakeet service requires an NVIDIA GPU")` is raised.
- `[app.py:infer]`: Only one inference executes at a time, enforced by non-blocking `lock.acquire(blocking=False)`; concurrent requests receive `HTTPException(429, "Inference busy", headers={"Retry-After": "5"})`. Disconnecting the HTTP client does not release `lock` while CUDA inference is running.
- `[app.py:infer]`: Any `torch.AcceleratorError` sets the module-level `accelerator_failed` event, causing `/health/live`, `/health/ready`, and `/v1/transcribe` to return HTTP 503 until the process is restarted.
- `[app.py:transcribe]`: Requires constant-time Bearer token match via `secrets.compare_digest`, a 64-character lowercase hexadecimal `X-Job-ID`, and a non-empty even-length byte stream not exceeding `MAX_BYTES`.

## Side Effects
- `[app.py:load_model]`: Downloads model weights via `huggingface_hub.hf_hub_download` and allocates the NeMo ASR model on the CUDA device.
- `[app.py:infer]`: Creates a temporary directory (`tempfile.TemporaryDirectory(prefix="wortlaut-asr-")`), writes `input.wav`, and executes GPU inference under `torch.inference_mode()`.

## Verification
- Run: `make test`
