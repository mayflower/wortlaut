"""MCP OAuth 2.1 Authorization & Protected Resource Server (RFC 9728, RFC 8414, RFC 7591, PKCE)."""

import base64
import hashlib
import hmac
import html
import ipaddress
import re
import secrets
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlsplit, urlunsplit

from fastapi import HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from wortlaut.models import McpOAuthAuthorization, McpOAuthClient, McpOAuthGrant
from wortlaut.oidc import (
    AuthProviderId,
    OidcProviderConfig,
    Principal,
    _b64url_encode,
    exchange_provider_token_for_claims,
    get_auth_provider,
    get_configured_auth_providers,
    get_provider_authorization_endpoint,
    has_any_auth_provider,
    is_admin_email,
    is_allowed_user_email,
    provider_extra_auth_params,
    verify_bearer_oidc_id_token,
    verify_user_session_token,
)
from wortlaut.settings import derive_subkey, get_settings
from wortlaut.ui import FAVICON_DATA_URI

MCP_SCOPES: tuple[str, ...] = ("mcp:read", "mcp:write")
DEFAULT_SCOPE_STRING = "mcp:read"
ACCESS_TOKEN_PREFIX = "wortlaut-mcp-at-"  # noqa: S105
REFRESH_TOKEN_PREFIX = "wortlaut-mcp-rt-"  # noqa: S105
CLIENT_ID_PREFIX = "wortlaut-mcp-client-"
CONSENT_COOKIE_NAME = "wortlaut_mcp_consent"

ACCESS_TOKEN_TTL_SECONDS = 3600
REFRESH_TOKEN_TTL_SECONDS = 30 * 86400
AUTH_FLOW_TTL_SECONDS = 600
AUTH_CODE_TTL_SECONDS = 300

_PKCE_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
_CUSTOM_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]{1,31}$")
_FORBIDDEN_SCHEMES = frozenset(
    {"javascript", "data", "vbscript", "file", "blob", "about", "ws", "wss", "ftp"}
)
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class McpAuthError(Exception):
    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        www_authenticate: str,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.www_authenticate = www_authenticate


@dataclass(frozen=True)
class McpAuthContext:
    principal: Principal
    scopes: frozenset[str]
    grant_id: uuid.UUID | None = None


def _token_hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _pkce_s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return _b64url_encode(digest)


_REGISTER_RATE_LOCK = threading.Lock()
_REGISTER_RATE_BUCKETS: dict[str, list[float]] = {}
_REGISTER_RATE_WINDOW_SEC = 60.0
_REGISTER_RATE_MAX_PER_IP = 40
_MAX_OAUTH_CLIENTS = 512
_SAFE_HOST_RE = re.compile(r"^[a-z0-9.-]+(?::\d{1,5})?$")


def _ip_in_trusted_proxies(raw_ip: str, trusted_entries: list[str]) -> bool:
    if not raw_ip or not trusted_entries:
        return False
    try:
        addr = ipaddress.ip_address(raw_ip.strip())
    except ValueError:
        return False
    for entry in trusted_entries:
        cleaned = (entry or "").strip()
        if not cleaned:
            continue
        try:
            if addr in ipaddress.ip_network(cleaned, strict=False):
                return True
        except ValueError:
            continue
    return False


def extract_client_ip(request: Request) -> str | None:
    """Resolve client IP, trusting X-Forwarded-For only from configured proxy IPs/CIDRs."""
    peer = request.client.host if request.client else None
    if not peer:
        return None
    trusted = get_settings().trusted_proxy_ips
    if not trusted or not _ip_in_trusted_proxies(peer, trusted):
        return peer
    xff = request.headers.get("x-forwarded-for") or ""
    if not xff.strip():
        return peer
    hops = [part.strip() for part in xff.split(",") if part.strip()]
    for hop in reversed(hops):
        try:
            ipaddress.ip_address(hop)
        except ValueError:
            continue
        if not _ip_in_trusted_proxies(hop, trusted):
            return hop
    return hops[0] if hops else peer


def _hmac_tag(purpose: bytes, value: str) -> str:
    subkey = derive_subkey(b"mcp-oauth-v1")
    return hmac.new(subkey, purpose + b"\0" + value.encode("utf-8"), hashlib.sha256).hexdigest()


def public_origin(request: Request) -> str:
    req_host = (request.url.hostname or "").lower()
    is_local_req = req_host in _LOOPBACK_HOSTS or req_host == "testserver"

    settings = get_settings()
    configured = settings.public_base_url()
    if configured:
        parsed = urlsplit(configured)
        host = (parsed.hostname or "").lower()
        if (
            parsed.scheme in ("http", "https")
            and parsed.netloc
            and host
            and host not in ("wortlaut.example.org", "meeting")
            and not host.endswith(".svc.cluster.local")
            and req_host != "testserver"
        ):
            return f"{parsed.scheme}://{parsed.netloc}"

    if is_local_req:
        return f"{request.url.scheme}://{request.url.netloc}"

    # Fallback when api_url is unconfigured/internal: reject spoofed or malformed Host headers.
    netloc = (request.url.netloc or "").strip().lower()
    if not netloc or not _SAFE_HOST_RE.match(netloc):
        return "https://wortlaut.example.org"
    scheme = "https" if request.url.scheme == "https" else "http"
    return f"{scheme}://{netloc}"


def mcp_resource_url(origin: str) -> str:
    return f"{origin.rstrip('/')}/mcp"


def mcp_resource_metadata_url(origin: str) -> str:
    return f"{origin.rstrip('/')}/.well-known/oauth-protected-resource/mcp"


def mcp_www_authenticate(
    origin: str,
    *,
    error: str | None = None,
    error_description: str | None = None,
    scope: str = DEFAULT_SCOPE_STRING,
) -> str:
    parts: list[str] = []
    if error:
        parts.append(f'error="{error}"')
    if error_description:
        clean_desc = error_description.replace('"', "'").replace("\n", " ")[:180]
        parts.append(f'error_description="{clean_desc}"')
    parts.append(f'resource_metadata="{mcp_resource_metadata_url(origin)}"')
    if scope:
        parts.append(f'scope="{scope}"')
    return "Bearer " + ", ".join(parts)


def cors_oauth_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    }


def protected_resource_metadata(request: Request) -> dict:
    origin = public_origin(request)
    return {
        "resource": mcp_resource_url(origin),
        "authorization_servers": [origin],
        "scopes_supported": list(MCP_SCOPES),
        "bearer_methods_supported": ["header"],
        "resource_name": f"{get_settings().assistant_name} MCP",
        "resource_documentation": f"{origin}/privacy",
    }


def authorization_server_metadata(request: Request) -> dict:
    origin = public_origin(request)
    return {
        "issuer": origin,
        "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/oauth/token",
        "registration_endpoint": f"{origin}/oauth/register",
        "revocation_endpoint": f"{origin}/oauth/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": list(MCP_SCOPES),
        "client_id_metadata_document_supported": False,
    }


