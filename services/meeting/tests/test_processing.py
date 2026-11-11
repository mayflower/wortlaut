import uuid
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ingest import authenticate, begin, frame, source
from test_recordings import API

from wortlaut.asr import finalize_processing
from wortlaut.models import AsrJob, Attempt, AudioChunk, AudioStream
from wortlaut.processing import read_pcm, segmentation_pass, timeline
from wortlaut.settings import get_settings

FIXTURES = Path(__file__).resolve().parents[3] / "worker/test/fixtures"


def test_corrupt_object_does_not_rollback_healthy_meeting_and_failure_is_exported(
    client, database, storage
):
    identities = []
    for _ in range(2):
        attempt, credential, identity = source(client, key=str(uuid.uuid4()))
        identities.append(identity)
        pcm = audio("german-a.wav")
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
            authenticate(socket, credential)
            socket.send_json(begin(identity))
            assert socket.receive_json()["type"] == "ack"
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
            assert socket.receive_json()["type"] == "ack"
        owner = {"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"}
        assert (
            client.post(
                f"/v1/attempts/{attempt}/status",
                headers=owner,
                json={"participation": "ended", "reason": "fixture_done"},
            ).status_code
            == 200
        )
    with Session(database) as db:
        damaged = db.scalar(
            select(AudioStream).where(
                AudioStream.stream_id == uuid.UUID(identities[0]["stream_id"])
            )
        )
        chunk = db.scalar(select(AudioChunk).where(AudioChunk.stream_id == damaged.id))
        damaged_id, chunk_id, key = damaged.id, chunk.id, chunk.object_key
    # Corrupt a real stored object, rather than replacing the storage read with a mock.
    storage.client.put_object(Bucket=storage.bucket, Key=key, Body=b"invalid PCM object")
    segmentation_pass(database)
    with Session(database) as db:
        assert db.get(AudioChunk, chunk_id).read_failures == 1
        assert db.get(AudioStream, damaged_id).scan_sample == 0
        healthy = db.scalar(select(AudioStream).where(AudioStream.id != damaged_id))
        assert healthy.scan_complete
        assert db.scalars(select(AsrJob).where(AsrJob.stream_id == healthy.id)).all()
    for _ in range(2):
        with Session(database) as db:
            db.get(AudioStream, damaged_id).scan_retry_at = datetime.now(UTC) - timedelta(seconds=1)
            db.commit()
        segmentation_pass(database)
    segmentation_pass(database)
    with Session(database) as db:
        assert db.get(AudioChunk, chunk_id).processing_error == "audio_integrity_failure"
        assert db.get(AudioStream, damaged_id).scan_complete
    finalize_processing(database)
    data = client.get(
        f"/v1/recordings/{identities[0]['meeting_id']}/exports/json", headers=API
    ).json()
    assert data["quality"]["unprocessed_audio"] is True
    assert data["quality"]["streams"][0]["unprocessed_ranges"] == [
        {"start_sample": 0, "end_sample": len(pcm) // 2, "reason": "audio_integrity_failure"}
    ]
    assert not data["quality"]["has_audio_gaps"]  # Received bytes failed processing, not transport.


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


def test_quality_preserves_replay_window_missing_eos_and_empty_sources(client, database, storage):
    attempt, credential, identity = source(client)
    empty = {**identity, "stream_id": str(uuid.uuid4()), "epoch": str(uuid.uuid4())}
    unknown = {
        **identity,
        "stream_id": str(uuid.uuid4()),
        "epoch": str(uuid.uuid4()),
        "provider_source_id": "fixture:unknown",
        "speaker_id": None,
        "attribution_unknown": True,
    }
    gap = {
        "type": "gap",
        "id": begin(identity)["id"] + "/possible",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "sequence": 1,
        "start_sample": 100,
        "sample_count": 100,
        "reason": "worker_buffer_limit",
    }
    closing = {
        "type": "end",
        "id": begin(identity)["id"] + "/end",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "final_sample": 400,
        "last_sequence": 3,
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for metadata in (identity, empty, unknown):
            socket.send_json(begin(metadata))
            assert socket.receive_json()["type"] == "ack"
        send_pcm(socket, identity, b"\0\0" * 100, 0, 0)
        send_pcm(socket, identity, b"\0\0" * 100, 2, 200)
        send_pcm(socket, unknown, b"\0\0" * 50, 0, 0)
        for control in (
            {**gap, "id": gap["id"] + "/stored", "sequence": 0, "start_sample": 0},
            gap,
            closing,
            {
                **closing,
                "id": begin(empty)["id"] + "/end",
                "stream_id": empty["stream_id"],
                "epoch": empty["epoch"],
                "final_sample": 0,
                "last_sequence": -1,
            },
        ):
            socket.send_json(control)
            assert socket.receive_json() == {"type": "ack", "id": control["id"]}
        detail = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
        qualities = {s["stream_id"]: s for s in detail["audio"]}
        first = qualities[identity["stream_id"]]
        assert first["accepted_samples"] == 200 and first["last_durable_sample"] == 300
        assert first["end_received"] and first["pending_input"]
        assert first["known_gaps"] == []  # Possible loss is still eligible for replay, despite EOS.
        assert qualities[empty["stream_id"]]["accepted_samples"] == 0
        assert qualities[empty["stream_id"]]["known_gaps"] == []
        assert not qualities[empty["stream_id"]]["pending_input"]
        assert qualities[unknown["stream_id"]]["capture_end_unknown"]
        assert qualities[unknown["stream_id"]]["attribution_unknown"]
        finalized = {**gap, "id": gap["id"] + "/final", "final": True}
        socket.send_json(finalized)
        assert socket.receive_json() == {"type": "ack", "id": finalized["id"]}
    detail = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    first = next(s for s in detail["audio"] if s["stream_id"] == identity["stream_id"])
    assert first["known_gaps"] == [{"start_sample": 100, "end_sample": 200}]
    assert first["pending_input"]  # Tail losses remain unknown before the drain deadline.
    assert (
        client.post(
            f"/v1/attempts/{attempt}/status",
            headers={"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"},
            json={"participation": "ended", "reason": "fixture_done"},
        ).status_code
        == 200
    )
    with Session(database) as db:
        db.get(Attempt, uuid.UUID(attempt)).ended_at = datetime.now(UTC) - timedelta(seconds=30)
        db.commit()
    segmentation_pass(database)
    finalize_processing(database)
    detail = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    response = client.get(f"/v1/recordings/{identity['meeting_id']}/exports/json", headers=API)
    assert response.status_code == 200
    exported = response.json()
    qualities = {s["stream_id"]: s for s in detail["audio"]}
    exported_qualities = {s["stream_id"]: s for s in exported["quality"]["streams"]}
    for metadata in (identity, empty, unknown):
        quality = qualities[metadata["stream_id"]]
        for key in (
            "accepted_samples",
            "last_durable_sample",
            "known_gaps",
            "pending_input",
            "capture_end_unknown",
            "attribution_unknown",
            "audio_deleted",
            "unprocessed_ranges",
        ):
            assert exported_qualities[metadata["stream_id"]][key] == quality[key]
        assert not quality["pending_input"]
    assert qualities[identity["stream_id"]]["known_gaps"] == [
        {"start_sample": 100, "end_sample": 200},
        {"start_sample": 300, "end_sample": 400},
    ]
    assert qualities[unknown["stream_id"]]["known_gaps"] == []
    assert qualities[unknown["stream_id"]]["capture_end_unknown"]
    assert exported["quality"]["attribution_unknown"]
    assert exported["quality"]["capture_end_unknown"]
    assert exported["quality"]["has_audio_gaps"]
    assert not exported["quality"]["no_audio_received"]


def test_long_voice_keeps_overlap_and_open_tail_across_incremental_restart(
    client, database, storage
):
    attempt, credential, identity = source(client)
    # Repeated real voiced PCM keeps VAD open across both 30-second core cuts.
    # This is a continuity fixture, not a natural-language recognition result.
    pcm = audio("german-a.wav")[16000:32000] * 160
    samples = len(pcm) // 2
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        assert socket.receive_json()["type"] == "ack"
        for sequence, start in enumerate(range(0, samples, 80000)):
            send_pcm(socket, identity, pcm[start * 2 : (start + 80000) * 2], sequence, start)
        segmentation_pass(database)
        with Session(database) as db:
            stream = db.scalar(select(AudioStream))
            assert stream.scan_sample == 480000 and not stream.scan_complete
            first_id = db.scalar(select(AsrJob.id))
        database.dispose()
        segmentation_pass(database)
        segmentation_pass(database)
        with Session(database) as db:
            stream = db.scalar(select(AudioStream))
            jobs = db.scalars(select(AsrJob).order_by(AsrJob.core_start)).all()
            assert [(j.core_start, j.core_end) for j in jobs] == [(0, 480000), (480000, 960000)]
            assert jobs[0].id == first_id
            assert stream.scan_sample == 960000 and not stream.scan_complete
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": samples,
                "last_sequence": sequence,
            }
        )
        assert socket.receive_json()["type"] == "ack"
    segmentation_pass(database)
    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        jobs = db.scalars(select(AsrJob).order_by(AsrJob.core_start)).all()
        assert [(j.core_start, j.core_end) for j in jobs] == [
            (0, 480000),
            (480000, 960000),
            (960000, samples),
        ]
        assert [(j.start_sample, j.end_sample) for j in jobs] == [
            (0, 483200),
            (476800, 963200),
            (956800, samples),
        ]
        assert stream.scan_complete and stream.scan_sample == samples
        for job in jobs:
            runs = timeline(db, stream)[0]
            assert (
                read_pcm(runs[0].chunks, job.start_sample, job.end_sample)
                == (pcm[job.start_sample * 2 : job.end_sample * 2])
            )
        identifiers = {job.id for job in jobs}
    segmentation_pass(database)
    with Session(database) as db:
        assert {job.id for job in db.scalars(select(AsrJob))} == identifiers


