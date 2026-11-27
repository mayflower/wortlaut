"""OIDC (Discovery + PKCE + PyJWT JWK verification) authentication and per-user authorization."""

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit

import httpx
import jwt
from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from wortlaut.models import CalendarEntry, CalendarSyncedEvent, Delivery, Recording
from wortlaut.settings import derive_subkey, get_settings

AuthProviderId = Literal["oidc", "google", "entra"]

USER_TOKEN_PREFIX = "wortlaut-user-"
_JWKS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_JWKS_TTL_SECONDS = 300.0
_DISCOVERY_CACHE: dict[tuple[str, str, str], tuple[float, dict]] = {}
_DISCOVERY_TTL_SECONDS = 300.0
_RFC2606_TEST_SUFFIXES = (".example.org", ".example.com", ".example.net", ".invalid", ".test")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
_TENANT_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_ENTRA_SPECIAL_TENANTS = frozenset({"common", "organizations", "consumers"})
_GOOGLE_ISSUER = "https://accounts.google.com"
_GOOGLE_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})


@dataclass(frozen=True)
class Principal:
    kind: Literal["operator", "user", "reader"]
    sub: str | None = None
    email: str | None = None
    name: str | None = None
    is_admin: bool = False
    recording_id: uuid.UUID | None = None


@dataclass(frozen=True)
class OidcProviderConfig:
    id: AuthProviderId
    label: str
    issuer: str
    client_id: str
    client_secret: str | None = None
    internal_issuer: str = ""
    authorization_endpoint_override: str = ""
    token_endpoint_override: str = ""
    jwks_uri_override: str = ""
    entra_tenant_id: str | None = None
    entra_allowed_tenants: tuple[str, ...] = ()


def _b64url_decode(data: str) -> bytes:
    rem = len(data) % 4
    if rem:
        data += "=" * (4 - rem)
    return base64.urlsafe_b64decode(data.encode("ascii"))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def is_admin_email(email: str | None) -> bool:
    if not email:
        return False
    admins = {e.strip().lower() for e in get_settings().oidc_admin_emails if e.strip()}
    return email.strip().lower() in admins


def is_allowed_user_email(email: str | None) -> bool:
    if not email or "@" not in email:
        return False
    clean = email.strip().lower()
    if is_admin_email(clean):
        return True
    domains = {d.strip().lower() for d in get_settings().oidc_allowed_domains if d.strip()}
    if not domains:
        return True
    domain = clean.rsplit("@", 1)[-1]
    return domain in domains


def _secret_value(secret) -> str | None:
    if secret is None:
        return None
    val = secret.get_secret_value().strip()
    return val or None


def get_configured_auth_providers() -> list[OidcProviderConfig]:
    """Return all enabled OIDC sign-in providers (generic OIDC, Microsoft Entra ID, Google)."""
    s = get_settings()
    providers: list[OidcProviderConfig] = []

    generic_issuer = (s.oidc_issuer or "").strip().rstrip("/")
    if generic_issuer:
        providers.append(
            OidcProviderConfig(
                id="oidc",
                label=(s.oidc_display_name or "").strip() or "SSO (OIDC)",
                issuer=generic_issuer,
                internal_issuer=(s.oidc_internal_issuer or "").strip().rstrip("/"),
                client_id=(s.oidc_client_id or "").strip() or "wortlaut",
                client_secret=_secret_value(s.oidc_client_secret),
                authorization_endpoint_override=(s.oidc_authorization_endpoint or "").strip(),
                token_endpoint_override=(s.oidc_token_endpoint or "").strip(),
                jwks_uri_override=(s.oidc_jwks_uri or "").strip(),
            )
        )

    entra_client_id = (s.entra_auth_client_id or "").strip()
    entra_tenant = (s.entra_auth_tenant_id or "").strip().strip("/")
    if entra_client_id and entra_tenant and _TENANT_SEGMENT_RE.match(entra_tenant):
        allowed_tenants = tuple(
            t.strip().lower() for t in (s.entra_auth_allowed_tenants or []) if t.strip()
        )
        providers.append(
            OidcProviderConfig(
                id="entra",
                label="Microsoft (Entra ID)",
                issuer=f"https://login.microsoftonline.com/{entra_tenant}/v2.0",
                client_id=entra_client_id,
                client_secret=_secret_value(s.entra_auth_client_secret),
                entra_tenant_id=entra_tenant,
                entra_allowed_tenants=allowed_tenants,
            )
        )

    google_client_id = (s.google_auth_client_id or "").strip()
    google_client_secret = _secret_value(s.google_auth_client_secret)
    if google_client_id and google_client_secret:
        providers.append(
            OidcProviderConfig(
                id="google",
                label="Google",
                issuer=_GOOGLE_ISSUER,
                client_id=google_client_id,
                client_secret=google_client_secret,
            )
        )

    return providers


