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