def test_frozen_missing_range_beyond_scan_window_keeps_later_voice(client, database, storage):
    attempt, credential, identity = source(client)
    pcm = audio("german-a.wav") + b"\0\0" * 16000
    samples = len(pcm) // 2
    later = 16000 * 65
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        assert socket.receive_json()["type"] == "ack"
        send_pcm(socket, identity, pcm, 0, 0)
        send_pcm(socket, identity, pcm, 13, later)
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": later + samples,
                "last_sequence": 13,
            }
        )
        assert socket.receive_json()["type"] == "ack"
    segmentation_pass(database)
    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        # EOS is not a reason to infer a loss before the retry/drain window closes.
        assert stream.scan_sample < later and not stream.scan_complete
        db.get(Attempt, uuid.UUID(attempt)).ended_at = datetime.now(UTC) - timedelta(seconds=30)
        db.commit()
    for _ in range(4):
        segmentation_pass(database)
    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        jobs = db.scalars(select(AsrJob).order_by(AsrJob.core_start)).all()
        assert len(jobs) == 2
        assert jobs[0].end_sample <= samples
        assert jobs[1].start_sample >= later
        assert stream.scan_complete and stream.scan_sample == later + samples
    data = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    assert data["audio"][0]["known_gaps"] == [{"start_sample": samples, "end_sample": later}]


