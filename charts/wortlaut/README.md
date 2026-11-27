# wortlaut Helm Chart

Deploys `wortlaut` (`meeting` control plane + Web-UI + OAuth 2.1 MCP server at `/mcp`, ephemeral `worker` Jobs, and local GPU/CPU `asr` service) on Kubernetes.

## Mode A: Zero-Dependency Single-Command Install (`bundled.enabled=true`)

Ideal for quick evaluation on K3s, kind, microk8s, or homelab clusters — automatically provisions embedded PostgreSQL 17, RustFS S3 storage, and persistent random Secrets:

```bash
helm upgrade --install wortlaut ./charts/wortlaut \
  --namespace wortlaut --create-namespace \
  --set host=wortlaut.example.org \
  --set bundled.enabled=true \
  --set asr.backend=parakeet \
  --set asr.device=cpu
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

**Production GPU (Qwen3-ASR 1.7B, default) with generic OIDC (Dex / Keycloak / Authentik):**

```bash
helm upgrade --install wortlaut ./charts/wortlaut \
  --namespace wortlaut \
  --set host=wortlaut.example.org \
  --set oidc.issuer=https://auth.example.org
```

**Production GPU with Parakeet TDT v3 ONNX (25 EU languages, word timestamps):**

```bash
helm upgrade --install wortlaut ./charts/wortlaut \
  --namespace wortlaut \
  --set host=wortlaut.example.org \
  --set asr.backend=parakeet \
  --set asr.device=cuda
```

**Optional: Multi-User Sign-In with Microsoft Entra ID and/or Google Sign-In:**

```bash
kubectl -n wortlaut create secret generic wortlaut-auth \
  --from-literal=WORTLAUT_ENTRA_AUTH_CLIENT_SECRET='REPLACE_PRIVATELY' \
  --from-literal=WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET='REPLACE_PRIVATELY'

helm upgrade --install wortlaut ./charts/wortlaut \
  --namespace wortlaut \
  --set host=wortlaut.example.org \
  --set oidc.entraClientId='<entra-app-client-id>' \
  --set oidc.entraTenantId='<entra-tenant-uuid>' \
  --set oidc.googleClientId='<google-client-id>.apps.googleusercontent.com' \
  --set 'oidc.allowedDomains={example.org}' \
  --set 'oidc.adminEmails={admin@example.org}'