def validate_redirect_uri(uri: str) -> str:
    if not isinstance(uri, str):
        raise ValueError("redirect_uri must be a string")
    cleaned = uri.strip()
    if not cleaned or len(cleaned) > 1024:
        raise ValueError("Invalid redirect_uri length")
    parsed = urlsplit(cleaned)
    if parsed.fragment:
        raise ValueError("redirect_uri must not contain a fragment")
    scheme = (parsed.scheme or "").lower()
    if not scheme or scheme in _FORBIDDEN_SCHEMES:
        raise ValueError("Unsupported redirect_uri scheme")
    if scheme == "http":
        host = (parsed.hostname or "").lower()
        if host not in _LOOPBACK_HOSTS:
            raise ValueError("Plain HTTP redirect_uri is only allowed for loopback hosts")
        if parsed.port is not None and not (1 <= parsed.port <= 65535):
            raise ValueError("Invalid loopback port")
        return cleaned
    if scheme == "https":
        if not parsed.hostname:
            raise ValueError("HTTPS redirect_uri requires a hostname")
        return cleaned
    if not _CUSTOM_SCHEME_RE.match(scheme):
        raise ValueError("Invalid custom redirect_uri scheme")
    return cleaned


def redirect_uri_matches_registered(requested: str, registered_list: list[str]) -> bool:
    try:
        validate_redirect_uri(requested)
    except ValueError:
        return False
    if requested in registered_list:
        return True
    req = urlsplit(requested)
    req_scheme = (req.scheme or "").lower()
    req_host = (req.hostname or "").lower()
    if req_scheme == "http" and req_host in _LOOPBACK_HOSTS:
        for reg_raw in registered_list:
            reg = urlsplit(reg_raw)
            if (
                (reg.scheme or "").lower() == "http"
                and (reg.hostname or "").lower() == req_host
                and (reg.path or "/") == (req.path or "/")
                and reg.port is None
            ):
                return True
    return False


def _validate_resource_indicator(resource: str | None, origin: str) -> str | None:
    if resource is None or not resource.strip():
        return None
    cleaned = resource.strip().rstrip("/")
    allowed = {origin.rstrip("/"), mcp_resource_url(origin).rstrip("/")}
    if cleaned not in allowed:
        raise ValueError("Invalid resource indicator for this MCP server")
    return mcp_resource_url(origin)


def _normalize_requested_scopes(raw_scope: str | None) -> list[str]:
    if not raw_scope or not raw_scope.strip():
        return ["mcp:read"]
    tokens = [tok.strip() for tok in raw_scope.split() if tok.strip()]
    recognized = [tok for tok in tokens if tok in MCP_SCOPES]
    ignored_oidc = {"openid", "profile", "email", "offline_access"}
    unknown = [tok for tok in tokens if tok not in MCP_SCOPES and tok not in ignored_oidc]
    if unknown:
        raise ValueError(f"Unsupported scope: {unknown[0]}")
    return recognized or ["mcp:read"]


def _redirect_with_params(redirect_uri: str, params: dict[str, str]) -> RedirectResponse:
    parsed = urlsplit(redirect_uri)
    existing = parsed.query
    added = urlencode(params)
    combined = f"{existing}&{added}" if existing else added
    target = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, combined, ""))
    return RedirectResponse(target, status_code=302, headers={"Cache-Control": "no-store"})


def oauth_error_json(
    error: str,
    description: str,
    *,
    status_code: int = 400,
) -> JSONResponse:
    return JSONResponse(
        {"error": error, "error_description": description},
        status_code=status_code,
        headers=cors_oauth_headers(),
    )


def register_oauth_client(
    db: Session, payload: dict, *, client_ip: str | None = None
) -> tuple[int, dict]:
    if client_ip:
        now_mono = time.monotonic()
        with _REGISTER_RATE_LOCK:
            bucket = [
                ts
                for ts in _REGISTER_RATE_BUCKETS.get(client_ip, [])
                if now_mono - ts < _REGISTER_RATE_WINDOW_SEC
            ]
            if len(bucket) >= _REGISTER_RATE_MAX_PER_IP:
                _REGISTER_RATE_BUCKETS[client_ip] = bucket
                return 429, {
                    "error": "slow_down",
                    "error_description": "Too many dynamic client registrations from this IP",
                }
            bucket.append(now_mono)
            _REGISTER_RATE_BUCKETS[client_ip] = bucket
            if len(_REGISTER_RATE_BUCKETS) > 1024:
                stale_keys = [
                    key
                    for key, stamps in _REGISTER_RATE_BUCKETS.items()
                    if not stamps or (now_mono - stamps[-1]) >= _REGISTER_RATE_WINDOW_SEC
                ]
                for key in stale_keys:
                    _REGISTER_RATE_BUCKETS.pop(key, None)
                if len(_REGISTER_RATE_BUCKETS) > 1024:
                    excess = len(_REGISTER_RATE_BUCKETS) - 1024
                    oldest_keys = sorted(
                        _REGISTER_RATE_BUCKETS,
                        key=lambda key: _REGISTER_RATE_BUCKETS[key][-1],
                    )[:excess]
                    for key in oldest_keys:
                        _REGISTER_RATE_BUCKETS.pop(key, None)

    raw_uris = payload.get("redirect_uris")
    if not isinstance(raw_uris, list) or not raw_uris or len(raw_uris) > 16:
        return 400, {
            "error": "invalid_redirect_uri",
            "error_description": "redirect_uris must be a non-empty array (max 16)",
        }
    validated_uris: list[str] = []
    for item in raw_uris:
        try:
            uri = validate_redirect_uri(item)
        except ValueError:
            return 400, {
                "error": "invalid_redirect_uri",
                "error_description": "Invalid redirect_uri",
            }
        if uri not in validated_uris:
            validated_uris.append(uri)

    auth_method = str(payload.get("token_endpoint_auth_method") or "none").strip()
    if auth_method not in ("none", "client_secret_post", "client_secret_basic"):
        return 400, {
            "error": "invalid_client_metadata",
            "error_description": "Unsupported token_endpoint_auth_method",
        }

    client_name = " ".join(str(payload.get("client_name") or "MCP Client").split())[:200]
    if not client_name:
        client_name = "MCP Client"

    client_uri_raw = payload.get("client_uri")
    client_uri: str | None = None
    if isinstance(client_uri_raw, str) and client_uri_raw.strip():
        parsed_uri = urlsplit(client_uri_raw.strip())
        if parsed_uri.scheme in ("http", "https") and parsed_uri.hostname:
            client_uri = client_uri_raw.strip()[:512]

    client_id = f"{CLIENT_ID_PREFIX}{secrets.token_hex(16)}"
    raw_secret: str | None = None
    secret_hash: str | None = None
    if auth_method in ("client_secret_post", "client_secret_basic"):
        raw_secret = f"wortlaut-mcp-cs-{secrets.token_urlsafe(32)}"
        secret_hash = _token_hash(raw_secret)

    now = datetime.now(UTC)
    total_clients = db.scalar(select(func.count()).select_from(McpOAuthClient)) or 0
    if total_clients >= _MAX_OAUTH_CLIENTS:
        referenced_grants = select(McpOAuthGrant.client_id)
        referenced_auths = select(McpOAuthAuthorization.client_id)
        stale_ids = db.scalars(
            select(McpOAuthClient.client_id)
            .where(
                McpOAuthClient.client_id.not_in(referenced_grants),
                McpOAuthClient.client_id.not_in(referenced_auths),
            )
            .order_by(McpOAuthClient.created_at.asc())
            .limit(max(16, total_clients - _MAX_OAUTH_CLIENTS + 1))
        ).all()
        if stale_ids:
            db.execute(delete(McpOAuthClient).where(McpOAuthClient.client_id.in_(stale_ids)))
        else:
            return 429, {
                "error": "temporarily_unavailable",
                "error_description": "Registered OAuth client capacity reached",
            }

    client = McpOAuthClient(
        client_id=client_id,
        client_secret_hash=secret_hash,
        client_name=client_name,
        client_uri=client_uri,
        redirect_uris=validated_uris,
        token_endpoint_auth_method=auth_method,
        created_at=now,
    )
    db.add(client)
    db.commit()

    response_data: dict = {
        "client_id": client_id,
        "client_id_issued_at": int(now.timestamp()),
        "client_name": client_name,
        "redirect_uris": validated_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": auth_method,
    }
    if client_uri:
        response_data["client_uri"] = client_uri
    if raw_secret:
        response_data["client_secret"] = raw_secret
        response_data["client_secret_expires_at"] = 0
    return 201, response_data


