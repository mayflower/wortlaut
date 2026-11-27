# Configuration & Integration Guide

This guide walks through configuring authentication, calendar OAuth2 writeback, conference provider sessions, screen-share keyframes, in-call chat controls, Model Context Protocol (MCP) clients, and speech/summary models for a self-hosted `wortlaut` instance.

---

## 1. Authentication Modes

### Single-User / API-Token Mode (Default)

When `WORTLAUT_OIDC_ISSUER` is left empty (`""`), `wortlaut` starts in single-operator mode. Open `/ui` and sign in using the `WORTLAUT_API_TOKEN` configured in your `.env` or `wortlaut-runtime` Secret.

### Multi-User Sign-In (OIDC, Microsoft Entra ID, Google)

`wortlaut` supports three optional OAuth2 / OIDC sign-in providers — individually or side-by-side on the login screen and MCP OAuth flow. All enabled providers use Authorization Code + PKCE (`S256`), verify signed ID tokens via provider JWKS, and share the same `WORTLAUT_OIDC_ALLOWED_DOMAINS` / `WORTLAUT_OIDC_ADMIN_EMAILS` access policies.

All providers share the unified Redirect URI:
- `https://<your-wortlaut-domain>/auth/callback`

#### Option A: Generic OIDC (Dex, Keycloak, Authentik, etc.)

1. Register an OIDC client with Redirect URI `https://<your-wortlaut-domain>/auth/callback`, Authorization Code + PKCE (`S256`), scopes `openid profile email`.
2. Configure:
   ```dotenv
   WORTLAUT_OIDC_ISSUER=https://auth.example.org
   WORTLAUT_OIDC_CLIENT_ID=wortlaut
   WORTLAUT_OIDC_CLIENT_SECRET=               # Optional (for confidential OIDC clients)
   WORTLAUT_OIDC_DISPLAY_NAME=                # Optional custom button label
   WORTLAUT_OIDC_ALLOWED_DOMAINS=["example.org"]
   WORTLAUT_OIDC_ADMIN_EMAILS=["admin@example.org"]
   ```
   *(If the backend container reaches the OIDC provider via an internal cluster DNS name while browsers use the public URL, set `WORTLAUT_OIDC_INTERNAL_ISSUER=http://dex.dex.svc.cluster.local:5556`.)*

#### Option B: Microsoft Entra ID (Azure AD)

1. Create an **App registration** in Microsoft Entra ID with Platform **Web** (or **Single-page application** for PKCE-only without secret) and Redirect URI `https://<your-wortlaut-domain>/auth/callback`.
2. Grant delegated permissions `openid`, `profile`, `email`.
3. Configure:
   ```dotenv
   WORTLAUT_ENTRA_AUTH_CLIENT_ID=<application-client-id>
   WORTLAUT_ENTRA_AUTH_CLIENT_SECRET=<client-secret>   # Required for Web apps; omit for SPA/public PKCE
   WORTLAUT_ENTRA_AUTH_TENANT_ID=<tenant-uuid>         # Recommended single-tenant UUID/domain (or "organizations"/"common")
   WORTLAUT_ENTRA_AUTH_ALLOWED_TENANTS=[]              # Explicit tenant UUID allowlist when using "organizations"/"common"
   WORTLAUT_OIDC_ALLOWED_DOMAINS=["example.org"]
   WORTLAUT_OIDC_ADMIN_EMAILS=["admin@example.org"]
   ```
   *(Security note: `wortlaut` requires `WORTLAUT_ENTRA_AUTH_TENANT_ID` to be set explicitly. In single-tenant mode, token `iss`/`tid` are pinned to that tenant. In unrestricted multi-tenant mode without `WORTLAUT_ENTRA_AUTH_ALLOWED_TENANTS`, tokens are only accepted if Microsoft explicitly attests email verification via `xms_edov=1` or `email_verified=true` to prevent cross-tenant nOAuth email spoofing.)*

#### Option C: Google Sign-In

