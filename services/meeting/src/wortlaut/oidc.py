"""Dex OIDC (PKCE + RS256 JWKS) authentication and per-user authorization."""

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from wortlaut.models import CalendarEntry, CalendarSyncedEvent, Delivery, Recording
from wortlaut.settings import get_settings

USER_TOKEN_PREFIX = "wortlaut-user-"
_JWKS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_JWKS_TTL_SECONDS = 300.0


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
    secret = get_settings().api_token.get_secret_value().encode()
    sig = hmac.new(
        secret,
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
    secret = get_settings().api_token.get_secret_value().encode()
    expected = hmac.new(
        secret,
        b"wortlaut-user-session\0" + payload_b64.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    if not secrets.compare_digest(sig.encode("ascii"), expected.encode("ascii")):
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


def fetch_dex_jwks(*, force_refresh: bool = False) -> list[dict]:
    base = _dex_base_url()
    now = time.monotonic()
    cached = _JWKS_CACHE.get(base)
    if cached and not force_refresh and (now - cached[0]) < _JWKS_TTL_SECONDS:
        return cached[1]
    try:
        res = httpx.get(f"{base}/keys", timeout=8.0)
        res.raise_for_status()
        keys = res.json().get("keys", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "OIDC JWKS unavailable") from exc
    _JWKS_CACHE[base] = (now, keys)
    return keys


def _rsa_public_key_from_jwk(jwk: dict):
    n = int.from_bytes(_b64url_decode(jwk["n"]), "big")
    e = int.from_bytes(_b64url_decode(jwk["e"]), "big")
    return rsa.RSAPublicNumbers(e, n).public_key()


def verify_dex_id_token(raw_jwt: str, *, expected_nonce: str | None = None) -> dict:
    settings = get_settings()
    if not settings.oidc_issuer:
        raise HTTPException(503, "OIDC is not configured")
    parts = raw_jwt.split(".")
    if len(parts) != 3:
        raise HTTPException(401, "Invalid OIDC ID token format")
    header_b64, claims_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
        claims = json.loads(_b64url_decode(claims_b64))
        signature = _b64url_decode(sig_b64)
    except (ValueError, UnicodeError, TypeError):
        raise HTTPException(401, "Malformed OIDC ID token") from None

    if header.get("alg") != "RS256":
        raise HTTPException(401, "Unsupported OIDC signing algorithm")

    kid = header.get("kid")
    keys = fetch_dex_jwks(force_refresh=False)
    matching = [k for k in keys if k.get("kty") == "RSA" and (not kid or k.get("kid") == kid)]
    if not matching:
        keys = fetch_dex_jwks(force_refresh=True)
        matching = [k for k in keys if k.get("kty") == "RSA" and (not kid or k.get("kid") == kid)]
    if not matching:
        raise HTTPException(401, "Unknown OIDC signing key")

    signing_input = f"{header_b64}.{claims_b64}".encode("ascii")
    verified = False
    for jwk in matching:
        try:
            pub = _rsa_public_key_from_jwk(jwk)
            pub.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
            verified = True
            break
        except (InvalidSignature, KeyError, ValueError):
            continue
    if not verified:
        raise HTTPException(401, "Invalid OIDC token signature")

    now = int(time.time())
    expected_iss = settings.oidc_issuer.strip().rstrip("/")
    iss = str(claims.get("iss") or "").rstrip("/")
    if iss != expected_iss:
        raise HTTPException(401, "Invalid OIDC token issuer")

    aud = claims.get("aud")
    aud_list = [aud] if isinstance(aud, str) else (aud if isinstance(aud, list) else [])
    if settings.oidc_client_id not in aud_list:
        raise HTTPException(401, "Invalid OIDC token audience")

    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp <= now - 30:
        raise HTTPException(401, "Expired OIDC token")

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
    base = _dex_base_url()
    try:
        res = httpx.post(
            f"{base}/token",
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
        predicates.append(
            select(CalendarEntry.id)
            .where(
                CalendarEntry.id == Recording.calendar_entry_id,
                or_(
                    func.lower(CalendarEntry.organizer) == user_email,
                    func.lower(CalendarEntry.original).like(f"%mailto:{user_email}%"),
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
