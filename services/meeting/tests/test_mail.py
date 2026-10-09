import io
import re
import socket
import uuid
import zipfile
from datetime import UTC, datetime, timedelta
from email import policy
from email.parser import BytesParser

import pytest
from aiosmtpd.controller import Controller
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ingest import authenticate, begin, source
from test_processing import send_pcm
from test_recordings import API, create

from wortlaut.asr import commit_result, finalize_processing
from wortlaut.mail import smtp_pass
from wortlaut.models import AsrJob, AudioStream, Delivery, Recording
from wortlaut.processing import segmentation_pass
from wortlaut.settings import get_settings


class Receiver:
    def __init__(self):
        self.mode = "accept"
        self.messages = []
        self.envelopes = []

    async def handle_DATA(self, server, session, envelope):
        if self.mode == "refuse":
            return "451 Explicit temporary refusal"
        self.messages.append(
            BytesParser(policy=policy.default).parsebytes(envelope.original_content)
        )
        self.envelopes.append(list(envelope.rcpt_tos))
        if self.mode == "disconnect":
            server.transport.close()
            return "250 This reply cannot reach the client"
        return "250 Accepted"


@pytest.fixture
def smtp(monkeypatch):
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    receiver = Receiver()
    server = Controller(receiver, hostname="127.0.0.1", port=port)
    server.start()
    monkeypatch.setenv("WORTLAUT_SMTP_HOST", "127.0.0.1")
    monkeypatch.setenv("WORTLAUT_SMTP_PORT", str(port))
    monkeypatch.setenv("WORTLAUT_SMTP_TLS", "none")
    monkeypatch.setenv("WORTLAUT_SMTP_FROM", "bot@example.org")
    monkeypatch.setenv("WORTLAUT_RESULT_RECIPIENTS", '{"default":["operator@example.org"]}')
    get_settings.cache_clear()
    try:
        yield receiver
    finally:
        server.stop()
        get_settings.cache_clear()


def finished_capture(client, database):
    attempt, credential, identity = source(client)
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        send_pcm(socket, identity, bytes(32000), 0, 0)
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": 16000,
                "last_sequence": 0,
            }
        )
        socket.receive_json()
    response = client.post(
        f"/v1/attempts/{attempt}/status",
        headers={"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"},
        json={"participation": "ended", "reason": "fixture_done"},
    )
    assert response.status_code == 200
    segmentation_pass(database)
    finalize_processing(database)
    recording = uuid.UUID(identity["meeting_id"])
    with Session(database) as db:
        assert db.get(Recording, recording).processing == "completed"
    return recording


def test_successful_real_smtp_has_three_exports_and_does_not_send_without_audio(
    client,
    database,
    storage,
    smtp,
):
    recording = finished_capture(client, database)
    smtp_pass(database)
    assert len(smtp.messages) == 1
    message = smtp.messages[0]
    assert {part.get_filename().rsplit(".", 1)[-1] for part in message.iter_attachments()} == {
        "txt",
        "vtt",
        "json",
    }
    assert smtp.envelopes == [["operator@example.org"]]
    body = message.get_body(preferencelist=("plain",)).get_content()
    assert "Quellenabdeckung: unknown" in body
    assert "vollständigen Qualitäts- und Zeitangaben" in body
    with Session(database) as db:
        delivery = db.get(Delivery, recording)
        assert delivery.status == "delivered"
        assert delivery.message_id == message["Message-ID"]
        assert db.get(Recording, recording).processing == "completed"
    smtp_pass(database)
    assert len(smtp.messages) == 1
    empty = uuid.UUID(create(client, key="mail-without-audio"))
    with Session(database) as db:
        db.get(Recording, empty).processing = "completed"
        db.commit()
    smtp_pass(database)
    assert len(smtp.messages) == 1
    with Session(database) as db:
        assert db.get(Delivery, empty) is None


def test_definitive_data_refusal_retries_with_stable_message_id(client, database, storage, smtp):
    recording = finished_capture(client, database)
    smtp.mode = "refuse"
    smtp_pass(database)
    with Session(database) as db:
        delivery = db.get(Delivery, recording)
        identifier = delivery.message_id
        assert (delivery.status, delivery.error, delivery.attempts) == ("pending", "smtp_451", 1)
        delivery.retry_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    assert not smtp.messages
    smtp.mode = "accept"
    smtp_pass(database)
    assert smtp.messages[0]["Message-ID"] == identifier
    with Session(database) as db:
        assert db.get(Delivery, recording).status == "delivered"
        assert db.get(Delivery, recording).attempts == 2