def _set_consent_cookie(response: Response, auth_id: uuid.UUID, origin: str) -> None:
    raw_id = str(auth_id)
    sig = _hmac_tag(b"mcp-consent-cookie", raw_id)
    response.set_cookie(
        key=CONSENT_COOKIE_NAME,
        value=f"{raw_id}.{sig}",
        max_age=AUTH_FLOW_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=origin.startswith("https://"),
        path="/",
    )


def _verify_consent_cookie(request: Request, auth_id: uuid.UUID) -> bool:
    cookie_val = request.cookies.get(CONSENT_COOKIE_NAME) or ""
    if "." not in cookie_val:
        return False
    raw_id, sig = cookie_val.rsplit(".", 1)
    if raw_id != str(auth_id):
        return False
    expected = _hmac_tag(b"mcp-consent-cookie", raw_id)
    return secrets.compare_digest(sig, expected)


def _render_consent_html(
    *,
    auth_row: McpOAuthAuthorization,
    client: McpOAuthClient,
    require_local_token: bool,
    error_message: str | None = None,
) -> str:
    settings = get_settings()
    is_en = settings.default_locale == "en"
    parsed_cb = urlsplit(auth_row.redirect_uri)
    cb_display = f"{parsed_cb.scheme}://{parsed_cb.netloc or parsed_cb.path}"
    assistant = html.escape(settings.assistant_name)
    client_name = html.escape(client.client_name)
    cb_escaped = html.escape(cb_display)
    user_label = html.escape(
        f"{auth_row.user_name or ''} ({auth_row.user_email})".strip()
        if auth_row.user_email
        else "Operator"
    )
    req_scopes = set(auth_row.requested_scopes or MCP_SCOPES)
    has_write_requested = "mcp:write" in req_scopes

    title = (
        f"Authorize MCP Access – {assistant}"
        if is_en
        else f"MCP-Zugriff autorisieren – {assistant}"
    )
    heading = (
        f"Connect {client_name} to {assistant}?"
        if is_en
        else f"{client_name} mit {assistant} verbinden?"
    )
    subtitle = (
        "This AI / MCP client is requesting authenticated access to your meetings."
        if is_en
        else (
            "Dieser KI- bzw. MCP-Client bittet um authentifizierten Zugriff auf Ihre Besprechungen."
        )
    )
    signed_in_label = "Signed in as" if is_en else "Angemeldet als"
    callback_label = "Client callback" if is_en else "Client-Rücksprungziel"
    read_title = (
        "Read meetings, speaker transcripts & calendar (mcp:read)"
        if is_en
        else "Aufnahmen, Sprecher-Transkripte & Kalender lesen (mcp:read)"
    )
    read_desc = (
        "Search your accessible recordings, read verbatim transcripts, summaries, "
        "exports, and upcoming calendar events."
        if is_en
        else (
            "Eigene und freigegebene Aufnahmen durchsuchen, Wortprotokolle, "
            "Zusammenfassungen, Exporte und Kalendertermine lesen."
        )
    )
    write_title = (
        "Schedule recordings & edit protocols (mcp:write)"
        if is_en
        else "Aufnahmen planen & Protokolle bearbeiten (mcp:write)"
    )
    write_desc = (
        "Start or cancel recordings, update speaker names/glossary, generate summaries, "
        "and toggle calendar auto-recording."
        if is_en
        else (
            "Aufnahmen starten oder stoppen, Sprechernamen/Glossar pflegen, "
            "Zusammenfassungen erzeugen und Kalender-Aufnahmen umschalten."
        )
    )
    token_label = (
        "Instance API key or session token"
        if is_en
        else "Instanz-API-Schlüssel oder Sitzungs-Token"
    )
    token_placeholder = (
        "Paste WORTLAUT_API_TOKEN (OIDC is not enabled on this instance)"
        if is_en
        else "WORTLAUT_API_TOKEN eingeben (OIDC ist auf dieser Instanz nicht aktiviert)"
    )
    allow_label = "Authorize client" if is_en else "Zugriff erlauben"
    deny_label = "Cancel" if is_en else "Abbrechen"
    revoke_hint = (
        "You can review and revoke connected MCP clients at any time in the wortlaut "
        "Web-UI under “MCP & AI Clients”."
        if is_en
        else (
            "Verbundene MCP-Clients können jederzeit in der wortlaut Web-UI unter "
            "„MCP & KI-Clients“ eingesehen und widerrufen werden."
        )
    )

    write_scope_block = (
        f"""
      <label class="scope-item">
        <input type="checkbox" name="scopes" value="mcp:write">
        <span>
          <span class="scope-title">{write_title}</span>
          <span class="scope-desc">{write_desc}</span>
        </span>
      </label>"""
        if has_write_requested
        else ""
    )
    err_block = f'<div class="err-box">{html.escape(error_message)}</div>' if error_message else ""
    user_or_token_block = (
        f"""
        <div class="field-group">
          <label for="operator_token">{token_label}</label>
          <input id="operator_token" name="operator_token" type="password" required
                 autocomplete="off" placeholder="{token_placeholder}">
        </div>
        """
        if require_local_token
        else f"""
        <div class="meta-row">
          <span class="meta-key">{signed_in_label}</span>
          <span class="meta-val">{user_label}</span>
        </div>
        """
    )

    return f"""<!DOCTYPE html>
<html lang="{"en" if is_en else "de"}" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <link rel="icon" type="image/svg+xml" href="{FAVICON_DATA_URI}">
  <style>
    :root {{
      color-scheme: light dark;
      --bg: light-dark(#fafaf9, #111113);
      --surface: light-dark(#ffffff, #18181b);
      --muted-bg: light-dark(#f5f5f4, #222226);
      --border: light-dark(#e7e5e4, #27272a);
      --text: light-dark(#1c1917, #fafaf9);
      --muted: light-dark(#57534e, #a8a29e);
      --accent: light-dark(#047857, #10b981);
      --accent-fg: light-dark(#ffffff, #052e16);
      --accent-hover: light-dark(#065f46, #34d399);
      --emerald-ink: light-dark(#047857, #34d399);
      --emerald-bg: light-dark(rgba(5, 150, 105, 0.09), rgba(16, 185, 129, 0.12));
      --emerald-border: light-dark(rgba(5, 150, 105, 0.28), rgba(16, 185, 129, 0.32));
      --danger-bg: light-dark(#fef2f2, rgba(239, 68, 68, 0.12));
      --danger-border: light-dark(#fecaca, rgba(239, 68, 68, 0.36));
      --danger-text: light-dark(#991b1b, #fca5a5);
    }}
    html[data-theme="light"] {{ color-scheme: light; }}
    html[data-theme="dark"] {{ color-scheme: dark; }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }}
    .card {{
      width: 100%;
      max-width: 520px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }}
    .card-top {{
      padding: 14px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }}
    .brand {{
      display: inline-flex;
      align-items: center;
      gap: 9px;
      font-size: 13.5px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text);
    }}
    .brand-mark {{
      width: 26px;
      height: 26px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--emerald-bg);
      border: 1px solid var(--emerald-border);
      color: var(--emerald-ink);
    }}
    .proto-pill {{
      display: inline-block;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--muted);
      background: var(--muted-bg);
      border: 1px solid var(--border);
      padding: 2px 9px;
      border-radius: 999px;
    }}
    .card-body {{
      padding: 24px;
    }}
    h1 {{
      margin: 0 0 6px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.28;
    }}
    .sub {{ margin: 0 0 18px; font-size: 13.5px; color: var(--muted); }}
    .meta-box {{
      background: var(--muted-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 11px 14px;
      margin-bottom: 16px;
      font-size: 12.5px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }}
    .meta-row {{ display: flex; justify-content: space-between; gap: 12px; }}
    .meta-key {{ color: var(--muted); flex-shrink: 0; }}
    .meta-val {{
      font-weight: 600;
      text-align: right;
      overflow-wrap: anywhere;
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', ui-monospace, monospace;
      font-size: 13px;
    }}
    .scope-item {{
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 10px;
      cursor: pointer;
    }}
    .scope-item input {{
      margin-top: 3px;
      accent-color: var(--accent);
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }}
    .scope-title {{ font-size: 13.5px; font-weight: 600; display: block; }}
    .scope-desc {{ font-size: 12.5px; color: var(--muted); display: block; margin-top: 2px; }}
    .field-group {{ margin-bottom: 16px; }}
    .field-group label {{ display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }}
    .field-group input {{
      width: 100%;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 13.5px;
    }}
    .field-group input:focus-visible {{
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }}
    .err-box {{
      background: var(--danger-bg);
      border: 1px solid var(--danger-border);
      color: var(--danger-text);
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
    }}
    .actions {{ display: flex; gap: 10px; margin-top: 20px; }}
    button {{
      flex: 1;
      padding: 9px 16px;
      border-radius: 999px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      transition: background 0.15s ease;
    }}
    .btn-primary {{
      background: var(--accent);
      color: var(--accent-fg);
      border-color: transparent;
    }}
    .btn-primary:hover {{ background: var(--accent-hover); }}
    .btn-secondary {{ background: transparent; color: var(--text); }}
    .btn-secondary:hover {{ background: var(--muted-bg); }}
    .hint {{ margin: 16px 0 0; font-size: 12px; color: var(--muted); text-align: center; }}
  </style>
  <script>
    (function () {{
      try {{
        var m = localStorage.getItem('wortlaut-theme-mode');
        var sys = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var dark = m === 'dark' || (m !== 'light' && sys);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      }} catch (e) {{}}
    }})();
  </script>
</head>
<body>
  <main class="card">
    <div class="card-top">
      <span class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round">
            <path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/>
            <path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>
          </svg>
        </span>
        <span>Wortlaut.cloud</span>
      </span>
      <span class="proto-pill">MCP · OAuth 2.1</span>
    </div>
    <div class="card-body">
      <h1>{heading}</h1>
      <p class="sub">{subtitle}</p>
      {err_block}
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="auth_id" value="{auth_row.id}">
        <input type="hidden" name="csrf_token" value="{html.escape(auth_row.csrf_token)}">
        <div class="meta-box">
          <div class="meta-row">
            <span class="meta-key">{callback_label}</span>
            <span class="meta-val">{cb_escaped}</span>
          </div>
          {user_or_token_block if not require_local_token else ""}
        </div>
        {user_or_token_block if require_local_token else ""}
        <label class="scope-item">
          <input type="checkbox" name="scopes" value="mcp:read" checked disabled>
          <input type="hidden" name="scopes" value="mcp:read">
          <span>
            <span class="scope-title">{read_title}</span>
            <span class="scope-desc">{read_desc}</span>
          </span>
        </label>{write_scope_block}
        <div class="actions">
          <button type="submit" name="decision" value="deny" class="btn-secondary" formnovalidate>
            {deny_label}
          </button>
          <button type="submit" name="decision" value="allow" class="btn-primary">
            {allow_label}
          </button>
        </div>
      </form>
      <p class="hint">{revoke_hint}</p>
    </div>
  </main>
</body>
</html>"""


