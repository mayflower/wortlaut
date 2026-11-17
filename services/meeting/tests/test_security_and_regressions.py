"""Targeted regression & security integration tests for the 2026-11-17 review fixes."""

import json
import re
import time
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_calendar import configure as configure_calendar
from test_calendar import imported, mail
from test_recordings import API


def test_ui_boot_script_escapes_script_breakout_xss(client, monkeypatch):
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_ASSISTANT_NAME", "</script><script>alert(1)</script>")
    monkeypatch.setenv("WORTLAUT_PRIVACY_URL", "https://example.org/privacy?a=1&b=</script>")
    get_settings.cache_clear()

    res = client.get("/ui")
    assert res.status_code == 200
    html = res.text
    assert "</script><script>alert(1)" not in html
    m = re.search(r"window\.__WORTLAUT_BOOT__\s*=\s*(\{.*?\});\s*</script>", html, re.DOTALL)
    assert m is not None
    parsed = json.loads(m.group(1))
    assert parsed["instance"]["assistantName"] == "</script><script>alert(1)</script>"


def test_oidc_discovery_and_pyjwt_es256_eddsa_verification(client, monkeypatch):
    import wortlaut.oidc as oidc_mod
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_OIDC_ISSUER", "https://sso.corp.internal/realms/main")
    monkeypatch.setenv("WORTLAUT_OIDC_INTERNAL_ISSUER", "http://keycloak.svc:8080/realms/main")
    monkeypatch.setenv("WORTLAUT_OIDC_CLIENT_ID", "wortlaut-web")
    monkeypatch.setenv("WORTLAUT_OIDC_ALLOWED_DOMAINS", '["mayflower.de"]')
    get_settings.cache_clear()

    ec_priv = ec.generate_private_key(ec.SECP256R1())
    ed_priv = ed25519.Ed25519PrivateKey.generate()
    ec_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(ec_priv.public_key()))
    ec_jwk.update({"kid": "ec-k1", "alg": "ES256", "use": "sig"})
    ed_jwk = json.loads(jwt.algorithms.OKPAlgorithm.to_jwk(ed_priv.public_key()))
    ed_jwk.update({"kid": "ed-k1", "alg": "EdDSA", "use": "sig"})

    class _FakeHttpResp:
        def __init__(self, data: dict):
            self.status_code = 200
            self._data = data

        def raise_for_status(self):
            pass

        def json(self):
            return self._data

    seen_urls: list[str] = []

    def fake_get(url: str, **kwargs):
        seen_urls.append(url)
        if url.endswith("/.well-known/openid-configuration"):
            return _FakeHttpResp(
                {
                    "issuer": "https://sso.corp.internal/realms/main",
                    "authorization_endpoint": (
                        "https://sso.corp.internal/realms/main/protocol/openid-connect/auth"
                    ),
                    "token_endpoint": (
                        "https://sso.corp.internal/realms/main/protocol/openid-connect/token"
                    ),
                    "jwks_uri": (
                        "https://sso.corp.internal/realms/main/protocol/openid-connect/certs"
                    ),
                }
            )
        if url.endswith("/protocol/openid-connect/certs"):
            return _FakeHttpResp({"keys": [ec_jwk, ed_jwk]})
        raise AssertionError(f"Unexpected URL: {url}")

    monkeypatch.setattr(oidc_mod.httpx, "get", fake_get)

    cfg = client.get("/v1/auth/oidc/config").json()
    assert cfg["enabled"] is True
    assert (
        cfg["authorization_endpoint"]
        == "https://sso.corp.internal/realms/main/protocol/openid-connect/auth"
    )
    assert (
        oidc_mod.get_oidc_token_endpoint()
        == "http://keycloak.svc:8080/realms/main/protocol/openid-connect/token"
    )

    now = int(time.time())
    for alg, priv, kid in [("ES256", ec_priv, "ec-k1"), ("EdDSA", ed_priv, "ed-k1")]:
        tok = jwt.encode(
            {
                "iss": "https://sso.corp.internal/realms/main/",
                "sub": f"user-{alg}",
                "aud": "wortlaut-web",
                "iat": now,
                "exp": now + 600,
                "nonce": "n-123",
                "email": "clara@mayflower.de",
                "email_verified": True,
                "name": "Clara Auth",
            },
            priv,
            algorithm=alg,
            headers={"kid": kid},
        )
        claims = oidc_mod.verify_dex_id_token(tok, expected_nonce="n-123")
        assert claims["sub"] == f"user-{alg}"
        assert claims["email"] == "clara@mayflower.de"

    assert "http://keycloak.svc:8080/realms/main/protocol/openid-connect/certs" in seen_urls


