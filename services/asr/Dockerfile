# Official NVIDIA runtime, verified linux/amd64 manifest, model revision in app.py.
FROM nvcr.io/nvidia/nemo:25.11@sha256:ccefea2e98d0b1e7b4b5e83b52dbd1567336f6b04b4934c063b1d2251b72381d
RUN pip install --no-cache-dir 'nemo_toolkit[asr]==2.6.0' transformers==4.53.3 \
    pyarrow==20.0.0 fastapi==0.142.2 'uvicorn[standard]==0.54.0' \
    && python -c 'import nemo.collections.asr'
WORKDIR /app
COPY services/asr/app.py /app/app.py
RUN useradd --uid 10001 --create-home wortlaut && mkdir /model-cache && chown 10001:10001 /model-cache
ENV HF_HOME=/model-cache PYTHONUNBUFFERED=1
USER 10001:10001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "4", "--timeout-graceful-shutdown", "180"]
