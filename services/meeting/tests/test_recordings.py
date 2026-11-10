import hashlib
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioControl,
    AudioStream,
    Recording,
    TranscriptSegment,
)

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
        "encoded_transform": None,
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
    encoded = {
        "state": "observing",
        "frame_count": 20,
        "last_frame": {
            "timestamp": 1600,
            "rtp_timestamp": 1600,
            "synchronization_source": 123,
            "contributing_sources": [456],
            "payload_type": 111,
            "receive_time": 42.5,
            "capture_time": None,
            "mime_type": "audio/opus",
        },
    }
    response = client.post(
        f"/v1/attempts/{attempt}/status",
        headers=owner,
        json={"participation": "capturing", "receiver_sources": [
            {**evidence, "encoded_transform": encoded}
        ]},
    )
    assert response.status_code == 200
    diagnostic = client.get(f"/v1/recordings/{recording}", headers=API).json()["attempts"][0]
    assert diagnostic["diagnostics"]["receiver_sources"][0]["encoded_transform"] == encoded
    assert diagnostic["diagnostics"]["capability"] == "unverified"
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


@pytest.mark.parametrize("legacy", [False, True])
def test_final_status_replay_is_idempotent_but_cannot_reopen_or_rewrite_attempt(
    client, database, legacy
):
    recording = create(client)
    attempt, headers = prepare(client, recording)
    client.post(f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"})
    owner = {**headers, "X-Worker-ID": "owner"}
    final = {
        "participation": "ended",
        "reason": "deadline",
        "capability": "capability_unsupported",
        "audio_samples": 100,
        **({} if legacy else {"drained": False}),
    }
    assert (
        client.post(f"/v1/attempts/{attempt}/status", headers=owner, json=final).status_code == 200
    )
    if legacy:
        with Session(database) as db:
            stored = db.scalar(select(Attempt))
            stored.diagnostics = {
                key: value
                for key, value in stored.diagnostics.items()
                if key not in ("drained", "audio_clock")
            }
            db.commit()
    assert (
        client.post(f"/v1/attempts/{attempt}/status", headers=owner, json=final).status_code == 200
    )
    observed = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert observed["attempts"][0]["diagnostics"].get("drained") is (None if legacy else False)
    for changed in [
        {**final, "reason": "normal"},
        {**final, "participation": "capturing"},
        {**final, "drained": True},
    ]:
        assert (
            client.post(f"/v1/attempts/{attempt}/status", headers=owner, json=changed).status_code
            == 409
        )
    assert client.get(f"/v1/attempts/{attempt}/bootstrap", headers=owner).status_code == 401
    assert client.post(f"/v1/recordings/{recording}/attempts", headers=API).status_code == 409


def test_audio_clock_interruption_is_persisted_and_visible_without_inventing_sample_gaps(
    client, database, storage
):
    from test_ingest import authenticate, begin, source
    from test_processing import send_pcm

    from wortlaut.asr import finalize_processing
    from wortlaut.processing import segmentation_pass

    attempt, credential, identity = source(client)
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        assert socket.receive_json()["type"] == "ack"
        send_pcm(socket, identity, b"\0\0" * 100, 0, 0)
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": 100,
                "last_sequence": 0,
            }
        )
        assert socket.receive_json()["type"] == "ack"
    owner = {"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"}
    clock = {
        "state": "closed",
        "total_interruptions": 1,
        "interruptions": [
            {
                "reason": "suspended",
                "observed_start_utc": "2026-10-06T09:00:00.500Z",
                "observed_end_utc": "2026-10-06T09:00:01Z",
            }
        ],
    }
    final = {"participation": "ended", "reason": "fixture_done", "audio_clock": clock}
    bad_clock = {
        **clock,
        "interruptions": [
            {
                **clock["interruptions"][0],
                "observed_end_utc": "2026-10-06T09:00:00Z",
            }
        ],
    }
    assert (
        client.post(
            f"/v1/attempts/{attempt}/status",
            headers=owner,
            json={**final, "audio_clock": bad_clock},
        ).status_code
        == 422
    )
    for _ in range(2):
        assert (
            client.post(f"/v1/attempts/{attempt}/status", headers=owner, json=final).status_code
            == 200
        )
    segmentation_pass(database)
    finalize_processing(database)
    recording = identity["meeting_id"]
    detail = client.get(f"/v1/recordings/{recording}", headers=API).json()
    stored_clock = detail["attempts"][0]["diagnostics"]["audio_clock"]
    assert stored_clock["state"] == "closed"
    assert stored_clock["total_interruptions"] == 1
    assert stored_clock["interruptions"][0]["reason"] == "suspended"
    for field in ("observed_start_utc", "observed_end_utc"):
        assert datetime.fromisoformat(
            stored_clock["interruptions"][0][field]
        ) == datetime.fromisoformat(clock["interruptions"][0][field])
    assert detail["audio"][0]["known_gaps"] == []
    listed = client.get("/v1/recordings", headers=API).json()["items"][0]
    assert listed["quality"]["status"] == "incomplete"
    assert listed["quality"]["audio_clock_interrupted"] is True
    assert listed["quality"]["durable_sample_count"] == 100
    exported = client.get(f"/v1/recordings/{recording}/exports/json", headers=API)
    assert exported.status_code == 200
    data = exported.json()
    assert data["attempts"][0]["audio_clock"] == stored_clock
    assert data["quality"]["audio_clock_interrupted"] is True
    assert data["quality"]["has_audio_gaps"] is False
    assert data["quality"]["source_coverage"] == "unknown"
    for format in ("txt", "vtt"):
        assert (
            "Audio-Uhr unterbrochen: True"
            in client.get(f"/v1/recordings/{recording}/exports/{format}", headers=API).text
        )


