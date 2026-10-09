import uuid
from datetime import UTC, datetime, timedelta

from botocore.exceptions import ClientError
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_calendar import configure, imported, mail
from test_ingest import authenticate, begin, source
from test_processing import audio, send_pcm
from test_recordings import API

from wortlaut.asr import commit_result, finalize_processing, segment_result
from wortlaut.calendar import consume_imap_message
from wortlaut.ingest import capacity_reached, pending_samples
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioControl,
    AudioStream,
    CalendarEntry,
    Delivery,
    MailImport,
    Recording,
    TranscriptSegment,
)
from wortlaut.processing import segmentation_pass
from wortlaut.recurrence import recurrence_pass
from wortlaut.retention import retention_pass
from wortlaut.settings import get_settings


def test_abandonment_preserves_partial_quality_and_does_not_release_worker(
    client, database, storage
):
    attempt, credential, identity = source(client)
    second = {**identity, "stream_id": str(uuid.uuid4()), "epoch": str(uuid.uuid4())}
    pcm = audio("german-a.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for source_identity, piece in ((identity, pcm[:32000]), (second, pcm)):
            socket.send_json(begin(source_identity))
            socket.receive_json()
            send_pcm(socket, source_identity, piece, 0, 0)
        socket.send_json(
            {
                "type": "end",
                "id": begin(second)["id"] + "/end",
                "stream_id": second["stream_id"],
                "epoch": second["epoch"],
                "final_sample": len(pcm) // 2,
                "last_sequence": 0,
            }
        )
        socket.receive_json()
    for _ in range(5):
        segmentation_pass(database)
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identity["meeting_id"]))
        recording.ends_at = datetime.now(UTC) - timedelta(hours=73)
        job = db.scalar(select(AsrJob))
        job.status, job.claimed_at = "processing", datetime.now(UTC)
        identifier = job.id
        db.commit()
    retention_pass(database)
    status = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    assert status["processing"] == "failed"
    assert status["processing_error"] == "audio_retention_expired"
    assert status["participation"] == "joining"
    exported = client.get(
        f"/v1/recordings/{identity['meeting_id']}/exports/json", headers=API
    ).json()
    assert exported["quality"]["unprocessed_audio"]
    assert exported["quality"]["failed_asr_ranges"]
    assert exported["quality"]["capture_end_unknown"]
    with Session(database) as db:
        assert db.get(Attempt, uuid.UUID(attempt)).ended_at is None
        assert pending_samples(db) == 0
        commit_result(db, identifier, {"text": "late result must not revive"})
        assert db.get(TranscriptSegment, identifier) is None
        assert db.get(AsrJob, identifier).status == "failed"
        chunk = db.scalar(select(AudioChunk))
        assert storage.read(chunk.object_key)
    assert (
        client.post(f"/v1/recordings/{identity['meeting_id']}/attempts", headers=API).status_code
        == 409
    )
    worker_headers = {"Authorization": f"Bearer {credential}", "X-Worker-ID": "fixture-worker"}
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim",
            headers=worker_headers,
            json={"worker_id": "fixture-worker"},
        ).status_code
        == 409
    )
    assert (
        client.get(f"/v1/attempts/{attempt}/bootstrap", headers=worker_headers).status_code == 409
    )


def test_audio_cleanup_covers_orphans_and_keeps_exports_until_separate_expiry(
    client, database, storage
):
    attempt, credential, identity = source(client)
    pcm = audio("german-a.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        send_pcm(socket, identity, pcm, 0, 0)
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": len(pcm) // 2,
                "last_sequence": 0,
            }
        )
        socket.receive_json()
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identity["meeting_id"]))
        recording.participation = "ended"
        db.get(Attempt, uuid.UUID(attempt)).ended_at = datetime.now(UTC)
        db.commit()
    segmentation_pass(database)
    with Session(database) as db:
        job = db.scalar(select(AsrJob))
        identifier = job.id
        result = segment_result(
            job,
            db.get(AudioStream, job.stream_id),
            {"text": "fixture", "words": [{"word": "fixture", "start": 0.1, "end": 0.2}]},
        )
        commit_result(db, identifier, result)
        db.get(Attempt, uuid.UUID(attempt)).diagnostics = {
            "participants": [{"id": "device-session", "name": "private participant"}]
        }
        db.add(
            Delivery(
                recording_id=uuid.UUID(identity["meeting_id"]),
                message_id="<retention-fixture@example.org>",
                recipients=["private@example.org"],
                accepted_recipients=["private@example.org"],
                refused_codes={"other-private@example.org": 550},
                status="delivery_unknown",
            )
        )
        db.commit()
    finalize_processing(database)
    orphan = f"audio/{identity['meeting_id']}/uncommitted.pcm"
    storage.put(orphan, b"\0\0", {"fixture": True})
    retention_pass(database)  # Neither success nor a cleanup pass deletes fresh audio.
    assert storage.read(orphan) == b"\0\0"
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identity["meeting_id"]))
        assert recording.processing == "completed"
        recording.processing_finished_at = datetime.now(UTC) - timedelta(hours=25)
        db.commit()
    retention_pass(database)
    retention_pass(database)  # Idempotent even if the previous pass lost its caller.
    assert not storage.client.list_objects_v2(
        Bucket=storage.bucket, Prefix=f"audio/{identity['meeting_id']}/"
    ).get("Contents")
    with Session(database) as db:
        chunk = db.scalar(select(AudioChunk))
        assert chunk.deleted_at is not None
        assert not capacity_reached(db)
        try:
            storage.read(chunk.object_key)
        except ClientError as error:
            assert error.response["ResponseMetadata"]["HTTPStatusCode"] == 404
        else:
            raise AssertionError("Audio survived expiry")
    prefix = f"/v1/recordings/{identity['meeting_id']}/exports/json"
    response = client.get(prefix, headers=API)
    assert response.status_code == 200
    assert response.json()["quality"]["streams"][0]["audio_deleted"]
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identity["meeting_id"]))
        recording.processing_finished_at = datetime.now(UTC) - timedelta(days=31)
        db.commit()
    retention_pass(database)
    assert client.get(prefix, headers=API).status_code == 410
    assert (
        client.post(
            f"/v1/recordings/{identity['meeting_id']}/delivery/retry", headers=API
        ).status_code
        == 410
    )
    with Session(database) as db:
        # Participation ended, but process termination is still unproved.
        assert db.get(Recording, uuid.UUID(identity["meeting_id"])).metadata_deleted_at is None
        stored = db.get(Attempt, uuid.UUID(attempt))
        assert stored.diagnostics["participants"][0]["name"] == "private participant"
        stored.process_ended_at = datetime.now(UTC)
        db.commit()
    retention_pass(database)
    retention_pass(database)
    status = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    assert status["metadata_deleted_at"] is not None
    assert status["audio"] == []
    assert status["attempts"][0]["diagnostics"] == {}
    assert status["active_attempt_id"] == attempt
    with Session(database) as db:
        for model in (AudioControl, AudioChunk, AudioStream, AsrJob, TranscriptSegment):
            assert db.scalar(select(model)) is None
        recording = db.get(Recording, uuid.UUID(identity["meeting_id"]))
        assert recording.meeting_url == "" and recording.export_reader_nonce is None
        delivery = db.get(Delivery, recording.id)
        assert delivery.recipients == delivery.accepted_recipients == []
        assert delivery.refused_codes == {}
        commit_result(db, identifier, {"text": "late deleted result"})
        assert db.get(TranscriptSegment, identifier) is None
    assert (
        client.post(f"/v1/recordings/{identity['meeting_id']}/attempts", headers=API).status_code
        == 409
    )


