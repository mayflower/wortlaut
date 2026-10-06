import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.models import Attempt, Recording

API = {"Authorization": "Bearer fixture-api-token"}


def request_body():
    now = datetime.now(UTC)
    return {
        "meeting_url": "https://example.webex.com/meet/example",
        "starts_at": now.isoformat(),
        "ends_at": (now + timedelta(minutes=30)).isoformat(),
    }


def create(client, key="one", body=None):
    response = client.post(
        "/v1/recordings", json=body or request_body(), headers={**API, "Idempotency-Key": key}
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def prepare(client, recording):
    response = client.post(f"/v1/recordings/{recording}/attempts", headers=API)
    assert response.status_code == 200
    result = response.json()
    return result["attempt_id"], {"Authorization": f"Bearer {result['bootstrap_credential']}"}


def test_replay_is_same_recording_and_conflicting_payload_is_rejected(client, database):
    body = request_body()
    first = create(client, body=body)
    assert create(client, body=body) == first
    body["meeting_url"] = "https://other.webex.com/meet/example"
    assert (
        client.post(
            "/v1/recordings", json=body, headers={**API, "Idempotency-Key": "one"}
        ).status_code
        == 409
    )
    with Session(database) as db:
        assert len(db.scalars(select(Recording)).all()) == 1


def test_concurrent_preparation_and_claim_have_one_owner(client, database):
    recording = create(client)
    with ThreadPoolExecutor(2) as pool:
        results = list(
            pool.map(
                lambda _: client.post(f"/v1/recordings/{recording}/attempts", headers=API), range(2)
            )
        )
    assert sorted(r.status_code for r in results) == [200, 409]
    prepared = next(r.json() for r in results if r.status_code == 200)
    attempt = prepared["attempt_id"]
    headers = {"Authorization": f"Bearer {prepared['bootstrap_credential']}"}
    with ThreadPoolExecutor(2) as pool:
        claims = list(
            pool.map(
                lambda worker: client.post(
                    f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": worker}
                ),
                ["worker-A", "worker-B"],
            )
        )
    assert sorted(r.status_code for r in claims) == [200, 409]
    with Session(database) as db:
        stored = db.scalar(select(Attempt))
        assert stored.worker_id in ("worker-A", "worker-B")
        assert (
            stored.credential_hash
            == hashlib.sha256(prepared["bootstrap_credential"].encode()).hexdigest()
        )
        assert len(db.scalars(select(Attempt)).all()) == 1


def test_bootstrap_requires_owner_and_claim_retry_preserves_capture(client):
    recording = create(client)
    attempt, headers = prepare(client, recording)
    assert (
        client.get(
            f"/v1/attempts/{attempt}/bootstrap", headers={**headers, "X-Worker-ID": "owner"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 200
    )
    owner = {**headers, "X-Worker-ID": "owner"}
    evidence = {
        "provider_source_id": "webex:slot:r1",
        "source_kind": "speaker",
        "capture_path": "rtc_receiver",
        "track_id": "fixture-track",
        "csi": 456,
        "signaled_participant_id": "fixture-member",
        "source_state": "live",
        "ssrc": [{"source": 123, "timestamp": 12.0, "rtp_timestamp": 1600}],
        "csrc": [],
    }
    participants = {
        "available": True,
        "total": 1,
        "truncated": False,
        "sources": [
            {"participant_id": "fixture-member", "audio_csis": [456], "share_audio_csis": []}
        ],
    }
    assert (
        client.post(
            f"/v1/attempts/{attempt}/status",
            headers=owner,
            json={
                "participation": "capturing",
                "receiver_sources": [evidence],
                "participant_sources": participants,
            },
        ).status_code
        == 200
    )
    observed = client.get(f"/v1/recordings/{recording}", headers=API).json()["attempts"][0]
    assert observed["diagnostics"]["capability"] == "unverified"
    assert observed["diagnostics"]["receiver_sources"] == [evidence]
    assert observed["diagnostics"]["participant_sources"] == participants
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 200
    )
    assert (
        client.get(f"/v1/recordings/{recording}", headers=API).json()["participation"]
        == "capturing"
    )
    assert (
        client.get(
            f"/v1/attempts/{attempt}/bootstrap", headers={**headers, "X-Worker-ID": "other"}
        ).status_code
        == 409
    )
    # No provider credentials configured: explicit failure, no fake guest token.
    assert client.get(f"/v1/attempts/{attempt}/bootstrap", headers=owner).status_code == 503


def test_attempt_credential_cannot_access_api_or_another_attempt(client):
    first = create(client, "first")
    second = create(client, "second")
    attempt, headers = prepare(client, first)
    other, _ = prepare(client, second)
    assert client.get(f"/v1/recordings/{first}", headers=headers).status_code == 401
    assert (
        client.post(
            f"/v1/attempts/{other}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 200
    )


def test_bootstrap_reports_guest_expiry_and_reuses_occurrence_subject(client, monkeypatch):
    from wortlaut import app as app_module

    issued = []

    def issue(service_token, subject, display_name):
        issued.append((subject, display_name))
        return {"access_token": "fixture-guest", "expires_in": 90}

    monkeypatch.setattr(app_module, "guest_token", issue)
    body = request_body()
    body["ends_at"] = (datetime.fromisoformat(body["starts_at"]) + timedelta(hours=6)).isoformat()
    recording = create(client, body=body)
    attempt, headers = prepare(client, recording)
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 200
    )
    started = datetime.now(UTC)
    for _ in range(2):
        response = client.get(
            f"/v1/attempts/{attempt}/bootstrap", headers={**headers, "X-Worker-ID": "owner"}
        )
        assert response.status_code == 200
        assert response.headers["Cache-Control"] == "no-store"
        deadline = datetime.fromisoformat(response.json()["deadline"])
        expires = datetime.fromisoformat(response.json()["guest_expires_at"])
        assert (
            started + timedelta(seconds=85) < expires <= datetime.now(UTC) + timedelta(seconds=90)
        )
        assert deadline > expires
        assert deadline == datetime.fromisoformat(body["ends_at"])
    assert issued == [(f"wortlaut:{recording}", "wortlaut")] * 2
    monkeypatch.setattr(
        app_module, "guest_token", lambda *args: {"access_token": "fixture-guest", "expires_in": 20}
    )
    assert (
        client.get(
            f"/v1/attempts/{attempt}/bootstrap", headers={**headers, "X-Worker-ID": "owner"}
        ).status_code
        == 503
    )


def test_untrusted_url_or_ambiguous_timezone_is_rejected(client):
    body = request_body()
    for url in [
        "https://webex.com.attacker.example/",
        "http://example.webex.com/",
        "https://token@example.webex.com/",
        "https://example.webex.com:9000/",
    ]:
        body["meeting_url"] = url
        assert (
            client.post(
                "/v1/recordings", json=body, headers={**API, "Idempotency-Key": "bad"}
            ).status_code
            == 422
        )
    body = request_body()
    body["starts_at"] = "2026-10-06T09:00:00"
    assert (
        client.post(
            "/v1/recordings", json=body, headers={**API, "Idempotency-Key": "bad"}
        ).status_code
        == 422
    )


def test_final_status_replay_is_idempotent_but_cannot_reopen_or_rewrite_attempt(client):
    recording = create(client)
    attempt, headers = prepare(client, recording)
    client.post(f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"})
    owner = {**headers, "X-Worker-ID": "owner"}
    final = {
        "participation": "ended",
        "reason": "deadline",
        "capability": "capability_unsupported",
        "audio_samples": 100,
    }
    for _ in range(2):
        assert (
            client.post(f"/v1/attempts/{attempt}/status", headers=owner, json=final).status_code
            == 200
        )
    for changed in [{**final, "reason": "normal"}, {**final, "participation": "capturing"}]:
        assert (
            client.post(f"/v1/attempts/{attempt}/status", headers=owner, json=changed).status_code
            == 409
        )
    assert client.get(f"/v1/attempts/{attempt}/bootstrap", headers=owner).status_code == 401
    assert client.post(f"/v1/recordings/{recording}/attempts", headers=API).status_code == 409
