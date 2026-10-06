import uuid
from datetime import UTC, datetime, timedelta

from botocore.exceptions import ClientError
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ingest import authenticate, begin, source
from test_processing import audio, send_pcm
from test_recordings import API

from wortlaut.asr import commit_result, finalize_processing
from wortlaut.ingest import capacity_reached, pending_samples
from wortlaut.models import AsrJob, Attempt, AudioChunk, Recording, TranscriptSegment
from wortlaut.processing import segmentation_pass
from wortlaut.retention import retention_pass


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
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
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
        socket.receive_json()
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identity["meeting_id"]))
        recording.participation = "ended"
        db.get(Attempt, uuid.UUID(attempt)).ended_at = datetime.now(UTC)
        db.commit()
    segmentation_pass(database)
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