```

### Key Chart Values (`values.yaml`)

| Value | Default | Description |
| --- | --- | --- |
| `host` | `wortlaut.example.org` | Public HTTPS hostname for `/ui`, `/privacy`, `/docs`, `/mcp`, and OAuth2 callbacks |
| `defaultLocale` | `de` | Default language (`de` or `en`) for Web-UI, `/privacy`, live video tile, and chat intro |
| `bundled.enabled` | `false` | Provision embedded PostgreSQL 17, RustFS S3, and persistent random Secrets in-namespace |
| `ingress.enabled` | `true` | Create a Kubernetes Ingress; when `false`, workers call `http://wortlaut-meeting:8000/` in-cluster |
| `images.asr` | `ghcr.io/mayflower/wortlaut-asr:latest` | GPU ASR image (Python 3.14, Qwen3-ASR + Parakeet CUDA 13) |
| `images.asrCpu` | `ghcr.io/mayflower/wortlaut-asr-cpu:latest` | Slim multi-arch (`amd64`/`arm64`) CPU image selected automatically for `parakeet` + CPU |
| `providers.enableGoogleMeet` | `true` | Enable Google Meet browser capture |
| `providers.enableTeams` | `true` | Enable Microsoft Teams browser capture |
| `providers.enableZoom` | `true` | Enable Zoom Web Client capture |
| `providers.enableWebexBrowser` | `true` | Enable Cisco Webex browser capture (or Guest Issuer when `WORTLAUT_WEBEX_SERVICE_TOKEN` is supplied) |
| `keyframes.enabled` | `true` | Capture settled screen-share slide snapshots (`<= 1280×720` PNG; participant cameras never recorded) |
| `asr.backend` | `qwen3` | ASR backend: `qwen3` (Qwen3-ASR 1.7B, 30 languages) or `parakeet` (Parakeet TDT 0.6B v3 ONNX, 25 EU languages) |
| `asr.device` | `auto` | Execution device: `auto` (GPU when available), `cuda`, `cpu`, or `mps` (when `parakeet` + `cpu`, automatically uses `images.asrCpu` and omits GPU limits) |
| `asr.quantization` | `auto` | Precision/quantization: `auto` (`int8` for Parakeet/CPU, `fp32` for Parakeet/CUDA, `bfloat16` for Qwen3/CUDA, `float32` for Qwen3/CPU), `int8`, `fp32`, `bfloat16`, `float16`, `float32` |
| `asr.allowCpu` | `false` | Backward-compatible CPU opt-in when `asr.device=auto` (omits `nvidia.com/gpu`) |
| `asr.gpuCount` | `1` | Number of `nvidia.com/gpu` devices requested (setting `0` also switches to CPU mode) |
| `asr.modelRepo` | `""` | Optional Hugging Face model repo override (empty uses the backend's pinned default) |
| `asr.modelRevision` | `""` | Optional Hugging Face commit/revision override (empty uses the backend's pinned default) |
| `asr.languages` | `"*"` | Default ASR languages (`*` = all supported languages, or e.g. `German,English`; switchable per recording) |
| `asr.glossary` | `""` | Optional comma-separated domain vocabulary / acronyms passed to Qwen3-ASR and RAG search |
| `otlpEndpoint` | `""` | Optional OpenTelemetry OTLP endpoint for tracing/metrics |
| `llmSummary.enabled` | `false` | Enable optional LLM executive summaries, decisions, action items & RAG query expansion (Ollama or OpenAI-compatible API) |
| `llmSummary.openaiBaseUrl` | `""` | Optional OpenAI-compatible API base URL (e.g. `https://api.openai.com/v1` or local vLLM/LiteLLM); takes precedence over Ollama when set |
| `llmSummary.openaiModel` | `gpt-4o-mini` | Model ID for the OpenAI-compatible chat completions API |
| `llmSummary.openaiTimeoutSeconds` | `120` | Timeout in seconds for OpenAI-compatible LLM requests |
| `oidc.issuer` | `""` | Generic OIDC issuer URL (Dex, Keycloak, Authentik, etc.) |
| `oidc.clientId` | `wortlaut` | Generic OIDC client ID |
| `oidc.displayName` | `""` | Optional custom sign-in button label for generic OIDC |
| `oidc.entraClientId` | `""` | Optional Microsoft Entra ID Application (Client) ID for user sign-in |
| `oidc.entraTenantId` | `""` | Microsoft Entra Tenant UUID/domain (recommended single-tenant) or `organizations`/`common` |
| `oidc.entraAllowedTenants` | `[]` | Optional Entra Tenant UUID allowlist when using `organizations`/`common` |
| `oidc.googleClientId` | `""` | Optional Google OAuth 2.0 Web Client ID for user sign-in (requires `WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET`) |
| `oidc.allowedDomains` | `[]` | Shared allowed user email domains across all enabled sign-in providers |
| `oidc.adminEmails` | `[]` | Shared admin email addresses across all enabled sign-in providers |
| `oidc.secretName` | `wortlaut-auth` | Optional Kubernetes Secret holding `WORTLAUT_OIDC_CLIENT_SECRET`, `WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET`, and/or `WORTLAUT_ENTRA_AUTH_CLIENT_SECRET` |

### Optional Secret Keys (`wortlaut-runtime` / `wortlaut-auth`)

| Key | Description |
| --- | --- |
| `WORTLAUT_OIDC_CLIENT_SECRET` | Optional confidential client secret for generic OIDC (`wortlaut-auth`) |
| `WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET` | Google OAuth 2.0 Web Client Secret for Google Sign-In (`wortlaut-auth`) |
| `WORTLAUT_ENTRA_AUTH_CLIENT_SECRET` | Optional confidential client secret for Microsoft Entra ID Web apps (`wortlaut-auth`) |
| `WORTLAUT_GOOGLE_CALENDAR_CLIENT_ID` | Google OAuth2 Client ID (`calendar.events`) |
| `WORTLAUT_GOOGLE_CALENDAR_CLIENT_SECRET` | Google OAuth2 Client Secret |
| `WORTLAUT_MICROSOFT_CALENDAR_CLIENT_ID` | Microsoft Entra Application (Client) ID (`Calendars.ReadWrite`) |
| `WORTLAUT_MICROSOFT_CALENDAR_CLIENT_SECRET` | Optional Confidential Client Secret (leave unset for public SPA/PKCE) |
| `WORTLAUT_MICROSOFT_CALENDAR_TENANT_ID` | Entra Tenant ID or `common` |
| `WORTLAUT_OLLAMA_URL` | Local Ollama HTTP base URL (e.g. `http://ollama:11434`) for executive summaries |
| `WORTLAUT_OLLAMA_MODEL` | Ollama model identifier (default `qwen3.8:latest`) |
| `WORTLAUT_OPENAI_API_KEY` | Optional Bearer API key for `llmSummary.openaiBaseUrl` (never logged or returned via API) |
