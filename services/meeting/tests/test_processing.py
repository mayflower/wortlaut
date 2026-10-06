import uuid
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ingest import authenticate, begin, frame, source
from test_recordings import API

from wortlaut.models import AsrJob, Attempt, AudioStream
from wortlaut.processing import read_pcm, segmentation_pass, timeline
from wortlaut.settings import get_settings

FIXTURES = Path(__file__).resolve().parents[3] / "worker/test/fixtures"


def audio(name):
    with wave.open(str(FIXTURES / name), "rb") as fixture:
        assert (fixture.getnchannels(), fixture.getframerate(), fixture.getsampwidth()) == (
            1,
            16000,
            2,
        )
        return fixture.readframes(fixture.getnframes())


def send_pcm(socket, identity, pcm, sequence, start):
    metadata = {
        **identity,
        "sequence": sequence,
        "start_sample": start,
        "sample_count": len(pcm) // 2,
    }
    socket.send_bytes(frame(metadata, pcm))
    assert socket.receive_json()["type"] == "ack"


def test_speech_across_chunk_boundary_replays_after_restart_and_sources_remain_separate(
    client, database, storage
):
    attempt, credential, first = source(client)
    second = {
        **first,
        "stream_id": str(uuid.uuid4()),
        "epoch": str(uuid.uuid4()),
        "speaker_id": "speaker-B",
        "provider_source_id": "fixture:two",
        "monotonic_origin_ms": 1700,
    }
    pcm_a, pcm_b = audio("german-a.wav"), audio("german-b.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for identity in [first, second]:
            socket.send_json(begin(identity))
            socket.receive_json()
        send_pcm(socket, first, pcm_a[:32000], 0, 0)
        segmentation_pass(database)
        with Session(database) as db:
            assert not db.scalars(select(AsrJob)).all()
        # Release DB connections. Reconstruct the open voice from committed S3 data.
        database.dispose()
        for identity, pcm, offset in [(first, pcm_a, 16000), (second, pcm_b, 0)]:
            sequence = 1 if offset else 0
            while offset * 2 < len(pcm):
                piece = pcm[offset * 2 : (offset + 80000) * 2]
                send_pcm(socket, identity, piece, sequence, offset)
                offset += len(piece) // 2
                sequence += 1
            socket.send_json(
                {
                    "type": "end",
                    "id": begin(identity)["id"] + "/end",
                    "stream_id": identity["stream_id"],
                    "epoch": identity["epoch"],
                    "final_sample": offset,
                    "last_sequence": sequence - 1,
                }
            )
            socket.receive_json()
    for _ in range(10):
        segmentation_pass(database)
    with Session(database) as db:
        jobs = db.scalars(select(AsrJob)).all()
        identifiers = {job.id for job in jobs}
        assert len({job.stream_id for job in jobs}) == 2
        assert {job.binding["speaker_id"] for job in jobs} == {"speaker-A", "speaker-B"}
        first_stream = db.scalar(
            select(AudioStream).where(AudioStream.stream_id == uuid.UUID(first["stream_id"]))
        )
        assert any(
            job.stream_id == first_stream.id and job.start_sample < 16000 < job.end_sample
            for job in jobs
        )
        assert all(stream.scan_complete for stream in db.scalars(select(AudioStream)).all())
        for job in jobs:
            stream = db.get(AudioStream, job.stream_id)
            run = next(r for r in timeline(db, stream)[0] if r.start <= job.start_sample < r.end)
            original = pcm_a if job.binding["speaker_id"] == "speaker-A" else pcm_b
            assert (
                read_pcm(run.chunks, job.start_sample, job.end_sample)
                == original[job.start_sample * 2 : job.end_sample * 2]
            )
    segmentation_pass(database)
    with Session(database) as db:
        assert {job.id for job in db.scalars(select(AsrJob)).all()} == identifiers


def test_missing_end_finalizes_known_audio_without_inventing_tail_or_unlocking_worker(
    client, database, storage
):
    attempt, credential, identity = source(client)
    pcm = audio("german-a.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        send_pcm(socket, identity, pcm[:32000], 0, 0)
    # Confirmed end, drain expired; no EOS or evidence for lost tail duration.
    with Session(database) as db:
        stored = db.get(Attempt, uuid.UUID(attempt))
        stored.ended_at = datetime.now(UTC) - timedelta(seconds=30)
        db.commit()
    segmentation_pass(database)
    status = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    assert status["audio"][0]["capture_end_unknown"] is True
    assert status["audio"][0]["known_gaps"] == []
    assert status["audio"][0]["segmentation_complete"] is True
    assert (
        client.post(f"/v1/recordings/{identity['meeting_id']}/attempts", headers=API).status_code
        == 409
    )


def test_sample_bound_source_change_closes_voice_and_preserves_old_speaker(
    client, database, storage
):
    attempt, credential, identity = source(client)
    changed = {**identity, "speaker_id": "speaker-B", "provider_source_id": "fixture:second"}
    pcm_b = audio("german-b.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        send_pcm(socket, identity, audio("german-a.wav")[:32000], 0, 0)
        socket.send_json(
            {
                "type": "bind",
                "id": begin(identity)["id"] + "/bind",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "start_sample": 16000,
                "speaker_id": "speaker-B",
                "provider_source_id": "fixture:second",
                "source_kind": "speaker",
                "attribution_unknown": False,
            }
        )
        assert socket.receive_json()["type"] == "ack"
        send_pcm(socket, changed, pcm_b, 1, 16000)
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": 16000 + len(pcm_b) // 2,
                "last_sequence": 1,
            }
        )
        assert socket.receive_json()["type"] == "ack"
    for _ in range(5):
        segmentation_pass(database)
    with Session(database) as db:
        jobs = db.scalars(select(AsrJob)).all()
        assert {job.binding["speaker_id"] for job in jobs} == {"speaker-A", "speaker-B"}
        for job in jobs:
            if job.binding["speaker_id"] == "speaker-A":
                assert job.end_sample <= 16000
                assert job.binding["provider_source_id"] == "fixture:one"
            else:
                assert job.start_sample >= 16000
                assert job.binding["provider_source_id"] == "fixture:second"


def test_job_capacity_keeps_unsegmented_audio_and_resumes_after_result_commit(
    client, database, storage, monkeypatch
):
    from wortlaut.asr import commit_result

    attempt, credential, identity = source(client)
    second = {**identity, "stream_id": str(uuid.uuid4()), "epoch": str(uuid.uuid4())}
    pcm = audio("german-a.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for current in [identity, second]:
            socket.send_json(begin(current))
            socket.receive_json()
            send_pcm(socket, current, pcm, 0, 0)
            socket.send_json(
                {
                    "type": "end",
                    "id": begin(current)["id"] + "/end",
                    "stream_id": current["stream_id"],
                    "epoch": current["epoch"],
                    "final_sample": len(pcm) // 2,
                    "last_sequence": 0,
                }
            )
            socket.receive_json()
    monkeypatch.setenv("WORTLAUT_MAX_OPEN_ASR_JOBS", "1")
    get_settings.cache_clear()
    try:
        for _ in range(5):
            segmentation_pass(database)
        with Session(database) as db:
            jobs = db.scalars(select(AsrJob)).all()
            assert len(jobs) == 1
            blocked = db.scalar(select(AudioStream).where(AudioStream.scan_sample == 0))
            assert blocked is not None and not blocked.scan_complete
            blocked_id = blocked.id
            commit_result(db, jobs[0].id, {"text": "controlled completed result"})
        for _ in range(5):
            segmentation_pass(database)
        with Session(database) as db:
            job = db.scalar(select(AsrJob).where(AsrJob.status == "pending"))
            assert job.stream_id == blocked_id
            stream = db.get(AudioStream, blocked_id)
            run = timeline(db, stream)[0][0]
            assert read_pcm(run.chunks, job.start_sample, job.end_sample)
    finally:
        get_settings.cache_clear()