def test_reconnect_fences_old_socket_and_final_gap_resumes_active_speech(client, database, storage):
    attempt, credential, identity = source(client)
    pcm = audio("german-a.wav") + b"\0\0" * 16000
    samples = len(pcm) // 2
    first = {**identity, "sequence": 0, "start_sample": 0, "sample_count": samples}
    gap = {
        "type": "gap",
        "id": begin(identity)["id"] + "/gap",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "sequence": 1,
        "start_sample": samples,
        "sample_count": 16000,
        "reason": "worker_buffer_limit",
        "final": True,
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as old:
        authenticate(old, credential)
        old.send_json(begin(identity))
        assert old.receive_json()["type"] == "ack"
        send_pcm(old, identity, pcm, 0, 0)
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as current:
            authenticate(current, credential)
            # A stored chunk wins against an overflow after its ACK was lost.
            stored_gap = {
                **gap,
                "id": gap["id"] + "/stored",
                "sequence": 0,
                "start_sample": 0,
                "sample_count": samples,
            }
            for control in [stored_gap, gap, gap]:
                current.send_json(control)
                assert current.receive_json() == {"type": "ack", "id": control["id"]}
            # The superseded socket cannot backfill the now-final missing range.
            missing = {**identity, "sequence": 1, "start_sample": samples, "sample_count": 16000}
            old.send_bytes(frame(missing, b"\0\0" * 16000))
            assert old.receive_json() == {"type": "error", "reason": "ingest_rejected"}
            send_pcm(current, identity, pcm, 2, samples + 16000)
            # Identical durable PCM remains replayable even after its final-gap ACK.
            current.send_bytes(frame(first, pcm))
            assert current.receive_json()["type"] == "ack"
            for _ in range(3):
                segmentation_pass(database)
            with Session(database) as db:
                stream = db.scalar(select(AudioStream))
                assert stream.final_sample is None and not stream.scan_complete
                assert stream.scan_sample > samples + 16000
                jobs = db.scalars(select(AsrJob)).all()
                identifiers = {job.id for job in jobs}
                assert any(job.end_sample <= samples for job in jobs)
                assert any(job.start_sample >= samples + 16000 for job in jobs)
                assert all(
                    not (job.start_sample < samples + 16000 and job.end_sample > samples)
                    for job in jobs
                )
            current.send_bytes(frame(missing, b"\0\0" * 16000))
            assert current.receive_json() == {"type": "error", "reason": "ingest_rejected"}
    database.dispose()  # The final boundary and ASR identities survive a service restart.
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as replay:
        authenticate(replay, credential)
        replay.send_json(gap)
        assert replay.receive_json() == {"type": "ack", "id": gap["id"]}
        send_pcm(replay, identity, pcm, 2, samples + 16000)
    segmentation_pass(database)
    data = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    assert data["audio"][0]["known_gaps"] == [
        {"start_sample": samples, "end_sample": samples + 16000}
    ]
    assert data["asr"]["pending_source_seconds"] > 0
    assert data["asr"]["oldest_pending_seconds"] >= 0
    listed = client.get("/v1/recordings", headers=API).json()["items"][0]
    assert listed["provider"] == "webex"
    assert listed["quality"]["durable_sample_count"] == samples * 2
    assert listed["quality"]["finalized_gap_count"] == 1  # Stored-PCM gap does not count.
    with Session(database) as db:
        assert {job.id for job in db.scalars(select(AsrJob))} == identifiers
        assert len(db.scalars(select(AudioChunk)).all()) == 2


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


def test_coalesce_protocol_segments_filters_fillers_and_merges_broken_sentences():
    from wortlaut.exports import _coalesce_protocol_segments, _is_noise_or_filler

    assert _is_noise_or_filler("", 0.0)
    assert _is_noise_or_filler("Yeah.", 0.32)
    assert _is_noise_or_filler("Mm-hmm.", 0.48)
    assert _is_noise_or_filler("Yeah, genau.", 1.2)
    assert _is_noise_or_filler("I don't know.", 0.8)
    assert not _is_noise_or_filler(
        "Wir besprechen heute den aktuellen Projektstatus im Team.", 3.5
    )

    raw_segments = [
        {
            "id": "s1",
            "stream_id": "st1",
            "speaker_label": "Volkmar Erben",
            "start": 10.0,
            "end": 18.0,
            "text": "Dann kann man noch.",
            "words": [],
        },
        {
            "id": "s2",
            "stream_id": "st2",
            "speaker_label": "Johann Peter Hartmann",
            "start": 14.0,
            "end": 14.8,
            "text": "Genau richtig.",
            "words": [],
        },
        {
            "id": "s3",
            "stream_id": "st1",
            "speaker_label": "Volkmar Erben",
            "start": 18.4,
            "end": 26.0,
            "text": "das gewollte Feature direkt im System aktivieren.",
            "words": [],
        },
        {
            "id": "s4",
            "stream_id": "st2",
            "speaker_label": "Johann Peter Hartmann",
            "start": 27.0,
            "end": 34.0,
            "text": "Super, dann nehmen wir das so in das Protokoll auf.",
            "words": [],
        },
    ]
    coalesced = _coalesce_protocol_segments(raw_segments)
    assert len(coalesced) == 2
    assert coalesced[0]["speaker_label"] == "Volkmar Erben"
    assert (
        coalesced[0]["text"]
        == "Dann kann man noch das gewollte Feature direkt im System aktivieren."
    )
    assert coalesced[1]["speaker_label"] == "Johann Peter Hartmann"
    assert coalesced[1]["text"] == "Super, dann nehmen wir das so in das Protokoll auf."


def test_coalesce_protocol_segments_preserves_distinct_speaker_ids_sharing_display_name():
    from wortlaut.exports import _coalesce_protocol_segments, group_transcript_turns

    same_name_segments = [
        {
            "id": "s1",
            "stream_id": "stream-a",
            "speaker_id": "spaces/room/devices/268",
            "participant_id": "spaces/room/devices/268",
            "speaker_label": "Johann-Peter Hartmann",
            "start": 5.0,
            "end": 11.0,
            "text": "Wir prüfen die getrennten Audioquellen.",
            "words": [],
        },
        {
            "id": "s2",
            "stream_id": "stream-b",
            "speaker_id": "spaces/room/devices/270",
            "participant_id": "spaces/room/devices/270",
            "speaker_label": "Johann-Peter Hartmann",
            "start": 13.0,
            "end": 19.0,
            "text": "Der zweite Teilnehmer spricht zur gleichen Zeit.",
            "words": [],
        },
    ]
    coalesced = _coalesce_protocol_segments(same_name_segments)
    assert len(coalesced) == 2
    assert coalesced[0]["speaker_id"] == "spaces/room/devices/268"
    assert coalesced[0]["stream_id"] == "stream-a"
    assert coalesced[1]["speaker_id"] == "spaces/room/devices/270"
    assert coalesced[1]["stream_id"] == "stream-b"

    turns = group_transcript_turns(coalesced)
    assert len(turns) == 2


def test_micro_noise_blips_are_discarded_and_sentence_pauses_stay_intact(
    client, database, storage
):
    import struct

    from wortlaut.processing import POST_ROLL

    attempt, credential, identity = source(client)
    raw = audio("german-a.wav")
    orig = struct.unpack(f"<{len(raw) // 2}h", raw)

    def scale(samples, factor):
        clipped = [max(-32768, min(32767, int(x * factor))) for x in samples]
        return struct.pack(f"<{len(clipped)}h", *clipped)

    # Faint 180 ms breath/click (~418 peak, ~140 RMS) triggers WebRTC VAD briefly,
    # followed by 1.2 s silence, then two voiced clauses separated by a 630 ms
    # natural intra-sentence pause (< 720 ms SILENCE, > old 600 ms), then a tail click.
    faint_breath = scale(orig[1600 : 1600 + 2880], 0.03)
    voiced_clause = raw[16000 * 2 : 24000 * 2]  # 0.5 s continuously voiced speech
    intra_pause_630ms = b"\0\0" * 10080  # 630 ms (< SILENCE = 720 ms)
    pcm = (
        b"\0\0" * 8000
        + faint_breath
        + b"\0\0" * 19200
        + voiced_clause
        + intra_pause_630ms
        + voiced_clause
        + b"\0\0" * 19200
        + faint_breath
        + b"\0\0" * 8000
    )
    total_samples = len(pcm) // 2
    speech_start_sample = 8000 + (len(faint_breath) // 2) + 19200
    speech_end_sample = (
        speech_start_sample + (len(voiced_clause) // 2) * 2 + 10080
    )

    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        assert socket.receive_json()["type"] == "ack"
        last_seq = 0
        for last_seq, start in enumerate(range(0, total_samples, 80000)):
            send_pcm(
                socket,
                identity,
                pcm[start * 2 : (start + 80000) * 2],
                last_seq,
                start,
            )
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": total_samples,
                "last_sequence": last_seq,
            }
        )
        assert socket.receive_json()["type"] == "ack"

    for _ in range(3):
        segmentation_pass(database)

    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        jobs = db.scalars(select(AsrJob).order_by(AsrJob.start_sample)).all()
        assert stream.scan_complete and stream.scan_sample == total_samples
        # Neither leading/trailing faint breath blips create phantom jobs,
        # nor does the 700 ms intra-sentence pause split the real utterance.
        assert len(jobs) == 1
        job = jobs[0]
        assert job.start_sample >= speech_start_sample - 4800
        assert job.end_sample >= speech_end_sample + POST_ROLL - 960


def test_coalesce_protocol_segments_keeps_intervening_qna_chronological_and_bounds_turns():
    from wortlaut.exports import _coalesce_protocol_segments, group_transcript_turns

    qna_segments = [
        {
            "id": "q1",
            "stream_id": "st-alex",
            "speaker_id": "spk-alex",
            "speaker_label": "Alexander",
            "start": 10.0,
            "end": 18.0,
            "text": "Wie wollt ihr das denn bei Digitale Leute aufbauen?",
            "words": [],
        },
        {
            "id": "a1",
            "stream_id": "st-ben",
            "speaker_id": "spk-ben",
            "speaker_label": "Ben",
            "start": 18.4,
            "end": 20.3,
            "text": "Wir starten im Herbst.",
            "words": [],
        },
        {
            "id": "r1",
            "stream_id": "st-alex",
            "speaker_id": "spk-alex",
            "speaker_label": "Alexander",
            "start": 20.8,
            "end": 27.0,
            "text": "Ah super, das passt gut in unseren Zeitplan.",
            "words": [],
        },
        {
            "id": "r2",
            "stream_id": "st-alex",
            "speaker_id": "spk-alex",
            "speaker_label": "Alexander",
            "start": 35.0,
            "end": 42.0,
            "text": "Nach acht Sekunden Pause beginnt ein neuer Gedanke.",
            "words": [],
        },
    ]
    coalesced = _coalesce_protocol_segments(qna_segments)
    assert [c["id"] for c in coalesced] == ["q1", "a1", "r1", "r2"]
    assert [c["speaker_label"] for c in coalesced] == [
        "Alexander",
        "Ben",
        "Alexander",
        "Alexander",
    ]

    turns = group_transcript_turns(coalesced)
    assert [t["speaker"] for t in turns] == [
        "Alexander",
        "Ben",
        "Alexander",
        "Alexander",
    ]

    # Long monologue splits cleanly once merged turn span exceeds 45 seconds.
    long_monologue = [
        {
            "id": f"m{i}",
            "stream_id": "st-alex",
            "speaker_id": "spk-alex",
            "speaker_label": "Alexander",
            "start": float(i * 20),
            "end": float(i * 20 + 18),
            "text": f"Abschnitt {i}.",
            "words": [],
        }
        for i in range(4)
    ]
    mono_coalesced = _coalesce_protocol_segments(long_monologue)
    assert len(mono_coalesced) == 2
    assert mono_coalesced[0]["end"] - mono_coalesced[0]["start"] <= 45.0
    assert mono_coalesced[1]["end"] - mono_coalesced[1]["start"] <= 45.0


def test_speech_section_cuts_long_monologue_at_breath_pause_before_hard_limit():
    from wortlaut.processing import RATE, SOFT_MAX_SEGMENT, speech_section

    half_sec_voiced = audio("german-a.wav")[16000:32000]  # 0.5 s voiced PCM
    # 16.0 s continuous speech (> SOFT_MAX_SEGMENT = 14 s), then 420 ms breath pause
    # (< SILENCE = 720 ms, >= SOFT_SILENCE = 360 ms), then 8.0 s more speech.
    pcm = half_sec_voiced * 32 + (b"\0\0" * 6720) + half_sec_voiced * 16
    section, cursor = speech_section(pcm, 0, terminal=True)
    assert section is not None
    start, end, core_end = section
    assert start == 0
    assert SOFT_MAX_SEGMENT <= core_end < 18 * RATE
    assert end == core_end
    next_section, next_cursor = speech_section(pcm[cursor * 2 :], cursor, terminal=True)
    assert next_section is not None
    assert next_section[0] >= cursor
    assert next_cursor == len(pcm) // 2



