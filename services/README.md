# services

## Overview
Backend Python services directory grouping the GPU Parakeet ASR inference service and the `wortlaut` meeting coordination service.

## Subdirectories & Boundaries
- `asr`: [./asr/README.md](./asr/README.md) - FastAPI GPU service running a single loaded NVIDIA Parakeet (`nvidia/parakeet-tdt-0.6b-v3`) model for synchronous mono PCM16/16kHz transcription.
- `meeting`: [./meeting/README.md](./meeting/README.md) - FastAPI meeting coordination service and integrated operator/transcript Web-UI (`ui.py`) handling per-source audio ingest, S3 storage, WebRTC VAD segmentation, ASR job scheduling, Kubernetes worker reconciliation, calendar intake, and transcript exports/mail delivery.
