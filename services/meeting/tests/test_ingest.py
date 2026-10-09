import json
import struct
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_recordings import create, prepare

from wortlaut.ingest import ChunkContract
from wortlaut.models import AudioChunk, AudioControl
from wortlaut.settings import get_settings
from wortlaut.storage import ObjectConflict, canonical


def source(client, key="one"):
    meeting = create(client, key=key)
    attempt, headers = prepare(client, meeting)
    response = client.post(
        f"/v1/attempts/{attempt}/claim", headers=headers, json={"worker_id": "fixture-worker"}
    )
    assert response.status_code == 200
    stream, epoch = str(uuid.uuid4()), str(uuid.uuid4())
    identity = {
        "meeting_id": meeting,
        "attempt_id": attempt,
        "stream_id": stream,
        "epoch": epoch,
        "provider_source_id": "fixture:one",
        "speaker_id": "speaker-A",
        "source_kind": "speaker",
        "attribution_unknown": False,
        "sample_rate": 16000,
        "channels": 1,
        "encoding": "pcm_s16le",
        "monotonic_origin_ms": 1200,
        "session_monotonic_origin_ms": 1000,
        "session_utc_origin": "2026-10-06T09:00:00Z",
    }
    return attempt, headers["Authorization"][7:], identity


def begin(identity):
    return {
        **identity,
        "type": "begin",
        "id": (f"{identity['attempt_id']}/{identity['stream_id']}/{identity['epoch']}/begin"),
    }


def frame(metadata, pcm):
    encoded = json.dumps(metadata).encode()
    return struct.pack(">I", len(encoded)) + encoded + pcm


def authenticate(socket, credential):
    socket.send_json({"type": "auth", "credential": credential, "worker_id": "fixture-worker"})
    assert socket.receive_json() == {"type": "ready"}


def test_binding_boundaries_preserve_long_blocks_and_choose_current_participant(
    client, database, storage
):
    attempt, credential, identity = source(client)
    bound = {**identity, "speaker_id": "speaker-B", "provider_source_id": "fixture:second"}
    future = {**identity, "speaker_id": "speaker-C", "provider_source_id": "fixture:third"}

    def binding(at, source_identity):
        return {
            "type": "bind",
            "id": begin(identity)["id"] + f"/bind/{at}",
            "stream_id": identity["stream_id"],
            "epoch": identity["epoch"],
            "start_sample": at,
            **{
                key: source_identity[key]
                for key in (
                    "provider_source_id", "speaker_id", "source_kind", "attribution_unknown"
                )
            },
        }

    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        assert socket.receive_json()["type"] == "ack"
        first = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 80000}
        socket.send_bytes(frame(first, b"\0\0" * 80000))
        assert socket.receive_json()["type"] == "ack"
        # The last sample of a maximum-size block cannot be renamed.
        socket.send_json(binding(79999, bound))
        assert socket.receive_json()["type"] == "error"
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for control in (binding(80000, bound), binding(90000, future)):
            socket.send_json(control)
            assert socket.receive_json()["type"] == "ack"
        second = {**bound, "sequence": 1, "start_sample": 80000, "sample_count": 10001}
        socket.send_bytes(frame(second, b"\0\0" * 10001))
        assert socket.receive_json()["type"] == "error"  # Crosses the future binding.
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        second["sample_count"] = 10000
        socket.send_bytes(frame(second, b"\0\0" * 10000))
        assert socket.receive_json()["type"] == "ack"
        third = {**future, "sequence": 2, "start_sample": 90000, "sample_count": 100}
        socket.send_bytes(frame(third, b"\0\0" * 100))
        assert socket.receive_json()["type"] == "ack"
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": 90100,
                "last_sequence": 2,
            }
        )
        assert socket.receive_json()["type"] == "ack"
    with Session(database) as db:
        chunks = db.scalars(select(AudioChunk).order_by(AudioChunk.sequence)).all()
        assert [chunk.contract["speaker_id"] for chunk in chunks] == [
            "speaker-A", "speaker-B", "speaker-C",
        ]
        assert [storage.read(chunk.object_key) for chunk in chunks] == [
            b"\0\0" * 80000, b"\0\0" * 10000, b"\0\0" * 100,
        ]


def test_s3_conditional_create_does_not_overwrite_concurrent_audio_or_binding(storage):
    key, pcm, metadata = "concurrent.pcm", b"\x00\x01" * 100, {"speaker_id": "A"}
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: storage.put(key, pcm, metadata), range(2)))
    assert results[0] == results[1]
    with pytest.raises(ObjectConflict):
        storage.put(key, b"\x02\x03" * 100, metadata)
    with pytest.raises(ObjectConflict):
        storage.put(key, pcm, {"speaker_id": "B"})
    assert storage.read(key) == pcm
    unicode_metadata = {"participant_name": "𝄞" * 200, "provider_source_id": "会" * 200}
    storage.put("unicode.pcm", pcm, unicode_metadata)
    assert storage.read("unicode.pcm") == pcm
    with pytest.raises(ObjectConflict):
        storage.put("unicode.pcm", pcm, {**unicode_metadata, "participant_name": "other"})