def test_dedicated_encryption_key_survives_api_token_rotation(monkeypatch):
    import wortlaut.calendar_oauth as cal_oauth
    from wortlaut.settings import get_settings

    # 1. Legacy ciphertext encrypted before WORTLAUT_ENCRYPTION_KEY was configured
    monkeypatch.setenv("WORTLAUT_API_TOKEN", "old-operator-api-token")
    monkeypatch.delenv("WORTLAUT_ENCRYPTION_KEY", raising=False)
    get_settings.cache_clear()
    legacy_cipher = cal_oauth.encrypt_secret("google-refresh-secret-1")

    # 2. Dedicated WORTLAUT_ENCRYPTION_KEY: legacy cipher still decrypts via MultiFernet
    monkeypatch.setenv("WORTLAUT_ENCRYPTION_KEY", "dedicated-fernet-master-secret-2026")
    get_settings.cache_clear()
    assert cal_oauth.decrypt_secret(legacy_cipher) == "google-refresh-secret-1"

    # 3. New ciphertexts under WORTLAUT_ENCRYPTION_KEY survive WORTLAUT_API_TOKEN rotation!
    modern_cipher = cal_oauth.encrypt_secret("google-refresh-secret-2")
    monkeypatch.setenv("WORTLAUT_API_TOKEN", "rotated-brand-new-operator-api-token")
    get_settings.cache_clear()
    assert cal_oauth.decrypt_secret(modern_cipher) == "google-refresh-secret-2"