def test_web_ui_live_status_and_browser_participant_names_in_exports(
    client, database, storage, monkeypatch
):
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from test_ingest import authenticate, begin, source
    from test_processing import send_pcm

    from wortlaut.asr import commit_result, finalize_processing
    from wortlaut.models import AsrJob, AudioStream
    from wortlaut.processing import segmentation_pass

    for path in ("/", "/ui"):
        ui = client.get(path)
        assert ui.status_code == 200
        assert "text/html" in ui.headers["content-type"]
        assert "Bot in ein Meeting schicken" in ui.text

    attempt, credential, identity = source(client)
    bound = {
        **identity,
        "provider_source_id": "teams:fixture:receiver:1",
        "speaker_id": "participant-alice",
        "participant_id": "participant-alice",
        "attribution_unknown": False,
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(bound))
        assert socket.receive_json()["type"] == "ack"
        send_pcm(socket, bound, b"\0\0" * 16000, 0, 0)
        socket.send_json(
            {
                "type": "end",
                "id": begin(bound)["id"] + "/end",
                "stream_id": bound["stream_id"],
                "epoch": bound["epoch"],
                "final_sample": 16000,
                "last_sequence": 0,
            }
        )
        assert socket.receive_json()["type"] == "ack"

    recording = bound["meeting_id"]
    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        job = AsrJob(
            id="browser-label-job",
            stream_id=stream.id,
            start_sample=0,
            end_sample=16000,
            core_start=0,
            core_end=16000,
            binding={},
        )
        db.add(job)
        db.flush()
        commit_result(
            db,
            job.id,
            {
                "id": job.id,
                "stream_id": str(stream.stream_id),
                "epoch": str(stream.epoch),
                "source_kind": "speaker",
                "speaker_id": "participant-alice",
                "participant_id": "participant-alice",
                "provider_source_id": "teams:fixture:receiver:1",
                "attribution_unknown": False,
                "session_utc_origin": stream.contract["session_utc_origin"],
                "start": 0.0,
                "end": 1.0,
                "text": "Guten Tag zusammen.",
                "words": [{"word": "Guten", "start": 0.0, "end": 0.5}],
            },
        )

    client.post(
        f"/v1/attempts/{attempt}/status",
        headers={"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"},
        json={
            "participation": "capturing",
            "streams": 1,
            "audio_samples": 16000,
            "active_audio_samples": 16000,
            "receiver_sources": [
                {
                    "provider_source_id": "teams:fixture:receiver:1",
                    "source_kind": "speaker",
                    "capture_path": "rtc_receiver",
                    "track_id": "track-1",
                    "csi": 4201,
                    "signaled_participant_id": "participant-alice",
                    "participant_name": "Alice Example",
                    "ssrc": [],
                    "csrc": [],
                }
            ],
            "participant_sources": {
                "available": True,
                "total": 1,
                "truncated": False,
                "sources": [
                    {
                        "participant_id": "participant-alice",
                        "participant_name": "Alice Example",
                        "audio_csis": [4201],
                        "share_audio_csis": [],
                    }
                ],
            },
            "sdp": {
                "descriptions": 2,
                "audio_sections": 1,
                "video_sections": 1,
                "ssrc_count": 2,
                "cname_count": 1,
                "msid_count": 1,
            },
        },
    )

    rec_detail = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert rec_detail["live_status"]["is_active"] is True
    assert rec_detail["live_status"]["active_streams"] == 1
    assert rec_detail["live_status"]["bound_receivers"] == 1
    assert rec_detail["live_status"]["dom_or_signaled_participants"] == 1
    assert rec_detail["live_status"]["active_audio_seconds"] == 1.0
    assert rec_detail["live_status"]["sdp_descriptions"] == 2

    live_transcript = client.get(f"/v1/recordings/{recording}/transcript", headers=API)
    assert live_transcript.status_code == 200
    assert live_transcript.json()["segments"][0]["speaker_label"] == "Alice Example"

    client.post(
        f"/v1/attempts/{attempt}/status",
        headers={"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"},
        json={
            "participation": "ended",
            "reason": "normal",
            "streams": 1,
            "audio_samples": 16000,
            "active_audio_samples": 16000,
            "receiver_sources": [
                {
                    "provider_source_id": "teams:fixture:receiver:1",
                    "source_kind": "speaker",
                    "capture_path": "rtc_receiver",
                    "track_id": "track-1",
                    "csi": 4201,
                    "signaled_participant_id": "participant-alice",
                    "participant_name": "Alice Example",
                    "ssrc": [],
                    "csrc": [],
                }
            ],
            "participant_sources": {
                "available": True,
                "total": 1,
                "truncated": False,
                "sources": [
                    {
                        "participant_id": "participant-alice",
                        "participant_name": "Alice Example",
                        "audio_csis": [4201],
                        "share_audio_csis": [],
                    }
                ],
            },
        },
    )
    segmentation_pass(database)
    finalize_processing(database)

    txt = client.get(f"/v1/recordings/{recording}/exports/txt", headers=API).text
    assert "Alice Example: Guten Tag zusammen." in txt
    md_res = client.get(f"/v1/recordings/{recording}/exports/md", headers=API)
    assert md_res.status_code == 200
    assert md_res.headers["content-type"].startswith("text/markdown")
    assert "**Alice Example** (`00:00:00.000 – 00:00:01.000`): Guten Tag zusammen." in md_res.text
    assert "| Alice Example | `participant-alice` |" in md_res.text

    # Full-text and speaker search across recordings (P1-3)
    by_text = client.get("/v1/recordings?q=Guten+Tag+zusammen", headers=API).json()["items"]
    assert [r["id"] for r in by_text] == [recording]
    by_speaker = client.get("/v1/recordings?q=Alice+Example", headers=API).json()["items"]
    assert [r["id"] for r in by_speaker] == [recording]
    by_missing = client.get("/v1/recordings?q=NichtVorhandenerBegriff", headers=API).json()["items"]
    assert by_missing == []

    exported = client.get(f"/v1/recordings/{recording}/exports/json", headers=API).json()
    assert exported["segments"][0]["speaker_label"] == "Alice Example"
    assert exported["quality"]["attribution_unknown"] is False
    assert exported["sources_summary"][0]["provider_source_id"] == "teams:fixture:receiver:1"
    assert exported["sources_summary"][0]["participant_name"] == "Alice Example"
    assert exported["sources_summary"][0]["signaled_participant_id"] == "participant-alice"
    assert exported["sources_summary"][0]["segment_count"] == 1
    assert exported["sources_summary"][0]["speech_seconds"] == 1.0
    assert exported["sources_summary"][0]["sample_text"] == "Guten Tag zusammen."
    assert exported["audio_available"] is True

    # Audio snippet extraction (Click-to-Listen WAV)
    seg = exported["segments"][0]
    snippet_res = client.get(
        f"/v1/recordings/{recording}/audio-snippet",
        params={"stream_id": seg["stream_id"], "start": 0.0, "end": 1.0},
        headers=API,
    )
    assert snippet_res.status_code == 200
    assert snippet_res.headers["content-type"] == "audio/wav"
    assert snippet_res.content[:4] == b"RIFF"

    # Inline protocol editing (title, speaker override, term replacement)
    patch_res = client.patch(
        f"/v1/recordings/{recording}",
        headers=API,
        json={
            "title": "Projekt-Kickoff Q4",
            "speaker_overrides": {"participant-alice": "Dr. Alice Beispiel"},
            "term_replacements": {"Guten Tag": "Willkommen"},
            "notes": "Wichtige Vorbemerkung",
        },
    )
    assert patch_res.status_code == 200
    patched_tx = client.get(f"/v1/recordings/{recording}/transcript", headers=API).json()
    assert patched_tx["title"] == "Projekt-Kickoff Q4"
    assert patched_tx["notes"] == "Wichtige Vorbemerkung"
    assert patched_tx["segments"][0]["speaker_label"] == "Dr. Alice Beispiel"
    assert patched_tx["segments"][0]["text"] == "Willkommen zusammen."

    # Structured AI summary via local Ollama endpoint (opt-in via WORTLAUT_ENABLE_LLM_SUMMARY=true)
    from wortlaut import exports as exports_module
    from wortlaut.settings import get_settings

    assert client.post(f"/v1/recordings/{recording}/summary", headers=API).status_code == 503
    monkeypatch.setenv("WORTLAUT_ENABLE_LLM_SUMMARY", "true")
    get_settings.cache_clear()

    class FakeOllamaResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "message": {
                    "content": (
                        '{"summary": "Kurzes Kickoff-Treffen zur Begrüßung.", '
                        '"topics": [{"title": "Begrüßung", "details": "Willkommen im Team."}], '
                        '"action_items": [{"owner": "Dr. Alice Beispiel", '
                        '"task": "Agenda versenden"}]}'
                    )
                }
            }

    monkeypatch.setattr(exports_module.httpx, "post", lambda *a, **kw: FakeOllamaResponse())
    sum_res = client.post(f"/v1/recordings/{recording}/summary", headers=API)
    assert sum_res.status_code == 200
    assert sum_res.json()["summary"]["summary"] == "Kurzes Kickoff-Treffen zur Begrüßung."
    assert sum_res.json()["summary"]["action_items"][0]["owner"] == "Dr. Alice Beispiel"
    md_after = client.get(f"/v1/recordings/{recording}/exports/md", headers=API).text
    assert "## Kurzfassung" in md_after
    assert "Kurzes Kickoff-Treffen zur Begrüßung." in md_after
    assert "**Dr. Alice Beispiel**: Agenda versenden" in md_after


