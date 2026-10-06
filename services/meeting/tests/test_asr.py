import getpass
import hashlib
import json
import os
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from kubernetes import client as k8s_client
from kubernetes import config as k8s_config
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ingest import authenticate, begin, source
from test_processing import audio, send_pcm
from test_recordings import API

from wortlaut.asr import (
    claim_job,
    commit_result,
    finalize_processing,
    inference_pass,
    segment_result,
)
from wortlaut.models import AsrJob, AudioStream, TranscriptSegment
from wortlaut.processing import segmentation_pass
from wortlaut.settings import get_settings


@pytest.mark.skipif(
    os.getenv("WORTLAUT_TEST_NATIVE_ASR") != "true", reason="Opt-in: real cluster GPU"
)
def test_native_gpu_from_two_durable_sources_to_exports(client, database, storage, monkeypatch):
    root = Path(__file__).resolve().parents[3]
    for line in (root / ".dev/asr.env").read_text().splitlines():
        name, value = line.split("=", 1)
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("WORTLAUT_ASR_URL", "http://127.0.0.1:34602")
    get_settings.cache_clear()
    restart = os.getenv("WORTLAUT_TEST_RESTART_GPU") == "true"
    core = None
    old_pods = set()
    if restart:
        configuration = k8s_client.Configuration()
        k8s_config.load_kube_config(
            str(root / ".dev/kubeconfig"), context="data", client_configuration=configuration
        )
        configuration.retries = 0
        core = k8s_client.CoreV1Api(k8s_client.ApiClient(configuration))
        namespace = "wortlaut-" + getpass.getuser()
        pods = core.list_namespaced_pod(namespace, label_selector="app=wortlaut-asr").items
        assert len(pods) == 1
        old_pods = {pod.metadata.uid for pod in pods}
    first_result = None
    outage_at = None
    attempt, credential, first = source(client)
    second = {
        **first,
        "stream_id": str(uuid.uuid4()),
        "epoch": str(uuid.uuid4()),
        "speaker_id": "speaker-B",
        "provider_source_id": "fixture:two",
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for identity, filename in [(first, "german-a.wav"), (second, "german-b.wav")]:
            pcm = audio(filename)
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
            if restart:
                for _ in range(5):
                    segmentation_pass(database)
                if identity is first:
                    inference_pass(database)
                    with Session(database) as db:
                        first_result = db.scalar(select(TranscriptSegment)).result
                    # Graceful restart of our namespace's GPU pod, with UID
                    # precondition. The Deployment recreates it normally.
                    core.delete_namespaced_pod(
                        pods[0].metadata.name,
                        namespace,
                        body=k8s_client.V1DeleteOptions(
                            preconditions=k8s_client.V1Preconditions(uid=pods[0].metadata.uid)
                        ),
                    )
                    cutoff = time.monotonic() + 60
                    while time.monotonic() < cutoff:
                        try:
                            available = (
                                httpx.get(
                                    "http://127.0.0.1:34602/health/ready", timeout=1
                                ).status_code
                                == 200
                            )
                        except httpx.HTTPError:
                            available = False
                        if not available:
                            outage_at = time.monotonic()
                            break
                        time.sleep(0.5)
                    assert outage_at is not None, "GPU outage was not observed"
                else:
                    inference_pass(database)
                    finalize_processing(database)
                    with Session(database) as db:
                        pending = db.scalar(select(AsrJob).where(AsrJob.status == "pending"))
                        assert pending is not None and pending.error == "gpu_unavailable"
                        assert db.scalar(select(TranscriptSegment)).result == first_result
    started = time.monotonic()
    owner = {"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"}
    assert (
        client.post(
            f"/v1/attempts/{attempt}/status",
            headers=owner,
            json={"participation": "ended", "reason": "fixture_done"},
        ).status_code
        == 200
    )
    for _ in range(10):
        segmentation_pass(database)
    with Session(database) as db:
        jobs = db.scalars(select(AsrJob)).all()
        assert {job.binding["speaker_id"] for job in jobs} == {"speaker-A", "speaker-B"}
        job_samples = sum(job.end_sample - job.start_sample for job in jobs)
        job_count = len(jobs)
    restart_seconds = None
    if restart:
        cutoff = time.monotonic() + 240
        while time.monotonic() < cutoff:
            replacement = core.list_namespaced_pod(
                namespace, label_selector="app=wortlaut-asr"
            ).items
            if any(
                pod.metadata.uid not in old_pods
                and any(
                    c.type == "Ready" and c.status == "True" for c in (pod.status.conditions or [])
                )
                for pod in replacement
            ):
                try:
                    response = httpx.get("http://127.0.0.1:34602/health/ready", timeout=2)
                    if response.status_code == 200:
                        restart_seconds = time.monotonic() - outage_at
                        break
                except httpx.HTTPError:
                    pass
            time.sleep(1)
        assert restart_seconds is not None, "Replacement GPU did not become ready"
        # Wait for the production retry time rather than altering durable state.
        with Session(database) as db:
            retry_at = db.scalar(select(AsrJob.retry_at).where(AsrJob.status == "pending"))
        while retry_at and datetime.now(UTC) < retry_at:
            time.sleep(0.5)
    for _ in range(job_count):
        inference_pass(database)
    finalize_processing(database)
    prefix = f"/v1/recordings/{first['meeting_id']}/exports"
    exported = client.get(prefix + "/json", headers=API)
    assert exported.status_code == 200
    data = exported.json()
    assert data["processing"] == "completed"
    assert len(data["segments"]) == job_count
    assert len({segment["id"] for segment in data["segments"]}) == job_count
    if restart:
        with Session(database) as db:
            assert db.get(TranscriptSegment, first_result["id"]).result == first_result
    by_speaker = {
        speaker: " ".join(s["text"] for s in data["segments"] if s["speaker_id"] == speaker)
        for speaker in ("speaker-A", "speaker-B")
    }
    assert "getrennten Audioquellen" in by_speaker["speaker-A"]
    assert "zweite Teilnehmer" in by_speaker["speaker-B"]
    assert "gleichen Zeit" in by_speaker["speaker-B"]
    a, b = [next(s for s in data["segments"] if s["speaker_id"] == key) for key in by_speaker]
    assert max(a["start"], b["start"]) < min(a["end"], b["end"])
    assert not data["quality"]["has_audio_gaps"]
    for format in ("txt", "vtt"):
        text = client.get(prefix + "/" + format, headers=API).text
        assert "getrennten Audioquellen" in text and "zweite Teilnehmer" in text
    (root / ".dev/native-pipeline-result.json").write_text(
        json.dumps(
            {
                "boundary": "durable EOS to finalized export; synthetic sources, no Webex",
                "elapsed_seconds": time.monotonic() - started,
                "sources": 2,
                "asr_jobs": job_count,
                "asr_source_seconds": job_samples / 16000,
                "gpu_restart_outage_seconds": restart_seconds,
                "export": data,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def test_gpu_timeout_reclaim_and_duplicate_result_commit(client, database, storage, monkeypatch):
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
    for _ in range(5):
        segmentation_pass(database)
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-gpu-token")
    get_settings.cache_clear()
    client_factory = httpx.Client
    responses = []

    def handle(request):
        assert request.headers["Authorization"] == "Bearer fixture-gpu-token"
        if not responses:
            responses.append("timeout")
            raise httpx.ReadTimeout("simulated disconnect", request=request)
        return httpx.Response(
            200,
            json={
                "job_id": request.headers["X-Job-ID"],
                "pcm_sha256": hashlib.sha256(request.content).hexdigest(),
                "text": "Guten Morgen",
                "words": [
                    {"word": "Guten", "start": 0.2, "end": 0.4},
                    {"word": "Morgen", "start": 0.4, "end": 0.6},
                ],
            },
        )

    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: client_factory(**kwargs, transport=httpx.MockTransport(handle)),
    )
    try:
        inference_pass(database)
        with Session(database) as db:
            job = db.scalar(select(AsrJob).where(AsrJob.error == "gpu_unavailable"))
            identifier = job.id
            assert job.status == "pending" and job.attempts == 0
            job.status = "processing"
            job.claimed_at = datetime.now(UTC) - timedelta(seconds=200)
            db.commit()
            assert claim_job(db).id == identifier
            # A service restart leaves a stale claim; another pass reclaims it.
            job.claimed_at = datetime.now(UTC) - timedelta(seconds=200)
            db.commit()
        database.dispose()
        inference_pass(database)
        with Session(database) as db:
            stored = db.get(TranscriptSegment, identifier).result
            assert stored["text"] == "Guten Morgen"
            assert stored["speaker_id"] == "speaker-A"
            assert stored["start"] >= 0.2  # Stream has a 200 ms offset on the meeting axis.
            commit_result(db, identifier, {**stored, "text": "late different result"})
            assert db.get(TranscriptSegment, identifier).result == stored
            assert db.get(AsrJob, identifier).status == "completed"
        for _ in range(10):
            inference_pass(database)
        owner = {"Authorization": "Bearer " + credential, "X-Worker-ID": "fixture-worker"}
        assert (
            client.post(
                f"/v1/attempts/{attempt}/status",
                headers=owner,
                json={"participation": "ended", "reason": "fixture_done"},
            ).status_code
            == 200
        )
        finalize_processing(database)
        prefix = f"/v1/recordings/{identity['meeting_id']}/exports"
        exported = client.get(prefix + "/json", headers=API)
        assert exported.status_code == 200
        data = exported.json()
        assert data["processing"] == "completed"
        assert not data["quality"]["has_audio_gaps"]
        assert not data["quality"]["capture_end_unknown"]
        assert data["quality"]["participant_identity_requirement"] == "required"
        assert data["quality"]["source_coverage"] == "unknown"
        assert any(segment["text"] == "Guten Morgen" for segment in data["segments"])
        assert "Guten Morgen" in client.get(prefix + "/txt", headers=API).text
        assert "Quellenabdeckung: unbekannt" in client.get(prefix + "/txt", headers=API).text
        assert "Quellenabdeckung: unbekannt" in client.get(prefix + "/vtt", headers=API).text
        assert client.get(prefix + "/vtt", headers=API).text.startswith("WEBVTT\n")
    finally:
        get_settings.cache_clear()


def test_word_midpoint_has_one_owner_at_long_section_boundary():
    stream = AudioStream(
        stream_id=uuid.uuid4(),
        epoch=uuid.uuid4(),
        contract={
            "monotonic_origin_ms": 1500,
            "session_monotonic_origin_ms": 1000,
            "session_utc_origin": "2026-10-06T09:00:00Z",
        },
    )
    left = AsrJob(
        id="left", start_sample=0, end_sample=163200, core_start=0, core_end=160000, binding={}
    )
    right = AsrJob(
        id="right",
        start_sample=156800,
        end_sample=320000,
        core_start=160000,
        core_end=320000,
        binding={},
    )
    # The same word straddles the ten-second cut. Its midpoint equals the boundary.
    a = segment_result(
        left, stream, {"text": "Grenze", "words": [{"word": "Grenze", "start": 9.9, "end": 10.1}]}
    )
    b = segment_result(
        right, stream, {"text": "Grenze", "words": [{"word": "Grenze", "start": 0.1, "end": 0.3}]}
    )
    assert a["words"] == []
    assert b["text"] == "Grenze"
    assert b["words"][0]["start"] == 10.4