def test_orphan_object_and_lost_ack_recover_once_with_immutable_metadata(client, database, storage):
    attempt, credential, identity = source(client)
    metadata = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 200}
    pcm = b"\x01\x02" * 200
    identifier = f"{attempt}/{identity['stream_id']}/{identity['epoch']}/0"
    key = f"audio/{identity['meeting_id']}/{identifier}.pcm"
    # Real Object-Write without DB-Commit (worker retries after service crash).
    storage.put(key, pcm, ChunkContract.model_validate(metadata).model_dump(mode="json"))
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for _ in range(2):
            socket.send_json(begin(identity))
            assert socket.receive_json()["id"] == begin(identity)["id"]
        for _ in range(2):
            socket.send_bytes(frame(metadata, pcm))
            assert socket.receive_json() == {"type": "ack", "id": identifier}
        # Possible overflow after a lost ACK is reconciled with durable chunk data.
        gap = {
            "type": "gap",
            "id": identifier + "/gap",
            "stream_id": identity["stream_id"],
            "epoch": identity["epoch"],
            "sequence": 0,
            "start_sample": 0,
            "sample_count": 200,
            "reason": "worker_buffer_limit",
        }
        end = {
            "type": "end",
            "id": identifier + "/end",
            "stream_id": identity["stream_id"],
            "epoch": identity["epoch"],
            "last_sequence": 0,
            "final_sample": 200,
        }
        for control in [gap, gap, end, end]:
            socket.send_json(control)
            assert socket.receive_json() == {"type": "ack", "id": control["id"]}
    with Session(database) as db:
        assert len(db.scalars(select(AudioChunk)).all()) == 1
        assert len(db.scalars(select(AudioControl)).all()) == 3
    assert storage.read(key) == pcm
    for conflicting, changed_pcm in [
        ({**metadata, "speaker_id": "other"}, pcm),
        (metadata, b"\x03\x04" * 200),
    ]:
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
            authenticate(socket, credential)
            socket.send_bytes(frame(conflicting, changed_pcm))
            assert socket.receive_json() == {"type": "error", "reason": "ingest_rejected"}
    assert storage.read(key) == pcm


def test_conflicting_orphan_object_is_not_registered(client, database, storage):
    attempt, credential, identity = source(client)
    metadata = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
    identifier = f"{attempt}/{identity['stream_id']}/{identity['epoch']}/0"
    key = f"audio/{identity['meeting_id']}/{identifier}.pcm"
    old_metadata = ChunkContract.model_validate(metadata).model_dump(mode="json")
    old_metadata["speaker_id"] = "different"
    storage.put(key, b"\x00\x00" * 100, old_metadata)
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        socket.send_bytes(frame(metadata, b"\x00\x00" * 100))
        assert socket.receive_json()["type"] == "error"
    with Session(database) as db:
        assert db.get(AudioChunk, identifier) is None
    assert storage.read(key) == b"\x00\x00" * 100


def test_reconnect_waits_for_inflight_commit_before_final_gap_decision(
    client, database, storage, monkeypatch
):
    attempt, credential, identity = source(client)
    metadata = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
    identifier = f"{attempt}/{identity['stream_id']}/{identity['epoch']}/0"
    written, release = Event(), Event()
    put = storage.put

    def hold_after_real_write(*args):
        result = put(*args)
        written.set()
        if not release.wait(10):
            raise TimeoutError("Test did not release the in-flight object write")
        return result

    monkeypatch.setattr(storage, "put", hold_after_real_write)
    try:
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as old:
            authenticate(old, credential)
            old.send_json(begin(identity))
            assert old.receive_json()["type"] == "ack"
            old.send_bytes(frame(metadata, b"\x01\x02" * 100))
            assert written.wait(10)
            with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as current:
                with ThreadPoolExecutor(1) as pool:
                    ready = pool.submit(authenticate, current, credential)
                    try:
                        with pytest.raises(TimeoutError):
                            ready.result(timeout=0.2)
                    finally:
                        release.set()
                    assert old.receive_json() == {"type": "ack", "id": identifier}
                    ready.result(timeout=10)
                gap = {
                    "type": "gap",
                    "id": identifier + "/gap",
                    "stream_id": identity["stream_id"],
                    "epoch": identity["epoch"],
                    "sequence": 0,
                    "start_sample": 0,
                    "sample_count": 100,
                    "reason": "worker_buffer_limit",
                    "final": True,
                }
                current.send_json(gap)
                assert current.receive_json() == {"type": "ack", "id": gap["id"]}
        from test_recordings import API

        status = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
        assert status["audio"][0]["known_gaps"] == []
        assert status["ingest"]["durable_sample_count"] == 100
        with Session(database) as db:
            assert db.get(AudioChunk, identifier) is not None
    finally:
        release.set()


