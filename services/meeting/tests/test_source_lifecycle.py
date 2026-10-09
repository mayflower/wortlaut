"""Public ingest lifecycle against real PostgreSQL/S3; no provider capability claim."""

import struct
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ingest import authenticate, begin, frame, source
from test_recordings import API

from wortlaut.models import AudioChunk, AudioControl


def test_seventy_binding_changes_preserve_pcm_and_identities_across_reconnect(
    client, database, storage
):
    # Unpaced synthetic replay: a rotating receiver slot, three fixture IDs,
    # and identical display names. This does not prove provider attribution.
    attempt, credential, original = source(client)
    identity = {
        **original,
        "provider_source_id": "fixture:rotating-slot",
        "participant_id": "participant-A",
        "participant_name": "Gleicher Anzeigename",
    }
    opening = begin(identity)
    blocks, bindings = [], []
    for sequence in range(71):
        participant = "ABC"[sequence % 3]
        metadata = {
            **identity,
            "speaker_id": f"speaker-{participant}",
            "participant_id": f"participant-{participant}",
            "sequence": sequence,
            "start_sample": sequence * 16000,
            "sample_count": 16000,
        }
        pcm = struct.pack("<h", sequence + 1) * metadata["sample_count"]
        blocks.append((metadata, pcm))
        if sequence:
            bindings.append(
                {
                    "type": "bind",
                    "id": opening["id"] + f"/bind/{sequence}",
                    "stream_id": identity["stream_id"],
                    "epoch": identity["epoch"],
                    "start_sample": metadata["start_sample"],
                    **{
                        key: metadata[key]
                        for key in (
                            "provider_source_id", "speaker_id", "source_kind",
                            "attribution_unknown", "participant_id", "participant_name",
                        )
                    },
                }
            )
    closing = {
        "type": "end",
        "id": opening["id"] + "/end",
        "stream_id": identity["stream_id"],
        "epoch": identity["epoch"],
        "final_sample": 71 * 16000,
        "last_sequence": 70,
    }

    for left, right in ((0, 36), (36, 71)):
        with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
            authenticate(socket, credential)
            socket.send_json(opening)
            assert socket.receive_json() == {"type": "ack", "id": opening["id"]}
            for sequence in range(left, right):
                if sequence:
                    binding = bindings[sequence - 1]
                    socket.send_json(binding)
                    assert socket.receive_json() == {"type": "ack", "id": binding["id"]}
                metadata, pcm = blocks[sequence]
                socket.send_bytes(frame(metadata, pcm))
                assert socket.receive_json() == {
                    "type": "ack",
                    "id": f"{attempt}/{identity['stream_id']}/{identity['epoch']}/{sequence}",
                }
            if right == 71:
                # Old ACKs may have been lost. Replays retain their original
                # participant, even though the receiver has since changed.
                socket.send_json(bindings[0])
                assert socket.receive_json() == {"type": "ack", "id": bindings[0]["id"]}
                for sequence in (0, 35, 36, 70):
                    metadata, pcm = blocks[sequence]
                    socket.send_bytes(frame(metadata, pcm))
                    assert socket.receive_json() == {
                        "type": "ack",
                        "id": f"{attempt}/{identity['stream_id']}/{identity['epoch']}/{sequence}",
                    }
                for _ in range(2):
                    socket.send_json(closing)
                    assert socket.receive_json() == {"type": "ack", "id": closing["id"]}
        # Drop pooled connections; the second socket must recover from the
        # persisted contracts, not connection-local binding state.
        database.dispose()

    with Session(database) as db:
        chunks = db.scalars(select(AudioChunk).order_by(AudioChunk.sequence)).all()
        assert len(chunks) == len(blocks)
        for chunk, (metadata, pcm) in zip(chunks, blocks, strict=True):
            assert chunk.contract == metadata
            assert storage.read(chunk.object_key) == pcm
        persisted_bindings = db.scalars(
            select(AudioControl)
            .where(AudioControl.kind == "bind")
            .order_by(AudioControl.start_sample)
        ).all()
        assert [binding.contract for binding in persisted_bindings] == bindings

    response = client.get(f"/v1/recordings/{identity['meeting_id']}", headers=API)
    assert response.status_code == 200
    status = response.json()
    assert status["ingest"]["durable_sample_count"] == closing["final_sample"]
    assert status["ingest"]["durable_chunk_count"] == len(blocks)
    assert status["audio"][0]["accepted_samples"] == closing["final_sample"]
    assert status["audio"][0]["end_received"] is True
    assert status["audio"][0]["pending_input"] is False
    assert status["audio"][0]["known_gaps"] == []
    assert status["audio"][0]["attribution_unknown"] is False


def test_closed_epochs_do_not_consume_active_source_capacity(client):
    attempt, credential, original = source(client)
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for _ in range(70):
            identity = {**original, "stream_id": str(uuid.uuid4()), "epoch": str(uuid.uuid4())}
            opening = begin(identity)
            socket.send_json(opening)
            assert socket.receive_json() == {"type": "ack", "id": opening["id"]}
            closing = {
                "type": "end",
                "id": opening["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": 0,
                "last_sequence": -1,
            }
            socket.send_json(closing)
            assert socket.receive_json() == {"type": "ack", "id": closing["id"]}


def test_active_source_limit_rejects_only_the_additional_live_source(client):
    attempt, credential, original = source(client)
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for _ in range(64):
            identity = {**original, "stream_id": str(uuid.uuid4()), "epoch": str(uuid.uuid4())}
            opening = begin(identity)
            socket.send_json(opening)
            assert socket.receive_json() == {"type": "ack", "id": opening["id"]}
        socket.send_json(begin({**original, "stream_id": str(uuid.uuid4())}))
        response = socket.receive_json()
        assert response["type"] == "error"
        assert response["reason"] == "ingest_rejected"