def test_calendar_oauth_pagination_truncation_guard_and_refresh_token_preservation(
    database, monkeypatch
):
    import wortlaut.calendar_oauth as cal_oauth
    from wortlaut.models import CalendarConnection, CalendarSyncedEvent, Recording
    from wortlaut.oidc import Principal
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    monkeypatch.setenv("WORTLAUT_GOOGLE_CALENDAR_CLIENT_ID", "g-client-id")
    monkeypatch.setenv("WORTLAUT_GOOGLE_CALENDAR_CLIENT_SECRET", "g-client-secret")
    get_settings.cache_clear()
    now = datetime.now(UTC).replace(microsecond=0)

    # 1. Google multi-page pagination via nextPageToken (>250 events)
    pages_called: list[str | None] = []

    class _FakeResp:
        def __init__(self, payload: dict):
            self.status_code = 200
            self._payload = payload

        def json(self):
            return self._payload

    def fake_get(url: str, *, params=None, headers=None, timeout=15.0):
        page_tok = (params or {}).get("pageToken")
        pages_called.append(page_tok)
        if page_tok is None:
            return _FakeResp(
                {
                    "items": [
                        {
                            "id": f"ev-p1-{i}",
                            "status": "confirmed",
                            "summary": f"Page 1 #{i}",
                            "start": {"dateTime": (now + timedelta(hours=1)).isoformat()},
                            "end": {"dateTime": (now + timedelta(hours=2)).isoformat()},
                            "hangoutLink": "https://meet.google.com/abc-defg-hij",
                            "organizer": {"email": "alice@mayflower.de", "self": True},
                            "attendees": [
                                {"email": "bob@mayflower.de", "responseStatus": "accepted"}
                            ],
                        }
                        for i in range(2)
                    ],
                    "nextPageToken": "page-2-cursor",
                }
            )
        assert page_tok == "page-2-cursor"
        return _FakeResp(
            {
                "items": [
                    {
                        "id": "ev-p2-keep",
                        "status": "confirmed",
                        "summary": "Page 2 Event (>250)",
                        "start": {"dateTime": (now + timedelta(days=10)).isoformat()},
                        "end": {"dateTime": (now + timedelta(days=10, hours=1)).isoformat()},
                        "hangoutLink": "https://meet.google.com/klm-nopq-rst",
                        "organizer": {"email": "alice@mayflower.de", "self": True},
                        "attendees": [
                            {"email": "bob@mayflower.de", "responseStatus": "accepted"}
                        ],
                    }
                ]
            }
        )

    monkeypatch.setattr(cal_oauth.httpx, "get", fake_get)

    with Session(database) as db:
        conn = CalendarConnection(
            owner_sub="sub-alice",
            owner_email="alice@mayflower.de",
            provider="google",
            account_email="alice@mayflower.de",
            encrypted_access_token=cal_oauth.encrypt_secret("acc-1"),
            encrypted_refresh_token=cal_oauth.encrypt_secret("original-refresh-token"),
            token_expires_at=now + timedelta(hours=1),
        )
        db.add(conn)
        db.commit()
        snap = cal_oauth.snapshot_connection(conn)

    fetched, updated_snap, sync_err = cal_oauth.fetch_connection_events_unlocked(snap, now)
    assert sync_err is None
    assert pages_called == [None, "page-2-cursor"]
    assert {e["external_event_id"] for e in fetched} == {"ev-p1-0", "ev-p1-1", "ev-p2-keep"}
    assert fetched.truncated is False

    with Session(database) as db:
        conn_row = db.get(CalendarConnection, snap.id)
        assert conn_row is not None
        cal_oauth.apply_synced_events(db, conn_row, fetched, updated_snap, sync_err, now)
        db.commit()
        ev_p2 = db.scalar(
            select(CalendarSyncedEvent).where(
                CalendarSyncedEvent.external_event_id == "ev-p2-keep"
            )
        )
        assert ev_p2 is not None and ev_p2.recording_id is not None
        rec_p2_id = ev_p2.recording_id

    # 2. If pagination hits safety ceiling (truncated=True), unseen events MUST NOT cancel!
    partial = cal_oauth._EventPageList([fetched[0]], truncated=True)
    with Session(database) as db:
        conn_row = db.get(CalendarConnection, snap.id)
        assert conn_row is not None
        cal_oauth.apply_synced_events(db, conn_row, partial, updated_snap, None, now)
        db.commit()
        rec_p2 = db.get(Recording, rec_p2_id)
        assert rec_p2 is not None
        assert rec_p2.cancelled_at is None
        assert rec_p2.participation == "scheduled"

    # 3. Re-auth omitting refresh_token preserves existing encrypted_refresh_token!
    def fake_post(url: str, **kwargs):
        return _FakeResp({"access_token": "short-lived-1h-access", "expires_in": 3600})

    def fake_userinfo(url: str, **kwargs):
        return _FakeResp({"email": "alice@mayflower.de"})

    monkeypatch.setattr(cal_oauth.httpx, "post", fake_post)
    monkeypatch.setattr(cal_oauth.httpx, "get", fake_userinfo)
    monkeypatch.setattr(cal_oauth, "sync_connection", lambda db, c, now=None: [])

    principal = Principal(
        kind="user", sub="sub-alice", email="alice@mayflower.de", name="Alice", is_admin=False
    )
    with Session(database) as db:
        cal_oauth.exchange_calendar_oauth_code(
            db,
            principal=principal,
            provider="google",
            code="oauth-reauth-code",
            code_verifier="v" * 48,
            redirect_uri="http://localhost:34601/auth/callback",
        )
        updated_conn = db.get(CalendarConnection, snap.id)
        assert updated_conn is not None
        assert (
            cal_oauth.decrypt_secret(updated_conn.encrypted_refresh_token)
            == "original-refresh-token"
        )
        assert cal_oauth.decrypt_secret(updated_conn.encrypted_access_token) == (
            "short-lived-1h-access"
        )