def _build_mcp_oidc_redirect(
    *,
    provider: OidcProviderConfig,
    auth_row: McpOAuthAuthorization,
    origin: str,
) -> RedirectResponse:
    if not auth_row.upstream_verifier or not auth_row.upstream_nonce:
        raise ValueError("MCP OIDC authorization row is missing PKCE verifier or nonce")
    state_payload = f"{provider.id}.{auth_row.id}"
    state_sig = _hmac_tag(b"mcp-oidc-state", state_payload)
    oidc_params = {
        "client_id": provider.client_id,
        "redirect_uri": f"{origin}/auth/callback",
        "response_type": "code",
        "scope": "openid profile email",
        "state": f"mcp.{provider.id}.{auth_row.id}.{state_sig}",
        "nonce": auth_row.upstream_nonce,
        "code_challenge": _pkce_s256(auth_row.upstream_verifier),
        "code_challenge_method": "S256",
        **provider_extra_auth_params(provider),
    }
    auth_ep = get_provider_authorization_endpoint(provider)
    sep = "&" if "?" in auth_ep else "?"
    return RedirectResponse(
        f"{auth_ep}{sep}{urlencode(oidc_params)}",
        status_code=302,
        headers={"Cache-Control": "no-store"},
    )


def _render_provider_chooser_html(
    *,
    auth_row: McpOAuthAuthorization,
    client: McpOAuthClient,
    providers: list[OidcProviderConfig],
) -> str:
    settings = get_settings()
    is_en = settings.default_locale == "en"
    assistant = html.escape(settings.assistant_name)
    client_name = html.escape(client.client_name)
    title = f"Sign in – {assistant}" if is_en else f"Anmelden – {assistant}"
    heading = (
        f"Sign in to connect {client_name}" if is_en else f"Anmelden, um {client_name} zu verbinden"
    )
    subtitle = (
        "Choose your identity provider to continue."
        if is_en
        else "Wählen Sie einen Anmeldeanbieter aus, um fortzufahren."
    )
    buttons = []
    for idx, p in enumerate(providers):
        href = f"/oauth/login?{urlencode({'auth_id': str(auth_row.id), 'provider': p.id})}"
        label = f"Sign in with {p.label}" if is_en else f"Mit {p.label} anmelden"
        cls = "btn btn-primary" if idx == 0 else "btn btn-secondary"
        buttons.append(
            f'<a class="{cls}" href="{html.escape(href, quote=True)}">{html.escape(label)}</a>'
        )
    buttons_html = "\n      ".join(buttons)
    return f"""<!DOCTYPE html>
<html lang="{"en" if is_en else "de"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <link rel="icon" href="{FAVICON_DATA_URI}" />
  <title>{title}</title>
  <style>
    :root {{ color-scheme: dark light; }}
    body {{
      margin: 0; font-family: system-ui, -apple-system, sans-serif;
      background: #101018; color: #f0f0f9; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }}
    @media (prefers-color-scheme: light) {{
      body {{ background: #f0f0f7; color: #25252a; }}
      .card {{ background: #ffffff; border-color: rgba(37,37,42,0.12); }}
      .muted {{ color: #646472; }}
      .btn-secondary {{ background: #f4f4f8; color: #25252a; border-color: rgba(37,37,42,0.14); }}
    }}
    .card {{
      width: 100%; max-width: 420px; background: #1b1b21;
      border: 1px solid rgba(240,240,249,0.12); border-radius: 14px; padding: 28px;
      box-sizing: border-box;
    }}
    h1 {{ margin: 0 0 8px; font-size: 1.25rem; font-weight: 600; }}
    .muted {{ margin: 0 0 20px; font-size: 0.92rem; color: #a1a1b5; line-height: 1.45; }}
    .stack {{ display: flex; flex-direction: column; gap: 10px; }}
    .btn {{
      display: block; text-align: center; text-decoration: none; font-weight: 600;
      font-size: 0.95rem; padding: 11px 16px; border-radius: 999px;
      border: 1px solid transparent; transition: opacity .15s;
    }}
    .btn:hover {{ opacity: 0.9; }}
    .btn-primary {{ background: #10b981; color: #052e16; }}
    .btn-secondary {{
      background: #252530; color: #f0f0f9; border-color: rgba(240,240,249,0.16);
    }}
  </style>
</head>
<body>
  <main class="card">
    <h1>{heading}</h1>
    <p class="muted">{subtitle}</p>
    <div class="stack">
      {buttons_html}
    </div>
  </main>
</body>
</html>"""