def test_recording_title_guest_name_empty_room_timeout_and_otlp_telemetry(
    client, database, monkeypatch
):
    from wortlaut import telemetry
    from wortlaut.settings import get_settings

    exported_spans = []

    def fake_post(url, *, json=None, headers=None, timeout=None):
        exported_spans.append((url, json, headers))

    monkeypatch.setenv("WORTLAUT_ENABLE_TEAMS", "true")
    monkeypatch.setenv(
        "WORTLAUT_OTLP_ENDPOINT",
        "http://monitoring-stack-alloy.monitoring.svc.cluster.local:4318/v1/traces",
    )
    get_settings.cache_clear()
    monkeypatch.setattr(telemetry.httpx, "post", fake_post)

    now = datetime.now(UTC)
    response = client.post(
        "/v1/recordings",
        headers={**API, "Idempotency-Key": "titled-teams"},
        json={
            "meeting_url": "https://teams.microsoft.com/meet/123456789?p=secret",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
            "title": "  Architecture   Sync  ",
            "guest_name": "  wortlaut Notizen  ",
        },
    )
    assert response.status_code == 200
    created = response.json()
    assert created["title"] == "Architecture Sync"
    assert created["guest_name"] == "wortlaut Notizen"

    attempt, headers = prepare(client, created["id"])
    client.post(f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "owner"})
    owner = {**headers, "X-Worker-ID": "owner"}
    boot = client.get(f"/v1/attempts/{attempt}/bootstrap", headers=owner).json()
    assert boot["empty_room_timeout_seconds"] == 300
    assert boot["teams"]["display_name"] == "wortlaut Notizen"

    status = client.post(
        f"/v1/attempts/{attempt}/status",
        headers=owner,
        json={
            "participation": "capturing",
            "streams": 1,
            "audio_samples": 16000,
            "receiver_sources": [
                {
                    "provider_source_id": f"teams:{created['id']}:receiver:1",
                    "source_kind": "speaker",
                    "capture_path": "rtc_receiver",
                    "track_id": "audio-1",
                    "csi": 1001,
                    "signaled_participant_id": "alice-id",
                    "ssrc": [{"source": 1001, "timestamp": 1.0, "rtp_timestamp": 160}],
                    "csrc": [],
                }
            ],
            "participant_sources": {
                "available": True,
                "total": 1,
                "truncated": False,
                "sources": [
                    {
                        "participant_id": "alice-id",
                        "audio_csis": [1001],
                        "share_audio_csis": [],
                    }
                ],
            },
            "data_channels": [
                {
                    "label": "roster-v1",
                    "ready_state": "open",
                    "text_frames": 3,
                    "binary_frames": 0,
                    "json_frames": 3,
                    "json_keys": ["audio_csis", "participant_id", "participants"],
                }
            ],
        },
    )
    assert status.status_code == 200
    assert len(exported_spans) == 1
    url, otlp_payload, _ = exported_spans[0]
    assert url == "http://monitoring-stack-alloy.monitoring.svc.cluster.local:4318/v1/traces"
    span = otlp_payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert span["name"] == "wortlaut.worker.status"
    assert span["traceId"] == created["id"].replace("-", "")
    attrs = {item["key"]: item["value"] for item in span["attributes"]}
    assert attrs["wortlaut.provider"] == {"stringValue": "teams"}
    assert attrs["wortlaut.bound_receiver_count"] == {"intValue": "1"}
    assert attrs["wortlaut.data_channel_labels"] == {"stringValue": "roster-v1"}
    assert attrs["wortlaut.data_channel_json_keys"] == {
        "stringValue": "audio_csis,participant_id,participants"
    }
    get_settings.cache_clear()