def test_ics_duration_import_and_email_boundary_isolation(client, database, monkeypatch):
    from wortlaut.oidc import issue_user_session_token
    from wortlaut.recurrence import recurrence_pass
    from wortlaut.settings import get_settings

    configure_calendar(monkeypatch)
    monkeypatch.setenv(
        "WORTLAUT_ORGANIZER_PERMISSIONS",
        '{"alice_1@example.org":["alice_1@example.org"]}',
    )
    get_settings.cache_clear()
    now = datetime(2026, 10, 23, tzinfo=UTC)

    # VEVENT using RFC 5545 DURATION instead of DTEND + RRULE
    raw_ics = (
        b"From: alice_1@example.org\r\n"
        b"To: bot@example.org\r\n"
        b"X-Wortlaut-Authenticated-Sender: alice_1@example.org\r\n"
        b"MIME-Version: 1.0\r\n"
        b"Content-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\n"
        b"BEGIN:VCALENDAR\r\n"
        b"VERSION:2.0\r\n"
        b"PRODID:-//wortlaut//test//EN\r\n"
        b"METHOD:REQUEST\r\n"
        b"BEGIN:VEVENT\r\n"
        b"UID:duration-series-1@example.org\r\n"
        b"SEQUENCE:0\r\n"
        b"DTSTAMP:20261001T100000Z\r\n"
        b"ORGANIZER:mailto:alice_1@example.org\r\n"
        b"ATTENDEE:mailto:bob@example.org\r\n"
        b"DTSTART:20261024T090000Z\r\n"
        b"DURATION:PT45M\r\n"
        b"RRULE:FREQ=DAILY;COUNT=2\r\n"
        b"SUMMARY:RFC 5545 Duration Standup\r\n"
        b"DESCRIPTION:https://example.webex.com/meet/duration\r\n"
        b"END:VEVENT\r\n"
        b"END:VCALENDAR\r\n"
    )

    res = imported(client, raw_ics)
    assert res["status"] == "not_expanded"
    recurrence_pass(database, now)

    # Also import a single non-recurring invite with DURATION
    single_ics = mail(
        uid="single-duration@example.org",
        sender="alice_1@example.org",
        organizer="alice_1@example.org",
        starts="DTSTART:20991024T090000Z",
        ends="DURATION:PT30M",
    )
    single_res = imported(client, single_ics)
    assert single_res["status"] == "accepted"
    rec_id = single_res["recording_id"]

    # Verify SQL '_' wildcard and prefix spoofing CANNOT access alice_1's recording
    exp = int(time.time()) + 3600
    alice_tok, _ = issue_user_session_token(sub="s1", email="alice_1@example.org", exp=exp)
    spoof_wildcard_tok, _ = issue_user_session_token(
        sub="s2", email="alicex1@example.org", exp=exp
    )
    spoof_prefix_tok, _ = issue_user_session_token(sub="s3", email="alice_1@example.o", exp=exp)

    assert (
        client.get(
            f"/v1/recordings/{rec_id}", headers={"Authorization": f"Bearer {alice_tok}"}
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/v1/recordings/{rec_id}",
            headers={"Authorization": f"Bearer {spoof_wildcard_tok}"},
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/v1/recordings/{rec_id}",
            headers={"Authorization": f"Bearer {spoof_prefix_tok}"},
        ).status_code
        == 404
    )


