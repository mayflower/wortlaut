# Official NVIDIA PyTorch runtime: the same CUDA 13.0 / torch 2.9 stack the
# former NeMo-based image shipped, so the shared MPS GPU sees an unchanged client.
# Model revision is pinned in app.py.
FROM nvcr.io/nvidia/pytorch:25.09-py3@sha256:f3b4a33fd60d5e0358287bb44d57e91eda45e8f1681fef1bfd6c969371417130
RUN pip install --no-cache-dir transformers==5.22.2 fastapi==0.142.2 'uvicorn[standard]==0.54.0' \
    && python -c 'from transformers import AutoModelForMultimodalLM, AutoProcessor'
WORKDIR /app
COPY services/asr/app.py /app/app.py
RUN useradd --uid 10001 --create-home wortlaut && mkdir /model-cache && chown 10001:10001 /model-cache
ENV HF_HOME=/model-cache PYTHONUNBUFFERED=1
USER 10001:10001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "4", "--timeout-graceful-shutdown", "180"]
