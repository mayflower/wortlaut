# Configuration & Integration Guide

This guide walks through configuring optional authentication, calendar OAuth2 writeback, and conference provider sessions for a self-hosted `wortlaut` instance.

---

## 1. Authentication Modes

### Single-User / API-Token Mode (Default)

When `WORTLAUT_OIDC_ISSUER` is left empty (`""`), `wortlaut` starts in single-operator mode. Open `/ui` and sign in using the `WORTLAUT_API_TOKEN` configured in your `.env` or `wortlaut-runtime` Secret.

### Multi-User OIDC Mode (Dex, Keycloak, Authentik, Microsoft Entra)

`wortlaut` uses OAuth2 Authorization Code + PKCE in the browser and verifies RS256 ID tokens against `<WORTLAUT_OIDC_ISSUER>/keys` (or `.well-known/openid-configuration`).

1. Register a public OIDC client in your Identity Provider:
   - **Client ID**: `wortlaut` (or match `WORTLAUT_OIDC_CLIENT_ID`)
   - **Redirect URI**: `https://<your-wortlaut-domain>/auth/callback`
   - **Grant Type**: `Authorization Code` with **PKCE (`S256`)**
   - **Scopes**: `openid profile email`
2. Configure `wortlaut`:
   ```dotenv
   WORTLAUT_OIDC_ISSUER=https://auth.example.org
   WORTLAUT_OIDC_CLIENT_ID=wortlaut
   WORTLAUT_OIDC_ALLOWED_DOMAINS=["example.org"]
   WORTLAUT_OIDC_ADMIN_EMAILS=["admin@example.org"]
   ```
   *(If the backend container reaches the OIDC provider via an internal cluster DNS name while browsers use the public URL, set `WORTLAUT_OIDC_INTERNAL_ISSUER=http://dex.dex.svc.cluster.local:5556`.)*

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

All four providers work side-by-side per recording:

| Provider | Environment Flag | Default Join Mode | Optional Authenticated Session |
| --- | --- | --- | --- |
| **Google Meet** | `WORTLAUT_ENABLE_GOOGLE_MEET=true` | Browser guest (`wortlaut (<Inviter>)`) | Kubernetes Secret `WORTLAUT_MEET_STORAGE_STATE_SECRET` with Playwright `storageState.json` |
| **Microsoft Teams** | `WORTLAUT_ENABLE_TEAMS=true` | Browser guest (`en-US` / `WORTLAUT_TEAMS_LOCALE`) | Guest lobby admission |
| **Zoom** | `WORTLAUT_ENABLE_ZOOM=true` | Browser Web Client guest (`WORTLAUT_ZOOM_LOCALE=en-US`) | Kubernetes Secret `WORTLAUT_ZOOM_STORAGE_STATE_SECRET` |
| **Cisco Webex** | `WORTLAUT_ENABLE_WEBEX_BROWSER=true` | Browser Web Client guest (or Webex Guest Issuer via `WORTLAUT_WEBEX_SERVICE_TOKEN`) | Service App / Guest Issuer token |

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
- **Retention & Storage Quota (`WORTLAUT_TRANSCRIPT_RETENTION_DAYS` & `WORTLAUT_MAX_STORED_AUDIO_BYTES`)**: Stored under `keyframes/{recording_id}/` in `WORTLAUT1`-framed S3 objects, slide keyframes survive the 24-hour raw-audio purge (`WORTLAUT_AUDIO_RETENTION_HOURS`) so 30-day protocols retain their visual slide context, and are automatically purged alongside transcripts when `WORTLAUT_TRANSCRIPT_RETENTION_DAYS` expires or `DELETE /v1/recordings/{id}` is called. Active keyframe bytes count toward `WORTLAUT_MAX_STORED_AUDIO_BYTES`.
