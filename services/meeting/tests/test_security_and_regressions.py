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
    monkeypatch.setenv("WORTLAUT_OIDC_ALLOWED_DOMAINS", '["acme.example.org"]')
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
                "email": "clara@acme.example.org",
                "email_verified": True,
                "name": "Clara Auth",
            },
            priv,
            algorithm=alg,
            headers={"kid": kid},
        )
        claims = oidc_mod.verify_dex_id_token(tok, expected_nonce="n-123")
        assert claims["sub"] == f"user-{alg}"
        assert claims["email"] == "clara@acme.example.org"

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
                            "organizer": {"email": "alice@acme.example.org", "self": True},
                            "attendees": [
                                {"email": "bob@acme.example.org", "responseStatus": "accepted"}
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
                        "organizer": {"email": "alice@acme.example.org", "self": True},
                        "attendees": [
                            {"email": "bob@acme.example.org", "responseStatus": "accepted"}
                        ],
                    }
                ]
            }
        )

    monkeypatch.setattr(cal_oauth.httpx, "get", fake_get)

    with Session(database) as db:
        conn = CalendarConnection(
            owner_sub="sub-alice",
            owner_email="alice@acme.example.org",
            provider="google",
            account_email="alice@acme.example.org",
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
            select(CalendarSyncedEvent).where(CalendarSyncedEvent.external_event_id == "ev-p2-keep")
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
        return _FakeResp({"email": "alice@acme.example.org"})

    monkeypatch.setattr(cal_oauth.httpx, "post", fake_post)
    monkeypatch.setattr(cal_oauth.httpx, "get", fake_userinfo)
    monkeypatch.setattr(cal_oauth, "sync_connection", lambda db, c, now=None: [])

    principal = Principal(
        kind="user", sub="sub-alice", email="alice@acme.example.org", name="Alice", is_admin=False
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
    spoof_wildcard_tok, _ = issue_user_session_token(sub="s2", email="alicex1@example.org", exp=exp)
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


def test_csrc_onset_binding_and_optout_purge_and_calendar_attendee_context(
    client, database, storage
):
    from wortlaut.asr import build_asr_context_prompt
    from wortlaut.calendar_oauth import _merge_recording_attendees
    from wortlaut.models import (
        AsrJob,
        Attempt,
        AudioChunk,
        AudioControl,
        AudioStream,
        Recording,
        TranscriptSegment,
    )
    from wortlaut.processing import purge_opted_out_transcript_segments

    now = datetime.now(UTC)
    origin_iso = (now - timedelta(minutes=8)).isoformat()
    rec_id = uuid.uuid4()
    att_id = uuid.uuid4()
    stream_pk = uuid.uuid4()
    stream_ext = uuid.uuid4()
    epoch = uuid.uuid4()
    prov_src = f"google_meet:{rec_id}:receiver:3"

    init_contract = {
        "source_kind": "speaker",
        "provider_source_id": prov_src,
        "speaker_id": None,
        "participant_id": None,
        "participant_name": None,
        "attribution_unknown": True,
        "session_utc_origin": origin_iso,
        "monotonic_origin_ms": 0,
        "session_monotonic_origin_ms": 0,
    }
    pcm_bytes = b"\x18\x00" * (16000 * 10)  # 10.0 s of 16 kHz PCM
    pcm_key = f"audio/{rec_id}/{att_id}/{stream_ext}/000000.pcm"
    pcm_sha = storage.put(pcm_key, pcm_bytes, init_contract)

    with Session(database) as db:
        rec = Recording(
            id=rec_id,
            idempotency_key="csrc-onset-test",
            request_digest="d-onset",
            meeting_url="https://meet.google.com/csrc-onset-demo",
            provider="google_meet",
            title="Demo Webex Transkription",
            starts_at=now - timedelta(minutes=8),
            ends_at=now - timedelta(minutes=2),
            participation="ended",
            processing="completed",
            protocol_meta={},
        )
        _merge_recording_attendees(
            rec,
            ["nico.meier@acme.one", "maya@example.org"],
            ["Nico Meier", "Maya Lindner-Berg", "Eve OptedOut"],
        )
        att = Attempt(
            id=att_id,
            recording_id=rec_id,
            credential_hash="unused",
            credential_expires_at=now,
            ended_at=now - timedelta(minutes=2),
            end_reason="normal",
        )
        stream = AudioStream(
            id=stream_pk,
            attempt_id=att_id,
            stream_id=stream_ext,
            epoch=epoch,
            final_sample=16000 * 10,
            last_sequence=0,
            scan_sample=16000 * 10,
            scan_complete=True,
            contract=init_contract,
        )
        db.add(rec)
        db.flush()
        db.add(att)
        db.flush()
        db.add(stream)
        db.flush()

        # 0.0..0.801s (0..12818): CSRC onset unbound -> 12818: bind Volkmar
        # 5.0s (80000): unbind -> 5.801s (92816): bind Eve (who later opts out!)
        db.add_all(
            [
                AudioControl(
                    id=f"{att_id}/{stream_ext}/{epoch}/12818/bind",
                    stream_id=stream_pk,
                    kind="bind",
                    sequence=12818,
                    start_sample=12818,
                    contract={
                        "type": "bind",
                        "start_sample": 12818,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "speaker_id": "volkmar-id",
                        "participant_id": "volkmar-id",
                        "participant_name": "Stefan Novak",
                        "attribution_unknown": False,
                    },
                ),
                AudioControl(
                    id=f"{att_id}/{stream_ext}/{epoch}/80000/bind",
                    stream_id=stream_pk,
                    kind="bind",
                    sequence=80000,
                    start_sample=80000,
                    contract={
                        "type": "bind",
                        "start_sample": 80000,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "speaker_id": None,
                        "participant_id": None,
                        "participant_name": None,
                        "attribution_unknown": True,
                    },
                ),
                AudioControl(
                    id=f"{att_id}/{stream_ext}/{epoch}/92816/bind",
                    stream_id=stream_pk,
                    kind="bind",
                    sequence=92816,
                    start_sample=92816,
                    contract={
                        "type": "bind",
                        "start_sample": 92816,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "speaker_id": "eve-id",
                        "participant_id": "eve-id",
                        "participant_name": "Eve OptedOut",
                        "attribution_unknown": False,
                    },
                ),
                AudioChunk(
                    id=f"{stream_pk}:0",
                    stream_id=stream_pk,
                    sequence=0,
                    start_sample=0,
                    sample_count=16000 * 10,
                    checksum=pcm_sha,
                    contract=init_contract,
                    object_key=pcm_key,
                    object_size=len(pcm_bytes),
                ),
            ]
        )

        j_v_onset = AsrJob(
            id="a" * 64,
            stream_id=stream_pk,
            start_sample=0,
            end_sample=12818,
            core_start=0,
            core_end=12818,
            binding=init_contract,
            status="completed",
        )
        j_v_cont = AsrJob(
            id="b" * 64,
            stream_id=stream_pk,
            start_sample=12818,
            end_sample=64000,
            core_start=12818,
            core_end=64000,
            binding={
                "source_kind": "speaker",
                "provider_source_id": prov_src,
                "speaker_id": "volkmar-id",
                "participant_id": "volkmar-id",
                "participant_name": "Stefan Novak",
                "attribution_unknown": False,
            },
            status="completed",
        )
        j_e_onset = AsrJob(
            id="c" * 64,
            stream_id=stream_pk,
            start_sample=80000,
            end_sample=92816,
            core_start=80000,
            core_end=92816,
            binding=init_contract,
            status="completed",
        )
        j_other1 = AsrJob(
            id="d" * 64,
            stream_id=stream_pk,
            start_sample=64000,
            end_sample=72000,
            core_start=64000,
            core_end=72000,
            binding=j_v_cont.binding,
            status="completed",
        )
        j_other2 = AsrJob(
            id="e" * 64,
            stream_id=stream_pk,
            start_sample=72000,
            end_sample=78000,
            core_start=72000,
            core_end=78000,
            binding=j_v_cont.binding,
            status="completed",
        )
        db.add_all([j_v_onset, j_v_cont, j_e_onset, j_other1, j_other2])
        db.flush()
        db.add_all(
            [
                TranscriptSegment(
                    id=j_v_onset.id,
                    result={
                        "id": j_v_onset.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "participant_id": None,
                        "participant_name": None,
                        "speaker_id": None,
                        "attribution_unknown": True,
                        "start": 0.12,
                        "end": 0.80,
                        "text": "Na, wollte ich.",
                        "words": [],
                    },
                ),
                TranscriptSegment(
                    id=j_v_cont.id,
                    result={
                        "id": j_v_cont.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "participant_id": "volkmar-id",
                        "participant_name": "Stefan Novak",
                        "speaker_id": "volkmar-id",
                        "attribution_unknown": False,
                        "start": 0.81,
                        "end": 3.60,
                        "text": "nur sagen, die haben sich intern zusammengesetzt.",
                        "words": [],
                    },
                ),
                TranscriptSegment(
                    id=j_other1.id,
                    result={
                        "id": j_other1.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "participant_id": "volkmar-id",
                        "participant_name": "Stefan Novak",
                        "speaker_id": "volkmar-id",
                        "attribution_unknown": False,
                        "start": 4.0,
                        "end": 4.4,
                        "text": "Genau.",
                        "words": [],
                    },
                ),
                TranscriptSegment(
                    id=j_other2.id,
                    result={
                        "id": j_other2.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "participant_id": "volkmar-id",
                        "participant_name": "Stefan Novak",
                        "speaker_id": "volkmar-id",
                        "attribution_unknown": False,
                        "start": 4.5,
                        "end": 4.8,
                        "text": "Danke.",
                        "words": [],
                    },
                ),
                TranscriptSegment(
                    id=j_e_onset.id,
                    result={
                        "id": j_e_onset.id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": prov_src,
                        "participant_id": None,
                        "participant_name": None,
                        "speaker_id": None,
                        "attribution_unknown": True,
                        "start": 5.05,
                        "end": 5.80,
                        "text": "Aber ich möchte nicht.",
                        "words": [],
                    },
                ),
            ]
        )
        db.commit()

        # Eve opts out -> <=1.0s CSRC onset segment is purged + removed from context
        rec_db = db.get(Recording, rec_id)
        rec_db.protocol_meta = {
            **dict(rec_db.protocol_meta or {}),
            "opted_out_speakers": ["eve-id"],
        }
        purged = purge_opted_out_transcript_segments(db, rec_db, [att])
        assert purged == 1
        assert db.get(TranscriptSegment, j_e_onset.id) is None

        ctx_prompt = build_asr_context_prompt(db, j_v_cont, stream)
        assert ctx_prompt is not None
        assert "Nico Meier" in ctx_prompt
        assert "Maya Lindner-Berg" in ctx_prompt
        assert "Acme.ONE" in ctx_prompt
        assert "Eve OptedOut" not in ctx_prompt
        db.commit()

    tx = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    assert tx["quality"]["attribution_unknown"] is False
    assert len(tx["segments"]) == 1
    assert tx["segments"][0]["speaker_label"] == "Stefan Novak"
    assert (
        tx["segments"][0]["text"]
        == "Na, wollte ich nur sagen, die haben sich intern zusammengesetzt. Genau. Danke."
    )

    # Audio snippet across Volkmar's 0.801s onset succeeds; Eve's onset is 404 blocked
    v_wav = client.get(
        f"/v1/recordings/{rec_id}/audio-snippet",
        params={"stream_id": str(stream_ext), "start": 0.12, "end": 3.6},
        headers=API,
    )
    assert v_wav.status_code == 200
    assert v_wav.content[:4] == b"RIFF"

    e_wav = client.get(
        f"/v1/recordings/{rec_id}/audio-snippet",
        params={"stream_id": str(stream_ext), "start": 5.05, "end": 5.80},
        headers=API,
    )
    assert e_wav.status_code == 404


def test_group_calendar_writeback_and_oauth_reconnect_backfill(client, database, monkeypatch):
    from wortlaut import calendar_oauth as cal_oauth
    from wortlaut.models import CalendarConnection, CalendarSyncedEvent, Recording
    from wortlaut.oidc import Principal
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_GOOGLE_CALENDAR_CLIENT_ID", "g-client-id")
    monkeypatch.setenv("WORTLAUT_GOOGLE_CALENDAR_CLIENT_SECRET", "g-client-secret")
    get_settings.cache_clear()

    now = datetime.now(UTC)
    group_cal = "acme.example.org_teamcal1234567890@group.calendar.google.com"
    ext_event_id = "j8td45g2mak59ua5tq5nkhaahu_20261118T130000Z"
    rec_id = uuid.uuid4()

    with Session(database) as db:
        conn = CalendarConnection(
            owner_sub="sub-alex",
            owner_email="alex@acme.example.org",
            provider="google",
            account_email="alex@acme.example.org",
            encrypted_access_token=cal_oauth.encrypt_secret("readonly-access-token"),
            encrypted_refresh_token=cal_oauth.encrypt_secret("readonly-refresh-token"),
            token_expires_at=now + timedelta(hours=1),
        )
        rec = Recording(
            id=rec_id,
            idempotency_key="zweekly-group-cal-test",
            request_digest="digest-zweekly",
            meeting_url="https://meet.google.com/zweekly-room",
            provider="google_meet",
            title="Gruppe-DEV Zweekly",
            owner_sub="sub-alex",
            owner_email="alex@acme.example.org",
            starts_at=now - timedelta(hours=1),
            ends_at=now,
            participation="ended",
            processing="completed",
            export_reader_nonce=uuid.uuid4(),
            protocol_meta={
                "summary": {
                    "summary": "Fortschritte bei Wortlaut und Glossar-Editor besprochen.",
                    "topics": [],
                    "action_items": [],
                }
            },
        )
        db.add_all([conn, rec])
        db.flush()
        ev = CalendarSyncedEvent(
            connection_id=conn.id,
            owner_sub="sub-alex",
            owner_email="alex@acme.example.org",
            calendar_provider="google",
            external_event_id=ext_event_id,
            title="Gruppe-DEV Zweekly",
            starts_at=now - timedelta(hours=1),
            ends_at=now,
            organizer_email=group_cal,
            is_self_organized=False,
            meeting_provider="google_meet",
            meeting_url="https://meet.google.com/zweekly-room",
            status="confirmed",
            auto_record=True,
            recording_id=rec_id,
        )
        db.add(ev)
        db.commit()
        conn_id = conn.id
        ev_id = ev.id

    class _Resp:
        def __init__(self, status_code: int, body: dict):
            self.status_code = status_code
            self._body = body
            import json as _json

            self.text = _json.dumps(body)

        def json(self):
            return self._body

    patched_calls: list[tuple[str, dict, dict]] = []
    mode = {"scope": "readonly"}

    def fake_get(url: str, **kwargs):
        if "oauth2/v3/userinfo" in url:
            return _Resp(200, {"email": "alex@acme.example.org"})
        return _Resp(200, {"id": ext_event_id, "description": "Wöchentlicher Sync"})

    def fake_patch(url: str, **kwargs):
        if mode["scope"] == "readonly":
            return _Resp(
                403,
                {"error": {"code": 403, "message": "Insufficient Permission"}},
            )
        patched_calls.append((url, kwargs.get("params") or {}, kwargs.get("json") or {}))
        return _Resp(200, {"id": ext_event_id})

    def fake_post(url: str, **kwargs):
        return _Resp(
            200,
            {
                "access_token": "events-write-access-token",
                "refresh_token": "events-write-refresh-token",
                "expires_in": 3600,
            },
        )

    monkeypatch.setattr(cal_oauth.httpx, "get", fake_get)
    monkeypatch.setattr(cal_oauth.httpx, "patch", fake_patch)
    monkeypatch.setattr(cal_oauth.httpx, "post", fake_post)

    # 1. With readonly scope, writeback fails and records error + provider
    with Session(database) as db:
        rec_row = db.get(Recording, rec_id)
        assert rec_row is not None
        res1 = cal_oauth.publish_protocol_link_to_calendar_events(db, rec_row)
        db.commit()
        assert res1["status"] == "error"
        assert res1["error"] == "insufficient_calendar_write_scope"

    tx1 = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    assert tx1["calendar_link_error"] == "insufficient_calendar_write_scope"
    assert tx1["calendar_link_provider"] == "google"
    assert tx1["calendar_link_synced_at"] is None

    # 2. Reconnecting OAuth upgrades token AND automatically backfills pending writeback
    #    directly onto the shared @group.calendar.google.com calendar event!
    mode["scope"] = "events"

    def fake_sync(db_sess, c, now=None):
        ev_row = db_sess.get(CalendarSyncedEvent, ev_id)
        return [ev_row] if ev_row is not None else []

    monkeypatch.setattr(cal_oauth, "sync_connection", fake_sync)

    principal = Principal(
        kind="user",
        sub="sub-alex",
        email="alex@acme.example.org",
        name="Alex",
        is_admin=True,
    )
    with Session(database) as db:
        exch = cal_oauth.exchange_calendar_oauth_code(
            db,
            principal=principal,
            provider="google",
            code="fresh-consent-code",
            code_verifier="w" * 48,
            redirect_uri="https://wortlaut.example.org/auth/callback",
        )

    assert len(patched_calls) == 1
    patched_url, patched_params, patched_json = patched_calls[0]
    assert "acme.example.org_teamcal1234567890%40group.calendar.google.com" in patched_url
    assert patched_params == {"sendUpdates": "none"}
    assert str(rec_id) in patched_json["description"]
    assert "Fortschritte bei Wortlaut" in patched_json["description"]

    assert len(exch["synced_events"]) == 1
    assert exch["synced_events"][0]["calendar_link_synced_at"] is not None
    assert exch["synced_events"][0]["calendar_link_error"] is None

    tx2 = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    assert tx2["calendar_link_synced_at"] is not None
    assert tx2["calendar_link_error"] is None
    assert tx2["calendar_link_provider"] is None
    assert conn_id is not None


def test_immediate_opt_out_hides_live_speaker_zeros_s3_chunks_and_syncs_worker(
    client, database, storage
):
    """Opt-out hides live active_speakers, zeros prior/in-flight S3 PCM, and syncs worker."""
    import hashlib

    from wortlaut.ingest import accept_chunk, accept_control
    from wortlaut.models import Attempt, AudioChunk, Recording
    from wortlaut.storage import get_storage

    now = datetime.now(UTC)
    create = client.post(
        "/v1/recordings",
        headers={**API, "Idempotency-Key": f"optout-immediate-{uuid.uuid4()}"},
        json={
            "provider": "google_meet",
            "meeting_url": "https://meet.google.com/opt-outt-est",
            "title": "Immediate Opt-Out Audit",
            "starts_at": (now - timedelta(minutes=2)).isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
        },
    )
    assert create.status_code == 200, create.text
    rec_id = uuid.UUID(create.json()["id"])

    attempt_id = uuid.uuid4()
    stream_uuid = uuid.uuid4()
    epoch_uuid = uuid.uuid4()
    worker_secret = "worker-optout-secret-token-1234567890"
    secret_hash = hashlib.sha256(worker_secret.encode()).hexdigest()

    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        assert rec is not None
        rec.participation = "capturing"
        rec.processing = "processing"
        rec.active_attempt_id = attempt_id
        att = Attempt(
            id=attempt_id,
            recording_id=rec_id,
            credential_hash=secret_hash,
            credential_expires_at=now + timedelta(hours=1),
            worker_id="worker-optout-1",
            diagnostics={
                "streams": 1,
                "active_audio_samples": 32000,
                "participant_sources": {
                    "available": True,
                    "total": 2,
                    "sources": [
                        {
                            "participant_id": "spaces/s/devices/1",
                            "participant_name": "Alice",
                        },
                        {
                            "participant_id": "spaces/s/devices/562",
                            "participant_name": "Bob Example",
                        },
                    ],
                },
                "receiver_sources": [
                    {
                        "provider_source_id": f"google_meet:{rec_id}:receiver:0",
                        "signaled_participant_id": "spaces/s/devices/562",
                        "participant_name": "Bob Example",
                        "rtp_stats": {"audio_level": 0.42},
                    },
                    {
                        "provider_source_id": f"google_meet:{rec_id}:receiver:1",
                        "signaled_participant_id": "spaces/s/devices/1",
                        "participant_name": "Alice",
                        "rtp_stats": {"audio_level": 0.0},
                    },
                ],
            },
        )
        db.add(att)
        db.commit()

    base_meta = {
        "attempt_id": str(attempt_id),
        "meeting_id": str(rec_id),
        "stream_id": str(stream_uuid),
        "epoch": str(epoch_uuid),
        "provider_source_id": f"google_meet:{rec_id}:receiver:0",
        "source_kind": "speaker",
        "attribution_unknown": False,
        "sample_rate": 16000,
        "channels": 1,
        "encoding": "pcm_s16le",
        "monotonic_origin_ms": 1000.0,
        "session_monotonic_origin_ms": 0.0,
        "session_utc_origin": now.isoformat(),
    }
    alice_pcm = b"\x20\x05" * 16000
    florian_pcm = b"\x30\x08" * 16000

    with Session(database) as db:
        att = db.get(Attempt, attempt_id)
        rec = db.get(Recording, rec_id)
        accept_control(
            db,
            att,
            rec,
            {
                **base_meta,
                "type": "begin",
                "id": f"{attempt_id}/{stream_uuid}/{epoch_uuid}/begin",
                "participant_id": "spaces/s/devices/1",
                "speaker_id": "spaces/s/devices/1",
                "participant_name": "Alice",
            },
        )
        ch0_id = accept_chunk(
            db,
            att,
            rec,
            {
                **base_meta,
                "sequence": 0,
                "start_sample": 0,
                "sample_count": 16000,
                "participant_id": "spaces/s/devices/1",
                "speaker_id": "spaces/s/devices/1",
                "participant_name": "Alice",
            },
            alice_pcm,
        )
        accept_control(
            db,
            att,
            rec,
            {
                "type": "bind",
                "id": f"{attempt_id}/{stream_uuid}/{epoch_uuid}/16000/bind",
                "stream_id": str(stream_uuid),
                "epoch": str(epoch_uuid),
                "start_sample": 16000,
                "provider_source_id": f"google_meet:{rec_id}:receiver:0",
                "source_kind": "speaker",
                "attribution_unknown": False,
                "participant_id": "spaces/s/devices/562",
                "speaker_id": "spaces/s/devices/562",
                "participant_name": "Bob Example",
            },
        )
        ch1_id = accept_chunk(
            db,
            att,
            rec,
            {
                **base_meta,
                "sequence": 1,
                "start_sample": 16000,
                "sample_count": 16000,
                "participant_id": "spaces/s/devices/562",
                "speaker_id": "spaces/s/devices/562",
                "participant_name": "Bob Example",
            },
            florian_pcm,
        )

    # Before opt-out, live_status shows Florian as active speaker
    before = client.get(f"/v1/recordings/{rec_id}", headers=API).json()
    assert before["live_status"]["active_speakers"] == ["Bob Example"]
    assert before["live_status"]["max_audio_level"] == 0.42

    # Trigger opt-out via PATCH /v1/recordings/{id}
    patch = client.patch(
        f"/v1/recordings/{rec_id}",
        headers=API,
        json={"opted_out_speakers": ["Bob Example"]},
    )
    assert patch.status_code == 200, patch.text

    # 1. Live banner stops showing Florian as active speaker & suppresses his audio_level
    after = client.get(f"/v1/recordings/{rec_id}", headers=API).json()
    assert after["live_status"]["active_speakers"] == []
    assert after["live_status"]["max_audio_level"] == 0.0

    # 2. Prior S3 PCM chunk for Florian is immediately zeroed while Alice's chunk stays intact
    s3 = get_storage()
    with Session(database) as db:
        ch0 = db.get(AudioChunk, ch0_id)
        ch1 = db.get(AudioChunk, ch1_id)
        assert ch0 is not None and ch1 is not None
        assert s3.read(ch0.object_key) == alice_pcm
        assert s3.read(ch1.object_key) == b"\x00" * len(florian_pcm)
        assert ch1.checksum == hashlib.sha256(b"\x00" * len(florian_pcm)).hexdigest()

    # 3. In-flight chunk arriving after opt-out for Florian's device ID is stored as all-zero PCM
    with Session(database) as db:
        att = db.get(Attempt, attempt_id)
        rec = db.get(Recording, rec_id)
        ch2_id = accept_chunk(
            db,
            att,
            rec,
            {
                **base_meta,
                "sequence": 2,
                "start_sample": 32000,
                "sample_count": 16000,
                "participant_id": "spaces/s/devices/562",
                "speaker_id": "spaces/s/devices/562",
                "participant_name": "Bob Example",
            },
            florian_pcm,
        )
        ch2 = db.get(AudioChunk, ch2_id)
        assert ch2 is not None
        assert s3.read(ch2.object_key) == b"\x00" * len(florian_pcm)

    # 4. Transcript export still keeps audio_available=True for Alice
    tx = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    assert tx["audio_available"] is True

    # 5. Worker status heartbeat sends opted_out_windows and receives opted_out_speakers back
    hb = client.post(
        f"/v1/attempts/{attempt_id}/status",
        headers={
            "Authorization": f"Bearer {worker_secret}",
            "X-Worker-Id": "worker-optout-1",
        },
        json={
            "participation": "capturing",
            "streams": 1,
            "audio_samples": 48000,
            "active_audio_samples": 32000,
            "participant_sources": {
                "available": True,
                "total": 2,
                "opted_out": ["Bob Example"],
                "opted_out_windows": [
                    {
                        "started_at": (now + timedelta(seconds=12)).isoformat(),
                        "ended_at": (now + timedelta(seconds=18)).isoformat(),
                    }
                ],
                "sources": [],
            },
        },
    )
    assert hb.status_code == 200, hb.text
    assert hb.json()["opted_out_speakers"] == ["Bob Example"]

    # 6. Protocol JSON, Markdown, and Plaintext exports show anonymous (OPTED OUT COMMENT) marker
    tx_after = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    assert len(tx_after["opted_out_windows"]) == 1
    assert tx_after["opted_out_windows"][0]["offset_seconds"] == 12.0
    assert tx_after["opted_out_windows"][0]["end_offset_seconds"] == 18.0
    assert "Bob Example" not in str(tx_after["opted_out_windows"])

    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        assert rec is not None
        rec.processing = "completed"
        db.commit()

    md_resp = client.get(f"/v1/recordings/{rec_id}/exports/md", headers=API)
    assert md_resp.status_code == 200, md_resp.text
    assert "(OPTED OUT COMMENT)" in md_resp.text
    assert "Bob Example" not in md_resp.text

    txt_resp = client.get(f"/v1/recordings/{rec_id}/exports/txt", headers=API)
    assert txt_resp.status_code == 200, txt_resp.text
    assert "(OPTED OUT COMMENT)" in txt_resp.text
    assert "Bob Example" not in txt_resp.text


def test_google_and_entra_id_auth_providers_exchange_and_security(monkeypatch):
    """Google Auth & Entra ID work standalone or side-by-side with strict JWT validation."""
    from cryptography.hazmat.primitives.asymmetric import rsa
    from fastapi.testclient import TestClient

    import wortlaut.oidc as oidc_mod
    from wortlaut.app import app as fastapi_app
    from wortlaut.settings import get_settings

    allowed_tid = "11111111-2222-3333-4444-555555555555"
    other_tid = "99999999-8888-7777-6666-555555555555"

    monkeypatch.setenv("WORTLAUT_DATABASE_URL", "postgresql+psycopg://u:p@127.0.0.1:5432/unused")
    monkeypatch.setenv("WORTLAUT_API_TOKEN", "test-operator-token-for-auth-providers")
    monkeypatch.delenv("WORTLAUT_OIDC_ISSUER", raising=False)
    monkeypatch.setenv("WORTLAUT_OIDC_ALLOWED_DOMAINS", '["acme.example.org"]')
    monkeypatch.setenv("WORTLAUT_OIDC_ADMIN_EMAILS", '["admin@acme.example.org"]')
    monkeypatch.setenv(
        "WORTLAUT_GOOGLE_AUTH_CLIENT_ID", "google-client-123.apps.googleusercontent.com"
    )
    monkeypatch.setenv("WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET", "google-secret-xyz")
    monkeypatch.setenv("WORTLAUT_ENTRA_AUTH_CLIENT_ID", "entra-app-client-456")
    monkeypatch.setenv("WORTLAUT_ENTRA_AUTH_CLIENT_SECRET", "entra-secret-abc")
    monkeypatch.setenv("WORTLAUT_ENTRA_AUTH_TENANT_ID", "common")
    monkeypatch.setenv("WORTLAUT_ENTRA_AUTH_ALLOWED_TENANTS", json.dumps([allowed_tid]))
    get_settings.cache_clear()
    oidc_mod._DISCOVERY_CACHE.clear()
    oidc_mod._JWKS_CACHE.clear()

    google_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    entra_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    google_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(google_priv.public_key()))
    google_jwk.update({"kid": "g-k1", "alg": "RS256", "use": "sig"})
    entra_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(entra_priv.public_key()))
    entra_jwk.update({"kid": "e-k1", "alg": "RS256", "use": "sig"})

    class _Resp:
        def __init__(self, status: int, data: dict):
            self.status_code = status
            self._data = data

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def json(self):
            return self._data

    def fake_get(url: str, **kwargs):
        if url == "https://accounts.google.com/.well-known/openid-configuration":
            return _Resp(
                200,
                {
                    "issuer": "https://accounts.google.com",
                    "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
                    "token_endpoint": "https://oauth2.googleapis.com/token",
                    "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
                },
            )
        if url == "https://www.googleapis.com/oauth2/v3/certs":
            return _Resp(200, {"keys": [google_jwk]})
        if url == "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration":
            return _Resp(
                200,
                {
                    "issuer": "https://login.microsoftonline.com/{tenantid}/v2.0",
                    "authorization_endpoint": (
                        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
                    ),
                    "token_endpoint": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                    "jwks_uri": "https://login.microsoftonline.com/common/discovery/v2.0/keys",
                },
            )
        if url == "https://login.microsoftonline.com/common/discovery/v2.0/keys":
            return _Resp(200, {"keys": [entra_jwk]})
        raise AssertionError(f"Unexpected GET {url}")

    now = int(time.time())
    posted_forms: list[tuple[str, dict]] = []
    next_id_token: dict[str, str] = {}

    def fake_post(url: str, data=None, **kwargs):
        posted_forms.append((url, dict(data or {})))
        return _Resp(200, {"id_token": next_id_token["jwt"]})

    monkeypatch.setattr(oidc_mod.httpx, "get", fake_get)
    monkeypatch.setattr(oidc_mod.httpx, "post", fake_post)

    tc = TestClient(fastapi_app)

    # 1. Config endpoint & UI boot expose both Entra ID and Google options
    cfg = tc.get("/v1/auth/oidc/config").json()
    assert cfg["enabled"] is True
    by_id = {p["id"]: p for p in cfg["providers"]}
    assert set(by_id) == {"entra", "google"}
    assert (
        by_id["google"]["authorization_endpoint"] == "https://accounts.google.com/o/oauth2/v2/auth"
    )
    assert by_id["google"]["extra_params"] == {"prompt": "select_account", "hd": "acme.example.org"}
    assert (
        by_id["entra"]["authorization_endpoint"]
        == "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    )
    assert by_id["entra"]["extra_params"] == {"prompt": "select_account"}

    ui_html = tc.get("/ui").text
    boot_match = re.search(
        r"window\.__WORTLAUT_BOOT__\s*=\s*(\{.*?\});\s*</script>", ui_html, re.DOTALL
    )
    assert boot_match is not None
    boot_oidc = json.loads(boot_match.group(1))["instance"]["oidc"]
    assert boot_oidc["enabled"] is True
    assert [p["id"] for p in boot_oidc["providers"]] == ["entra", "google"]

    # 2. Google exchange sends client_secret, verifies RS256 JWKS, and namespaces sub
    google_ok = jwt.encode(
        {
            "iss": "https://accounts.google.com",
            "sub": "10987654321",
            "aud": "google-client-123.apps.googleusercontent.com",
            "iat": now,
            "exp": now + 600,
            "nonce": "nonce-g1",
            "email": "admin@acme.example.org",
            "email_verified": True,
            "name": "Alice Google",
        },
        google_priv,
        algorithm="RS256",
        headers={"kid": "g-k1"},
    )
    next_id_token["jwt"] = google_ok
    g_res = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "google",
            "code": "google-auth-code-1",
            "code_verifier": "v" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
            "nonce": "nonce-g1",
        },
    )
    assert g_res.status_code == 200, g_res.text
    g_body = g_res.json()
    assert g_body["user"]["sub"] == "google:10987654321"
    assert g_body["user"]["email"] == "admin@acme.example.org"
    assert g_body["user"]["is_admin"] is True
    assert posted_forms[-1][0] == "https://oauth2.googleapis.com/token"
    assert posted_forms[-1][1]["client_secret"] == "google-secret-xyz"

    # Google rejects unverified email
    next_id_token["jwt"] = jwt.encode(
        {
            "iss": "https://accounts.google.com",
            "sub": "10987654321",
            "aud": "google-client-123.apps.googleusercontent.com",
            "iat": now,
            "exp": now + 600,
            "email": "alice@acme.example.org",
            "email_verified": False,
        },
        google_priv,
        algorithm="RS256",
        headers={"kid": "g-k1"},
    )
    g_unverified = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "google",
            "code": "code-2",
            "code_verifier": "v" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
        },
    )
    assert g_unverified.status_code == 403

    # 3. Entra ID exchange handles tenant-stamped issuer & preferred_username without email_verified
    entra_ok = jwt.encode(
        {
            "iss": f"https://login.microsoftonline.com/{allowed_tid}/v2.0",
            "tid": allowed_tid,
            "oid": "oid-entra-777",
            "sub": "pairwise-sub-777",
            "aud": "entra-app-client-456",
            "iat": now,
            "exp": now + 600,
            "nonce": "nonce-e1",
            "preferred_username": "bob@acme.example.org",
            "name": "Bob Entra",
        },
        entra_priv,
        algorithm="RS256",
        headers={"kid": "e-k1"},
    )
    next_id_token["jwt"] = entra_ok
    e_res = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "entra-auth-code-1",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
            "nonce": "nonce-e1",
        },
    )
    assert e_res.status_code == 200, e_res.text
    e_body = e_res.json()
    assert e_body["user"]["sub"] == f"entra:{allowed_tid}:oid-entra-777"
    assert e_body["user"]["email"] == "bob@acme.example.org"
    assert e_body["user"]["is_admin"] is False
    assert posted_forms[-1][0] == "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    assert posted_forms[-1][1]["client_secret"] == "entra-secret-abc"

    # Entra ID rejects disallowed tenant tid
    next_id_token["jwt"] = jwt.encode(
        {
            "iss": f"https://login.microsoftonline.com/{other_tid}/v2.0",
            "tid": other_tid,
            "oid": "oid-rogue",
            "sub": "sub-rogue",
            "aud": "entra-app-client-456",
            "iat": now,
            "exp": now + 600,
            "preferred_username": "bob@acme.example.org",
        },
        entra_priv,
        algorithm="RS256",
        headers={"kid": "e-k1"},
    )
    e_bad_tid = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "code-3",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
        },
    )
    assert e_bad_tid.status_code == 403

    # Entra ID rejects unverified guest email (xms_edov == 0)
    next_id_token["jwt"] = jwt.encode(
        {
            "iss": f"https://login.microsoftonline.com/{allowed_tid}/v2.0",
            "tid": allowed_tid,
            "oid": "oid-guest",
            "sub": "sub-guest",
            "aud": "entra-app-client-456",
            "iat": now,
            "exp": now + 600,
            "email": "guest@acme.example.org",
            "xms_edov": 0,
        },
        entra_priv,
        algorithm="RS256",
        headers={"kid": "e-k1"},
    )
    e_unverified_guest = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "code-4",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
        },
    )
    assert e_unverified_guest.status_code == 403

    # 4. Bearer raw JWT auto-verification routes to matching provider
    assert oidc_mod.verify_bearer_oidc_id_token(google_ok)["sub"] == "google:10987654321"
    assert (
        oidc_mod.verify_bearer_oidc_id_token(entra_ok)["sub"]
        == f"entra:{allowed_tid}:oid-entra-777"
    )

    # 5. Redirect URI defense-in-depth rejects non-callback or fragment URLs
    bad_redir = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "google",
            "code": "code-bad-redir",
            "code_verifier": "v" * 48,
            "redirect_uri": "https://evil.example.org/steal#frag",
        },
    )
    assert bad_redir.status_code == 400

    # 6. Google Auth is NOT enabled when client_secret is missing
    monkeypatch.delenv("WORTLAUT_GOOGLE_AUTH_CLIENT_SECRET", raising=False)
    get_settings.cache_clear()
    assert [p.id for p in oidc_mod.get_configured_auth_providers()] == ["entra"]

    # 7. Entra ID nOAuth defense: unrestricted multi-tenant (common + empty allowlist)
    #    rejects tokens without explicit email_verified=True or xms_edov=1
    monkeypatch.setenv("WORTLAUT_ENTRA_AUTH_ALLOWED_TENANTS", "[]")
    get_settings.cache_clear()
    next_id_token["jwt"] = entra_ok  # has no xms_edov / email_verified claim
    e_noauth_blocked = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "code-noauth-1",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
            "nonce": "nonce-e1",
        },
    )
    assert e_noauth_blocked.status_code == 403

    entra_verified = jwt.encode(
        {
            "iss": f"https://login.microsoftonline.com/{allowed_tid}/v2.0",
            "tid": allowed_tid,
            "oid": "oid-entra-verified",
            "sub": "sub-entra-verified",
            "aud": "entra-app-client-456",
            "iat": now,
            "exp": now + 600,
            "preferred_username": "bob@acme.example.org",
            "xms_edov": 1,
        },
        entra_priv,
        algorithm="RS256",
        headers={"kid": "e-k1"},
    )
    next_id_token["jwt"] = entra_verified
    e_noauth_ok = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "code-noauth-2",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
        },
    )
    assert e_noauth_ok.status_code == 200, e_noauth_ok.text

    # 8. Domain-name single-tenant Entra ID pins against resolved discovery tenant issuer
    def fake_get_domain_tenant(url: str, **kwargs):
        if url.endswith("contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration"):
            return _Resp(
                200,
                {
                    "issuer": f"https://login.microsoftonline.com/{allowed_tid}/v2.0",
                    "authorization_endpoint": (
                        "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize"
                    ),
                    "token_endpoint": (
                        "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token"
                    ),
                    "jwks_uri": (
                        "https://login.microsoftonline.com/contoso.onmicrosoft.com/discovery/v2.0/keys"
                    ),
                },
            )
        if url.endswith("contoso.onmicrosoft.com/discovery/v2.0/keys"):
            return _Resp(200, {"keys": [entra_jwk]})
        return fake_get(url, **kwargs)

    monkeypatch.setattr(oidc_mod.httpx, "get", fake_get_domain_tenant)
    monkeypatch.setenv("WORTLAUT_ENTRA_AUTH_TENANT_ID", "contoso.onmicrosoft.com")
    get_settings.cache_clear()
    oidc_mod._DISCOVERY_CACHE.clear()
    oidc_mod._JWKS_CACHE.clear()

    # Token from allowed_tid passes without xms_edov because single-tenant is pinned
    next_id_token["jwt"] = entra_ok
    e_domain_ok = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "code-dom-ok",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
            "nonce": "nonce-e1",
        },
    )
    assert e_domain_ok.status_code == 200, e_domain_ok.text

    # Token from foreign tenant other_tid is rejected by domain-tenant discovery pinning
    next_id_token["jwt"] = jwt.encode(
        {
            "iss": f"https://login.microsoftonline.com/{other_tid}/v2.0",
            "tid": other_tid,
            "oid": "oid-foreign",
            "sub": "sub-foreign",
            "aud": "entra-app-client-456",
            "iat": now,
            "exp": now + 600,
            "preferred_username": "bob@acme.example.org",
        },
        entra_priv,
        algorithm="RS256",
        headers={"kid": "e-k1"},
    )
    e_domain_bad = tc.post(
        "/v1/auth/oidc/exchange",
        json={
            "provider": "entra",
            "code": "code-dom-bad",
            "code_verifier": "e" * 48,
            "redirect_uri": "https://wortlaut.example.org/auth/callback",
        },
    )
    assert e_domain_bad.status_code == 403
