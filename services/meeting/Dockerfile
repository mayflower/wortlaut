FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS sdk
WORKDIR /worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci
COPY worker/ ./
RUN npm run build

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
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