def test_bind_control_backfills_unattributed_prefix_on_single_speaker_stream(client, database):
    now = datetime.now(UTC)
    response = client.post(
        "/v1/recordings",
        headers={**API, "Idempotency-Key": "bind-backfill-key"},
        json={
            "provider": "google_meet",
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
        },
    )
    assert response.status_code == 200
    rec_id = response.json()["id"]
    attempt_id, headers = prepare(client, rec_id)
    client.post(f"/v1/attempts/{attempt_id}/claim", headers=headers, json={"worker_id": "owner"})
    owner = {**headers, "X-Worker-ID": "owner"}

    stream_uuid = uuid.uuid4()
    epoch_uuid = uuid.uuid4()
    source_id = f"google_meet:{rec_id}:receiver:1"
    origin_iso = "2026-04-16T08:00:05+00:00"

    with Session(database) as db:
        stream_row = AudioStream(
            attempt_id=uuid.UUID(attempt_id),
            stream_id=stream_uuid,
            epoch=epoch_uuid,
            final_sample=32000,
            last_sequence=1,
            scan_sample=32000,
            scan_complete=True,
            contract={
                "type": "begin",
                "id": f"{attempt_id}/begin-1",
                "meeting_id": rec_id,
                "attempt_id": attempt_id,
                "stream_id": str(stream_uuid),
                "epoch": str(epoch_uuid),
                "provider_source_id": source_id,
                "source_kind": "speaker",
                "speaker_id": None,
                "attribution_unknown": True,
                "sample_rate": 16000,
                "channels": 1,
                "format": "s16le",
                "session_utc_origin": origin_iso,
                "session_monotonic_origin_ms": 100.0,
                "monotonic_origin_ms": 100.0,
            },
        )
        db.add(stream_row)
        db.flush()
        db.add(
            AudioControl(
                id=f"{attempt_id}/bind-1",
                stream_id=stream_row.id,
                kind="bind",
                sequence=None,
                start_sample=8000,
                contract={
                    "type": "bind",
                    "id": f"{attempt_id}/bind-1",
                    "stream_id": str(stream_uuid),
                    "epoch": str(epoch_uuid),
                    "start_sample": 8000,
                    "provider_source_id": source_id,
                    "source_kind": "speaker",
                    "speaker_id": "devices/alice-1",
                    "participant_id": "devices/alice-1",
                    "participant_name": "Alice Visual",
                    "attribution_unknown": False,
                },
            )
        )
        job1 = AsrJob(
            id=f"{attempt_id}-job-1",
            stream_id=stream_row.id,
            start_sample=0,
            end_sample=8000,
            core_start=0,
            core_end=8000,
            binding={
                "provider_source_id": source_id,
                "source_kind": "speaker",
                "speaker_id": None,
                "attribution_unknown": True,
            },
            status="completed",
        )
        job2 = AsrJob(
            id=f"{attempt_id}-job-2",
            stream_id=stream_row.id,
            start_sample=8000,
            end_sample=32000,
            core_start=8000,
            core_end=32000,
            binding={
                "provider_source_id": source_id,
                "source_kind": "speaker",
                "speaker_id": "devices/alice-1",
                "participant_id": "devices/alice-1",
                "participant_name": "Alice Visual",
                "attribution_unknown": False,
            },
            status="completed",
        )
        db.add_all([job1, job2])
        db.flush()
        db.add_all(
            [
                TranscriptSegment(
                    id=job1.id,
                    result={
                        "id": job1.id,
                        "stream_id": str(stream_uuid),
                        "epoch": str(epoch_uuid),
                        "provider_source_id": source_id,
                        "source_kind": "speaker",
                        "speaker_id": None,
                        "attribution_unknown": True,
                        "session_utc_origin": origin_iso,
                        "start": 0.0,
                        "end": 0.5,
                        "text": "Hallo zusammen",
                        "words": [{"word": "Hallo", "start": 0.0, "end": 0.25}],
                    },
                ),
                TranscriptSegment(
                    id=job2.id,
                    result={
                        "id": job2.id,
                        "stream_id": str(stream_uuid),
                        "epoch": str(epoch_uuid),
                        "provider_source_id": source_id,
                        "source_kind": "speaker",
                        "speaker_id": "devices/alice-1",
                        "participant_id": "devices/alice-1",
                        "participant_name": "Alice Visual",
                        "attribution_unknown": False,
                        "session_utc_origin": origin_iso,
                        "start": 0.5,
                        "end": 2.0,
                        "text": "hier spricht Alice.",
                        "words": [{"word": "Alice.", "start": 1.0, "end": 2.0}],
                    },
                ),
            ]
        )
        db.commit()

    client.post(
        f"/v1/attempts/{attempt_id}/status",
        headers=owner,
        json={
            "participation": "capturing",
            "streams": 1,
            "audio_samples": 32000,
            "active_audio_samples": 24000,
            "receiver_sources": [
                {
                    "provider_source_id": source_id,
                    "source_kind": "speaker",
                    "capture_path": "rtc_receiver",
                    "track_id": "track-alice",
                    "csi": 5551,
                    "signaled_participant_id": "devices/alice-1",
                    "participant_name": "Alice Visual",
                    "ssrc": [{"source": 5551, "timestamp": 1.0, "rtp_timestamp": 160}],
                    "csrc": [],
                }
            ],
            "participant_sources": {
                "available": True,
                "total": 1,
                "truncated": False,
                "dom_participants": 1,
                "sources": [
                    {
                        "participant_id": "devices/alice-1",
                        "participant_name": "Alice Visual",
                        "audio_csis": [5551],
                        "share_audio_csis": [],
                    }
                ],
            },
            "data_channels": [
                {
                    "label": "http:fetch",
                    "ready_state": "open",
                    "text_frames": 2,
                    "binary_frames": 0,
                    "json_frames": 2,
                    "json_keys": ["participants"],
                    "wire_formats": ["utf8", "json"],
                }
            ],
        },
    )

    detail = client.get(f"/v1/recordings/{rec_id}", headers=API).json()
    assert detail["live_status"]["bound_named_receivers"] == 1
    assert detail["live_status"]["named_participants"] == 1
    assert detail["live_status"]["dom_participants"] == 1

    transcript = client.get(f"/v1/recordings/{rec_id}/transcript", headers=API).json()
    assert len(transcript["segments"]) == 2
    assert transcript["segments"][0]["attribution_unknown"] is False
    assert transcript["segments"][0]["participant_id"] == "devices/alice-1"
    assert transcript["segments"][0]["participant_name"] == "Alice Visual"
    assert transcript["segments"][0]["speaker_label"] == "Alice Visual"
    assert transcript["segments"][1]["speaker_label"] == "Alice Visual"
    assert transcript["sources_summary"][0]["participant_name"] == "Alice Visual"
    assert transcript["sources_summary"][0]["signaled_participant_id"] == "devices/alice-1"