def select_mcp_oidc_provider(
    request: Request,
    db: Session,
    *,
    auth_id_raw: str,
    provider_id: AuthProviderId,
) -> Response:
    try:
        auth_id = uuid.UUID(auth_id_raw)
    except ValueError:
        raise HTTPException(400, "Invalid authorization session id") from None
    now = datetime.now(UTC)
    auth_row = db.scalar(select(McpOAuthAuthorization).where(McpOAuthAuthorization.id == auth_id))
    if (
        auth_row is None
        or auth_row.expires_at <= now
        or auth_row.code_hash is not None
        or not auth_row.upstream_verifier
        or not auth_row.upstream_nonce
        or not _verify_consent_cookie(request, auth_id)
    ):
        raise HTTPException(400, "MCP authorization session expired or invalid browser binding")
    provider = get_auth_provider(provider_id)
    return _build_mcp_oidc_redirect(
        provider=provider,
        auth_row=auth_row,
        origin=public_origin(request),
    )


def start_oauth_authorization(
    request: Request,
    db: Session,
    *,
    response_type: str | None,
    client_id: str | None,
    redirect_uri: str | None,
    code_challenge: str | None,
    code_challenge_method: str | None,
    state: str | None,
    scope: str | None,
    resource: str | None,
) -> Response:
    if not client_id or not redirect_uri:
        raise HTTPException(400, "Missing client_id or redirect_uri")
    client = db.get(McpOAuthClient, client_id)
    if client is None or not redirect_uri_matches_registered(redirect_uri, client.redirect_uris):
        raise HTTPException(400, "Unregistered client_id or redirect_uri")

    def _redirect_err(err: str, desc: str) -> RedirectResponse:
        params: dict[str, str] = {"error": err, "error_description": desc}
        if state:
            params["state"] = state
        return _redirect_with_params(redirect_uri, params)

    if response_type != "code":
        return _redirect_err("unsupported_response_type", "Only response_type=code is supported")
    if (
        code_challenge_method != "S256"
        or not code_challenge
        or not _PKCE_CHALLENGE_RE.match(code_challenge)
    ):
        return _redirect_err(
            "invalid_request", "PKCE S256 code_challenge (43-128 chars) is required"
        )

    origin = public_origin(request)
    try:
        validated_resource = _validate_resource_indicator(resource, origin)
    except ValueError:
        return _redirect_err("invalid_target", "Invalid resource indicator")

    try:
        requested_scopes = _normalize_requested_scopes(scope)
    except ValueError:
        return _redirect_err("invalid_scope", "Invalid OAuth scope")

    now = datetime.now(UTC)
    auth_providers = get_configured_auth_providers()
    upstream_verifier = _b64url_encode(secrets.token_bytes(32)) if auth_providers else None
    upstream_nonce = _b64url_encode(secrets.token_bytes(16)) if auth_providers else None

    auth_row = McpOAuthAuthorization(
        id=uuid.uuid4(),
        client_id=client.client_id,
        redirect_uri=redirect_uri,
        client_state=state[:512] if state else None,
        code_challenge=code_challenge,
        requested_scopes=requested_scopes,
        granted_scopes=[],
        resource=validated_resource or mcp_resource_url(origin),
        upstream_verifier=upstream_verifier,
        upstream_nonce=upstream_nonce,
        csrf_token=secrets.token_hex(32),
        expires_at=now + timedelta(seconds=AUTH_FLOW_TTL_SECONDS),
        created_at=now,
    )
    db.add(auth_row)
    db.commit()

    if len(auth_providers) == 1 and upstream_verifier and upstream_nonce:
        resp: Response = _build_mcp_oidc_redirect(
            provider=auth_providers[0],
            auth_row=auth_row,
            origin=origin,
        )
        _set_consent_cookie(resp, auth_row.id, origin)
        return resp

    if len(auth_providers) > 1 and upstream_verifier and upstream_nonce:
        chooser_html = _render_provider_chooser_html(
            auth_row=auth_row,
            client=client,
            providers=auth_providers,
        )
        resp = HTMLResponse(chooser_html, headers={"Cache-Control": "no-store"})
        _set_consent_cookie(resp, auth_row.id, origin)
        return resp

    html_body = _render_consent_html(
        auth_row=auth_row,
        client=client,
        require_local_token=True,
    )
    resp = HTMLResponse(html_body, headers={"Cache-Control": "no-store"})
    _set_consent_cookie(resp, auth_row.id, origin)
    return resp


def is_mcp_oidc_callback(request: Request) -> bool:
    state = request.query_params.get("state") or ""
    return state.startswith("mcp.")


