# wortlaut Helm Chart

Deploys `wortlaut` (`meeting` control plane + Web-UI + OAuth 2.1 MCP server at `/mcp`, ephemeral `worker` Jobs, and local GPU/CPU `asr` service) on Kubernetes.

## Mode A: Zero-Dependency Single-Command Install (`bundled.enabled=true`)

Ideal for quick evaluation on K3s, kind, microk8s, or homelab clusters — automatically provisions embedded PostgreSQL 17, RustFS S3 storage, and persistent random Secrets:

```bash
helm upgrade --install wortlaut ./charts/wortlaut \
  --namespace wortlaut --create-namespace \
  --set host=wortlaut.example.org \
  --set bundled.enabled=true \
  --set asr.allowCpu=true
```

Retrieve the generated operator Bearer token to sign in at `https://wortlaut.example.org/ui`:

```bash
kubectl -n wortlaut get secret wortlaut-runtime -o jsonpath='{.data.WORTLAUT_API_TOKEN}' | base64 -d && echo
```

---

## Mode B: Production Install (External PostgreSQL & S3)

For production clusters (`bundled.enabled=false`, the default), bring your own managed PostgreSQL (e.g., CloudNativePG), S3-compatible object storage, and NVIDIA GPU node (`nvidia.com/gpu: 1`).

### 1. Create Required Kubernetes Secrets

```bash
kubectl create namespace wortlaut

kubectl -n wortlaut create secret generic wortlaut-runtime \
  --from-literal=WORTLAUT_DATABASE_URL='postgresql+psycopg://wortlaut:PASSWORD@postgres-rw:5432/wortlaut' \
  --from-literal=WORTLAUT_API_TOKEN="$(openssl rand -base64 32)"

kubectl -n wortlaut create secret generic wortlaut-storage \
  --from-literal=WORTLAUT_S3_ENDPOINT='http://rustfs:9000' \
  --from-literal=WORTLAUT_S3_ACCESS_KEY='wortlaut-s3' \
  --from-literal=WORTLAUT_S3_SECRET_KEY="$(openssl rand -base64 32)"

kubectl -n wortlaut create secret generic wortlaut-asr \
  --from-literal=WORTLAUT_ASR_URL='http://wortlaut-asr:8000' \
  --from-literal=WORTLAUT_ASR_TOKEN="$(openssl rand -base64 32)"
```

### 2. Install / Upgrade Chart

```bash
helm upgrade --install wortlaut ./charts/wortlaut \
  --namespace wortlaut \
  --set host=wortlaut.example.org \
  --set oidc.issuer=https://auth.example.org \
  --set asr.modelRepo=Qwen/Qwen3-ASR-1.7B-hf
```

### Key Chart Values (`values.yaml`)

| Value | Default | Description |
| --- | --- | --- |
| `host` | `wortlaut.example.org` | Public HTTPS hostname for `/ui`, `/privacy`, `/docs`, `/mcp`, and OAuth2 callbacks |
| `defaultLocale` | `de` | Default language (`de` or `en`) for Web-UI, `/privacy`, live video tile, and chat intro |
| `keyframes.enabled` | `true` | Capture settled screen-share slide snapshots (`<= 1280×720` PNG; participant cameras never recorded) |
| `asr.modelRepo` | `Qwen/Qwen3-ASR-1.7B-hf` | Hugging Face model ID loaded by `wortlaut-asr` |
| `asr.languages` | `German,English` | Allowed ASR languages (`*` enables all 30 languages) |
| `asr.glossary` | `""` | Optional comma-separated domain vocabulary / acronyms passed to Qwen3-ASR |
| `llmSummary.enabled` | `false` | Enable optional local Ollama executive summaries & action items |

### Optional Secret Keys (`wortlaut-runtime`)

| Key | Description |
| --- | --- |
| `WORTLAUT_GOOGLE_CALENDAR_CLIENT_ID` | Google OAuth2 Client ID (`calendar.events`) |
| `WORTLAUT_GOOGLE_CALENDAR_CLIENT_SECRET` | Google OAuth2 Client Secret |
| `WORTLAUT_MICROSOFT_CALENDAR_CLIENT_ID` | Microsoft Entra Application (Client) ID (`Calendars.ReadWrite`) |
| `WORTLAUT_MICROSOFT_CALENDAR_CLIENT_SECRET` | Optional Confidential Client Secret (leave unset for public SPA/PKCE) |
| `WORTLAUT_MICROSOFT_CALENDAR_TENANT_ID` | Entra Tenant ID or `common` |
| `WORTLAUT_OLLAMA_URL` | Local Ollama HTTP base URL (e.g. `http://ollama:11434`) for executive summaries |
| `WORTLAUT_OLLAMA_MODEL` | Ollama model identifier (default `qwen3.8:latest`) |
