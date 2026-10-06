import json
import struct
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_recordings import create, prepare

from wortlaut.ingest import ChunkContract
from wortlaut.models import AudioChunk, AudioControl
from wortlaut.settings import get_settings
from wortlaut.storage import ObjectConflict, canonical


def source(client):
    meeting = create(client)
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
