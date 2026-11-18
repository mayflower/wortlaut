import asyncio
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
    asr_span,
    claim_job,
    commit_result,
    finalize_processing,
    inference_pass,
    segment_result,
)
from wortlaut.models import AsrJob, AudioStream, TranscriptSegment
from wortlaut.processing import segmentation_pass
from wortlaut.settings import get_settings


def test_backlog_consumer_immediately_claims_next_work_and_yields_to_stop(monkeypatch):
    from wortlaut import app as app_module

    calls = []

    async def run():
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()

        def work(engine):
            calls.append(engine)
            if len(calls) == 2:
                loop.call_soon_threadsafe(stop.set)
            return True

        monkeypatch.setattr(app_module, "get_engine", lambda: "fixture-engine")
        await asyncio.wait_for(app_module.processing_loop(stop, work, interval=30), timeout=1)

    asyncio.run(run())
    assert calls == ["fixture-engine", "fixture-engine"]


def test_asr_claim_prioritizes_age_over_hash_and_skips_recent_claim(client, database):
    attempt, _, identity = source(client)
    with Session(database) as db:
        stream = AudioStream(
            attempt_id=uuid.UUID(attempt),
            stream_id=uuid.UUID(identity["stream_id"]),
            epoch=uuid.UUID(identity["epoch"]),
            contract=identity,
        )
        db.add(stream)
        db.flush()
        now = datetime.now(UTC)
        for index, (identifier, created) in enumerate(
            [("0" * 64, now), ("f" * 64, now - timedelta(minutes=1))]
        ):
            db.add(
                AsrJob(
                    id=identifier,
                    stream_id=stream.id,
                    start_sample=index * 16000,
                    end_sample=(index + 1) * 16000,
                    core_start=index * 16000,
                    core_end=(index + 1) * 16000,
                    binding={},
                    created_at=created,
                )
            )
        db.commit()
        assert claim_job(db).id == "f" * 64
        assert claim_job(db).id == "0" * 64
        assert claim_job(db) is None


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
    # Speech starts inside a five-second block well after the source origin.
    # ASR must keep that overlapping block when reading a later job range.
    pcm = b"\0\0" * (19 * 16000) + audio("german-a.wav")
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        socket.send_json(begin(identity))
        socket.receive_json()
        last_sequence = -1
        for last_sequence, offset in enumerate(range(0, len(pcm), 16000 * 5 * 2)):
            send_pcm(
                socket, identity, pcm[offset : offset + 16000 * 5 * 2], last_sequence, offset // 2
            )
        socket.send_json(
            {
                "type": "end",
                "id": begin(identity)["id"] + "/end",
                "stream_id": identity["stream_id"],
                "epoch": identity["epoch"],
                "final_sample": len(pcm) // 2,
                "last_sequence": last_sequence,
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
        with Session(database) as db:
            job = db.get(AsrJob, request.headers["X-Job-ID"])
            assert job.start_sample > 18 * 16000
            # Only the job's disjoint core reaches the ASR.
            span_start, span_end = asr_span(job)
            assert request.content == pcm[span_start * 2 : span_end * 2]
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
            assert stored["start"] >= 18.2  # Preserve the delayed speech and meeting offset.
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


def test_long_section_cut_sends_disjoint_audio_and_offsets_words_from_the_core():
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
    # The 200 ms segmentation overlap around a hard cut never reaches the ASR,
    # so a transcript without word timestamps cannot repeat the boundary word.
    assert asr_span(left) == (0, 160000)
    assert asr_span(right) == (160000, 320000)
    untimed = segment_result(
        right, stream, {"text": "Grenze", "language": "German", "words": [{"word": "Grenze"}]}
    )
    assert untimed["text"] == "Grenze"
    assert untimed["words"] == [{"word": "Grenze"}]
    assert (untimed["start"], untimed["end"]) == (10.5, 20.5)
    assert untimed["language"] == "German"
    # Timestamped responses still work and are offset from the core start.
    timed = segment_result(
        right, stream, {"text": "Grenze", "words": [{"word": "Grenze", "start": 0.1, "end": 0.3}]}
    )
    assert timed["words"][0]["start"] == 10.6
    assert (timed["start"], timed["end"]) == (10.6, 10.8)


def test_segment_result_drops_truncated_decoder_output_and_rejects_mixed_timing():
    import pytest

    from wortlaut.asr import InvalidResult

    stream = AudioStream(
        stream_id=uuid.uuid4(),
        epoch=uuid.uuid4(),
        contract={
            "monotonic_origin_ms": 1000,
            "session_monotonic_origin_ms": 1000,
            "session_utc_origin": "2026-10-06T09:00:00Z",
        },
    )
    job = AsrJob(
        id="loop", start_sample=0, end_sample=32000, core_start=0, core_end=32000, binding={}
    )
    looped = segment_result(
        job,
        stream,
        {
            "text": "ja ja ja ja",
            "truncated": True,
            "words": [{"word": "ja", "confidence": 0.99}] * 4,
        },
    )
    assert looped["text"] == "" and looped["words"] == []
    assert looped["asr_truncated"] is True
    assert "confidence" not in looped
    with pytest.raises(InvalidResult, match="invalid_word_timestamps"):
        segment_result(
            job,
            stream,
            {"text": "a b", "words": [{"word": "a", "start": 0.1, "end": 0.2}, {"word": "b"}]},
        )
    with pytest.raises(InvalidResult, match="words_unavailable"):
        segment_result(job, stream, {"text": "a", "words": []})


def test_segment_result_preserves_word_confidence_and_rejects_low_confidence_hallucinations():
    import pytest

    from wortlaut.asr import InvalidResult

    stream = AudioStream(
        stream_id=uuid.uuid4(),
        epoch=uuid.uuid4(),
        contract={
            "monotonic_origin_ms": 1000,
            "session_monotonic_origin_ms": 1000,
            "session_utc_origin": "2026-10-06T09:00:00Z",
        },
    )
    job = AsrJob(
        id="conf-job",
        start_sample=0,
        end_sample=16000 * 4,
        core_start=0,
        core_end=16000 * 4,
        binding={"speaker_id": "speaker-A"},
    )

    # Word confidences below reflect Qwen3-ASR byte-level BPE subword posteriors:
    # real German compounds and short confirmations score >= 0.35 mean / >= 0.55 peak,
    # whereas unintelligible noise hallucinations stay uniformly low across pieces.
    def words(*pairs):
        return [
            {"word": w, "start": 0.3 * i, "end": 0.3 * i + 0.25, "confidence": c}
            for i, (w, c) in enumerate(pairs)
        ]

    def result(*pairs):
        return segment_result(
            job, stream, {"text": " ".join(w for w, _ in pairs), "words": words(*pairs)}
        )

    clear = (("Haben", 0.923), ("wir", 1.0), ("wieviel", 0.895), ("Bildschirme", 0.999))
    valid = result(*clear)
    assert valid["text"] == "Haben wir wieviel Bildschirme"
    assert valid["confidence"] == round((0.923 + 1.0 + 0.895 + 0.999) / 4, 4)
    assert [w["confidence"] for w in valid["words"]] == [0.923, 1.0, 0.895, 0.999]

    # Real German speech with multi-subword compounds keeps moderate BPE posteriors.
    weak = (
        ("Da", 0.333), ("hast", 0.631), ("du", 0.687), ("jetzt", 0.47), ("zum", 0.374),
        ("Zeit,", 0.542), ("aber", 0.398), ("jetzt", 0.285), ("will", 0.425), ("ich.", 0.452),
    )
    assert result(*weak)["text"] == "Da hast du jetzt zum Zeit, aber jetzt will ich."

    # Rustling noise decoded as weak tokens: neither mean (0.29) nor peak (0.38) passes.
    hallucinated = result(("Small", 0.31), ("made", 0.28), ("a", 0.22), ("pistol.", 0.38))
    assert hallucinated["text"] == ""
    assert hallucinated["words"] == []
    assert "confidence" not in hallucinated
    assert result(("Jaknął", 0.19))["words"] == []
    assert result(("Genau.", 0.42))["text"] == "Genau."

    # Consecutive n-gram decoder loop is suppressed even when truncated=False,
    # while natural 4x agreement ("ja ja ja ja") is preserved.
    assert result(*[("ja", 0.85)] * 4)["text"] == "ja ja ja ja"
    assert result(*[("ja", 0.85)] * 6)["text"] == ""
    assert result(*([("und", 0.8), ("dann", 0.8)] * 4))["text"] == ""

    with pytest.raises(InvalidResult, match="invalid_word_confidence"):
        segment_result(
            job,
            stream,
            {
                "text": "Ungültig",
                "words": [{"word": "Ungültig", "start": 0.1, "end": 0.5, "confidence": 1.5}],
            },
        )


def test_asr_glossary_and_context_prompt_exclude_opted_out_speakers(
    client, database, storage, monkeypatch
):
    import base64

    from wortlaut.asr import build_asr_context_prompt
    from wortlaut.models import Attempt, AudioControl, Recording, TranscriptSegment
    from wortlaut.settings import Settings, get_settings

    # Comma-separated and JSON list formats both parse cleanly in Settings.
    s_csv = Settings(
        database_url="postgresql://u:p@localhost/db",
        api_token="tok",
        asr_glossary="Mayflower, mAIstack; Astryx\nMayflower",
    )
    assert s_csv.asr_glossary == ["Mayflower", "mAIstack", "Astryx"]
    s_json = Settings(
        database_url="postgresql://u:p@localhost/db",
        api_token="tok",
        asr_glossary='["Qwen3-ASR", "Wortlaut"]',
    )
    assert s_json.asr_glossary == ["Qwen3-ASR", "Wortlaut"]

    monkeypatch.setenv("WORTLAUT_ASR_GLOSSARY", "Mayflower, mAIstack, Astryx")
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-gpu-token")
    get_settings.cache_clear()
    try:
        with Session(database) as db:
            now = datetime.now(UTC)
            rec = Recording(
                idempotency_key="ctx-glossary-rec",
                request_digest="d" * 64,
                provider="google_meet",
                meeting_url="https://meet.google.com/abc-defg-hij",
                title="mAIstack Architektur Sync",
                starts_at=now,
                ends_at=now + timedelta(minutes=30),
                protocol_meta={
                    "opted_out_speakers": ["Geheimer Gast"],
                    "term_replacements": {"meistack": "mAIstack"},
                    "speaker_overrides": {"spaces/r/devices/9": "Björn Schotte"},
                },
            )
            db.add(rec)
            db.flush()
            att = Attempt(
                recording_id=rec.id,
                credential_hash="x" * 64,
                credential_expires_at=now + timedelta(minutes=32),
                diagnostics={
                    "participant_sources": {
                        "sources": [
                            {
                                "participant_id": "spaces/r/devices/1",
                                "participant_name": "Johann Peter Hartmann",
                            },
                            {
                                "participant_id": "spaces/r/devices/2",
                                "participant_name": "Geheimer Gast",
                            },
                        ]
                    }
                },
            )
            db.add(att)
            db.flush()
            st = AudioStream(
                attempt_id=att.id,
                stream_id=uuid.uuid4(),
                epoch=uuid.uuid4(),
                contract={
                    "monotonic_origin_ms": 1000,
                    "session_monotonic_origin_ms": 1000,
                    "session_utc_origin": now.isoformat(),
                    "participant_id": "spaces/r/devices/1",
                    "speaker_id": "spaces/r/devices/1",
                    "participant_name": "Johann Peter Hartmann",
                },
            )
            db.add(st)
            db.flush()
            db.add(
                AudioControl(
                    id=f"{att.id}/{st.stream_id}/{st.epoch}/16000/bind",
                    stream_id=st.id,
                    kind="bind",
                    start_sample=16000,
                    contract={
                        "participant_id": "spaces/r/devices/3",
                        "speaker_id": "spaces/r/devices/3",
                        "participant_name": "Robin Gloster",
                    },
                )
            )
            db.flush()
            prior_job = AsrJob(
                id="0" * 64,
                stream_id=st.id,
                start_sample=0,
                end_sample=16000 * 3,
                core_start=0,
                core_end=16000 * 3,
                binding={"speaker_id": "spaces/r/devices/1"},
                status="completed",
            )
            db.add(prior_job)
            db.add(
                TranscriptSegment(
                    id="0" * 64,
                    result={
                        "id": "0" * 64,
                        "text": "Wir starten heute mit dem",
                        "speaker_id": "spaces/r/devices/1",
                    },
                )
            )
            cur_job = AsrJob(
                id="1" * 64,
                stream_id=st.id,
                start_sample=16000 * 3,
                end_sample=16000 * 6,
                core_start=16000 * 3,
                core_end=16000 * 6,
                binding={
                    "speaker_id": "spaces/r/devices/1",
                    "participant_id": "spaces/r/devices/1",
                    "participant_name": "Johann Peter Hartmann",
                },
                status="pending",
            )
            db.add(cur_job)
            db.flush()
            prompt = build_asr_context_prompt(db, cur_job, st, get_settings())
            assert prompt is not None
            assert "mAIstack Architektur Sync" in prompt
            assert "Johann Peter Hartmann" in prompt
            assert "Robin Gloster" in prompt
            assert "Björn Schotte" in prompt
            assert "Geheimer Gast" not in prompt
            assert "Mayflower" in prompt and "Astryx" in prompt
            assert "Wir starten heute mit dem" in prompt
            encoded = base64.b64encode(prompt.encode("utf-8")).decode("ascii")
            assert base64.b64decode(encoded).decode("utf-8") == prompt

            prior_seg = db.get(TranscriptSegment, "0" * 64)
            prior_seg.result = {**prior_seg.result, "confidence": 0.25}
            db.flush()
            low_conf_prompt = build_asr_context_prompt(db, cur_job, st, get_settings())
            assert low_conf_prompt is not None
            assert "Wir starten heute mit dem" not in low_conf_prompt
    finally:
        get_settings.cache_clear()


def test_per_recording_and_in_call_language_switching_across_30_languages(
    client, database, storage, monkeypatch
):
    from wortlaut import exports as exports_module
    from wortlaut.languages import QWEN_ASR_LANGUAGES, normalize_asr_language

    assert len(QWEN_ASR_LANGUAGES) == 30
    for lang in QWEN_ASR_LANGUAGES:
        assert normalize_asr_language(lang) == lang
        assert normalize_asr_language(lang.lower()) == lang
    assert normalize_asr_language("auto") == "auto"
    assert normalize_asr_language("*") == "auto"
    assert normalize_asr_language("日本語") == "Japanese"
    assert normalize_asr_language("中文") == "Chinese"
    assert normalize_asr_language("العربية") == "Arabic"
    assert normalize_asr_language("Tiếng Việt") == "Vietnamese"
    assert normalize_asr_language("de+en") == "German,English"
    with pytest.raises(ValueError, match="Unsupported Qwen3-ASR language"):
        normalize_asr_language("Klingon")

    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    get_settings.cache_clear()

    now = datetime.now(UTC).replace(microsecond=0)
    # Invalid language rejected with 422 on POST /v1/recordings
    bad_create = client.post(
        "/v1/recordings",
        headers={**API, "Idempotency-Key": "bad-lang-rec"},
        json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
            "language": "Klingon",
        },
    )
    assert bad_create.status_code == 422

    # 1. Create recording starting in French ("fr" -> "French")
    created = client.post(
        "/v1/recordings",
        headers={**API, "Idempotency-Key": "lang-switch-rec"},
        json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(minutes=30)).isoformat(),
            "title": "Global Architecture Sync",
            "language": "fr",
        },
    )
    assert created.status_code == 200, created.text
    rec_id = created.json()["id"]
    assert created.json()["language"] == "French"

    att_res = client.post(f"/v1/recordings/{rec_id}/attempts", headers=API)
    assert att_res.status_code == 200
    attempt = att_res.json()["attempt_id"]
    credential = att_res.json()["bootstrap_credential"]
    auth_hdr = {"Authorization": f"Bearer {credential}"}
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim",
            headers=auth_hdr,
            json={"worker_id": "fixture-worker"},
        ).status_code
        == 200
    )
    owner = {**auth_hdr, "X-Worker-ID": "fixture-worker"}
    boot = client.get(f"/v1/attempts/{attempt}/bootstrap", headers=owner)
    assert boot.status_code == 200
    assert boot.json()["asr_language"] == "French"

    # Send 2 streams so we can switch language mid-call between jobs!
    speech_pcm = audio("german-a.wav")
    identity1 = {
        "meeting_id": rec_id,
        "attempt_id": attempt,
        "stream_id": str(uuid.uuid4()),
        "epoch": str(uuid.uuid4()),
        "provider_source_id": "meet:lang:1",
        "source_kind": "speaker",
        "speaker_id": "spk-polyglot",
        "participant_id": "spk-polyglot",
        "participant_name": "Claire Moreau",
        "attribution_unknown": False,
        "sample_rate": 16000,
        "channels": 1,
        "encoding": "pcm_s16le",
        "monotonic_origin_ms": 1200,
        "session_monotonic_origin_ms": 1000,
        "session_utc_origin": now.isoformat(),
    }
    identity2 = {
        **identity1,
        "stream_id": str(uuid.uuid4()),
        "epoch": str(uuid.uuid4()),
        "provider_source_id": "meet:lang:2",
        "speaker_id": "spk-kenji",
        "participant_id": "spk-kenji",
        "participant_name": "Kenji Sato",
        "monotonic_origin_ms": 20000,
    }
    with client.websocket_connect(f"/v1/attempts/{attempt}/audio") as socket:
        authenticate(socket, credential)
        for ident in (identity1, identity2):
            socket.send_json(begin(ident))
            assert socket.receive_json()["type"] == "ack"
            last_seq = -1
            for last_seq, offset in enumerate(range(0, len(speech_pcm), 16000 * 5 * 2)):
                send_pcm(
                    socket,
                    ident,
                    speech_pcm[offset : offset + 16000 * 5 * 2],
                    last_seq,
                    offset // 2,
                )
            socket.send_json(
                {
                    "type": "end",
                    "id": begin(ident)["id"] + "/end",
                    "stream_id": ident["stream_id"],
                    "epoch": ident["epoch"],
                    "final_sample": len(speech_pcm) // 2,
                    "last_sequence": last_seq,
                }
            )
            assert socket.receive_json()["type"] == "ack"

    for _ in range(8):
        segmentation_pass(database)
    with Session(database) as db:
        pending_jobs = db.scalars(select(AsrJob).where(AsrJob.status == "pending")).all()
        assert len(pending_jobs) == 2

    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-gpu-token")
    monkeypatch.setenv("WORTLAUT_ENABLE_LLM_SUMMARY", "true")
    monkeypatch.setenv("WORTLAUT_OLLAMA_URL", "http://ollama.local:11434")
    get_settings.cache_clear()
    seen_asr_headers: list[dict[str, str]] = []
    client_factory = httpx.Client

    def mock_asr(request: httpx.Request) -> httpx.Response:
        seen_asr_headers.append(
            {
                "langs": request.headers.get("X-ASR-Languages", ""),
                "primary": request.headers.get("X-Primary-Language", ""),
            }
        )
        req_lang = request.headers.get("X-ASR-Languages", "")
        if req_lang == "French":
            return httpx.Response(
                200,
                json={
                    "job_id": request.headers["X-Job-ID"],
                    "pcm_sha256": hashlib.sha256(request.content).hexdigest(),
                    "text": "Bonjour tout le monde",
                    "language": "French",
                    "words": [
                        {"word": "Bonjour", "confidence": 0.95},
                        {"word": "tout", "confidence": 0.92},
                        {"word": "le", "confidence": 0.94},
                        {"word": "monde", "confidence": 0.96},
                    ],
                },
            )
        return httpx.Response(
            200,
            json={
                "job_id": request.headers["X-Job-ID"],
                "pcm_sha256": hashlib.sha256(request.content).hexdigest(),
                "text": "皆さん こんにちは",
                "language": "Japanese",
                "words": [
                    {"word": "皆さん", "confidence": 0.93},
                    {"word": "こんにちは", "confidence": 0.97},
                ],
            },
        )

    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: client_factory(**kwargs, transport=httpx.MockTransport(mock_asr)),
    )
    try:
        # First job runs with French ("X-ASR-Languages: French", "X-Primary-Language: French")
        assert inference_pass(database) is True
        assert seen_asr_headers[0] == {"langs": "French", "primary": "French"}

        # 2. Live operator PATCH switches language to Japanese while recording is running
        patch_ja = client.patch(
            f"/v1/recordings/{rec_id}", headers=API, json={"language": "Japanese"}
        )
        assert patch_ja.status_code == 200
        assert patch_ja.json()["language"] == "Japanese"

        st1 = client.post(
            f"/v1/attempts/{attempt}/status",
            headers=owner,
            json={
                "participation": "capturing",
                "streams": 1,
                "audio_samples": 160000,
                "participant_sources": {
                    "available": True,
                    "total": 1,
                    "sources": [
                        {
                            "participant_id": "spk-polyglot",
                            "audio_csis": [1],
                            "share_audio_csis": [],
                        }
                    ],
                },
            },
        )
        assert st1.status_code == 200
        assert st1.json()["asr_language"] == "Japanese"

        # Second job immediately runs with Japanese!
        while inference_pass(database):
            pass
        assert seen_asr_headers[-1] == {"langs": "Japanese", "primary": "Japanese"}

        # 3. Operator switches to "auto" in Web-UI PATCH; worker status sync reflects "auto"
        patch_auto = client.patch(
            f"/v1/recordings/{rec_id}", headers=API, json={"language": "auto"}
        )
        assert patch_auto.status_code == 200
        assert patch_auto.json()["language"] == "auto"
        assert set(patch_auto.json()["detected_languages"]) == {"French", "Japanese"}

        st_auto = client.post(
            f"/v1/attempts/{attempt}/status",
            headers=owner,
            json={
                "participation": "capturing",
                "streams": 1,
                "audio_samples": 180000,
                "participant_sources": {
                    "available": True,
                    "total": 1,
                    "sources": [
                        {
                            "participant_id": "spk-polyglot",
                            "audio_csis": [1],
                            "share_audio_csis": [],
                        }
                    ],
                },
            },
        )
        assert st_auto.status_code == 200
        assert st_auto.json()["asr_language"] == "auto"

        # 4. Operator switches language to Spanish via PATCH, then worker ends call
        patch_es = client.patch(
            f"/v1/recordings/{rec_id}", headers=API, json={"language": "Spanish"}
        )
        assert patch_es.status_code == 200
        assert patch_es.json()["language"] == "Spanish"

        st_es = client.post(
            f"/v1/attempts/{attempt}/status",
            headers=owner,
            json={
                "participation": "ended",
                "reason": "normal",
                "streams": 1,
                "audio_samples": 180000,
                "participant_sources": {
                    "available": True,
                    "total": 1,
                    "sources": [
                        {
                            "participant_id": "spk-polyglot",
                            "audio_csis": [1],
                            "share_audio_csis": [],
                        }
                    ],
                },
            },
        )
        assert st_es.status_code == 200
        assert st_es.json()["asr_language"] == "Spanish"

        # 5. Ollama summary receives explicit target language ("Spanish") in system prompt
        from wortlaut import exports as exports_module

        captured_sys_prompts: list[str] = []

        class FakeSpanishOllama:
            status_code = 200

            def raise_for_status(self):
                pass

            @staticmethod
            def json():
                return {
                    "message": {
                        "content": json.dumps(
                            {
                                "summary": "Resumen de arquitectura global.",
                                "topics": [{"title": "Sincronización", "details": "Acordado."}],
                                "action_items": [],
                            }
                        )
                    }
                }

        def capture_ollama(*args, **kwargs):
            msgs = kwargs.get("json", {}).get("messages", [])
            captured_sys_prompts.append(msgs[0]["content"] if msgs else "")
            return FakeSpanishOllama()

        monkeypatch.setattr(exports_module.httpx, "post", capture_ollama)
        sum_resp = client.post(f"/v1/recordings/{rec_id}/summary", headers=API)
        assert sum_resp.status_code == 200
        assert "written in Spanish" in captured_sys_prompts[0]
    finally:
        get_settings.cache_clear()


