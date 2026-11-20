FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS sdk
WORKDIR /worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci
COPY worker/ ./
RUN npm run build

FROM python:3.14-slim-trixie
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG WORTLAUT_FETCH_EMBEDDING_MODEL=1
RUN if [ "$WORTLAUT_FETCH_EMBEDDING_MODEL" = "1" ]; then \
      /usr/local/bin/python3 -c "$(printf '%s\n' \
        'import hashlib, pathlib, shutil, urllib.request' \
        'base = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78"' \
        'out = pathlib.Path("/app/models/multilingual-e5-small-int8")' \
        'out.mkdir(parents=True, exist_ok=True)' \
        'files = [' \
        '    ("onnx/model_quantized.onnx", "model_quantized.onnx", "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193"),' \
        '    ("tokenizer.json", "tokenizer.json", "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),' \
        ']' \
        'for src, name, expected in files:' \
        '    dst = out / name' \
        '    req = urllib.request.Request(f"{base}/{src}", headers={"User-Agent": "wortlaut-docker-build/1.0"})' \
        '    with urllib.request.urlopen(req, timeout=120) as resp, dst.open("wb") as fh:' \
        '        shutil.copyfileobj(resp, fh)' \
        '    with dst.open("rb") as fh:' \
        '        actual = hashlib.file_digest(fh, "sha256").hexdigest()' \
        '    if actual != expected:' \
        '        raise RuntimeError(f"SHA-256 mismatch for {name}: {actual}")')" \
      && chmod -R a+rX /app/models/multilingual-e5-small-int8; \
    fi
COPY --from=ghcr.io/astral-sh/uv:0.13.9 /uv /usr/local/bin/uv
COPY services/meeting/pyproject.toml services/meeting/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --no-cache
COPY services/meeting/ ./
RUN uv sync --frozen --no-dev --no-cache && rm -f /usr/local/bin/uv && useradd --uid 10001 --create-home wortlaut
COPY --from=sdk /worker/dist ./sdk
COPY site ./site
ENV PATH="/app/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
USER 10001
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn wortlaut.app:app --host 0.0.0.0 --port 8000 --workers 1"]
