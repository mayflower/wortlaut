# Unified Python 3.14 GPU runtime supporting both Qwen3-ASR (Transformers/PyTorch)
# and Parakeet TDT 0.6B v3 (ONNX Runtime GPU) on CUDA 13 + cuDNN 9.
# Model revisions are pinned in app.py.
FROM python:3.14-slim-trixie
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.9 /uv /usr/local/bin/uv
WORKDIR /app
RUN uv venv /app/.venv \
    && uv pip install --python /app/.venv/bin/python --no-cache \
      torch==2.15.0 \
      transformers==5.23.0 \
      fastapi==0.165.0 \
      'uvicorn[standard]==0.54.0' \
      onnx-asr==0.12.0 \
      onnxruntime-gpu==1.32.0 \
      'nvidia-curand~=10.0' \
    && /app/.venv/bin/python -c 'import torch, onnx_asr, onnxruntime; from transformers import AutoModelForMultimodalLM, AutoProcessor' \
    && rm -rf /usr/local/bin/uv /usr/local/bin/pip* /usr/local/lib/python3.14/ensurepip /usr/local/lib/python3.14/site-packages/pip* \
    && useradd --uid 10001 --create-home wortlaut \
    && mkdir /model-cache \
    && chown 10001:10001 /model-cache
COPY services/asr/app.py /app/app.py
RUN /app/.venv/bin/python -m py_compile /app/app.py
ENV PATH="/app/.venv/bin:$PATH" \
    HF_HOME=/model-cache \
    CUDA_CACHE_PATH=/model-cache/nv-cache \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "4", "--timeout-graceful-shutdown", "180"]