def test_unknown_acceptance_requires_explicit_retry_and_large_export_reader_is_scoped(
    client,
    database,
    storage,
    smtp,
    monkeypatch,
):
    recording = finished_capture(client, database)
    monkeypatch.setenv("WORTLAUT_MAIL_ATTACHMENT_LIMIT_BYTES", "1")
    get_settings.cache_clear()
    smtp.mode = "disconnect"
    smtp_pass(database)
    assert len(smtp.messages) == 1
    assert not list(smtp.messages[0].iter_attachments())
    body = smtp.messages[0].get_body(preferencelist=("plain",)).get_content()
    assert f"/v1/recordings/{recording}/exports/json" in body
    reader = re.search(r"wortlaut-read-[0-9a-f]{64}", body).group()
    assert get_settings().api_token.get_secret_value() not in body
    assert "?token=" not in body
    access = {"Authorization": "Bearer " + reader}
    for format in ("txt", "vtt", "json"):
        endpoint = f"/v1/recordings/{recording}/exports/{format}"
        response = client.get(endpoint, headers=access)
        assert response.status_code == 200
        assert response.content == client.get(endpoint, headers=API).content
    other = create(client, key="reader-other")
    assert client.get(f"/v1/recordings/{other}/exports/json", headers=access).status_code == 401
    assert client.get(f"/v1/recordings/{recording}", headers=access).status_code == 401
    for endpoint in (
        f"/v1/recordings/{recording}/cancel",
        f"/v1/recordings/{recording}/attempts",
        f"/v1/recordings/{recording}/delivery/retry",
    ):
        assert client.post(endpoint, headers=access).status_code == 401
    assert client.post("/v1/recordings", headers=access, json={}).status_code == 401
    state = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert state["delivery"]["status"] == "delivery_unknown"
    assert state["processing"] == "completed"
    assert client.get(f"/v1/recordings/{recording}/exports/json", headers=API).status_code == 200
    smtp_pass(database)
    assert len(smtp.messages) == 1
    response = client.post(f"/v1/recordings/{recording}/delivery/retry", headers=API)
    assert response.status_code == 200
    smtp.mode = "accept"
    smtp_pass(database)
    assert len(smtp.messages) == 2
    assert smtp.messages[0]["Message-ID"] == smtp.messages[1]["Message-ID"]
    assert reader in smtp.messages[1].get_body(preferencelist=("plain",)).get_content()
    with Session(database) as db:
        db.get(Recording, recording).processing_finished_at = datetime.now(UTC) - timedelta(days=31)
        db.commit()
    # The reader expires on the request path, even before cleanup runs.
    assert client.get(f"/v1/recordings/{recording}/exports/json", headers=access).status_code == 401
    with Session(database) as db:
        db.get(Recording, recording).transcript_deleted_at = datetime.now(UTC)
        db.commit()
    assert client.get(f"/v1/recordings/{recording}/exports/json", headers=access).status_code == 401
    assert client.get(f"/v1/recordings/{recording}/exports/json", headers=API).status_code == 410


def test_large_repetitive_exports_are_losslessly_zipped_before_real_smtp(
    client, database, storage, smtp, monkeypatch
):
    recording = finished_capture(client, database)
    text = "Vollständiger protokollierter Gesprächsinhalt. " * 5000
    with Session(database) as db:
        stream = db.scalar(select(AudioStream))
        job = AsrJob(
            id="large-mail",
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
                "speaker_id": "fixture-member",
                "provider_source_id": "fixture:one",
                "attribution_unknown": False,
                "session_utc_origin": stream.contract["session_utc_origin"],
                "start": 0,
                "end": 1,
                "text": text,
                "words": [],
            },
        )
    monkeypatch.setenv("WORTLAUT_MAIL_ATTACHMENT_LIMIT_BYTES", "20000")
    get_settings.cache_clear()
    expected = {
        f"wortlaut-{recording}.{format}": client.get(
            f"/v1/recordings/{recording}/exports/{format}", headers=API
        ).content
        for format in ("txt", "vtt", "json")
    }
    assert len(expected[f"wortlaut-{recording}.txt"]) > 20000
    smtp_pass(database)
    assert len(smtp.messages) == 1
    message = smtp.messages[0]
    assert len(message.as_bytes()) < 20000
    (attachment,) = message.iter_attachments()
    assert attachment.get_filename() == f"wortlaut-{recording}.zip"
    with zipfile.ZipFile(io.BytesIO(attachment.get_payload(decode=True))) as archive:
        assert {name: archive.read(name) for name in archive.namelist()} == expected
    assert "wortlaut-read-" not in message.get_body(preferencelist=("plain",)).get_content()
    with Session(database) as db:
        assert db.get(Delivery, recording).status == "delivered"
        assert db.get(Recording, recording).export_reader_nonce is None