def handle_mcp_oidc_callback(request: Request, db: Session) -> Response:
    raw_state = request.query_params.get("state") or ""
    parts = raw_state.split(".")
    provider_id: AuthProviderId
    if len(parts) == 4 and parts[0] == "mcp" and parts[1] in ("oidc", "google", "entra"):
        _, raw_provider, raw_id, sig = parts
        provider_id = raw_provider  # type: ignore[assignment]
        expected_sig = _hmac_tag(b"mcp-oidc-state", f"{provider_id}.{raw_id}")
    elif len(parts) == 3 and parts[0] == "mcp":
        _, raw_id, sig = parts
        provider_id = "oidc"
        expected_sig = _hmac_tag(b"mcp-oidc-state", raw_id)
    else:
        raise HTTPException(400, "Invalid MCP OAuth callback state")
    if not secrets.compare_digest(sig, expected_sig):
        raise HTTPException(400, "Invalid MCP OAuth state signature")
    try:
        auth_id = uuid.UUID(raw_id)
    except ValueError:
        raise HTTPException(400, "Malformed MCP OAuth state identifier") from None

    now = datetime.now(UTC)
    auth_row = db.scalar(
        select(McpOAuthAuthorization).where(McpOAuthAuthorization.id == auth_id).with_for_update()
    )
    if (
        auth_row is None
        or auth_row.expires_at <= now
        or auth_row.code_hash is not None
        or not _verify_consent_cookie(request, auth_id)
    ):
        raise HTTPException(400, "MCP authorization session expired or invalid browser binding")

    client = db.get(McpOAuthClient, auth_row.client_id)
    if client is None:
        raise HTTPException(400, "MCP client no longer exists")

    upstream_err = request.query_params.get("error")
    if upstream_err:
        db.delete(auth_row)
        db.commit()
        params = {"error": "access_denied", "error_description": "Upstream OIDC login cancelled"}
        if auth_row.client_state:
            params["state"] = auth_row.client_state
        return _redirect_with_params(auth_row.redirect_uri, params)

    code = request.query_params.get("code") or ""
    if not code or not auth_row.upstream_verifier:
        raise HTTPException(400, "Missing OIDC authorization code")

    origin = public_origin(request)
    provider = get_auth_provider(provider_id)
    claims = exchange_provider_token_for_claims(
        provider=provider,
        code=code,
        code_verifier=auth_row.upstream_verifier,
        redirect_uri=f"{origin}/auth/callback",
        nonce=auth_row.upstream_nonce,
    )
    clean_email = claims["email"].strip().lower()
    auth_row.user_sub = claims["sub"]
    auth_row.user_email = clean_email
    auth_row.user_name = (
        claims.get("name") or claims.get("preferred_username") or clean_email.split("@", 1)[0]
    )[:200]
    auth_row.upstream_verifier = None
    db.commit()

    html_body = _render_consent_html(
        auth_row=auth_row,
        client=client,
        require_local_token=False,
    )
    return HTMLResponse(html_body, headers={"Cache-Control": "no-store"})


def submit_oauth_consent(
    request: Request,
    db: Session,
    *,
    auth_id_raw: str,
    csrf_token: str,
    decision: str,
    selected_scopes: list[str],
    operator_token: str | None = None,
) -> Response:
    try:
        auth_id = uuid.UUID(auth_id_raw)
    except ValueError:
        raise HTTPException(400, "Invalid authorization identifier") from None

    now = datetime.now(UTC)
    auth_row = db.scalar(
        select(McpOAuthAuthorization).where(McpOAuthAuthorization.id == auth_id).with_for_update()
    )
    if (
        auth_row is None
        or auth_row.expires_at <= now
        or auth_row.code_hash is not None
        or not _verify_consent_cookie(request, auth_id)
        or not secrets.compare_digest(csrf_token or "", auth_row.csrf_token)
    ):
        raise HTTPException(400, "Authorization session expired or invalid CSRF token")

    client = db.get(McpOAuthClient, auth_row.client_id)
    if client is None:
        raise HTTPException(400, "MCP client not found")

    if decision != "allow":
        redirect_uri = auth_row.redirect_uri
        client_state = auth_row.client_state
        db.delete(auth_row)
        db.commit()
        params = {"error": "access_denied", "error_description": "User denied authorization"}
        if client_state:
            params["state"] = client_state
        resp = _redirect_with_params(redirect_uri, params)
        resp.delete_cookie(CONSENT_COOKIE_NAME, path="/")
        return resp

    settings = get_settings()
    if not auth_row.user_email and not auth_row.is_operator:
        if has_any_auth_provider():
            raise HTTPException(401, "OIDC authentication has not completed")
        supplied = (operator_token or "").strip()
        expected_api = settings.api_token.get_secret_value()
        if supplied and secrets.compare_digest(
            supplied.encode("utf-8"), expected_api.encode("utf-8")
        ):
            auth_row.is_operator = True
            auth_row.user_name = "Operator"
        else:
            session_principal = verify_user_session_token(supplied) if supplied else None
            if session_principal is not None and session_principal.email:
                auth_row.user_sub = session_principal.sub
                auth_row.user_email = session_principal.email
                auth_row.user_name = session_principal.name
            else:
                html_body = _render_consent_html(
                    auth_row=auth_row,
                    client=client,
                    require_local_token=True,
                    error_message=(
                        "Invalid API key or session token."
                        if settings.default_locale == "en"
                        else "Ungültiger API-Schlüssel oder Sitzungs-Token."
                    ),
                )
                return HTMLResponse(
                    html_body, status_code=401, headers={"Cache-Control": "no-store"}
                )

    allowed_requested = set(auth_row.requested_scopes or ["mcp:read"])
    granted = ["mcp:read"]
    if "mcp:write" in selected_scopes and "mcp:write" in allowed_requested:
        granted.append("mcp:write")

    raw_code = f"wortlaut-mcp-code-{secrets.token_urlsafe(32)}"
    auth_row.granted_scopes = granted
    auth_row.code_hash = _token_hash(raw_code)
    auth_row.code_expires_at = now + timedelta(seconds=AUTH_CODE_TTL_SECONDS)
    db.commit()

    params = {"code": raw_code}
    if auth_row.client_state:
        params["state"] = auth_row.client_state
    resp = _redirect_with_params(auth_row.redirect_uri, params)
    resp.delete_cookie(CONSENT_COOKIE_NAME, path="/")
    return resp


def _extract_basic_client_credentials(request: Request) -> tuple[str | None, str | None]:
    auth_header = request.headers.get("authorization") or ""
    if not auth_header.lower().startswith("basic "):
        return None, None
    try:
        decoded = base64.b64decode(auth_header[6:].strip()).decode("utf-8")
    except ValueError, UnicodeDecodeError:
        return None, None
    if ":" not in decoded:
        return None, None
    cid, csec = decoded.split(":", 1)
    return cid, csec


def _verify_client_authentication(
    request: Request,
    db: Session,
    form_client_id: str | None,
    form_client_secret: str | None,
) -> McpOAuthClient | None:
    basic_id, basic_secret = _extract_basic_client_credentials(request)
    client_id = form_client_id or basic_id
    if not client_id:
        return None
    client = db.get(McpOAuthClient, client_id)
    if client is None:
        return None
    if client.token_endpoint_auth_method == "none":  # noqa: S105
        return client
    supplied_secret = (
        basic_secret
        if client.token_endpoint_auth_method == "client_secret_basic"  # noqa: S105
        else (form_client_secret or basic_secret)
    )
    if not supplied_secret or not client.client_secret_hash:
        return None
    if not secrets.compare_digest(_token_hash(supplied_secret), client.client_secret_hash):
        return None
    return client