def test_shared_sfu_stream_honest_attribution_snippet_opt_out_and_word_boundary_replacements(
    client, database, storage
):
    from wortlaut.models import (
        AsrJob,
        Attempt,
        AudioChunk,
        AudioControl,
        AudioStream,
        Recording,
        TranscriptSegment,
    )

    now = datetime.now(UTC).replace(microsecond=0)
    origin_iso = (now - timedelta(minutes=10)).isoformat()
    rec_id = uuid.uuid4()
    att_id = uuid.uuid4()
    stream_pk = uuid.uuid4()
    stream_ext = uuid.uuid4()
    epoch = uuid.uuid4()

    # Shared SFU receiver: initially attribution_unknown, then bound to Alice at 0.1s (sample 1600),
    # then unbound at 2.0s (sample 32000), then bound to Bob (who opts out!) at 4.0s (sample 64000).
    init_contract = {
        "source_kind": "speaker",
        "provider_source_id": f"google_meet:{rec_id}:receiver:1",
        "speaker_id": None,
        "participant_id": None,
        "participant_name": None,
        "attribution_unknown": True,
        "session_utc_origin": origin_iso,
        "monotonic_origin_ms": 0,
        "session_monotonic_origin_ms": 0,
    }
    pcm_bytes = b"\x20\x00" * 96000  # 6.0 seconds of 16kHz s16le PCM
    pcm_key = f"audio/{rec_id}/{att_id}/{stream_ext}/000000.pcm"
    pcm_sha = storage.put(pcm_key, pcm_bytes, init_contract)

    with Session(database) as db:
        rec = Recording(
            id=rec_id,
            idempotency_key="sfu-shared-optout",
            request_digest="d-sfu",
            meeting_url="https://meet.google.com/sfu-test-one",
            provider="google_meet",
            title="SFU Multi-Speaker Test",
            starts_at=now - timedelta(minutes=10),
            ends_at=now - timedelta(minutes=4),
            participation="ended",
            processing="completed",
            protocol_meta={
                "opted_out_speakers": ["bob-id"],
                "term_replacements": {
                    "ai": "AI",
                    "AI": "Artificial Intelligence",
                },
            },
        )
        att = Attempt(
            id=att_id,
            recording_id=rec_id,
            credential_hash="unused",
            credential_expires_at=now,
            ended_at=now - timedelta(minutes=4),
            end_reason="normal",
        )
        stream = AudioStream(
            id=stream_pk,
            attempt_id=att_id,
            stream_id=stream_ext,
            epoch=epoch,
            final_sample=96000,
            last_sequence=0,
            scan_sample=96000,
            scan_complete=True,
            contract=init_contract,
        )
        db.add(rec)
        db.flush()
        db.add(att)
        db.flush()
        db.add(stream)
        db.flush()

        db.add_all(
            [
                AudioControl(
                    id=f"{att_id}/{stream_ext}/{epoch}/1600/bind",
                    stream_id=stream_pk,
                    kind="bind",
                    sequence=1600,
                    contract={
                        "type": "bind",
                        "start_sample": 1600,
                        "source_kind": "speaker",
                        "provider_source_id": init_contract["provider_source_id"],
                        "speaker_id": "alice-id",
                        "participant_id": "alice-id",
                        "participant_name": "Alice",
                        "attribution_unknown": False,
                    },
                ),
                AudioControl(
                    id=f"{att_id}/{stream_ext}/{epoch}/32000/bind",
                    stream_id=stream_pk,
                    kind="bind",
                    sequence=32000,
                    contract={
                        "type": "bind",
                        "start_sample": 32000,
                        "source_kind": "speaker",
                        "provider_source_id": init_contract["provider_source_id"],
                        "speaker_id": None,
                        "participant_id": None,
                        "participant_name": None,
                        "attribution_unknown": True,
                    },
                ),
                AudioControl(
                    id=f"{att_id}/{stream_ext}/{epoch}/64000/bind",
                    stream_id=stream_pk,
                    kind="bind",
                    sequence=64000,
                    contract={
                        "type": "bind",
                        "start_sample": 64000,
                        "source_kind": "speaker",
                        "provider_source_id": init_contract["provider_source_id"],
                        "speaker_id": "bob-id",
                        "participant_id": "bob-id",
                        "participant_name": "Bob",
                        "attribution_unknown": False,
                    },
                ),
                AudioChunk(
                    id=f"{stream_pk}:0",
                    stream_id=stream_pk,
                    sequence=0,
                    start_sample=0,
                    sample_count=96000,
                    checksum=pcm_sha,
                    contract=init_contract,
                    object_key=pcm_key,
                    object_size=len(pcm_bytes),
                ),
            ]
        )

        j_alice = AsrJob(
            id=str(uuid.uuid4()),
            stream_id=stream_pk,
            start_sample=1600,
            end_sample=24000,
            core_start=1600,
            core_end=24000,
            binding={},
            status="completed",
        )
        j_unk = AsrJob(
            id=str(uuid.uuid4()),
            stream_id=stream_pk,
            start_sample=33600,
            end_sample=48000,
            core_start=33600,
            core_end=48000,
            binding={},
            status="completed",
        )
        db.add_all([j_alice, j_unk])
        db.flush()

        db.add_all(
            [
                TranscriptSegment(
                    id=j_alice.id,
                    result={
                        "id": j_alice.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": init_contract["provider_source_id"],
                        "participant_id": "alice-id",
                        "participant_name": "Alice",
                        "speaker_id": "alice-id",
                        "attribution_unknown": False,
                        "start": 0.2,
                        "end": 1.5,
                        "text": "She said ai helps our workflow.",
                        "words": [],
                    },
                ),
                TranscriptSegment(
                    id=j_unk.id,
                    result={
                        "id": j_unk.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": init_contract["provider_source_id"],
                        "participant_id": None,
                        "participant_name": None,
                        "speaker_id": None,
                        "attribution_unknown": True,
                        "start": 2.2,
                        "end": 3.0,
                        "text": "Unbound transition phrase.",
                        "words": [],
                    },
                ),
            ]
        )
        db.commit()

    tx = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    segs = tx["segments"]
    assert len(segs) == 2
    # F-16: Word-boundary single-pass replacement ("said" preserved, no chaining)
    assert segs[0]["text"] == "She said AI helps our workflow."
    assert segs[0]["attribution_unknown"] is False
    # F-03: Multi-speaker stream MUST NOT guess nearest speaker for attribution_unknown segment!
    assert segs[1]["attribution_unknown"] is True
    assert segs[1]["speaker_id"] is None

    # F-10: Missing stream_id is rejected (404)
    assert (
        client.get(
            f"/v1/recordings/{rec_id}/audio-snippet",
            params={"start": 0.2, "end": 1.5},
            headers=API,
        ).status_code
        == 404
    )
    # F-10: Alice's bound interval [0.2, 1.5] on shared SFU stream IS allowed!
    alice_wav = client.get(
        f"/v1/recordings/{rec_id}/audio-snippet",
        params={"stream_id": str(stream_ext), "start": 0.2, "end": 1.5},
        headers=API,
    )
    assert alice_wav.status_code == 200
    assert alice_wav.content[:4] == b"RIFF"

    # F-10: Bob's opted-out interval [4.2, 5.5] on the SAME shared SFU stream IS blocked!
    bob_wav = client.get(
        f"/v1/recordings/{rec_id}/audio-snippet",
        params={"stream_id": str(stream_ext), "start": 4.2, "end": 5.5},
        headers=API,
    )
    assert bob_wav.status_code == 404
    assert "speaker_opted_out" in bob_wav.text

    # F-10: Unattributed interval [2.2, 3.0] when opt-outs exist on recording IS blocked!
    unk_wav = client.get(
        f"/v1/recordings/{rec_id}/audio-snippet",
        params={"stream_id": str(stream_ext), "start": 2.2, "end": 3.0},
        headers=API,
    )
    assert unk_wav.status_code == 404


