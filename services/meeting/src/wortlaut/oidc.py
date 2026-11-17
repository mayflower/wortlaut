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

USER_TOKEN_PREFIX = "wortlaut-user-"
_JWKS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_JWKS_TTL_SECONDS = 300.0
_DISCOVERY_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_DISCOVERY_TTL_SECONDS = 300.0
_RFC2606_TEST_SUFFIXES = (".example.org", ".example.com", ".example.net", ".invalid", ".test")


@dataclass(frozen=True)
class Principal:
    kind: Literal["operator", "user", "reader"]
    sub: str | None = None
    email: str | None = None
    name: str | None = None
    is_admin: bool = False
    recording_id: uuid.UUID | None = None


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


def _dex_base_url() -> str:
    s = get_settings()
    base = (s.oidc_internal_issuer or s.oidc_issuer).strip().rstrip("/")
    if not base:
        raise HTTPException(503, "OIDC is not configured")
    return base


def _rewrite_internal_endpoint(url: str, public_iss: str, internal_iss: str) -> str:
    if internal_iss and public_iss and url.startswith(public_iss):
        return internal_iss + url[len(public_iss) :]
    return url


def fetch_oidc_discovery(*, force_refresh: bool = False) -> dict:
    s = get_settings()
    public_iss = (s.oidc_issuer or "").strip().rstrip("/")
    if not public_iss:
        raise HTTPException(503, "OIDC is not configured")
    internal_iss = (s.oidc_internal_issuer or "").strip().rstrip("/")
    base = internal_iss or public_iss
    cache_key = (public_iss, internal_iss)
    now = time.monotonic()
    cached = _DISCOVERY_CACHE.get(cache_key)
    if cached and not force_refresh and (now - cached[0]) < _DISCOVERY_TTL_SECONDS:
        return cached[1]

    fallback = {
        "issuer": public_iss,
        "authorization_endpoint": s.oidc_authorization_endpoint.strip() or f"{public_iss}/auth",
        "token_endpoint": s.oidc_token_endpoint.strip() or f"{base}/token",
        "jwks_uri": s.oidc_jwks_uri.strip() or f"{base}/keys",
    }
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
            s.oidc_authorization_endpoint.strip()
            or str(doc.get("authorization_endpoint") or "").strip()
            or fallback["authorization_endpoint"]
        )
        raw_tok_ep = (
            s.oidc_token_endpoint.strip()
            or str(doc.get("token_endpoint") or "").strip()
            or fallback["token_endpoint"]
        )
        raw_jwks_uri = (
            s.oidc_jwks_uri.strip()
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


def get_oidc_authorization_endpoint() -> str:
    return fetch_oidc_discovery()["authorization_endpoint"]


def get_oidc_token_endpoint() -> str:
    return fetch_oidc_discovery()["token_endpoint"]


def fetch_dex_jwks(*, force_refresh: bool = False) -> list[dict]:
    jwks_uri = fetch_oidc_discovery(force_refresh=force_refresh)["jwks_uri"]
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


def verify_dex_id_token(raw_jwt: str, *, expected_nonce: str | None = None) -> dict:
    settings = get_settings()
    if not settings.oidc_issuer:
        raise HTTPException(503, "OIDC is not configured")
    try:
        header = jwt.get_unverified_header(raw_jwt)
    except jwt.DecodeError:
        raise HTTPException(401, "Malformed OIDC ID token") from None

    alg = header.get("alg")
    expected_kty = _ALLOWED_JWT_ALGS.get(str(alg or ""))
    if not expected_kty:
        raise HTTPException(401, "Unsupported OIDC signing algorithm")

    kid = header.get("kid")
    keys = fetch_dex_jwks(force_refresh=False)
    matching = [
        k for k in keys if k.get("kty") == expected_kty and (not kid or k.get("kid") == kid)
    ]
    if not matching:
        keys = fetch_dex_jwks(force_refresh=True)
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
                audience=settings.oidc_client_id,
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

    expected_iss = settings.oidc_issuer.strip().rstrip("/")
    iss = str(claims.get("iss") or "").rstrip("/")
    if iss != expected_iss:
        raise HTTPException(401, "Invalid OIDC token issuer")

    if expected_nonce is not None and claims.get("nonce") != expected_nonce:
        raise HTTPException(401, "Invalid OIDC nonce")

    email = (claims.get("email") or "").strip().lower()
    email_verified = claims.get("email_verified")
    if not email or email_verified is not True:
        raise HTTPException(403, "Verified email address required")
    if not is_allowed_user_email(email):
        raise HTTPException(403, "Email domain is not authorized for this instance")

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise HTTPException(401, "Missing OIDC subject")

    return claims


verify_oidc_id_token = verify_dex_id_token


def exchange_oidc_code(
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    nonce: str | None = None,
) -> dict:
    settings = get_settings()
    if not settings.oidc_issuer:
        raise HTTPException(503, "OIDC is not configured")
    if len(code_verifier) < 43 or not code or not redirect_uri:
        raise HTTPException(400, "Invalid PKCE parameters")
    token_url = get_oidc_token_endpoint()
    try:
        res = httpx.post(
            token_url,
            data={
                "grant_type": "authorization_code",
                "client_id": settings.oidc_client_id,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
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

    claims = verify_dex_id_token(raw_id_token, expected_nonce=nonce)
    session_token, payload = issue_user_session_token(
        sub=claims["sub"],
        email=claims["email"],
        name=claims.get("name") or claims.get("preferred_username") or claims["email"],
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