def exchange_oauth_token(
    request: Request,
    db: Session,
    params: dict[str, str],
) -> JSONResponse:
    grant_type = (params.get("grant_type") or "").strip()
    client = _verify_client_authentication(
        request,
        db,
        params.get("client_id"),
        params.get("client_secret"),
    )
    if client is None:
        return oauth_error_json(
            "invalid_client", "Invalid client_id or client credentials", status_code=401
        )

    origin = public_origin(request)
    try:
        requested_resource = _validate_resource_indicator(params.get("resource"), origin)
    except ValueError:
        return oauth_error_json("invalid_target", "Invalid resource indicator", status_code=400)

    now = datetime.now(UTC)

    if grant_type == "authorization_code":
        raw_code = (params.get("code") or "").strip()
        code_verifier = (params.get("code_verifier") or "").strip()
        redirect_uri = (params.get("redirect_uri") or "").strip()
        if not raw_code or not code_verifier or not redirect_uri:
            return oauth_error_json(
                "invalid_request", "code, redirect_uri, and code_verifier are required"
            )
        if not (43 <= len(code_verifier) <= 128):
            return oauth_error_json("invalid_grant", "Invalid PKCE code_verifier length")

        code_digest = _token_hash(raw_code)
        auth_row = db.scalar(
            select(McpOAuthAuthorization)
            .where(McpOAuthAuthorization.code_hash == code_digest)
            .with_for_update()
        )
        if auth_row is None or auth_row.client_id != client.client_id:
            return oauth_error_json("invalid_grant", "Invalid authorization code")

        if auth_row.consumed_at is not None:
            if auth_row.grant_id is not None:
                prior_grant = db.scalar(
                    select(McpOAuthGrant)
                    .where(McpOAuthGrant.id == auth_row.grant_id)
                    .with_for_update()
                )
                if prior_grant is not None and prior_grant.revoked_at is None:
                    prior_grant.revoked_at = now
                db.commit()
            return oauth_error_json("invalid_grant", "Authorization code has already been used")

        if auth_row.code_expires_at is None or auth_row.code_expires_at <= now:
            return oauth_error_json("invalid_grant", "Authorization code expired")

        if auth_row.redirect_uri != redirect_uri:
            return oauth_error_json("invalid_grant", "redirect_uri mismatch")

        try:
            computed_challenge = _pkce_s256(code_verifier)
        except UnicodeEncodeError:
            return oauth_error_json("invalid_grant", "Invalid PKCE code_verifier encoding")

        if not secrets.compare_digest(computed_challenge, auth_row.code_challenge):
            return oauth_error_json("invalid_grant", "PKCE verification failed")

        if not auth_row.is_operator and not is_allowed_user_email(auth_row.user_email):
            return oauth_error_json("invalid_grant", "User is no longer authorized")

        raw_access = f"{ACCESS_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
        raw_refresh = f"{REFRESH_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
        scopes = list(auth_row.granted_scopes or ["mcp:read"])
        grant = McpOAuthGrant(
            id=uuid.uuid4(),
            client_id=client.client_id,
            client_name=client.client_name,
            owner_sub=auth_row.user_sub,
            owner_email=auth_row.user_email,
            owner_name=auth_row.user_name,
            is_operator=auth_row.is_operator,
            scopes=scopes,
            resource=requested_resource or auth_row.resource or mcp_resource_url(origin),
            access_token_hash=_token_hash(raw_access),
            access_expires_at=now + timedelta(seconds=ACCESS_TOKEN_TTL_SECONDS),
            refresh_token_hash=_token_hash(raw_refresh),
            refresh_expires_at=now + timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS),
            last_used_at=now,
            created_at=now,
        )
        db.add(grant)
        auth_row.consumed_at = now
        auth_row.grant_id = grant.id
        db.commit()

        return JSONResponse(
            {
                "access_token": raw_access,
                "token_type": "Bearer",
                "expires_in": ACCESS_TOKEN_TTL_SECONDS,
                "refresh_token": raw_refresh,
                "scope": " ".join(scopes),
            },
            headers=cors_oauth_headers(),
        )

    if grant_type == "refresh_token":
        raw_refresh = (params.get("refresh_token") or "").strip()
        if not raw_refresh.startswith(REFRESH_TOKEN_PREFIX):
            return oauth_error_json("invalid_grant", "Invalid refresh_token")
        grant = db.scalar(
            select(McpOAuthGrant)
            .where(McpOAuthGrant.refresh_token_hash == _token_hash(raw_refresh))
            .with_for_update()
        )
        if (
            grant is None
            or grant.client_id != client.client_id
            or grant.revoked_at is not None
            or grant.refresh_expires_at <= now
        ):
            return oauth_error_json("invalid_grant", "Refresh token expired or revoked")

        if not grant.is_operator and not is_allowed_user_email(grant.owner_email):
            grant.revoked_at = now
            db.commit()
            return oauth_error_json("invalid_grant", "User access revoked")

        granted_set = set(grant.scopes or ["mcp:read"])
        raw_scope = (params.get("scope") or "").strip()
        if raw_scope:
            req_tokens = {s for s in raw_scope.split() if s}
            if not req_tokens or not req_tokens.issubset(granted_set):
                return oauth_error_json("invalid_scope", "Requested scope exceeds original grant")
            active_scopes = [s for s in MCP_SCOPES if s in req_tokens]
        else:
            active_scopes = [s for s in MCP_SCOPES if s in granted_set] or ["mcp:read"]

        new_access = f"{ACCESS_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
        new_refresh = f"{REFRESH_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
        grant.scopes = active_scopes
        grant.access_token_hash = _token_hash(new_access)
        grant.access_expires_at = now + timedelta(seconds=ACCESS_TOKEN_TTL_SECONDS)
        grant.refresh_token_hash = _token_hash(new_refresh)
        grant.refresh_expires_at = now + timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS)
        grant.last_used_at = now
        db.commit()

        return JSONResponse(
            {
                "access_token": new_access,
                "token_type": "Bearer",
                "expires_in": ACCESS_TOKEN_TTL_SECONDS,
                "refresh_token": new_refresh,
                "scope": " ".join(active_scopes),
            },
            headers=cors_oauth_headers(),
        )

    return oauth_error_json("unsupported_grant_type", f"Unsupported grant_type: {grant_type}")


def revoke_oauth_token(
    request: Request,
    db: Session,
    params: dict[str, str],
) -> JSONResponse | Response:
    cleaned = (params.get("token") or "").strip()
    if not cleaned:
        return Response(status_code=200, headers=cors_oauth_headers())
    digest = _token_hash(cleaned)
    now = datetime.now(UTC)
    grant = db.scalar(
        select(McpOAuthGrant)
        .where(
            or_(
                McpOAuthGrant.access_token_hash == digest,
                McpOAuthGrant.refresh_token_hash == digest,
            )
        )
        .with_for_update()
    )
    if grant is not None:
        client = db.get(McpOAuthClient, grant.client_id)
        if client is not None and client.token_endpoint_auth_method != "none":  # noqa: S105
            authed = _verify_client_authentication(
                request,
                db,
                params.get("client_id"),
                params.get("client_secret"),
            )
            if authed is None or authed.client_id != client.client_id:
                return oauth_error_json(
                    "invalid_client",
                    "Client authentication required for confidential client revocation",
                    status_code=401,
                )
        if grant.revoked_at is None:
            grant.revoked_at = now
            db.commit()
    return Response(status_code=200, headers=cors_oauth_headers())