def test_persistent_glossary_editor_tenancy_asr_and_export_aliases(
    client, database, monkeypatch
):
    from wortlaut.asr import build_asr_context_prompt
    from wortlaut.exports import chat_reader_token, export_data
    from wortlaut.models import Attempt, Recording
    from wortlaut.oidc import issue_user_session_token

    monkeypatch.setenv("WORTLAUT_ASR_GLOSSARY", "Wortlaut, LegacyEnvTerm")
    monkeypatch.setenv("WORTLAUT_OIDC_ALLOWED_DOMAINS", '["example.org"]')
    monkeypatch.setenv("WORTLAUT_OIDC_ADMIN_EMAILS", '["admin@example.org"]')
    get_settings.cache_clear()
    try:
        alice_token, _ = issue_user_session_token(
            sub="sub-alice", email="alice@example.org", name="Alice"
        )
        bob_token, _ = issue_user_session_token(
            sub="sub-bob", email="bob@example.org", name="Bob"
        )
        admin_token, _ = issue_user_session_token(
            sub="sub-admin", email="admin@example.org", name="Admin"
        )
        alice_hdr = {"Authorization": f"Bearer {alice_token}"}
        bob_hdr = {"Authorization": f"Bearer {bob_token}"}
        admin_hdr = {"Authorization": f"Bearer {admin_token}"}

        # 1. Baseline env glossary visible; non-admin cannot mutate global scope
        init_res = client.get("/v1/glossary", headers=alice_hdr)
        assert init_res.status_code == 200
        init_body = init_res.json()
        assert init_body["can_edit_global"] is False
        assert init_body["has_personal_scope"] is True
        assert init_body["default_scope"] == "personal"
        global_terms = {e["term"]: e for e in init_body["global_entries"]}
        assert "Wortlaut" in global_terms and global_terms["Wortlaut"]["source"] == "env"
        assert "LegacyEnvTerm" in global_terms

        forbidden = client.post(
            "/v1/glossary/entries",
            headers=alice_hdr,
            json={"scope": "global", "term": "ForbiddenGlobal"},
        )
        assert forbidden.status_code == 403

        # 2. Admin bulk-imports team terms, slash terms (S/4HANA), and phonetic aliases,
        #    and suppresses LegacyEnvTerm via DELETE without touching env config.
        up_global = client.post(
            "/v1/glossary/entries",
            headers=admin_hdr,
            json={
                "scope": "global",
                "raw_text": (
                    "Mainova, Hertener Stadtwerke, S/4HANA\n"
                    "Mistack | Maystack -> mAIstack"
                ),
            },
        )
        assert up_global.status_code == 200
        del_env = client.delete(
            "/v1/glossary/entries",
            headers=admin_hdr,
            params={"term_key": "legacyenvterm", "scope": "global"},
        )
        assert del_env.status_code == 200
        del_slash = client.delete(
            "/v1/glossary/entries",
            headers=admin_hdr,
            params={"term_key": "s/4hana", "scope": "global"},
        )
        assert del_slash.status_code == 200

        after_global = {e["term"]: e for e in del_slash.json()["global_entries"]}
        assert "LegacyEnvTerm" not in after_global
        assert del_slash.json()["suppressed_env_terms"] == ["LegacyEnvTerm"]
        assert "S/4HANA" not in after_global
        assert "Mainova" in after_global
        assert "Hertener Stadtwerke" in after_global
        assert after_global["mAIstack"]["aliases"] == ["Mistack", "Maystack"]

        # 3. Alice adds personal confidential term + alias (scope="auto" routes to personal);
        #    Bob never sees Alice's personal entries.
        up_alice = client.post(
            "/v1/glossary/entries",
            headers=alice_hdr,
            json={
                "scope": "auto",
                "term": "Projekt Phoenix",
                "aliases": ["Projekt Fönix"],
            },
        )
        assert up_alice.status_code == 200
        assert up_alice.json()["scope"] == "personal"
        assert [e["term"] for e in up_alice.json()["personal_entries"]] == ["Projekt Phoenix"]

        bob_view = client.get("/v1/glossary", headers=bob_hdr).json()
        assert bob_view["personal_entries"] == []

        # 4. Verify ASR context prompt + lossless export alias normalization + reader rejection
        now = datetime.now(UTC)
        with Session(database) as db:
            rec = Recording(
                id=uuid.uuid4(),
                idempotency_key=f"gloss-{uuid.uuid4()}",
                request_digest="digest-gloss",
                provider="google_meet",
                meeting_url="https://meet.google.com/abc-defg-hij",
                title="Architektur",
                owner_email="alice@example.org",
                starts_at=now,
                ends_at=now + timedelta(hours=1),
                participation="ended",
                processing="completed",
                protocol_meta={},
            )
            db.add(rec)
            db.flush()
            reader_tok = chat_reader_token(rec)
            att = Attempt(
                id=uuid.uuid4(),
                recording_id=rec.id,
                credential_hash="h",
                credential_expires_at=now + timedelta(hours=2),
                diagnostics={},
            )
            db.add(att)
            db.flush()
            stream = AudioStream(
                id=uuid.uuid4(),
                attempt_id=att.id,
                stream_id=uuid.uuid4(),
                epoch=uuid.uuid4(),
                contract={
                    "provider_source_id": "meet-rcv-1",
                    "source_kind": "speaker",
                    "participant_id": "spk-alice",
                    "speaker_id": "spk-alice",
                    "participant_name": "Alice",
                    "attribution_unknown": False,
                    "session_utc_origin": now.isoformat(),
                    "monotonic_origin_ms": 0,
                    "session_monotonic_origin_ms": 0,
                },
            )
            db.add(stream)
            db.flush()
            job = AsrJob(
                id=str(uuid.uuid4()),
                stream_id=stream.id,
                start_sample=0,
                end_sample=32000,
                core_start=0,
                core_end=32000,
                status="completed",
                binding=dict(stream.contract),
            )
            db.add(job)
            db.flush()
            db.add(
                TranscriptSegment(
                    id=job.id,
                    result={
                        "id": job.id,
                        "stream_id": str(stream.stream_id),
                        "epoch": str(stream.epoch),
                        "provider_source_id": "meet-rcv-1",
                        "source_kind": "speaker",
                        "participant_id": "spk-alice",
                        "speaker_id": "spk-alice",
                        "participant_name": "Alice",
                        "attribution_unknown": False,
                        "session_utc_origin": now.isoformat(),
                        "start": 0.0,
                        "end": 2.0,
                        "start_sample": 0,
                        "end_sample": 32000,
                        "confidence": 0.92,
                        "text": "Wir nutzen Mistack fuer Projekt Fönix bei Mainova.",
                        "words": [],
                    },
                )
            )
            db.commit()

            prompt = build_asr_context_prompt(db, job, stream, get_settings())
            assert prompt is not None
            assert "Projekt Phoenix" in prompt
            assert "mAIstack" in prompt
            assert "Mainova" in prompt
            assert "LegacyEnvTerm" not in prompt

            exported = export_data(db, rec)
            assert (
                exported["segments"][0]["text"]
                == "Wir nutzen mAIstack fuer Projekt Phoenix bei Mainova."
            )
            # Raw segment in DB stays untouched (lossless display-time normalization)
            raw_seg = db.get(TranscriptSegment, job.id)
            assert raw_seg.result["text"] == "Wir nutzen Mistack fuer Projekt Fönix bei Mainova."

        assert (
            client.get(
                "/v1/glossary",
                headers={"Authorization": f"Bearer {reader_tok}"},
            ).status_code
            == 401
        )
    finally:
        get_settings.cache_clear()