def test_persona_workflows_rejoin_desc_filters_reader_token_and_metrics(client, database):
    from wortlaut.exports import export_reader_token

    now = datetime.now(UTC)
    first = create(
        client,
        key="persona-1",
        body={
            "provider": "teams",
            "meeting_url": "https://teams.microsoft.com/meet/111111111?p=one",
            "title": "Kunden-Kickoff Alpha",
            "starts_at": (now - timedelta(minutes=10)).isoformat(),
            "ends_at": (now + timedelta(minutes=20)).isoformat(),
        },
    )
    second = create(
        client,
        key="persona-2",
        body={
            "provider": "google_meet",
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "title": "Architektur Review Beta",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
        },
    )

    desc_list = client.get("/v1/recordings?order=desc", headers=API).json()["items"]
    assert [item["id"] for item in desc_list[:2]] == [second, first]

    filtered = client.get("/v1/recordings?q=Architektur", headers=API).json()["items"]
    assert [item["id"] for item in filtered] == [second]

    multi_part = client.get(
        "/v1/recordings?participation=scheduled,capturing", headers=API
    ).json()["items"]
    assert {item["id"] for item in multi_part} >= {first, second}

    attempt, creds = prepare(client, first)
    client.post(f"/v1/attempts/{attempt}/claim", headers=creds, json={"worker_id": "w1"})
    client.post(
        f"/v1/attempts/{attempt}/status",
        headers={**creds, "X-Worker-ID": "w1"},
        json={"participation": "ended", "reason": "lobby_timeout"},
    )
    ended_state = client.get(f"/v1/recordings/{first}", headers=API).json()
    assert ended_state["participation"] == "ended"
    assert ended_state["participation_reason"] == "lobby_timeout"

    rejoined = client.post(f"/v1/recordings/{first}/rejoin", headers=API)
    assert rejoined.status_code == 200
    assert rejoined.json()["participation"] == "scheduled"
    assert rejoined.json()["participation_reason"] is None
    assert rejoined.json()["active_attempt_id"] is None

    attempt2, _ = prepare(client, first)
    assert attempt2 != attempt

    with Session(database) as db:
        rec_row = db.get(Recording, uuid.UUID(second))
        rec_row.processing = "completed"
        rec_row.processing_finished_at = now
        rec_row.export_reader_nonce = uuid.uuid4()
        db.commit()
        reader_tok = export_reader_token(rec_row)

    trans_res = client.get(
        f"/v1/recordings/{second}/transcript",
        headers={"Authorization": f"Bearer {reader_tok}"},
    )
    assert trans_res.status_code == 200

    rec_reader_res = client.get(
        f"/v1/recordings/{second}",
        headers={"Authorization": f"Bearer {reader_tok}"},
    )
    assert rec_reader_res.status_code == 200
    assert rec_reader_res.json()["title"] == "Architektur Review Beta"
    assert all("job_name" not in a for a in rec_reader_res.json().get("attempts", []))

    metrics_res = client.get("/metrics", headers=API)
    assert metrics_res.status_code == 200
    assert "wortlaut_recordings_total" in metrics_res.text
    assert "wortlaut_active_attempts 1" in metrics_res.text