def has_any_auth_provider() -> bool:
    return bool(get_configured_auth_providers())


def get_auth_provider(provider_id: AuthProviderId = "oidc") -> OidcProviderConfig:
    for provider in get_configured_auth_providers():
        if provider.id == provider_id:
            return provider
    raise HTTPException(503, f"Authentication provider '{provider_id}' is not configured")


def provider_extra_auth_params(provider: OidcProviderConfig) -> dict[str, str]:
    if provider.id == "google":
        params: dict[str, str] = {"prompt": "select_account"}
        domains = [d.strip().lower() for d in get_settings().oidc_allowed_domains if d.strip()]
        if len(domains) == 1:
            params["hd"] = domains[0]
        return params
    if provider.id == "entra":
        return {"prompt": "select_account"}
    return {}


def issue_user_session_token(
    *,
    sub: str,
    email: str,
    name: str | None = None,
    exp: int | None = None,
) -> tuple[str, dict]:
    now = int(time.time())
    expires = exp if exp and exp > now else now + 12 * 3600
    clean_email = email.strip().lower()
    admin = is_admin_email(clean_email)
    payload = {
        "sub": sub,
        "email": clean_email,
        "name": (name or "").strip() or clean_email.split("@", 1)[0],
        "is_admin": admin,
        "iat": now,
        "exp": expires,
    }
    payload_b64 = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    )
    subkey = derive_subkey(b"user-session-v1")
    sig = hmac.new(
        subkey,
        b"wortlaut-user-session\0" + payload_b64.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{USER_TOKEN_PREFIX}{payload_b64}.{sig}", payload


def verify_user_session_token(token: str) -> Principal | None:
    if not token.startswith(USER_TOKEN_PREFIX):
        return None
    rest = token.removeprefix(USER_TOKEN_PREFIX)
    if "." not in rest:
        return None
    payload_b64, sig = rest.rsplit(".", 1)
    msg = b"wortlaut-user-session\0" + payload_b64.encode("ascii")
    subkey = derive_subkey(b"user-session-v1")
    expected = hmac.new(subkey, msg, hashlib.sha256).hexdigest()
    valid_sig = secrets.compare_digest(sig.encode("ascii"), expected.encode("ascii"))
    if not valid_sig:
        legacy_secret = get_settings().api_token.get_secret_value().encode()
        legacy_expected = hmac.new(legacy_secret, msg, hashlib.sha256).hexdigest()
        valid_sig = secrets.compare_digest(sig.encode("ascii"), legacy_expected.encode("ascii"))
    if not valid_sig:
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, UnicodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    sub = payload.get("sub")
    email = payload.get("email")
    if (
        not isinstance(exp, int)
        or exp <= int(time.time())
        or not isinstance(sub, str)
        or not sub
        or not isinstance(email, str)
        or not is_allowed_user_email(email)
    ):
        return None
    clean_email = email.strip().lower()
    return Principal(
        kind="user",
        sub=sub,
        email=clean_email,
        name=payload.get("name") or clean_email,
        is_admin=is_admin_email(clean_email),
    )


def _rewrite_internal_endpoint(url: str, public_iss: str, internal_iss: str) -> str:
    if internal_iss and public_iss and url.startswith(public_iss):
        return internal_iss + url[len(public_iss) :]
    return url


def _provider_fallback_discovery(provider: OidcProviderConfig) -> dict:
    public_iss = provider.issuer.rstrip("/")
    base = (provider.internal_issuer or public_iss).rstrip("/")
    if provider.id == "google":
        return {
            "issuer": _GOOGLE_ISSUER,
            "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
            "token_endpoint": "https://oauth2.googleapis.com/token",
            "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
        }
    if provider.id == "entra":
        tenant = provider.entra_tenant_id or "common"
        return {
            "issuer": public_iss,
            "authorization_endpoint": (
                f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"
            ),
            "token_endpoint": f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            "jwks_uri": f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
        }
    return {
        "issuer": public_iss,
        "authorization_endpoint": provider.authorization_endpoint_override or f"{public_iss}/auth",
        "token_endpoint": provider.token_endpoint_override or f"{base}/token",
        "jwks_uri": provider.jwks_uri_override or f"{base}/keys",
    }


def fetch_provider_discovery(
    provider: OidcProviderConfig, *, force_refresh: bool = False
) -> dict:
    public_iss = provider.issuer.rstrip("/")
    internal_iss = provider.internal_issuer.rstrip("/")
    base = internal_iss or public_iss
    cache_key = (provider.id, public_iss, internal_iss)
    now = time.monotonic()
    cached = _DISCOVERY_CACHE.get(cache_key)
    if cached and not force_refresh and (now - cached[0]) < _DISCOVERY_TTL_SECONDS:
        return cached[1]

    fallback = _provider_fallback_discovery(provider)
    host = (urlsplit(base).hostname or "").lower()
    if host in ("example.org", "example.com", "example.net") or host.endswith(
        _RFC2606_TEST_SUFFIXES
    ):
        _DISCOVERY_CACHE[cache_key] = (now, fallback)
        return fallback

    try:
        res = httpx.get(f"{base}/.well-known/openid-configuration", timeout=5.0)
        res.raise_for_status()
        doc = res.json()
        if not isinstance(doc, dict):
            raise ValueError("Invalid OIDC discovery document")
        auth_ep = (
            provider.authorization_endpoint_override
            or str(doc.get("authorization_endpoint") or "").strip()
            or fallback["authorization_endpoint"]
        )
        raw_tok_ep = (
            provider.token_endpoint_override
            or str(doc.get("token_endpoint") or "").strip()
            or fallback["token_endpoint"]
        )
        raw_jwks_uri = (
            provider.jwks_uri_override
            or str(doc.get("jwks_uri") or "").strip()
            or fallback["jwks_uri"]
        )
        resolved = {
            "issuer": str(doc.get("issuer") or public_iss).rstrip("/"),
            "authorization_endpoint": auth_ep,
            "token_endpoint": _rewrite_internal_endpoint(raw_tok_ep, public_iss, internal_iss),
            "jwks_uri": _rewrite_internal_endpoint(raw_jwks_uri, public_iss, internal_iss),
        }
        _DISCOVERY_CACHE[cache_key] = (now, resolved)
        return resolved
    except (httpx.HTTPError, ValueError):
        _DISCOVERY_CACHE[cache_key] = (now, fallback)
        return fallback


def fetch_oidc_discovery(*, force_refresh: bool = False) -> dict:
    return fetch_provider_discovery(get_auth_provider("oidc"), force_refresh=force_refresh)


def get_provider_authorization_endpoint(provider: OidcProviderConfig) -> str:
    return fetch_provider_discovery(provider)["authorization_endpoint"]


def get_provider_token_endpoint(provider: OidcProviderConfig) -> str:
    return fetch_provider_discovery(provider)["token_endpoint"]


def get_oidc_authorization_endpoint() -> str:
    return get_provider_authorization_endpoint(get_auth_provider("oidc"))


def get_oidc_token_endpoint() -> str:
    return get_provider_token_endpoint(get_auth_provider("oidc"))


def fetch_provider_jwks(
    provider: OidcProviderConfig, *, force_refresh: bool = False
) -> list[dict]:
    jwks_uri = fetch_provider_discovery(provider, force_refresh=force_refresh)["jwks_uri"]
    now = time.monotonic()
    cached = _JWKS_CACHE.get(jwks_uri)
    if cached and not force_refresh and (now - cached[0]) < _JWKS_TTL_SECONDS:
        return cached[1]
    try:
        res = httpx.get(jwks_uri, timeout=8.0)
        res.raise_for_status()
        keys = res.json().get("keys", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "OIDC JWKS unavailable") from exc
    _JWKS_CACHE[jwks_uri] = (now, keys)
    return keys


def fetch_dex_jwks(*, force_refresh: bool = False) -> list[dict]:
    return fetch_provider_jwks(get_auth_provider("oidc"), force_refresh=force_refresh)


fetch_oidc_jwks = fetch_dex_jwks


_ALLOWED_JWT_ALGS: dict[str, str] = {
    "RS256": "RSA",
    "RS384": "RSA",
    "RS512": "RSA",
    "PS256": "RSA",
    "PS384": "RSA",
    "PS512": "RSA",
    "ES256": "EC",
    "ES384": "EC",
    "ES512": "EC",
    "EdDSA": "OKP",
}


def _validate_provider_issuer_and_identity(
    claims: dict,
    provider: OidcProviderConfig,
    *,
    discovery_issuer: str | None = None,
) -> tuple[str, str, str]:
    """Validate issuer, email verification, and domain policy; return (sub, email, name)."""
    iss = str(claims.get("iss") or "").rstrip("/")

    if provider.id == "google":
        if iss not in _GOOGLE_ISSUERS:
            raise HTTPException(401, "Invalid OIDC token issuer")
        email = str(claims.get("email") or "").strip().lower()
        if not email or claims.get("email_verified") is not True:
            raise HTTPException(403, "Verified email address required")
        if not is_allowed_user_email(email):
            raise HTTPException(403, "Email domain is not authorized for this instance")
        raw_sub = claims.get("sub")
        if not isinstance(raw_sub, str) or not raw_sub.strip():
            raise HTTPException(401, "Missing OIDC subject")
        name = str(claims.get("name") or email.split("@", 1)[0]).strip()
        return f"google:{raw_sub.strip()}", email, name

    if provider.id == "entra":
        tid = str(claims.get("tid") or "").strip().lower()
        if not tid or not _UUID_RE.match(tid):
            raise HTTPException(401, "Invalid Microsoft Entra tenant claim")
        expected_entra_iss = f"https://login.microsoftonline.com/{tid}/v2.0"
        if iss.lower() != expected_entra_iss:
            raise HTTPException(401, "Invalid OIDC token issuer")
        configured_tenant = (provider.entra_tenant_id or "").strip().lower()
        if configured_tenant not in _ENTRA_SPECIAL_TENANTS:
            if _UUID_RE.match(configured_tenant):
                if tid != configured_tenant:
                    raise HTTPException(
                        403, "Microsoft Entra tenant is not authorized for this instance"
                    )
            else:
                resolved_iss = (discovery_issuer or "").strip().rstrip("/").lower()
                if not resolved_iss or "{tenantid}" in resolved_iss or iss.lower() != resolved_iss:
                    raise HTTPException(
                        403, "Microsoft Entra tenant is not authorized for this instance"
                    )
        if provider.entra_allowed_tenants and tid not in provider.entra_allowed_tenants:
            raise HTTPException(403, "Microsoft Entra tenant is not authorized for this instance")

        if claims.get("email_verified") is False or claims.get("xms_edov") in (0, False, "0"):
            raise HTTPException(403, "Verified email address required")
        # Defense against Microsoft Entra "nOAuth" email spoofing: in unrestricted multi-tenant
        # mode (common/organizations/consumers without an explicit tenant allowlist), require an
        # explicit verified-email proof (email_verified=true or xms_edov=1) before trusting email.
        unrestricted_multi_tenant = (
            configured_tenant in _ENTRA_SPECIAL_TENANTS and not provider.entra_allowed_tenants
        )
        if unrestricted_multi_tenant and not (
            claims.get("email_verified") is True or claims.get("xms_edov") in (1, True, "1")
        ):
            raise HTTPException(403, "Verified email address required")

        raw_email = (
            claims.get("email") or claims.get("preferred_username") or claims.get("upn") or ""
        )
        email = str(raw_email).strip().lower()
        if not email or "@" not in email:
            raise HTTPException(403, "Verified email address required")
        if not is_allowed_user_email(email):
            raise HTTPException(403, "Email domain is not authorized for this instance")

        raw_sub = claims.get("oid") or claims.get("sub")
        if not isinstance(raw_sub, str) or not raw_sub.strip():
            raise HTTPException(401, "Missing OIDC subject")
        name = str(
            claims.get("name") or claims.get("preferred_username") or email.split("@", 1)[0]
        ).strip()
        return f"entra:{tid}:{raw_sub.strip()}", email, name

    # Generic OIDC (Dex, Keycloak, Authentik, etc.)
    expected_iss = provider.issuer.strip().rstrip("/")
    if iss != expected_iss:
        raise HTTPException(401, "Invalid OIDC token issuer")
    email = str(claims.get("email") or "").strip().lower()
    if not email or claims.get("email_verified") is not True:
        raise HTTPException(403, "Verified email address required")
    if not is_allowed_user_email(email):
        raise HTTPException(403, "Email domain is not authorized for this instance")
    raw_sub = claims.get("sub")
    if not isinstance(raw_sub, str) or not raw_sub.strip():
        raise HTTPException(401, "Missing OIDC subject")
    name = str(
        claims.get("name") or claims.get("preferred_username") or email.split("@", 1)[0]
    ).strip()
    return raw_sub.strip(), email, name


def verify_provider_id_token(
    raw_jwt: str,
    *,
    provider: OidcProviderConfig,
    expected_nonce: str | None = None,
) -> dict:
    try:
        header = jwt.get_unverified_header(raw_jwt)
    except jwt.DecodeError:
        raise HTTPException(401, "Malformed OIDC ID token") from None

    alg = header.get("alg")
    expected_kty = _ALLOWED_JWT_ALGS.get(str(alg or ""))
    if not expected_kty:
        raise HTTPException(401, "Unsupported OIDC signing algorithm")

    kid = header.get("kid")
    keys = fetch_provider_jwks(provider, force_refresh=False)
    matching = [
        k for k in keys if k.get("kty") == expected_kty and (not kid or k.get("kid") == kid)
    ]
    if not matching:
        keys = fetch_provider_jwks(provider, force_refresh=True)
        matching = [
            k for k in keys if k.get("kty") == expected_kty and (not kid or k.get("kid") == kid)
        ]
    if not matching:
        raise HTTPException(401, "Unknown OIDC signing key")

    claims: dict | None = None
    last_jwt_error: jwt.PyJWTError | None = None
    for jwk_dict in matching:
        try:
            py_jwk = jwt.PyJWK.from_dict(jwk_dict, algorithm=alg)
            claims = jwt.decode(
                raw_jwt,
                key=py_jwk.key,
                algorithms=[alg],
                audience=provider.client_id,
                options={"require": ["exp", "iss", "aud", "sub"], "verify_iss": False},
                leeway=30,
            )
            break
        except jwt.ExpiredSignatureError:
            raise HTTPException(401, "Expired OIDC token") from None
        except jwt.InvalidAudienceError:
            raise HTTPException(401, "Invalid OIDC token audience") from None
        except (jwt.PyJWTError, KeyError, ValueError, TypeError) as exc:
            if isinstance(exc, jwt.PyJWTError):
                last_jwt_error = exc
            continue

    if claims is None:
        if isinstance(last_jwt_error, jwt.MissingRequiredClaimError):
            raise HTTPException(401, f"Missing required OIDC claim: {last_jwt_error}") from None
        raise HTTPException(401, "Invalid OIDC token signature")

    if expected_nonce is not None and claims.get("nonce") != expected_nonce:
        raise HTTPException(401, "Invalid OIDC nonce")

    discovery = fetch_provider_discovery(provider, force_refresh=False)
    canonical_sub, email, name = _validate_provider_issuer_and_identity(
        claims, provider, discovery_issuer=discovery.get("issuer")
    )
    normalized = dict(claims)
    normalized["sub"] = canonical_sub
    normalized["email"] = email
    normalized["name"] = name
    normalized["_provider"] = provider.id
    return normalized


def verify_dex_id_token(raw_jwt: str, *, expected_nonce: str | None = None) -> dict:
    return verify_provider_id_token(
        raw_jwt, provider=get_auth_provider("oidc"), expected_nonce=expected_nonce
    )


verify_oidc_id_token = verify_dex_id_token


def verify_bearer_oidc_id_token(raw_jwt: str) -> dict:
    """Verify a raw OIDC JWT presented as a Bearer token against configured auth providers."""
    providers = get_configured_auth_providers()
    if not providers:
        raise HTTPException(503, "OIDC is not configured")
    if len(providers) == 1:
        return verify_provider_id_token(raw_jwt, provider=providers[0])
    try:
        unverified = jwt.decode(
            raw_jwt,
            options={
                "verify_signature": False,
                "verify_exp": False,
                "verify_aud": False,
                "verify_iss": False,
            },
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "Malformed OIDC ID token") from None
    iss = str(unverified.get("iss") or "").rstrip("/")
    raw_aud = unverified.get("aud")
    aud_set = (
        {str(a) for a in raw_aud}
        if isinstance(raw_aud, list)
        else ({str(raw_aud)} if raw_aud else set())
    )

    def _iss_matches(provider: OidcProviderConfig) -> bool:
        if provider.id == "google":
            return iss in _GOOGLE_ISSUERS
        if provider.id == "entra":
            return iss.lower().startswith("https://login.microsoftonline.com/")
        return iss == provider.issuer.rstrip("/")

    for provider in providers:
        if _iss_matches(provider) and provider.client_id in aud_set:
            return verify_provider_id_token(raw_jwt, provider=provider)
    for provider in providers:
        if _iss_matches(provider):
            return verify_provider_id_token(raw_jwt, provider=provider)
    raise HTTPException(401, "Invalid OIDC token issuer")


def _validate_oidc_redirect_uri(redirect_uri: str) -> str:
    parsed = urlsplit(redirect_uri.strip())
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or parsed.fragment
        or not parsed.path.endswith("/auth/callback")
    ):
        raise HTTPException(400, "Invalid OIDC redirect_uri")
    return redirect_uri.strip()