def test_calendar_retention_preserves_active_series_and_historical_deduplication(
    client, database, storage, monkeypatch
):
    from icalendar import Calendar

    configure(monkeypatch)
    monkeypatch.setenv("WORTLAUT_CALENDAR_HORIZON_DAYS", "1")
    get_settings.cache_clear()
    now = datetime.now(UTC)
    past = (now - timedelta(days=45)).replace(microsecond=0)
    arguments = {
        "starts": "DTSTART:" + past.strftime("%Y%m%dT%H%M%SZ"),
        "ends": "DTEND:" + (past + timedelta(minutes=30)).strftime("%Y%m%dT%H%M%SZ"),
        "link": "https://meet.google.com/abc-defg-hij",
        "extra": (
            "DESCRIPTION:private invitation\r\n"
            "ATTENDEE;CN=Private Name:mailto:private@example.org\r\n"
        ),
    }
    single = mail(uid="expired-single", **arguments)
    with Session(database) as db:
        result = consume_imap_message(db, 1, 1, single)[0]
        db.commit()
    series = mail(
        uid="active-series",
        **{**arguments, "extra": arguments["extra"] + "RRULE:FREQ=DAILY;COUNT=100\r\n"},
    )
    imported(client, series)
    recurrence_pass(database, past - timedelta(seconds=1))
    with Session(database) as db:
        old = db.scalars(select(Recording)).all()
        old_ids = {r.id for r in old}
        assert len(old_ids) == 2
        for recording in old:
            recording.participation, recording.processing = "ended", "completed"
            recording.processing_finished_at = now - timedelta(days=31)
        db.commit()
    recurrence_pass(database, now)
    with Session(database) as db:
        upcoming_ids = set(db.scalars(select(Recording.id).where(Recording.id.not_in(old_ids))))
        assert upcoming_ids
    retention_pass(database)
    with Session(database) as db:
        entry = db.get(CalendarEntry, uuid.UUID(result["id"]))
        assert entry.original == "" and entry.status == "accepted"
        assert "organizer" not in db.scalar(select(MailImport)).result[0]
        master = db.scalar(select(CalendarEntry).where(CalendarEntry.uid == "active-series"))
        event = Calendar.from_ical(master.original).walk("VEVENT")[0]
        assert event.get("ATTENDEE") is None and event.get("DESCRIPTION") is None
        assert str(event["RRULE"]["FREQ"][0]) == "DAILY"
        assert str(event["URL"]) == arguments["link"]
        assert all(db.get(Recording, identifier).metadata_deleted_at for identifier in old_ids)
        for upcoming_id in upcoming_ids:
            upcoming = db.get(Recording, upcoming_id)
            assert upcoming.participation == "scheduled" and upcoming.metadata_deleted_at is None
            assert upcoming.meeting_url == arguments["link"]
        replay = consume_imap_message(db, 1, 1, single)[0]
        assert replay["recording_id"] == result["recording_id"]
        db.commit()
    assert imported(client, single)["recording_id"] == result["recording_id"]
    assert imported(client, series)["import"] == "replay"
    recurrence_pass(database, now)
    with Session(database) as db:
        assert {r.id for r in db.scalars(select(Recording))} == old_ids | upcoming_ids
        assert all(
            db.get(Recording, identifier).participation == "scheduled"
            for identifier in upcoming_ids
        )
        assert db.get(CalendarEntry, uuid.UUID(result["id"])).status == "accepted"
    assert (
        client.post(f"/v1/recordings/{result['recording_id']}/attempts", headers=API).status_code
        == 409
    )