1. Create an **OAuth 2.0 Web application** credential in Google Cloud Console with Authorized redirect URI `https://<your-wortlaut-domain>/auth/callback`.
2. Configure (both Client ID and Client Secret are required by Google's token endpoint):
   ```dotenv
   WORTLAUT_GOOGLE_AUTH_CLIENT_ID=<google-client-id>.apps.googleusercontent.com
   WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET=<google-client-secret>
   WORTLAUT_OIDC_ALLOWED_DOMAINS=["example.org"]
   WORTLAUT_OIDC_ADMIN_EMAILS=["admin@example.org"]
   ```

---

## 2. Calendar Sync & Automatic Protocol Linking (OAuth2)

Connecting Google Calendar or Microsoft 365 allows users to automatically schedule `wortlaut` for upcoming meetings and writes the scoped read-only protocol link (`wortlaut-read-…`) plus optional executive summary directly back into the calendar event after processing finishes.

Both providers share the unified callback URI:
```text
https://<your-wortlaut-domain>/auth/callback
```

### Google Calendar (`calendar.events`)

1. In the **Google Cloud Console**, enable the **Google Calendar API**.
2. Under **Credentials → Create Credentials → OAuth client ID** (Web application):
   - Add Authorized Redirect URI: `https://<your-wortlaut-domain>/auth/callback`
   - Request scope: `https://www.googleapis.com/auth/calendar.events`
3. Set in `.env` or `wortlaut-runtime` Secret:
   ```dotenv
   WORTLAUT_GOOGLE_CALENDAR_CLIENT_ID=your-client-id.apps.googleusercontent.com
   WORTLAUT_GOOGLE_CALENDAR_CLIENT_SECRET=your-client-secret
   ```

### Microsoft 365 / Outlook (`Calendars.ReadWrite`)

1. In **Microsoft Entra Admin Center → App registrations → New registration**:
   - **Platform**: Single-page application (SPA) — or Web if using a client secret
   - **Redirect URI**: `https://<your-wortlaut-domain>/auth/callback`
   - **API permissions**: Microsoft Graph → Delegated → `Calendars.ReadWrite`, `User.Read`, `offline_access`
2. Set in `.env` or `wortlaut-runtime` Secret:
   ```dotenv
   WORTLAUT_MICROSOFT_CALENDAR_CLIENT_ID=00000000-0000-0000-0000-000000000000
   WORTLAUT_MICROSOFT_CALENDAR_TENANT_ID=common
   # Optional if registered as a Confidential Web client instead of SPA:
   # WORTLAUT_MICROSOFT_CALENDAR_CLIENT_SECRET=...
   ```

---

## 3. Conference Provider Configuration

All four conference platforms are **enabled by default** (`true`) out of the box and work side-by-side per recording (set any individual `WORTLAUT_ENABLE_<PROVIDER>=false` to disable a platform):

| Provider | Environment Flag (Default) | Default Join Mode | Optional Authenticated Session |
| --- | --- | --- | --- |
| **Google Meet** | `WORTLAUT_ENABLE_GOOGLE_MEET=true` | Browser guest (`wortlaut (<Inviter>)`) | Kubernetes Secret `WORTLAUT_MEET_STORAGE_STATE_SECRET` with Playwright `storageState.json` |
| **Microsoft Teams** | `WORTLAUT_ENABLE_TEAMS=true` | Browser guest (`en-US` / `WORTLAUT_TEAMS_LOCALE`) | Guest lobby admission |
| **Zoom** | `WORTLAUT_ENABLE_ZOOM=true` | Browser Web Client guest (`WORTLAUT_ZOOM_LOCALE=en-US`) | Kubernetes Secret `WORTLAUT_ZOOM_STORAGE_STATE_SECRET` |
| **Cisco Webex** | `WORTLAUT_ENABLE_WEBEX_BROWSER=true` | Browser Web Client guest (or Webex Guest Issuer when `WORTLAUT_WEBEX_SERVICE_TOKEN` is set) | Service App / Guest Issuer token |

---

## 4. Screen-Share Slide Keyframes (`WORTLAUT_ENABLE_KEYFRAMES`)

By default (`WORTLAUT_ENABLE_KEYFRAMES=true`), browser workers capture static PNG snapshots (`<= 1280 × 720`, `<= 60` per recording) **strictly from verified screen-share tracks** whenever a shared slide or diagram settles for at least 3 seconds. Participant camera feeds, gallery tiles, and unattributed video tracks are rejected fail-closed (`dropped_unverified`).

```dotenv
# Default: true. Set to false to disable screen-share snapshot capture instance-wide.
WORTLAUT_ENABLE_KEYFRAMES=true
```

Key operational interactions:

- **Provider support**: Active in browser capture modes for **Google Meet**, **Microsoft Teams**, **Cisco Webex Browser** (`WORTLAUT_ENABLE_WEBEX_BROWSER=true`), and **Zoom Web Client**; reports `capability: "unsupported"` when running in headless Webex Guest-Issuer SDK mode.
- **Transparency (`/privacy` & `WORTLAUT_ENABLE_CHAT_INTRO`)**: When `WORTLAUT_ENABLE_KEYFRAMES=true`, both the public `/privacy` notice (`DE`/`EN`) and the in-call chat introduction (`WORTLAUT_ENABLE_CHAT_INTRO=true`) explicitly state that participant camera video is never recorded and only settled screen-share snapshots are stored. Setting `WORTLAUT_ENABLE_KEYFRAMES=false` restores audio-only wording automatically.
- **Live Opt-Out & Single-Slide Deletion**: Typing `no` / `nein` / `opt out` in the meeting chat (or updating `opted_out_speakers`) stops further snapshots from that presenter and synchronously purges their already-uploaded keyframes from S3 and PostgreSQL. Operators and recording owners can also delete individual slides via the Web-UI or `DELETE /v1/recordings/{id}/keyframes/{keyframe_id}`.
- **Retention & Storage Quota (`WORTLAUT_TRANSCRIPT_RETENTION_DAYS` & `WORTLAUT_MAX_STORED_AUDIO_BYTES`)**: Stored under `keyframes/{recording_id}/` in `WORTLAUT1`-framed S3 objects, slide keyframes survive the 24-hour raw-audio purge (`WORTLAUT_RAW_AUDIO_RETENTION_HOURS`) so 30-day protocols retain their visual slide context, and are automatically purged alongside transcripts when `WORTLAUT_TRANSCRIPT_RETENTION_DAYS` expires or `DELETE /v1/recordings/{id}` is called. Active keyframe bytes count toward `WORTLAUT_MAX_STORED_AUDIO_BYTES`.

---

## 5. In-Call Chat Controls, Live Video Tile & Transparency (`/privacy`)

During browser-captured calls (**Google Meet**, **Microsoft Teams**, **Cisco Webex Browser**, and **Zoom**), `wortlaut` transmits a `1280 × 720` WebRTC video tile displaying recent speaker-attributed turns, recording status, and available chat commands (`WORTLAUT_ASSISTANT_NAME`, default `wortlaut`).

```dotenv
WORTLAUT_ASSISTANT_NAME=wortlaut
WORTLAUT_DEFAULT_LOCALE=en          # "en" or "de" for UI, /privacy, video tile & chat intro
WORTLAUT_ENABLE_CHAT_INTRO=true     # Post concise transparency + command notice in meeting chat
WORTLAUT_PRIVACY_URL=               # Defaults to <WORTLAUT_API_URL>/privacy
```

Participants can control `wortlaut` directly from the conference chat without opening `/ui`:

| Chat Command | Effect |
| --- | --- |
| `no`, `opt out`, `optout`, `stop`, `widerspruch` | Immediately halts audio and screen-share capture for that participant and purges their prior transcript segments and slide keyframes from PostgreSQL and S3. |
| `#pause`, `/pause`, `!pause`, `#off-the-record`, `#pausieren` | Zeroes audio samples in worker RAM, suspends slide keyframe sampling, records a `pause_windows` entry, and switches the video tile to an amber **OFF THE RECORD** banner. |
| `#resume`, `/resume`, `!resume`, `#weiter`, `#fortsetzen` | Ends the off-the-record pause and resumes normal capture without leaving the room. |

---

## 6. Model Context Protocol (MCP) Server & OAuth 2.1 (`/mcp`)

`wortlaut` exposes a built-in **MCP Streamable HTTP** server at `POST /mcp` (`GET /mcp`, `DELETE /mcp`) with zero extra containers required:

- **OAuth 2.1 Auto-Discovery (`mcp auth`)**: Serves RFC 9728 Protected Resource Metadata (`/.well-known/oauth-protected-resource/mcp`), RFC 8414 Authorization Server Metadata (`/.well-known/oauth-authorization-server`), and RFC 7591 Dynamic Client Registration (`/oauth/register`) with mandatory PKCE (`S256`) and an explicit browser consent screen (`/oauth/authorize`).
- **Scopes & Tenant Isolation**: `mcp:read` grants read access to the authenticated user’s own/invited recordings (`list_recordings` for chronological/status/provider browsing, `search_protocols` for hybrid semantic + full-text passage retrieval, `get_recording`, `get_transcript`, `get_keyframe`, and binary slide keyframes `wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png`). `mcp:write` additionally enables scheduling/cancelling recordings (`schedule_recording`, `cancel_recording`) and updating protocol metadata/summaries (`update_protocol`).
- **Hybrid RAG Search (`search_protocols`)**: `wortlaut-meeting` chunks completed protocols (`decision`, `action_item`, `summary`, `topic`, `notes`, `slide`, and speaker-attributed `transcript` windows excluding opted-out speakers and `#pause` intervals), computes 384-d CPU ONNX embeddings (`multilingual-e5-small` `int8`) locally without requiring an external `/v1/embeddings` API or PostgreSQL `pgvector`, and fuses cosine similarity with PostgreSQL 17 multi-language (`simple` + `german` + `english`) `tsvector` GIN ranking via Reciprocal Rank Fusion (RRF). RBAC pre-filtering executes in SQL before ranking.
- **Connecting Clients**:
  ```sh
  claude mcp add --transport http wortlaut https://<your-wortlaut-domain>/mcp
  ```
  *(Headless scripts may also pass `Authorization: Bearer <WORTLAUT_API_TOKEN>` directly to `POST /mcp`.)*
- **Revocation**: Users and operators can inspect and revoke active MCP client grants anytime at `/ui#view=mcp` (`GET /v1/mcp/grants`, `DELETE /v1/mcp/grants/{grant_id}`).

---

## 7. Speech-to-Text (`wortlaut-asr`), Glossary, Local Summaries & Retention

```dotenv
# --- wortlaut-asr & wortlaut-meeting services ---
WORTLAUT_ASR_MODEL_REPO=Qwen/Qwen3-ASR-1.7B-hf
WORTLAUT_ASR_LANGUAGES=*                # "*" = auto-detect all 30 languages (or e.g. "German,English"); switchable per recording
WORTLAUT_ASR_ALLOW_CPU=false            # Set true when running without an NVIDIA GPU

# --- wortlaut-meeting service ---
WORTLAUT_ASR_GLOSSARY=                  # Optional comma-separated or JSON list of domain terms/acronyms
WORTLAUT_MAX_OVERTIME_SECONDS=3600      # Auto-extend active meetings past ends_at (15m steps, up to 60m)
WORTLAUT_ENABLE_LLM_SUMMARY=false       # Mandatory explicit opt-in for post-call summaries & slide text extraction
WORTLAUT_OLLAMA_URL=http://ollama:11434
WORTLAUT_OLLAMA_MODEL=qwen3.8:latest
WORTLAUT_OPENAI_BASE_URL=               # Optional external OpenAI-compatible /v1 base URL (query-only RAG expansion; summaries only when WORTLAUT_ENABLE_LLM_SUMMARY=true)
WORTLAUT_OPENAI_API_KEY=                # Optional Bearer secret (store in ignored .env or Kubernetes Secret only)
WORTLAUT_OPENAI_MODEL=gpt-4o-mini
WORTLAUT_OPENAI_TIMEOUT_SECONDS=120
WORTLAUT_RAG_QUERY_EXPANSION_TIMEOUT_SECONDS=1.5
WORTLAUT_RAW_AUDIO_RETENTION_HOURS=24   # Purge raw S3 audio chunks 24h after meeting end
WORTLAUT_TRANSCRIPT_RETENTION_DAYS=30   # Purge transcripts, slide keyframes, and RAG chunks after 30 days
WORTLAUT_MAX_ACTIVE_MEETINGS=15
WORTLAUT_MAX_STORED_AUDIO_BYTES=8589934592
```

*(See [`services/meeting/src/wortlaut/settings.py`](../services/meeting/src/wortlaut/settings.py) for the complete typed settings schema and defaults.)*