def exchange_provider_token_for_claims(
    *,
    provider: OidcProviderConfig,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    nonce: str | None = None,
) -> dict:
    token_url = get_provider_token_endpoint(provider)
    form_data = {
        "grant_type": "authorization_code",
        "client_id": provider.client_id,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    if provider.client_secret:
        form_data["client_secret"] = provider.client_secret
    try:
        res = httpx.post(
            token_url,
            data=form_data,
            headers={"Accept": "application/json"},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(503, "OIDC token endpoint unreachable") from exc
    if res.status_code != 200:
        raise HTTPException(401, "OIDC authorization code exchange failed")
    try:
        token_data = res.json()
    except ValueError:
        raise HTTPException(502, "Invalid response from OIDC token endpoint") from None

    raw_id_token = token_data.get("id_token")
    if not isinstance(raw_id_token, str) or not raw_id_token:
        raise HTTPException(401, "OIDC response did not include an id_token")

    return verify_provider_id_token(raw_id_token, provider=provider, expected_nonce=nonce)


def exchange_oidc_code(
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    nonce: str | None = None,
    provider_id: AuthProviderId = "oidc",
) -> dict:
    provider = get_auth_provider(provider_id)
    if len(code_verifier) < 43 or not code or not redirect_uri:
        raise HTTPException(400, "Invalid PKCE parameters")
    validated_redirect = _validate_oidc_redirect_uri(redirect_uri)
    claims = exchange_provider_token_for_claims(
        provider=provider,
        code=code,
        code_verifier=code_verifier,
        redirect_uri=validated_redirect,
        nonce=nonce,
    )
    session_token, payload = issue_user_session_token(
        sub=claims["sub"],
        email=claims["email"],
        name=claims.get("name") or claims["email"],
        exp=int(claims["exp"]),
    )
    return {
        "token": session_token,
        "expires_at": datetime.fromtimestamp(payload["exp"], tz=UTC).isoformat(),
        "user": {
            "sub": payload["sub"],
            "email": payload["email"],
            "name": payload["name"],
            "is_admin": payload["is_admin"],
        },
    }


def user_recording_access_predicate(principal: Principal):
    user_email = (principal.email or "").strip().lower()
    predicates = []
    if principal.sub:
        predicates.append(Recording.owner_sub == principal.sub)
    if user_email:
        predicates.append(func.lower(Recording.owner_email) == user_email)
        predicates.append(Recording.protocol_meta["attendee_emails"].contains([user_email]))
        mailto_pattern = rf"mailto:{re.escape(user_email)}([^a-z0-9._%+-]|$)"
        predicates.append(
            select(CalendarEntry.id)
            .where(
                CalendarEntry.id == Recording.calendar_entry_id,
                or_(
                    func.lower(CalendarEntry.organizer) == user_email,
                    func.lower(CalendarEntry.original).op("~")(mailto_pattern),
                ),
            )
            .correlate(Recording)
            .exists()
        )
        predicates.append(
            select(Delivery.recording_id)
            .where(
                Delivery.recording_id == Recording.id,
                Delivery.recipients.contains([user_email]),
            )
            .correlate(Recording)
            .exists()
        )
        predicates.append(
            select(CalendarSyncedEvent.id)
            .where(
                or_(
                    func.lower(CalendarSyncedEvent.owner_email) == user_email,
                    func.lower(CalendarSyncedEvent.organizer_email) == user_email,
                ),
                or_(
                    CalendarSyncedEvent.recording_id == Recording.id,
                    and_(
                        CalendarSyncedEvent.meeting_url == Recording.meeting_url,
                        CalendarSyncedEvent.starts_at <= Recording.ends_at + timedelta(hours=1),
                        CalendarSyncedEvent.ends_at >= Recording.starts_at - timedelta(hours=1),
                    ),
                ),
            )
            .correlate(Recording)
            .exists()
        )
    return or_(*predicates) if predicates else False


def can_access_recording(db: Session, principal: Principal, recording: Recording) -> bool:
    if principal.is_admin or principal.kind == "operator":
        return True
    if principal.kind == "reader":
        return principal.recording_id == recording.id
    if principal.kind == "user":
        if principal.sub and recording.owner_sub and recording.owner_sub == principal.sub:
            return True
        user_email = (principal.email or "").strip().lower()
        if user_email and recording.owner_email and recording.owner_email.lower() == user_email:
            return True
        attendees = (recording.protocol_meta or {}).get("attendee_emails") or []
        if user_email and any(str(e).strip().lower() == user_email for e in attendees):
            return True
        pred = user_recording_access_predicate(principal)
        if pred is not False and db.scalar(
            select(Recording.id).where(Recording.id == recording.id, pred)
        ):
            return True
    return False