@pytest.mark.parametrize("limit", ["samples", "storage"])
def test_capacity_preserves_committed_audio_replays_and_rejects_new_work(
    client, database, storage, monkeypatch, limit
):
    from test_recordings import API, request_body

    from wortlaut.ingest import pending_samples

    attempt, credential, identity = source(client)
    first = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
    if limit == "samples":
        monkeypatch.setenv("WORTLAUT_MAX_PENDING_SAMPLES_TOTAL", "100")
    else:
        contract = ChunkContract.model_validate(first).model_dump(mode="json")
        monkeypatch.setenv("WORTLAUT_MAX_STORED_AUDIO_BYTES", str(213 + len(canonical(contract))))
    get_settings.cache_clear()
    try:
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
            authenticate(socket, credential)
            socket.send_json(begin(identity))
            socket.receive_json()
            for _ in range(2):
                socket.send_bytes(frame(first, b"\0\0" * 100))
                assert socket.receive_json()["type"] == "ack"
            second = {**identity, "sequence": 1, "start_sample": 100, "sample_count": 100}
            socket.send_bytes(frame(second, b"\0\0" * 100))
            assert socket.receive_json() == {"type": "error", "reason": "audio_capacity_limit"}
        with Session(database) as db:
            assert pending_samples(db) == 100
            assert len(db.scalars(select(AudioChunk)).all()) == 1
        blocked = client.post(
            "/v1/recordings", headers={**API, "Idempotency-Key": "capacity"}, json=request_body()
        )
        assert blocked.status_code == 503
    finally:
        get_settings.cache_clear()