def test_mcp_https_origin_allowlist_and_register_rate_limit(client, monkeypatch):
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_MCP_ALLOWED_ORIGINS", '["https://claude.ai"]')
    get_settings.cache_clear()

    # Arbitrary HTTPS Origin MUST be rejected (F-09)
    evil_opt = client.options("/mcp", headers={"Origin": "https://evil-attacker.org"})
    assert evil_opt.status_code == 403
    # Explicitly configured HTTPS Origin IS allowed
    ok_opt = client.options("/mcp", headers={"Origin": "https://claude.ai"})
    assert ok_opt.status_code == 204
    assert ok_opt.headers.get("access-control-allow-origin") == "https://claude.ai"

    # Dynamic Client Registration rate limit (40/min per IP)
    statuses = [
        client.post(
            "/oauth/register",
            json={"client_name": f"Bot {i}", "redirect_uris": ["http://127.0.0.1/cb"]},
        ).status_code
        for i in range(42)
    ]
    assert statuses[:40] == [201] * 40
    assert statuses[40] == 429


def test_docker_runtime_recovers_running_worker_after_process_restart(
    client, database, tmp_path, monkeypatch
):
    from test_recordings import create

    from wortlaut import controller as controller_module
    from wortlaut.controller import controller_pass
    from wortlaut.models import Attempt
    from wortlaut.runtime_backends import DockerRuntime
    from wortlaut.settings import get_settings

    monkeypatch.setattr(controller_module, "SCHEDULER_LOCK", uuid.uuid4().int >> 65)
    monkeypatch.setenv("WORTLAUT_WEBEX_SERVICE_TOKEN", "controlled-provider-not-real-webex")
    get_settings.cache_clear()

    engine_containers: dict[str, dict] = {}

    def fake_docker(method: str, path: str, payload: dict | None = None) -> tuple[int, str]:
        if method == "POST" and path.startswith("/containers/create?"):
            name = path.split("name=", 1)[1]
            cid = uuid.uuid4().hex
            engine_containers[name] = {
                "Id": cid,
                "Names": [f"/{name}"],
                "Labels": (payload or {}).get("Labels") or {},
                "State": "created",
                "Running": False,
                "ExitCode": 0,
                "Created": int(time.time()),
            }
            return 201, json.dumps({"Id": cid})
        if method == "POST" and path.endswith("/start"):
            name = path.split("/")[2]
            engine_containers[name]["State"] = "running"
            engine_containers[name]["Running"] = True
            return 204, ""
        if method == "GET" and path == "/containers/json?all=1":
            return 200, json.dumps(list(engine_containers.values()))
        if method == "GET" and path.endswith("/json"):
            name = path.split("/")[2]
            if name not in engine_containers:
                return 404, ""
            c = engine_containers[name]
            return 200, json.dumps({"State": {"Running": c["Running"], "ExitCode": c["ExitCode"]}})
        if method == "DELETE":
            name = path.split("/")[2].split("?")[0]
            engine_containers.pop(name, None)
            return 204, ""
        return 404, ""

    state_dir = tmp_path / "docker-restart-state"
    rt1 = DockerRuntime(root=state_dir)
    monkeypatch.setattr(rt1, "_docker_request", fake_docker)

    rec_id = create(client, key="docker-restart-recovery")
    controller_pass(database, (rt1, rt1))
    controller_pass(database, (rt1, rt1))
    assert len(engine_containers) == 1

    with Session(database) as db:
        first_attempt = db.scalar(select(Attempt).where(Attempt.recording_id == uuid.UUID(rec_id)))
        assert first_attempt is not None
        first_attempt_id = first_attempt.id

    # Simulate container restart: fresh DockerRuntime with empty in-memory self.jobs!
    rt2 = DockerRuntime(root=state_dir)
    assert rt2.jobs == {}
    monkeypatch.setattr(rt2, "_docker_request", fake_docker)

    controller_pass(database, (rt2, rt2))
    # Must adopt the running container rather than failing job_missing or duplicating!
    assert len(engine_containers) == 1
    detail = client.get(f"/v1/recordings/{rec_id}", headers=API).json()
    assert detail["active_attempt_id"] == str(first_attempt_id)
    assert detail["participation_reason"] is None