def test_oidc_dex_pkce_exchange_and_per_user_isolation(client, database, monkeypatch):
    import base64
    import json
    import time

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    import wortlaut.oidc as oidc_mod

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub_numbers = private_key.public_key().public_numbers()

    def _int_b64(val: int) -> str:
        length = (val.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(val.to_bytes(length, "big")).rstrip(b"=").decode("ascii")

    jwks = [
        {
            "kty": "RSA",
            "kid": "test-dex-key-1",
            "alg": "RS256",
            "use": "sig",
            "n": _int_b64(pub_numbers.n),
            "e": _int_b64(pub_numbers.e),
        }
    ]
    monkeypatch.setattr(oidc_mod, "fetch_dex_jwks", lambda *, force_refresh=False: jwks)

    def _make_id_token(sub: str, email: str, name: str, nonce: str = "n1") -> str:
        header = {"alg": "RS256", "typ": "JWT", "kid": "test-dex-key-1"}
        now_ts = int(time.time())
        payload = {
            "iss": "https://id.data.mayflower.tech",
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
        signing_input = f"{h_b64}.{p_b64}".encode("ascii")
        sig = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        s_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
        return f"{h_b64}.{p_b64}.{s_b64}"

    next_id_token = {"value": ""}

    class _FakeResp:
        status_code = 200

        def json(self):
            return {"id_token": next_id_token["value"], "token_type": "bearer"}

    monkeypatch.setattr(oidc_mod.httpx, "post", lambda *a, **kw: _FakeResp())

    next_id_token["value"] = _make_id_token(
        "sub-mara", "mara.lindner@mayflower.de", "Mara Lindner", "nonce-mara"
    )
    ex_mara = client.post(
        "/v1/auth/oidc/exchange",
        json={
            "code": "code-mara",
            "code_verifier": "v" * 44,
            "redirect_uri": "http://127.0.0.1:34601/auth/callback",
            "nonce": "nonce-mara",
        },
    )
    assert ex_mara.status_code == 200
    mara_token = ex_mara.json()["token"]
    assert mara_token.startswith("wortlaut-user-")
    assert ex_mara.json()["user"]["email"] == "mara.lindner@mayflower.de"
    assert ex_mara.json()["user"]["is_admin"] is False
    mara_headers = {"Authorization": f"Bearer {mara_token}"}

    me_mara = client.get("/v1/auth/me", headers=mara_headers)
    assert me_mara.status_code == 200
    assert me_mara.json()["email"] == "mara.lindner@mayflower.de"

    next_id_token["value"] = _make_id_token(
        "sub-thomas", "thomas.berg@mayflower.de", "Thomas Berg", "nonce-thomas"
    )
    thomas_token = client.post(
        "/v1/auth/oidc/exchange",
        json={
            "code": "code-thomas",
            "code_verifier": "v" * 44,
            "redirect_uri": "http://127.0.0.1:34601/auth/callback",
            "nonce": "nonce-thomas",
        },
    ).json()["token"]
    thomas_headers = {"Authorization": f"Bearer {thomas_token}"}

    next_id_token["value"] = _make_id_token(
        "sub-admin",
        "johann-peter.hartmann@mayflower.de",
        "Johann-Peter Hartmann",
        "nonce-admin",
    )
    ex_admin = client.post(
        "/v1/auth/oidc/exchange",
        json={
            "code": "code-admin",
            "code_verifier": "v" * 44,
            "redirect_uri": "http://127.0.0.1:34601/auth/callback",
            "nonce": "nonce-admin",
        },
    )
    assert ex_admin.status_code == 200
    assert ex_admin.json()["user"]["is_admin"] is True
    admin_headers = {"Authorization": f"Bearer {ex_admin.json()['token']}"}

    now = datetime.now(UTC)
    rec_mara = client.post(
        "/v1/recordings",
        headers={**mara_headers, "Idempotency-Key": "oidc-mara-1"},
        json={
            "provider": "google_meet",
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "title": "Mara Sprint Sync",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
        },
    )
    assert rec_mara.status_code == 200
    rec_mara_id = rec_mara.json()["id"]
    assert rec_mara.json()["owner_email"] == "mara.lindner@mayflower.de"

    rec_thomas = client.post(
        "/v1/recordings",
        headers={**thomas_headers, "Idempotency-Key": "oidc-thomas-1"},
        json={
            "provider": "teams",
            "meeting_url": "https://teams.microsoft.com/meet/222222222?p=two",
            "title": "Thomas Kunden-Call",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
        },
    )
    assert rec_thomas.status_code == 200
    rec_thomas_id = rec_thomas.json()["id"]

    mara_list_ids = {
        r["id"] for r in client.get("/v1/recordings", headers=mara_headers).json()["items"]
    }
    assert rec_mara_id in mara_list_ids
    assert rec_thomas_id not in mara_list_ids

    assert client.get(f"/v1/recordings/{rec_thomas_id}", headers=mara_headers).status_code == 404
    assert (
        client.post(f"/v1/recordings/{rec_thomas_id}/cancel", headers=mara_headers).status_code
        == 404
    )

    admin_list_ids = {
        r["id"] for r in client.get("/v1/recordings", headers=admin_headers).json()["items"]
    }
    assert {rec_mara_id, rec_thomas_id} <= admin_list_ids
    assert client.get(f"/v1/recordings/{rec_thomas_id}", headers=admin_headers).status_code == 200

    privacy = client.get("/privacy")
    assert privacy.status_code == 200
    assert "Datenschutz- &amp; Transparenzhinweis" in privacy.text
    assert "Keine Stimmprofile" in privacy.text

    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    get_settings.cache_clear()
    attempt_id, attempt_headers = prepare(client, rec_mara_id)
    assert (
        client.post(
            f"/v1/attempts/{attempt_id}/claim",
            headers=attempt_headers,
            json={"worker_id": "owner-mara"},
        ).status_code
        == 200
    )
    boot = client.get(
        f"/v1/attempts/{attempt_id}/bootstrap",
        headers={**attempt_headers, "X-Worker-ID": "owner-mara"},
    )
    assert boot.status_code == 200
    boot_data = boot.json()
    assert boot_data["invited_by"] == "mara.lindner@mayflower.de"
    assert "mara.lindner@mayflower.de" in boot_data["chat_intro"]
    assert f"/ui#view=meetings&id={rec_mara_id}" in boot_data["chat_intro"]
    assert "/privacy" in boot_data["chat_intro"]

    assert (
        client.delete(f"/v1/recordings/{rec_thomas_id}", headers=mara_headers).status_code == 404
    )
    del_res = client.delete(f"/v1/recordings/{rec_thomas_id}", headers=thomas_headers)
    assert del_res.status_code == 200
    assert del_res.json() == {"deleted": True, "id": rec_thomas_id}
    assert client.get(f"/v1/recordings/{rec_thomas_id}", headers=thomas_headers).status_code == 404

    monkeypatch.setenv("WORTLAUT_GOOGLE_CALENDAR_CLIENT_ID", "gcal-client-id")
    monkeypatch.setenv("WORTLAUT_GOOGLE_CALENDAR_CLIENT_SECRET", "gcal-secret")
    monkeypatch.setenv("WORTLAUT_MICROSOFT_CALENDAR_CLIENT_ID", "m365-client-id")
    monkeypatch.setenv("WORTLAUT_MICROSOFT_CALENDAR_CLIENT_SECRET", "m365-secret")
    get_settings.cache_clear()

    import wortlaut.calendar_oauth as cal_oauth_mod

    gcal_start = (now + timedelta(hours=1)).isoformat()
    gcal_end = (now + timedelta(hours=2)).isoformat()
    m365_start = (now + timedelta(hours=3)).isoformat()
    m365_end = (now + timedelta(hours=4)).isoformat()

    class _FakeCalTokenResp:
        def __init__(self, email: str):
            self.status_code = 200
            self._email = email

        def json(self):
            return {
                "access_token": f"access-{self._email}",
                "refresh_token": f"refresh-{self._email}",
                "expires_in": 3600,
                "id_token": _make_id_token("sub-cal", self._email, "Cal User"),
            }

    monkeypatch.setattr(
        cal_oauth_mod.httpx,
        "post",
        lambda url, **kw: _FakeCalTokenResp(
            "mara.lindner@mayflower.de"
            if "googleapis.com" in url
            else "thomas.berg@mayflower.de"
        ),
    )
    class _FakeCalGetResp:
        def __init__(self, payload: dict):
            self.status_code = 200
            self._payload = payload

        def json(self):
            return self._payload

    def _fake_cal_get(url, **kw):
        if "googleapis.com" in url:
            return _FakeCalGetResp(
                {
                    "items": [
                        {
                            "id": "gcal-own-1",
                            "status": "confirmed",
                            "summary": "Interner Sprint Planning",
                            "organizer": {"email": "mara.lindner@mayflower.de", "self": True},
                            "attendees": [
                                {
                                    "email": "mara.lindner@mayflower.de",
                                    "self": True,
                                    "responseStatus": "accepted",
                                },
                                {
                                    "email": "kollege@mayflower.de",
                                    "responseStatus": "accepted",
                                },
                            ],
                            "start": {"dateTime": gcal_start},
                            "end": {"dateTime": gcal_end},
                            "hangoutLink": "https://meet.google.com/own-meet-xyz",
                        },
                        {
                            "id": "gcal-solo-blocker",
                            "status": "confirmed",
                            "summary": "Fokuszeit ohne Teilnehmer",
                            "organizer": {"email": "mara.lindner@mayflower.de", "self": True},
                            "start": {"dateTime": gcal_start},
                            "end": {"dateTime": gcal_end},
                            "hangoutLink": "https://meet.google.com/sol-blck-xyz",
                        },
                        {
                            "id": "gcal-unconfirmed-3",
                            "status": "confirmed",
                            "summary": "Latein Nachhilfe",
                            "organizer": {"email": "mara.lindner@mayflower.de", "self": True},
                            "attendees": [
                                {
                                    "email": "mara.lindner@mayflower.de",
                                    "self": True,
                                    "responseStatus": "accepted",
                                },
                                {
                                    "email": "schueler@outlook.example",
                                    "responseStatus": "needsAction",
                                },
                            ],
                            "start": {"dateTime": gcal_start},
                            "end": {"dateTime": gcal_end},
                            "hangoutLink": "https://meet.google.com/lat-nach-xyz",
                        },
                        {
                            "id": "gcal-ext-2",
                            "status": "confirmed",
                            "summary": "Kunden-Workshop ACME",
                            "organizer": {"email": "kunde@acme-corp.example", "self": False},
                            "start": {"dateTime": gcal_start},
                            "end": {"dateTime": gcal_end},
                            "hangoutLink": "https://meet.google.com/ext-cust-abc",
                        },
                    ]
                }
            )
        return _FakeCalGetResp(
            {
                "value": [
                    {
                        "id": "m365-ext-1",
                        "subject": "Enterprise Pitch Microsoft Teams",
                        "isCancelled": False,
                        "isOrganizer": False,
                        "organizer": {
                            "emailAddress": {"address": "procurement@enterprise.example"}
                        },
                        "start": {"dateTime": m365_start, "timeZone": "UTC"},
                        "end": {"dateTime": m365_end, "timeZone": "UTC"},
                        "onlineMeeting": {
                            "joinUrl": "https://teams.microsoft.com/meet/999888777?p=ext"
                        },
                    }
                ]
            }
        )

    monkeypatch.setattr(cal_oauth_mod.httpx, "get", _fake_cal_get)

    gcal_ex = client.post(
        "/v1/calendar/oauth/exchange",
        headers=mara_headers,
        json={
            "provider": "google",
            "code": "gcal-auth-code",
            "code_verifier": "g" * 44,
            "redirect_uri": "https://wortlaut.data.mayflower.tech/auth/callback",
        },
    )
    assert gcal_ex.status_code == 200, gcal_ex.text
    gcal_data = gcal_ex.json()
    assert gcal_data["connection"]["provider"] == "google"
    assert gcal_data["connection"]["account_email"] == "mara.lindner@mayflower.de"
    events_by_ext = {e["external_event_id"]: e for e in gcal_data["synced_events"]}
    assert set(events_by_ext) == {"gcal-own-1", "gcal-unconfirmed-3", "gcal-ext-2"}

    own_ev = events_by_ext["gcal-own-1"]
    assert own_ev["is_self_organized"] is True
    assert own_ev["auto_record"] is True
    assert own_ev["recording_id"] is not None

    unconf_ev = events_by_ext["gcal-unconfirmed-3"]
    assert unconf_ev["is_self_organized"] is True
    assert unconf_ev["auto_record"] is False
    assert unconf_ev["recording_id"] is None

    ext_ev = events_by_ext["gcal-ext-2"]
    assert ext_ev["is_self_organized"] is False
    assert ext_ev["auto_record"] is False
    assert ext_ev["recording_id"] is None

    toggle_on = client.post(
        f"/v1/calendar/oauth/events/{ext_ev['id']}/toggle",
        headers=mara_headers,
        json={"enabled": True},
    )
    assert toggle_on.status_code == 200
    assert toggle_on.json()["auto_record"] is True
    assert toggle_on.json()["user_override"] is True
    ext_rec_id = toggle_on.json()["recording_id"]
    assert ext_rec_id is not None

    cancel_ext = client.post(f"/v1/recordings/{ext_rec_id}/cancel", headers=mara_headers)
    assert cancel_ext.status_code == 200
    resync = client.post(
        f"/v1/calendar/oauth/connections/{gcal_data['connection']['id']}/sync",
        headers=mara_headers,
    )
    assert resync.status_code == 200
    resync_by_ext = {e["external_event_id"]: e for e in resync.json()["synced_events"]}
    assert resync_by_ext["gcal-ext-2"]["auto_record"] is False
    assert resync_by_ext["gcal-ext-2"]["user_override"] is False
    assert resync_by_ext["gcal-ext-2"]["recording_id"] is None

    toggle_off = client.post(
        f"/v1/calendar/oauth/events/{own_ev['id']}/toggle",
        headers=mara_headers,
        json={"enabled": False},
    )
    assert toggle_off.status_code == 200
    assert toggle_off.json()["auto_record"] is False
    assert toggle_off.json()["user_override"] is False
    assert toggle_off.json()["recording_id"] is None

    m365_ex = client.post(
        "/v1/calendar/oauth/exchange",
        headers=thomas_headers,
        json={
            "provider": "microsoft",
            "code": "m365-auth-code",
            "code_verifier": "m" * 44,
            "redirect_uri": "https://wortlaut.data.mayflower.tech/auth/callback",
        },
    )
    assert m365_ex.status_code == 200, m365_ex.text
    m365_ev = m365_ex.json()["synced_events"][0]
    assert m365_ev["calendar_provider"] == "microsoft"
    assert m365_ev["meeting_provider"] == "teams"
    assert m365_ev["is_self_organized"] is False
    assert m365_ev["auto_record"] is False

    cal_mara = client.get("/v1/calendar", headers=mara_headers).json()
    assert len(cal_mara["connections"]) == 1
    assert {e["external_event_id"] for e in cal_mara["synced_events"]} == {
        "gcal-own-1",
        "gcal-unconfirmed-3",
        "gcal-ext-2",
    }

    disc = client.delete(
        f"/v1/calendar/oauth/connections/{gcal_data['connection']['id']}",
        headers=mara_headers,
    )
    assert disc.status_code == 200
    assert client.get("/v1/calendar", headers=mara_headers).json()["connections"] == []