def test_gap_boundaries_cannot_overlap_audio_or_be_excluded_by_end(client, database, storage):
    attempt, credential, identity = source(client)
    gap = {
        "type": "gap",
        "id": begin(identity)["id"] + "/gap",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "sequence": 1,
        "start_sample": 100,
        "sample_count": 100,
        "reason": "buffer_limit",
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        socket.send_json(gap)
        assert socket.receive_json()["type"] == "ack"
        metadata = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
        socket.send_bytes(frame(metadata, b"\0\0" * 100))
        assert socket.receive_json()["type"] == "ack"
    for invalid in (
        {**gap, "id": gap["id"] + "changed", "sample_count": 150},
        {**gap, "id": gap["id"] + "overlap", "sequence": 2, "start_sample": 150},
        {
            "type": "end",
            "id": gap["id"] + "/end",
            "stream_id": identity["stream_id"],
            "epoch": identity["epoch"],
            "last_sequence": 1,
            "final_sample": 100,
        },
    ):
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
            authenticate(socket, credential)
            socket.send_json(invalid)
            assert socket.receive_json() == {"type": "error", "reason": "ingest_rejected"}
    from wortlaut.models import AudioStream
    from wortlaut.processing import timeline

    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        assert stream.final_sample is None
        assert timeline(db, stream)[2]["known_gaps"] == []  # Still wait for a possible lost ACK.


def test_metadata_density_keeps_replays_end_and_later_audio_windows(
    client, database, storage, monkeypatch
):
    from test_recordings import API

    from wortlaut import ingest

    monkeypatch.setattr(ingest, "MAX_WINDOW_RECORDS", 3)
    attempt, credential, identity = source(client)
    first = {**identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
    binding = {
        "type": "bind",
        "id": begin(identity)["id"] + "/bind",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "start_sample": 100,
        "provider_source_id": "fixture:two",
        "speaker_id": "speaker-B",
        "source_kind": "speaker",
        "attribution_unknown": False,
    }
    gap = {
        "type": "gap",
        "id": begin(identity)["id"] + "/gap",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "sequence": 1,
        "start_sample": 100,
        "sample_count": 100,
        "reason": "worker_buffer_limit",
        "final": True,
    }
    rebound = {**identity, "provider_source_id": "fixture:two", "speaker_id": "speaker-B"}
    rejected = {**rebound, "sequence": 2, "start_sample": 200, "sample_count": 100}
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        assert socket.receive_json()["type"] == "ack"
        socket.send_bytes(frame(first, b"\x01\x02" * 100))
        assert socket.receive_json()["type"] == "ack"
        for control in (binding, gap, binding, gap):
            socket.send_json(control)
            assert socket.receive_json() == {"type": "ack", "id": control["id"]}
        socket.send_bytes(frame(first, b"\x01\x02" * 100))
        assert socket.receive_json()["type"] == "ack"
        socket.send_bytes(frame(rejected, b"\x03\x04" * 100))
        assert socket.receive_json() == {"type": "error", "reason": "audio_metadata_capacity_limit"}
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json({**binding, "id": binding["id"] + "-later", "start_sample": 200})
        assert socket.receive_json() == {"type": "error", "reason": "audio_metadata_capacity_limit"}
    # A different sample window remains usable in this same epoch. The missing
    # sequences are intentionally not synthesized or silently labeled as audio.
    later = {
        **rebound,
        "sequence": 12,
        "start_sample": ingest.AUDIO_WINDOW_SAMPLES,
        "sample_count": 100,
    }
    closing = {
        "type": "end",
        "id": begin(identity)["id"] + "/end",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "last_sequence": 12,
        "final_sample": later["start_sample"] + 100,
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_bytes(frame(later, b"\x05\x06" * 100))
        assert socket.receive_json()["type"] == "ack"
        for _ in range(2):
            socket.send_json(closing)
            assert socket.receive_json() == {"type": "ack", "id": closing["id"]}
    data = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API).json()
    assert data["audio"][0]["accepted_samples"] == 200
    assert data["audio"][0]["known_gaps"] == [{"start_sample": 100, "end_sample": 200}]
    assert data["audio"][0]["end_received"]
    assert data["audio"][0]["pending_input"]
    with Session(database) as db:
        chunks = db.scalars(select(AudioChunk).order_by(AudioChunk.sequence)).all()
        assert [c.sequence for c in chunks] == [0, 12]
        assert storage.read(chunks[0].object_key) == b"\x01\x02" * 100
        assert storage.read(chunks[1].object_key) == b"\x05\x06" * 100


def test_ingest_rate_survives_reconnect_and_preserves_replay_and_end(
    client, database, storage, monkeypatch
):
    from wortlaut import ingest

    clock = datetime.now(UTC)
    monkeypatch.setattr(ingest, "datetime", SimpleNamespace(now=lambda _: clock))
    monkeypatch.setattr(ingest, "INGEST_BURST", 3)
    monkeypatch.setattr(ingest, "INGEST_FRAMES_PER_SECOND", 1)
    attempt, credential, identity = source(client)
    opening = begin(identity)
    frames = [
        {**identity, "sequence": n, "start_sample": n * 100, "sample_count": 100} for n in range(2)
    ]
    closing = {
        "type": "end",
        "id": opening["id"] + "/end",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "last_sequence": 1,
        "final_sample": 200,
    }
    next_identity = {**identity, "stream_id": str(uuid.uuid4()), "epoch": str(uuid.uuid4())}
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(opening)
        assert socket.receive_json()["type"] == "ack"
        for metadata in frames:
            socket.send_bytes(frame(metadata, b"\x01\x02" * 100))
            assert socket.receive_json()["type"] == "ack"
        socket.send_json(opening)
        assert socket.receive_json()["type"] == "ack"
        for metadata in frames:
            socket.send_bytes(frame(metadata, b"\x01\x02" * 100))
            assert socket.receive_json()["type"] == "ack"
        socket.send_json(closing)
        assert socket.receive_json() == {"type": "ack", "id": closing["id"]}
        socket.send_json(begin(next_identity))
        assert socket.receive_json() == {"type": "error", "reason": "audio_ingest_rate_limit"}
    database.dispose()  # The allowance is durable, not attached to a process or socket.
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(next_identity))
        assert socket.receive_json() == {"type": "error", "reason": "audio_ingest_rate_limit"}
    healthy_attempt, healthy_credential, healthy_identity = source(client, key="healthy")
    with client.websocket_connect(f"/v1/attempts/{healthy_attempt}/audio") as socket:
        authenticate(socket, healthy_credential)
        socket.send_json(begin(healthy_identity))
        assert socket.receive_json()["type"] == "ack"
        healthy = {**healthy_identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
        socket.send_bytes(frame(healthy, b"\x05\x06" * 100))
        assert socket.receive_json()["type"] == "ack"
    clock += timedelta(seconds=2)
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(next_identity))
        assert socket.receive_json()["type"] == "ack"
        metadata = {**next_identity, "sequence": 0, "start_sample": 0, "sample_count": 100}
        socket.send_bytes(frame(metadata, b"\x03\x04" * 100))
        assert socket.receive_json()["type"] == "ack"
        socket.send_bytes(frame({**metadata, "sequence": 1, "start_sample": 100}, b"\0\0" * 100))
        assert socket.receive_json() == {"type": "error", "reason": "audio_ingest_rate_limit"}
    with Session(database) as db:
        chunks = db.scalars(select(AudioChunk)).all()
        assert len(chunks) == 4
        assert sorted(len(storage.read(c.object_key)) for c in chunks) == [200, 200, 200, 200]
