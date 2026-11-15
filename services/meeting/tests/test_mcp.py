import base64
import hashlib
import json
import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlencode, urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from sqlalchemy import select
from sqlalchemy.orm import Session


def _pkce_pair(seed: str = "verifier") -> tuple[str, str]:
    verifier = (seed * 12)[:64]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _extract_hidden_input(html_text: str, name: str) -> str:
    m = re.search(rf'name="{re.escape(name)}"\s+value="([^"]+)"', html_text)
    assert m is not None, f"Hidden input {name!r} not found in HTML"
    return m.group(1)


def _setup_mock_dex(monkeypatch):
    import wortlaut.mcp_oauth as mcp_oauth_mod
    import wortlaut.oidc as oidc_mod
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_OIDC_ISSUER", "https://id.example.org")
    monkeypatch.setenv("WORTLAUT_OIDC_CLIENT_ID", "wortlaut")
    monkeypatch.setenv("WORTLAUT_OIDC_ALLOWED_DOMAINS", '["mayflower.de"]')
    monkeypatch.setenv("WORTLAUT_OIDC_ADMIN_EMAILS", '["admin@mayflower.de"]')
    get_settings.cache_clear()

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_numbers = private_key.public_key().public_numbers()

    def _int_b64(val: int) -> str:
        length = (val.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(val.to_bytes(length, "big")).rstrip(b"=").decode("ascii")

    jwks = [
        {
            "kty": "RSA",
            "kid": "mcp-dex-key-1",
            "alg": "RS256",
            "use": "sig",
            "n": _int_b64(pub_numbers.n),
            "e": _int_b64(pub_numbers.e),
        }
    ]
    monkeypatch.setattr(oidc_mod, "fetch_dex_jwks", lambda *, force_refresh=False: jwks)

    active_user = {
        "sub": "sub-alice",
        "email": "alice@mayflower.de",
        "name": "Alice Meier",
        "nonce": "",
    }

    def _make_id_token(sub: str, email: str, name: str, nonce: str) -> str:
        header = {"alg": "RS256", "typ": "JWT", "kid": "mcp-dex-key-1"}
        now_ts = int(time.time())
        payload = {
            "iss": "https://id.example.org",
            "sub": sub,
            "aud": "wortlaut",
            "exp": now_ts + 3600,
            "iat": now_ts,
            "nonce": nonce,
            "email": email,
            "email_verified": True,
            "name": name,
        }
        h_b64 = (
            base64.urlsafe_b64encode(json.dumps(header).encode("utf-8"))
            .rstrip(b"=")
            .decode("ascii")
        )
        p_b64 = (
            base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8"))
            .rstrip(b"=")
            .decode("ascii")
        )
        sig = private_key.sign(
            f"{h_b64}.{p_b64}".encode("ascii"), padding.PKCS1v15(), hashes.SHA256()
        )
        s_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
        return f"{h_b64}.{p_b64}.{s_b64}"

    class _FakeDexTokenResp:
        status_code = 200

        def json(self):
            return {
                "id_token": _make_id_token(
                    active_user["sub"],
                    active_user["email"],
                    active_user["name"],
                    active_user["nonce"],
                ),
                "token_type": "bearer",
            }

    monkeypatch.setattr(mcp_oauth_mod.httpx, "post", lambda *a, **kw: _FakeDexTokenResp())
    return active_user


def _authorize_mcp_user_via_oidc(
    client,
    active_user: dict,
    *,
    sub: str,
    email: str,
    name: str,
    scopes: list[str],
    client_name: str = "Claude Code Test",
) -> dict:
    reg = client.post(
        "/oauth/register",
        json={
            "client_name": client_name,
            "redirect_uris": ["http://127.0.0.1/callback"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert reg.status_code == 201, reg.text
    client_id = reg.json()["client_id"]

    verifier, challenge = _pkce_pair(f"pkce-{sub}-{uuid.uuid4().hex}")
    cb_uri = "http://127.0.0.1:53123/callback"
    client.cookies.clear()
    auth_resp = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": cb_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "cli-state-xyz",
            "scope": " ".join(scopes),
            "resource": "http://testserver/mcp",
        },
        follow_redirects=False,
    )
    assert auth_resp.status_code == 302
    dex_loc = urlsplit(auth_resp.headers["location"])
    assert f"{dex_loc.scheme}://{dex_loc.netloc}{dex_loc.path}" == "https://id.example.org/auth"
    dex_qs = parse_qs(dex_loc.query)
    upstream_state = dex_qs["state"][0]
    assert upstream_state.startswith("mcp.")
    active_user.update(
        {
            "sub": sub,
            "email": email,
            "name": name,
            "nonce": dex_qs["nonce"][0],
        }
    )

    cb_resp = client.get(
        "/auth/callback",
        params={"code": "dex-auth-code", "state": upstream_state},
        follow_redirects=False,
    )
    assert cb_resp.status_code == 200, cb_resp.text
    assert client_name in cb_resp.text
    assert email in cb_resp.text

    auth_id = _extract_hidden_input(cb_resp.text, "auth_id")
    csrf_token = _extract_hidden_input(cb_resp.text, "csrf_token")
    form_pairs = [
        ("auth_id", auth_id),
        ("csrf_token", csrf_token),
        ("decision", "allow"),
        *[("scopes", sc) for sc in scopes],
    ]
    consent_resp = client.post(
        "/oauth/consent",
        content=urlencode(form_pairs),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    assert consent_resp.status_code == 302, consent_resp.text
    client_cb = urlsplit(consent_resp.headers["location"])
    assert f"{client_cb.scheme}://{client_cb.netloc}{client_cb.path}" == cb_uri
    cb_qs = parse_qs(client_cb.query)
    assert cb_qs["state"] == ["cli-state-xyz"]
    auth_code = cb_qs["code"][0]

    tok_resp = client.post(
        "/oauth/token",
        content=urlencode(
            {
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": auth_code,
                "redirect_uri": cb_uri,
                "code_verifier": verifier,
                "resource": "http://testserver/mcp",
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert tok_resp.status_code == 200, tok_resp.text
    client.cookies.clear()
    return {
        "client_id": client_id,
        "redirect_uri": cb_uri,
        "code": auth_code,
        "code_verifier": verifier,
        "tokens": tok_resp.json(),
    }


def test_mcp_discovery_registration_and_oauth_security(client, database, monkeypatch):
    from wortlaut.models import McpOAuthAuthorization, McpOAuthClient, McpOAuthGrant
    from wortlaut.retention import mcp_oauth_retention

    active_user = _setup_mock_dex(monkeypatch)

    # 1. Unauthenticated /mcp returns 401 + RFC 9728 WWW-Authenticate resource_metadata header
    unauth_post = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
    )
    assert unauth_post.status_code == 401
    www_auth = unauth_post.headers["www-authenticate"]
    assert (
        'resource_metadata="http://testserver/.well-known/oauth-protected-resource/mcp"'
        in www_auth
    )
    assert 'scope="mcp:read mcp:write"' in www_auth

    unauth_get = client.get("/mcp")
    assert unauth_get.status_code == 401
    assert "resource_metadata=" in unauth_get.headers["www-authenticate"]

    # 2. Protected Resource Metadata & Authorization Server Metadata
    prm = client.get("/.well-known/oauth-protected-resource/mcp")
    assert prm.status_code == 200
    assert prm.json()["resource"] == "http://testserver/mcp"
    assert prm.json()["authorization_servers"] == ["http://testserver"]
    assert prm.json()["scopes_supported"] == ["mcp:read", "mcp:write"]

    asm = client.get("/.well-known/oauth-authorization-server")
    assert asm.status_code == 200
    assert asm.json()["authorization_endpoint"] == "http://testserver/oauth/authorize"
    assert asm.json()["token_endpoint"] == "http://testserver/oauth/token"
    assert asm.json()["registration_endpoint"] == "http://testserver/oauth/register"
    assert asm.json()["code_challenge_methods_supported"] == ["S256"]

    # Normal SPA /auth/callback must remain untouched when state does not start with "mcp."
    spa_cb = client.get("/auth/callback", params={"code": "spa-code", "state": "random-spa"})
    assert spa_cb.status_code == 200
    assert "__WORTLAUT_BOOT__" in spa_cb.text

    # 3. Dynamic Client Registration validation
    for bad_uri in [
        "javascript:alert(1)",
        "http://evil.example.org/callback",
        "http://127.0.0.1/callback#fragment",
    ]:
        bad_reg = client.post(
            "/oauth/register",
            json={"client_name": "Bad", "redirect_uris": [bad_uri]},
        )
        assert bad_reg.status_code == 400
        assert bad_reg.json()["error"] == "invalid_redirect_uri"

    # Confidential client registration + Basic auth check
    conf_reg = client.post(
        "/oauth/register",
        json={
            "client_name": "Confidential Agent",
            "redirect_uris": ["https://agent.example.org/oauth/cb", "cursor://mcp/callback"],
            "token_endpoint_auth_method": "client_secret_basic",
        },
    )
    assert conf_reg.status_code == 201
    conf_data = conf_reg.json()
    assert conf_data["client_secret"].startswith("wortlaut-mcp-cs-")
    with Session(database) as db:
        stored_conf = db.get(McpOAuthClient, conf_data["client_id"])
        assert stored_conf is not None
        assert stored_conf.client_secret_hash != conf_data["client_secret"]

    # 4. Confused Deputy / Cookie / CSRF protection on OIDC callback & consent
    reg = client.post(
        "/oauth/register",
        json={"client_name": "Attack Test", "redirect_uris": ["http://127.0.0.1/cb"]},
    ).json()
    verifier, challenge = _pkce_pair("confused-deputy-test")
    auth_start = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": reg["client_id"],
            "redirect_uri": "http://127.0.0.1:44111/cb",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    dex_qs = parse_qs(urlsplit(auth_start.headers["location"]).query)
    upstream_state = dex_qs["state"][0]
    active_user.update(
        {
            "sub": "sub-alice",
            "email": "alice@mayflower.de",
            "name": "Alice Meier",
            "nonce": dex_qs["nonce"][0],
        }
    )

    #Without the browser-bound wortlaut_mcp_consent cookie, callback MUST fail
    saved_cookie = client.cookies.get("wortlaut_mcp_consent")
    client.cookies.clear()
    no_cookie_cb = client.get(
        "/auth/callback",
        params={"code": "dex-code", "state": upstream_state},
    )
    assert no_cookie_cb.status_code == 400

    # Restore cookie, complete OIDC callback, then test tampered CSRF token on POST /oauth/consent
    client.cookies.set("wortlaut_mcp_consent", saved_cookie)
    ok_cb = client.get(
        "/auth/callback",
        params={"code": "dex-code", "state": upstream_state},
    )
    assert ok_cb.status_code == 200
    auth_id = _extract_hidden_input(ok_cb.text, "auth_id")
    bad_csrf = client.post(
        "/oauth/consent",
        content=urlencode(
            {
                "auth_id": auth_id,
                "csrf_token": "wrong-csrf",
                "decision": "allow",
                "scopes": "mcp:read",
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert bad_csrf.status_code == 400
    client.cookies.clear()

    # 5. Full OAuth 2.1 flow + PKCE + single-use code replay revocation + refresh rotation
    flow = _authorize_mcp_user_via_oidc(
        client,
        active_user,
        sub="sub-alice",
        email="alice@mayflower.de",
        name="Alice Meier",
        scopes=["mcp:read", "mcp:write"],
    )
    access_1 = flow["tokens"]["access_token"]
    refresh_1 = flow["tokens"]["refresh_token"]
    assert access_1.startswith("wortlaut-mcp-at-")
    assert refresh_1.startswith("wortlaut-mcp-rt-")
    assert flow["tokens"]["scope"] == "mcp:read mcp:write"

    # Refresh token rotation + scope narrowing to mcp:read
    rot = client.post(
        "/oauth/token",
        content=urlencode(
            {
                "grant_type": "refresh_token",
                "client_id": flow["client_id"],
                "refresh_token": refresh_1,
                "scope": "mcp:read",
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert rot.status_code == 200, rot.text
    access_2 = rot.json()["access_token"]
    refresh_2 = rot.json()["refresh_token"]
    assert rot.json()["scope"] == "mcp:read"
    assert access_2 != access_1
    assert refresh_2 != refresh_1

    # Old refresh token must no longer work
    old_rt_attempt = client.post(
        "/oauth/token",
        content=urlencode(
            {
                "grant_type": "refresh_token",
                "client_id": flow["client_id"],
                "refresh_token": refresh_1,
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert old_rt_attempt.status_code == 400
    assert old_rt_attempt.json()["error"] == "invalid_grant"

    # Replaying the already-consumed authorization code must fail AND revoke the issued grant!
    replay = client.post(
        "/oauth/token",
        content=urlencode(
            {
                "grant_type": "authorization_code",
                "client_id": flow["client_id"],
                "code": flow["code"],
                "redirect_uri": flow["redirect_uri"],
                "code_verifier": flow["code_verifier"],
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"

    after_replay = client.post(
        "/mcp",
        headers={"Authorization": f"Bearer {access_2}"},
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
    )
    assert after_replay.status_code == 401

    # 6. Scope ceiling on consent + RFC 7009 confidential client authentication on revocation
    ceil_verifier, ceil_challenge = _pkce_pair("scope-ceiling-confidential")
    client.cookies.clear()
    ceil_auth = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": conf_data["client_id"],
            "redirect_uri": "https://agent.example.org/oauth/cb",
            "code_challenge": ceil_challenge,
            "code_challenge_method": "S256",
            "scope": "mcp:read",
        },
        follow_redirects=False,
    )
    ceil_dex_qs = parse_qs(urlsplit(ceil_auth.headers["location"]).query)
    active_user.update(
        {
            "sub": "sub-alice",
            "email": "alice@mayflower.de",
            "name": "Alice Meier",
            "nonce": ceil_dex_qs["nonce"][0],
        }
    )
    ceil_cb = client.get(
        "/auth/callback",
        params={"code": "dex-code-ceil", "state": ceil_dex_qs["state"][0]},
    )
    assert ceil_cb.status_code == 200
    assert 'value="mcp:write"' not in ceil_cb.text
    ceil_consent = client.post(
        "/oauth/consent",
        content=urlencode(
            [
                ("auth_id", _extract_hidden_input(ceil_cb.text, "auth_id")),
                ("csrf_token", _extract_hidden_input(ceil_cb.text, "csrf_token")),
                ("decision", "allow"),
                ("scopes", "mcp:read"),
                ("scopes", "mcp:write"),
            ]
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    assert ceil_consent.status_code == 302
    ceil_code = parse_qs(urlsplit(ceil_consent.headers["location"]).query)["code"][0]
    conf_tok = client.post(
        "/oauth/token",
        auth=(conf_data["client_id"], conf_data["client_secret"]),
        content=urlencode(
            {
                "grant_type": "authorization_code",
                "code": ceil_code,
                "redirect_uri": "https://agent.example.org/oauth/cb",
                "code_verifier": ceil_verifier,
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert conf_tok.status_code == 200, conf_tok.text
    assert conf_tok.json()["scope"] == "mcp:read"
    conf_at = conf_tok.json()["access_token"]

    # Unauthenticated revocation of a confidential client's token MUST fail with 401
    unauth_rev = client.post(
        "/oauth/revoke",
        content=urlencode({"token": conf_at}),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert unauth_rev.status_code == 401
    auth_rev = client.post(
        "/oauth/revoke",
        auth=(conf_data["client_id"], conf_data["client_secret"]),
        content=urlencode({"token": conf_at}),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert auth_rev.status_code == 200

    # Retention cleanup removes stale expired auth flows, old revoked grants, and orphaned clients
    now = datetime.now(UTC)
    with Session(database) as db:
        for g in db.scalars(select(McpOAuthGrant)).all():
            g.revoked_at = now - timedelta(days=10)
        for a in db.scalars(select(McpOAuthAuthorization)).all():
            a.expires_at = now - timedelta(hours=3)
        for c in db.scalars(select(McpOAuthClient)).all():
            c.created_at = now - timedelta(days=45)
        db.commit()
    mcp_oauth_retention(database, now)
    with Session(database) as db:
        assert db.scalars(select(McpOAuthAuthorization)).all() == []
        assert db.scalars(select(McpOAuthGrant)).all() == []
        assert db.scalars(select(McpOAuthClient)).all() == []


def test_mcp_non_oidc_local_token_fallback(client, monkeypatch):
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_OIDC_ISSUER", "")
    get_settings.cache_clear()

    reg = client.post(
        "/oauth/register",
        json={"client_name": "Local CLI", "redirect_uris": ["http://localhost/cb"]},
    ).json()
    verifier, challenge = _pkce_pair("local-operator-flow")
    auth_page = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": reg["client_id"],
            "redirect_uri": "http://localhost:39999/cb",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert auth_page.status_code == 200
    assert 'name="operator_token"' in auth_page.text
    auth_id = _extract_hidden_input(auth_page.text, "auth_id")
    csrf_token = _extract_hidden_input(auth_page.text, "csrf_token")

    bad_tok = client.post(
        "/oauth/consent",
        content=urlencode(
            {
                "auth_id": auth_id,
                "csrf_token": csrf_token,
                "decision": "allow",
                "operator_token": "wrong-token",
                "scopes": "mcp:read",
            }
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    assert bad_tok.status_code == 401

    ok_tok = client.post(
        "/oauth/consent",
        content=urlencode(
            [
                ("auth_id", auth_id),
                ("csrf_token", csrf_token),
                ("decision", "allow"),
                ("operator_token", "fixture-api-token"),
                ("scopes", "mcp:read"),
                ("scopes", "mcp:write"),
            ]
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    assert ok_tok.status_code == 302
    code = parse_qs(urlsplit(ok_tok.headers["location"]).query)["code"][0]

    tok_res = client.post(
        "/oauth/token",
        json={
            "grant_type": "authorization_code",
            "client_id": reg["client_id"],
            "code": code,
            "redirect_uri": "http://localhost:39999/cb",
            "code_verifier": verifier,
        },
    )
    assert tok_res.status_code == 200
    mcp_init = client.post(
        "/mcp",
        headers={"Authorization": f"Bearer {tok_res.json()['access_token']}"},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        },
    )
    assert mcp_init.status_code == 200
    assert mcp_init.json()["result"]["protocolVersion"] == "2025-06-18"
    client.cookies.clear()


def test_mcp_tools_resources_multi_user_isolation_and_ui_revocation(
    client, database, storage, monkeypatch
):
    from wortlaut.models import (
        AsrJob,
        Attempt,
        AudioChunk,
        AudioStream,
        Recording,
        TranscriptSegment,
    )
    from wortlaut.oidc import issue_user_session_token

    active_user = _setup_mock_dex(monkeypatch)
    now = datetime.now(UTC)

    # Seed real PostgreSQL + S3 recordings for Alice and Bob
    alice_rec_id = uuid.uuid4()
    bob_rec_id = uuid.uuid4()
    attempt_id = uuid.uuid4()
    stream_row_id = uuid.uuid4()
    stream_ext_id = uuid.uuid4()
    stream_epoch = uuid.uuid4()
    job_1_id = str(uuid.uuid4())
    job_2_id = str(uuid.uuid4())
    origin_iso = (now - timedelta(hours=1)).isoformat()
    stream_contract = {
        "source_kind": "speaker",
        "provider_source_id": "rtc:1",
        "participant_id": "spaces/meet/devices/42",
        "signaled_participant_id": "spaces/meet/devices/42",
        "participant_name": "Dr. Weber",
        "speaker_id": "spaces/meet/devices/42",
        "attribution_unknown": False,
        "attribution_status": "bound",
        "session_utc_origin": origin_iso,
        "monotonic_origin_ms": 0,
        "session_monotonic_origin_ms": 0,
    }
    pcm_key = f"audio/{alice_rec_id}/{attempt_id}/{stream_ext_id}/000000.pcm"
    pcm_bytes = b"\x10\x00" * 128000  # 8.0 seconds of 16kHz mono s16le PCM
    pcm_sha = storage.put(pcm_key, pcm_bytes, stream_contract)

    with Session(database) as db:
        alice_rec = Recording(
            id=alice_rec_id,
            idempotency_key="mcp-seed-alice",
            request_digest="d-alice",
            meeting_url="https://meet.google.com/ali-ceee-one",
            provider="google_meet",
            title="Architektur-Board Q4",
            owner_sub="sub-alice",
            owner_email="alice@mayflower.de",
            starts_at=now - timedelta(hours=1),
            ends_at=now - timedelta(minutes=15),
            participation="ended",
            processing="completed",
            protocol_meta={
                "summary": {
                    "summary": "Entscheidung für PostgreSQL 17 Partitionierung.",
                    "topics": [{"title": "Datenbank", "details": "Migration im Dezember."}],
                    "action_items": [{"owner": "Dr. Weber", "task": "Runbook schreiben"}],
                }
            },
        )
        bob_rec = Recording(
            id=bob_rec_id,
            idempotency_key="mcp-seed-bob",
            request_digest="d-bob",
            meeting_url="https://teams.microsoft.com/meet/777888999?p=secret",
            provider="teams",
            title="Bob Vertrauliches HR-Gespräch",
            owner_sub="sub-bob",
            owner_email="bob@mayflower.de",
            starts_at=now + timedelta(hours=2),
            ends_at=now + timedelta(hours=3),
            participation="scheduled",
            processing="pending",
        )
        db.add_all([alice_rec, bob_rec])
        db.flush()

        att = Attempt(
            id=attempt_id,
            recording_id=alice_rec_id,
            credential_hash="unused",
            credential_expires_at=now,
            ended_at=now - timedelta(minutes=15),
            end_reason="normal",
            diagnostics={
                "participant_sources": {
                    "available": True,
                    "total": 1,
                    "truncated": False,
                    "sources": [],
                    "chat_markers": [
                        {
                            "id": "mcp-mk-1",
                            "kind": "decision",
                            "text": "Kubevela Rollout freigegeben",
                            "author": "Dr. Weber",
                            "captured_at": (now - timedelta(minutes=50)).isoformat(),
                        }
                    ],
                    "pause_windows": [
                        {
                            "started_at": (now - timedelta(minutes=40)).isoformat(),
                            "ended_at": (now - timedelta(minutes=38)).isoformat(),
                            "by": "Dr. Weber",
                        }
                    ],
                }
            },
        )
        db.add(att)
        db.flush()

        stream = AudioStream(
            id=stream_row_id,
            attempt_id=attempt_id,
            stream_id=stream_ext_id,
            epoch=stream_epoch,
            final_sample=128000,
            last_sequence=0,
            scan_sample=128000,
            scan_complete=True,
            contract=stream_contract,
        )
        db.add(stream)
        db.flush()

        db.add(
            AudioChunk(
                id=f"{stream_row_id}:0",
                stream_id=stream_row_id,
                sequence=0,
                start_sample=0,
                sample_count=128000,
                checksum=pcm_sha,
                contract=stream_contract,
                object_key=pcm_key,
                object_size=len(pcm_bytes),
            )
        )
        j1 = AsrJob(
            id=job_1_id,
            stream_id=stream_row_id,
            start_sample=0,
            end_sample=16000,
            core_start=0,
            core_end=16000,
            binding=stream_contract,
            status="completed",
        )
        j2 = AsrJob(
            id=job_2_id,
            stream_id=stream_row_id,
            start_sample=96000,
            end_sample=112000,
            core_start=96000,
            core_end=112000,
            binding=stream_contract,
            status="completed",
        )
        db.add_all([j1, j2])
        db.flush()

        db.add_all(
            [
                TranscriptSegment(
                    id=job_1_id,
                    result={
                        "id": job_1_id,
                        "stream_id": str(stream_ext_id),
                        "epoch": str(stream_epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": "rtc:1",
                        "participant_id": "spaces/meet/devices/42",
                        "start": 0.0,
                        "end": 1.0,
                        "confidence": 0.94,
                        "text": "Wir migrieren Kubevela auf ArgoCD bis Freitag.",
                        "participant_name": "Dr. Weber",
                        "speaker_id": "spaces/meet/devices/42",
                        "attribution_unknown": False,
                        "words": [],
                    },
                ),
                TranscriptSegment(
                    id=job_2_id,
                    result={
                        "id": job_2_id,
                        "stream_id": str(stream_ext_id),
                        "epoch": str(stream_epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": "rtc:1",
                        "participant_id": "spaces/meet/devices/42",
                        "start": 6.0,
                        "end": 7.0,
                        "confidence": 0.92,
                        "text": "Die Latenzgrenze bleibt unter 50 Millisekunden.",
                        "participant_name": "Dr. Weber",
                        "speaker_id": "spaces/meet/devices/42",
                        "attribution_unknown": False,
                        "words": [],
                    },
                ),
            ]
        )
        db.commit()

    # Issue a read-only MCP grant for Alice and a full read+write grant for Alice & Bob
    alice_ro = _authorize_mcp_user_via_oidc(
        client,
        active_user,
        sub="sub-alice",
        email="alice@mayflower.de",
        name="Alice Meier",
        scopes=["mcp:read"],
        client_name="Cursor ReadOnly",
    )
    alice_rw = _authorize_mcp_user_via_oidc(
        client,
        active_user,
        sub="sub-alice",
        email="alice@mayflower.de",
        name="Alice Meier",
        scopes=["mcp:read", "mcp:write"],
        client_name="Claude Code ReadWrite",
    )
    bob_rw = _authorize_mcp_user_via_oidc(
        client,
        active_user,
        sub="sub-bob",
        email="bob@mayflower.de",
        name="Bob Schmidt",
        scopes=["mcp:read", "mcp:write"],
        client_name="Bob Desktop MCP",
    )

    ro_headers = {"Authorization": f"Bearer {alice_ro['tokens']['access_token']}"}
    rw_headers = {"Authorization": f"Bearer {alice_rw['tokens']['access_token']}"}
    bob_headers = {"Authorization": f"Bearer {bob_rw['tokens']['access_token']}"}

    def _rpc(hdrs: dict, method: str, params: dict | None = None, rpc_id: int = 1):
        return client.post(
            "/mcp",
            headers=hdrs,
            json={"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}},
        )

    # Initialize + session binding verification
    init_res = _rpc(ro_headers, "initialize", {"protocolVersion": "2025-11-25"})
    assert init_res.status_code == 200
    alice_session_id = init_res.headers["mcp-session-id"]
    assert init_res.json()["result"]["protocolVersion"] == "2025-11-25"

    # Notifications return 202 Accepted
    notif_res = client.post(
        "/mcp",
        headers={**ro_headers, "Mcp-Session-Id": alice_session_id},
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
    )
    assert notif_res.status_code == 202

    # Bob cannot use Alice's Mcp-Session-Id
    cross_session = client.post(
        "/mcp",
        headers={**bob_headers, "Mcp-Session-Id": alice_session_id},
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
    )
    assert cross_session.status_code == 404

    # Disallowed browser Origin is rejected on both OPTIONS and POST /mcp (DNS rebinding guard)
    assert client.options("/mcp", headers={"Origin": "http://evil.example.org"}).status_code == 403
    assert (
        client.post(
            "/mcp",
            headers={**ro_headers, "Origin": "http://evil.example.org"},
            json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        ).status_code
        == 403
    )

    # Strict boolean validation rejects string "false" instead of coercing to True
    bad_bool = _rpc(
        rw_headers,
        "tools/call",
        {
            "name": "toggle_calendar_event_recording",
            "arguments": {"event_id": str(uuid.uuid4()), "enabled": "false"},
        },
    ).json()["result"]
    assert bad_bool["isError"] is True
    assert "enabled must be a boolean" in bad_bool["content"][0]["text"]

    # Read-only grant only exposes the 5 mcp:read tools, while read+write exposes all 11
    ro_tools = {t["name"] for t in _rpc(ro_headers, "tools/list").json()["result"]["tools"]}
    assert ro_tools == {
        "list_recordings",
        "get_recording",
        "get_transcript",
        "export_protocol",
        "list_calendar_events",
    }
    rw_tools = {t["name"] for t in _rpc(rw_headers, "tools/list").json()["result"]["tools"]}
    assert len(rw_tools) == 11
    assert {"schedule_recording", "cancel_recording", "update_protocol"} <= rw_tools

    # Read-only grant gets 403 + insufficient_scope WWW-Authenticate when calling write tools
    ro_write_attempt = _rpc(
        ro_headers,
        "tools/call",
        {
            "name": "schedule_recording",
            "arguments": {"meeting_url": "https://meet.google.com/new-call-now"},
        },
    )
    assert ro_write_attempt.status_code == 403
    assert 'error="insufficient_scope"' in ro_write_attempt.headers["www-authenticate"]

    # Multi-user isolation: Alice finds her recording by transcript query and never sees Bob's
    list_res = _rpc(
        ro_headers,
        "tools/call",
        {"name": "list_recordings", "arguments": {"query": "ArgoCD"}},
    ).json()["result"]
    assert list_res["isError"] is False
    listed_ids = [item["id"] for item in list_res["structuredContent"]["items"]]
    assert listed_ids == [str(alice_rec_id)]

    all_alice_ids = [
        item["id"]
        for item in _rpc(
            ro_headers, "tools/call", {"name": "list_recordings", "arguments": {}}
        ).json()["result"]["structuredContent"]["items"]
    ]
    assert str(bob_rec_id) not in all_alice_ids

    # Alice cannot read, export, or cancel Bob's recording
    bob_get_err = _rpc(
        rw_headers,
        "tools/call",
        {"name": "get_recording", "arguments": {"recording_id": str(bob_rec_id)}},
    ).json()["result"]
    assert bob_get_err["isError"] is True
    bob_cancel_err = _rpc(
        rw_headers,
        "tools/call",
        {"name": "cancel_recording", "arguments": {"recording_id": str(bob_rec_id)}},
    ).json()["result"]
    assert bob_cancel_err["isError"] is True
    bob_res_err = _rpc(
        ro_headers,
        "resources/read",
        {"uri": f"wortlaut://recordings/{bob_rec_id}/protocol.md"},
    ).json()
    assert bob_res_err["error"]["code"] == -32002

    # Alice reads her transcript + verifies isolated WAV audio snippet using her MCP access token!
    tx_res = _rpc(
        ro_headers,
        "tools/call",
        {
            "name": "get_transcript",
            "arguments": {"recording_id": str(alice_rec_id), "speaker": "Weber"},
        },
    ).json()["result"]
    assert tx_res["isError"] is False
    segs = tx_res["structuredContent"]["segments"]
    assert len(segs) == 2
    snippet_path = segs[0]["audio_snippet_path"]
    wav_resp = client.get(snippet_path, headers=ro_headers)
    assert wav_resp.status_code == 200
    assert wav_resp.content[:4] == b"RIFF"
    # Bob's MCP token cannot fetch Alice's audio snippet
    assert client.get(snippet_path, headers=bob_headers).status_code == 404

    # Alice updates speaker override + glossary term replacement via update_protocol
    upd_res = _rpc(
        rw_headers,
        "tools/call",
        {
            "name": "update_protocol",
            "arguments": {
                "recording_id": str(alice_rec_id),
                "notes": "Freigegeben durch Architektur-Gremium.",
                "speaker_overrides": {"Dr. Weber": "Prof. Dr. Martin Weber"},
                "term_replacements": {"Kubevela": "KubeVela"},
            },
        },
    ).json()["result"]
    assert upd_res["isError"] is False

    md_res = _rpc(
        ro_headers,
        "tools/call",
        {
            "name": "export_protocol",
            "arguments": {"recording_id": str(alice_rec_id), "format": "md"},
        },
    ).json()["result"]
    assert "Prof. Dr. Martin Weber" in md_res["content"][0]["text"]
    assert "KubeVela" in md_res["content"][0]["text"]
    assert "Freigegeben durch Architektur-Gremium." in md_res["content"][0]["text"]

    rec_detail_mcp = _rpc(
        ro_headers,
        "tools/call",
        {"name": "get_recording", "arguments": {"recording_id": str(alice_rec_id)}},
    ).json()["result"]["structuredContent"]
    assert rec_detail_mcp["transcript"]["chat_marker_count"] == 1
    assert rec_detail_mcp["transcript"]["pause_window_count"] == 1
    assert rec_detail_mcp["chat_markers"][0]["author"] == "Prof. Dr. Martin Weber"
    assert rec_detail_mcp["chat_markers"][0]["text"] == "KubeVela Rollout freigegeben"

    full_tx_mcp = _rpc(
        ro_headers,
        "tools/call",
        {"name": "get_transcript", "arguments": {"recording_id": str(alice_rec_id)}},
    ).json()["result"]["structuredContent"]
    assert len(full_tx_mcp["chat_markers"]) == 1
    assert len(full_tx_mcp["pause_windows"]) == 1

    # Query & speaker filtering on get_transcript applies to chat_markers and hides pause_windows
    matching_query_mcp = _rpc(
        ro_headers,
        "tools/call",
        {
            "name": "get_transcript",
            "arguments": {"recording_id": str(alice_rec_id), "query": "Rollout"},
        },
    ).json()["result"]
    assert len(matching_query_mcp["structuredContent"]["chat_markers"]) == 1
    assert matching_query_mcp["structuredContent"]["pause_windows"] == []
    assert "[DECISION]" in matching_query_mcp["content"][0]["text"]

    non_matching_speaker_mcp = _rpc(
        ro_headers,
        "tools/call",
        {
            "name": "get_transcript",
            "arguments": {"recording_id": str(alice_rec_id), "speaker": "Nobody"},
        },
    ).json()["result"]["structuredContent"]
    assert non_matching_speaker_mcp["chat_markers"] == []
    assert non_matching_speaker_mcp["pause_windows"] == []

    # Resources & Prompts
    res_list = _rpc(ro_headers, "resources/list").json()["result"]["resources"]
    assert [r["uri"] for r in res_list] == [f"wortlaut://recordings/{alice_rec_id}/protocol.md"]
    res_read = _rpc(
        ro_headers,
        "resources/read",
        {"uri": f"wortlaut://recordings/{alice_rec_id}/protocol.md"},
    ).json()["result"]
    assert "Prof. Dr. Martin Weber" in res_read["contents"][0]["text"]

    prompts_list = _rpc(ro_headers, "prompts/list").json()["result"]["prompts"]
    assert {p["name"] for p in prompts_list} == {"meeting_followup", "decision_audit"}
    prompt_get = _rpc(
        ro_headers,
        "prompts/get",
        {
            "name": "decision_audit",
            "arguments": {"recording_id": str(alice_rec_id), "topic": "ArgoCD"},
        },
    ).json()["result"]
    assert str(alice_rec_id) in prompt_get["messages"][0]["content"]["text"]

    # Schedule & cancel a new recording via MCP write tools
    sched = _rpc(
        rw_headers,
        "tools/call",
        {
            "name": "schedule_recording",
            "arguments": {
                "meeting_url": "https://zoom.us/j/91234567890?pwd=test",
                "title": "MCP Scheduled Zoom Sync",
                "duration_minutes": 45,
            },
        },
    ).json()["result"]
    assert sched["isError"] is False
    new_rec_id = sched["structuredContent"]["id"]
    assert sched["structuredContent"]["provider"] == "zoom"

    canc = _rpc(
        rw_headers,
        "tools/call",
        {"name": "cancel_recording", "arguments": {"recording_id": new_rec_id}},
    ).json()["result"]
    assert canc["isError"] is False
    assert canc["structuredContent"]["cancelled_at"] is not None

    # Web-UI MCP grant management (/v1/mcp/grants): Alice sees her 2 grants, not Bob's
    alice_ui_token, _ = issue_user_session_token(
        sub="sub-alice",
        email="alice@mayflower.de",
        name="Alice Meier",
        exp=int(time.time()) + 3600,
    )
    alice_ui_hdrs = {"Authorization": f"Bearer {alice_ui_token}"}
    bob_ui_token, _ = issue_user_session_token(
        sub="sub-bob",
        email="bob@mayflower.de",
        name="Bob Schmidt",
        exp=int(time.time()) + 3600,
    )
    bob_ui_hdrs = {"Authorization": f"Bearer {bob_ui_token}"}

    alice_grants = client.get("/v1/mcp/grants", headers=alice_ui_hdrs).json()
    assert alice_grants["endpoint"] == "http://testserver/mcp"
    assert {g["client_name"] for g in alice_grants["grants"]} == {
        "Cursor ReadOnly",
        "Claude Code ReadWrite",
    }
    bob_grants = client.get("/v1/mcp/grants", headers=bob_ui_hdrs).json()["grants"]
    assert len(bob_grants) == 1

    # Alice cannot revoke Bob's grant
    assert (
        client.delete(f"/v1/mcp/grants/{bob_grants[0]['id']}", headers=alice_ui_hdrs).status_code
        == 404
    )

    # Revoking Alice's ReadWrite grant via Web-UI immediately invalidates access & refresh tokens
    rw_grant_id = next(
        g["id"] for g in alice_grants["grants"] if g["client_name"] == "Claude Code ReadWrite"
    )
    rev_res = client.delete(f"/v1/mcp/grants/{rw_grant_id}", headers=alice_ui_hdrs)
    assert rev_res.status_code == 200
    assert _rpc(rw_headers, "ping").status_code == 401
    assert (
        client.post(
            "/oauth/token",
            content=urlencode(
                {
                    "grant_type": "refresh_token",
                    "client_id": alice_rw["client_id"],
                    "refresh_token": alice_rw["tokens"]["refresh_token"],
                }
            ),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ).status_code
        == 400
    )

    # RFC 7009 /oauth/revoke revokes Alice's remaining ReadOnly grant
    rfc_rev = client.post(
        "/oauth/revoke",
        content=urlencode({"token": alice_ro["tokens"]["access_token"]}),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert rfc_rev.status_code == 200
    assert _rpc(ro_headers, "ping").status_code == 401
    assert client.get("/v1/mcp/grants", headers=alice_ui_hdrs).json()["grants"] == []