def verify_mcp_access_token_principal(
    db: Session,
    raw_token: str,
    *,
    required_scope: str = "mcp:read",
) -> Principal | None:
    if not raw_token.startswith(ACCESS_TOKEN_PREFIX):
        return None
    now = datetime.now(UTC)
    grant = db.scalar(
        select(McpOAuthGrant).where(McpOAuthGrant.access_token_hash == _token_hash(raw_token))
    )
    if grant is None or grant.revoked_at is not None or grant.access_expires_at <= now:
        return None
    scopes = set(grant.scopes or ["mcp:read"])
    if required_scope and required_scope not in scopes:
        return None
    if grant.is_operator:
        return Principal(kind="operator", is_admin=True)
    if not grant.owner_email or not is_allowed_user_email(grant.owner_email):
        return None
    clean_email = grant.owner_email.strip().lower()
    return Principal(
        kind="user",
        sub=grant.owner_sub,
        email=clean_email,
        name=grant.owner_name or clean_email,
        is_admin=is_admin_email(clean_email),
    )


def authenticate_mcp_request(
    request: Request,
    db: Session,
    authorization: str | None,
) -> McpAuthContext:
    origin = public_origin(request)
    if not authorization or not authorization.startswith("Bearer "):
        raise McpAuthError(
            401,
            "MCP Bearer token required",
            www_authenticate=mcp_www_authenticate(origin),
        )
    token = authorization[7:].strip()
    if not token:
        raise McpAuthError(
            401,
            "MCP Bearer token required",
            www_authenticate=mcp_www_authenticate(origin),
        )

    now = datetime.now(UTC)
    if token.startswith(ACCESS_TOKEN_PREFIX):
        grant = db.scalar(
            select(McpOAuthGrant).where(McpOAuthGrant.access_token_hash == _token_hash(token))
        )
        if grant is None or grant.revoked_at is not None or grant.access_expires_at <= now:
            raise McpAuthError(
                401,
                "Invalid or expired MCP access token",
                www_authenticate=mcp_www_authenticate(
                    origin,
                    error="invalid_token",
                    error_description="Access token expired or revoked",
                ),
            )
        if grant.is_operator:
            principal = Principal(kind="operator", is_admin=True)
        else:
            if not grant.owner_email or not is_allowed_user_email(grant.owner_email):
                raise McpAuthError(
                    401,
                    "MCP user is no longer authorized",
                    www_authenticate=mcp_www_authenticate(
                        origin,
                        error="invalid_token",
                        error_description="User authorization revoked",
                    ),
                )
            clean_email = grant.owner_email.strip().lower()
            principal = Principal(
                kind="user",
                sub=grant.owner_sub,
                email=clean_email,
                name=grant.owner_name or clean_email,
                is_admin=is_admin_email(clean_email),
            )
        if grant.last_used_at is None or (now - grant.last_used_at).total_seconds() >= 60:
            grant.last_used_at = now
            db.commit()
        return McpAuthContext(
            principal=principal,
            scopes=frozenset(grant.scopes or ["mcp:read"]),
            grant_id=grant.id,
        )

    # Also support direct operator API token, user session token, or Dex OIDC ID token
    settings = get_settings()
    if secrets.compare_digest(
        token.encode("utf-8"), settings.api_token.get_secret_value().encode("utf-8")
    ):
        return McpAuthContext(
            principal=Principal(kind="operator", is_admin=True),
            scopes=frozenset(MCP_SCOPES),
        )

    session_principal = verify_user_session_token(token)
    if session_principal is not None:
        return McpAuthContext(
            principal=session_principal,
            scopes=frozenset(MCP_SCOPES),
        )

    if token.count(".") == 2 and not token.startswith("wortlaut-read-"):
        try:
            claims = verify_bearer_oidc_id_token(token)
        except HTTPException as exc:
            raise McpAuthError(
                401,
                str(exc.detail),
                www_authenticate=mcp_www_authenticate(
                    origin, error="invalid_token", error_description=str(exc.detail)
                ),
            ) from None
        email = claims["email"].strip().lower()
        return McpAuthContext(
            principal=Principal(
                kind="user",
                sub=claims["sub"],
                email=email,
                name=claims.get("name") or email,
                is_admin=is_admin_email(email),
            ),
            scopes=frozenset(MCP_SCOPES),
        )

    raise McpAuthError(
        401,
        "Invalid MCP credential",
        www_authenticate=mcp_www_authenticate(
            origin, error="invalid_token", error_description="Unrecognized Bearer token"
        ),
    )


def grant_json(grant: McpOAuthGrant) -> dict:
    return {
        "id": str(grant.id),
        "client_id": grant.client_id,
        "client_name": grant.client_name,
        "owner_email": grant.owner_email,
        "owner_name": grant.owner_name,
        "is_operator": grant.is_operator,
        "scopes": list(grant.scopes or []),
        "created_at": grant.created_at.isoformat() if grant.created_at else None,
        "last_used_at": grant.last_used_at.isoformat() if grant.last_used_at else None,
        "access_expires_at": (
            grant.access_expires_at.isoformat() if grant.access_expires_at else None
        ),
        "refresh_expires_at": (
            grant.refresh_expires_at.isoformat() if grant.refresh_expires_at else None
        ),
    }


def list_user_mcp_grants(db: Session, principal: Principal) -> list[dict]:
    now = datetime.now(UTC)
    stmt = select(McpOAuthGrant).where(
        McpOAuthGrant.revoked_at.is_(None),
        McpOAuthGrant.refresh_expires_at > now,
    )
    if principal.kind == "operator":
        pass
    else:
        user_email = (principal.email or "").strip().lower()
        conds = []
        if principal.sub:
            conds.append(McpOAuthGrant.owner_sub == principal.sub)
        if user_email:
            conds.append(McpOAuthGrant.owner_email == user_email)
        if not conds:
            return []
        stmt = stmt.where(or_(*conds))
    rows = db.scalars(stmt.order_by(McpOAuthGrant.created_at.desc()).limit(100)).all()
    return [grant_json(g) for g in rows]


def revoke_user_mcp_grant(db: Session, principal: Principal, grant_id: uuid.UUID) -> bool:
    grant = db.scalar(select(McpOAuthGrant).where(McpOAuthGrant.id == grant_id).with_for_update())
    if grant is None or grant.revoked_at is not None:
        return False
    if principal.kind != "operator" and not principal.is_admin:
        user_email = (principal.email or "").strip().lower()
        owns = (principal.sub and grant.owner_sub == principal.sub) or (
            user_email and (grant.owner_email or "").lower() == user_email
        )
        if not owns:
            return False
    grant.revoked_at = datetime.now(UTC)
    db.commit()
    return True
