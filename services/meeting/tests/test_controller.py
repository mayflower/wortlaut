"""Real DB/API ownership; controlled Kubernetes responses, not cluster proof."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from kubernetes.client.exceptions import ApiException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_recordings import API, create, request_body

from wortlaut import controller as controller_module
from wortlaut.controller import POD_FINALIZER, controller_pass, job_body
from wortlaut.models import Attempt, Recording
from wortlaut.settings import get_settings


@pytest.fixture
def cluster(monkeypatch):
    # Test schemas share the development DB. PostgreSQL advisory locks are
    # database-wide, so isolate this fixture from its live scheduler while
    # retaining one shared real lock for concurrent controllers in the test.
    monkeypatch.setattr(controller_module, "SCHEDULER_LOCK", uuid.uuid4().int >> 65)
    monkeypatch.setenv("WORTLAUT_WEBEX_SERVICE_TOKEN", "controlled-provider-not-real-webex")
    get_settings.cache_clear()
    jobs, pods, secrets = {}, [], {}
    batch, core = Mock(), Mock()

    def read(objects, name, *_args, **_kwargs):
        if name not in objects:
            raise ApiException(status=404)
        return objects[name]

    def create_job(_namespace, body, **_kwargs):
        name = body["metadata"]["name"]
        if name in jobs:
            raise ApiException(status=409)
        job = NS(
            metadata=NS(
                name=name,
                labels=body["metadata"]["labels"],
                uid=str(uuid.uuid4()),
                resource_version="1",
            ),
            spec=NS(active_deadline_seconds=body["spec"]["activeDeadlineSeconds"]),
            status=NS(start_time=datetime.now(UTC)),
        )
        jobs[name] = job
        return job

    def create_secret(_namespace, body, **_kwargs):
        secrets[body["metadata"]["name"]] = NS(
            metadata=NS(labels=body["metadata"]["labels"], uid=str(uuid.uuid4())),
            credential=body["stringData"]["credential"],
        )

    batch.read_namespaced_job.side_effect = lambda name, *a, **k: read(jobs, name)
    batch.create_namespaced_job.side_effect = create_job
    batch.patch_namespaced_job.side_effect = lambda name, _ns, body, **k: setattr(
        jobs[name].spec, "active_deadline_seconds", body["spec"]["activeDeadlineSeconds"]
    )
    core.create_namespaced_secret.side_effect = create_secret
    core.read_namespaced_secret.side_effect = lambda name, *a, **k: read(secrets, name)
    core.delete_namespaced_secret.side_effect = lambda name, *a, **k: secrets.pop(name)
    core.list_namespaced_pod.side_effect = lambda *a, **k: NS(items=pods.copy())

    def patch_pod(name, _namespace, body, **_kwargs):
        target = next(p for p in pods if p.metadata.name == name)
        assert body[0] == {"op": "test", "path": "/metadata/uid", "value": target.metadata.uid}
        assert body[1] == {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": target.metadata.resource_version,
        }
        target.metadata.finalizers = body[2]["value"]

    core.patch_namespaced_pod.side_effect = patch_pod
    yield NS(apis=(batch, core), jobs=jobs, pods=pods, secrets=secrets)
    get_settings.cache_clear()


def prepared(database, cluster):
    controller_pass(database, cluster.apis)
    controller_pass(database, cluster.apis)
    with Session(database) as db:
        attempt = db.scalar(select(Attempt))
        return (
            attempt.id,
            attempt.job_name,
            {"Authorization": f"Bearer {cluster.secrets[attempt.job_name].credential}"},
        )


def pod(job, phase="Running"):
    return NS(
        metadata=NS(
            uid=str(uuid.uuid4()),
            name=job.metadata.name + "-pod",
            resource_version="1",
            finalizers=[POD_FINALIZER],
            owner_references=[NS(kind="Job", uid=job.metadata.uid)],
        ),
        status=NS(
            phase=phase,
            container_statuses=[
                NS(
                    state=NS(
                        terminated=NS(finished_at=datetime.now(UTC)) if phase == "Failed" else None,
                        running=NS(started_at=datetime.now(UTC)) if phase == "Running" else None,
                    )
                )
            ],
        ),
    )


def test_three_providers_start_parallel_with_their_own_configuration(
    client, database, cluster, monkeypatch
):
    monkeypatch.setenv("WORTLAUT_MAX_ACTIVE_MEETINGS", "3")
    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    monkeypatch.setenv("WORTLAUT_MEET_STORAGE_STATE_SECRET", "wortlaut-meet-browser")
    monkeypatch.setenv("WORTLAUT_ENABLE_TEAMS", "true")
    get_settings.cache_clear()
    webex = create(client, "webex")
    meet = create(
        client, "meet", {**request_body(), "meeting_url": "https://meet.google.com/abc-defg-hij"}
    )
    teams = create(
        client, "teams", {**request_body(), "meeting_url": "https://teams.microsoft.com/meet/123"}
    )
    controller_pass(database, cluster.apis)
    controller_pass(database, cluster.apis)
    assert len(cluster.jobs) == 3
    with Session(database) as db:
        for identifier, provider in [(webex, "webex"), (meet, "google_meet"), (teams, "teams")]:
            recording = db.get(Recording, uuid.UUID(identifier))
            assert recording.provider == provider
            assert recording.active_attempt_id is not None
            attempt = db.get(Attempt, recording.active_attempt_id)
            body = job_body(recording, attempt)
            worker = body["spec"]["template"]["spec"]["containers"][0]
            assert worker["env"][-1]["valueFrom"]["secretKeyRef"]["name"] == attempt.job_name
            volumes = body["spec"]["template"]["spec"]["volumes"]
            secrets = [v["secret"]["secretName"] for v in volumes if "secret" in v]
            assert secrets == (["wortlaut-meet-browser"] if provider == "google_meet" else [])
            assert worker.get("envFrom", []) == []
    waiting = create(
        client,
        "another-meet",
        {**request_body(), "meeting_url": "https://meet.google.com/xyz-abcd-efg"},
    )
    controller_pass(database, cluster.apis)
    assert len(cluster.jobs) == 3
    with Session(database) as db:
        queued = db.get(Recording, uuid.UUID(waiting))
        assert queued.active_attempt_id is None
        assert queued.participation_reason == "worker_capacity_limit"


def test_scheduler_lock_defers_start_until_the_other_controller_releases_it(
    client, database, cluster
):
    recording = create(client)
    with Session(database) as competing:
        competing.execute(select(func.pg_advisory_xact_lock(controller_module.SCHEDULER_LOCK)))
        controller_pass(database, cluster.apis)
        assert client.get(f"/v1/recordings/{recording}", headers=API).json()[
            "active_attempt_id"
        ] is None
        assert cluster.jobs == cluster.secrets == {}
    controller_pass(database, cluster.apis)
    controller_pass(database, cluster.apis)
    assert len(cluster.jobs) == len(cluster.secrets) == 1
    assert client.get(f"/v1/recordings/{recording}", headers=API).json()["active_attempt_id"]


def test_missing_webex_access_does_not_block_meet(client, database, cluster, monkeypatch):
    monkeypatch.delenv("WORTLAUT_WEBEX_SERVICE_TOKEN")
    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    get_settings.cache_clear()
    webex = create(client, "webex")
    # More unavailable Webex meetings than the controller's bounded start page.
    # All precede the eligible Meet recording in the persisted scheduler queue.
    with Session(database) as db:
        template = db.get(Recording, uuid.UUID(webex))
        template.starts_at -= timedelta(seconds=10)
        db.add_all(
            Recording(
                idempotency_key=f"unconfigured-webex-{number}",
                request_digest=template.request_digest,
                meeting_url=template.meeting_url,
                starts_at=template.starts_at,
                ends_at=template.ends_at,
            )
            for number in range(16)
        )
        expired = Recording(
            idempotency_key="expired-webex",
            request_digest=template.request_digest,
            meeting_url=template.meeting_url,
            starts_at=template.starts_at - timedelta(hours=1),
            ends_at=template.starts_at - timedelta(minutes=1),
        )
        db.add(expired)
        db.flush()
        expired_id = expired.id
        db.commit()
    meet = create(
        client, "meet", {**request_body(), "meeting_url": "https://meet.google.com/abc-defg-hij"}
    )
    controller_pass(database, cluster.apis)
    controller_pass(database, cluster.apis)
    assert len(cluster.jobs) == 1
    with Session(database) as db:
        blocked = db.scalars(
            select(Recording).where(Recording.provider == "webex", Recording.id != expired_id)
        ).all()
        assert len(blocked) == 17
        assert all(r.participation_reason == "webex_not_configured" for r in blocked)
        assert all(r.active_attempt_id is None for r in blocked)
        assert db.get(Recording, expired_id).participation == "ended"
        assert db.get(Recording, expired_id).participation_reason == "missed"
        assert db.get(Recording, uuid.UUID(meet)).active_attempt_id is not None


def test_restart_adopts_existing_job_and_two_workers_cannot_join(client, database, cluster):
    recording = create(client)
    identifier, name, headers = prepared(database, cluster)
    original_uid = cluster.jobs[name].metadata.uid
    controller_pass(database, cluster.apis)  # A fresh controller invocation adopts the same Job.
    with ThreadPoolExecutor(2) as executor:
        claims = list(
            executor.map(
                lambda worker: client.post(
                    f"/v1/attempts/{identifier}/claim", headers=headers, json={"worker_id": worker}
                ),
                ["first-pod", "duplicate-pod"],
            )
        )
    assert sorted(r.status_code for r in claims) == [200, 409]
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert len(status["attempts"]) == 1
    assert status["attempts"][0]["job_uid"] == original_uid
    assert len(cluster.jobs) == 1


def test_missing_pod_or_job_never_releases_owner(client, database, cluster):
    recording = create(client)
    identifier, name, headers = prepared(database, cluster)
    assert (
        client.post(
            f"/v1/attempts/{identifier}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 200
    )
    cluster.pods.append(pod(cluster.jobs[name]))
    controller_pass(database, cluster.apis)
    cluster.pods.clear()  # Force-delete/partition: object disappearance is not process exit.
    controller_pass(database, cluster.apis)
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert status["participation"] == "unknown"
    assert status["participation_reason"] == "pod_missing"
    assert status["attempts"][0]["ended_at"] is None
    assert client.post(f"/v1/recordings/{recording}/attempts", headers=API).status_code == 409
    cluster.jobs.clear()
    controller_pass(database, cluster.apis)
    assert (
        client.get(f"/v1/recordings/{recording}", headers=API).json()["participation_reason"]
        == "job_missing"
    )
    assert name in cluster.secrets
    assert not cluster.jobs


def test_cancel_after_claim_keeps_audio_drain_and_waits_for_process_exit(client, database, cluster):
    recording = create(client)
    identifier, name, headers = prepared(database, cluster)
    client.post(f"/v1/attempts/{identifier}/claim", headers=headers, json={"worker_id": "owner"})
    running = pod(cluster.jobs[name])
    cluster.pods.append(running)
    controller_pass(database, cluster.apis)
    assert client.post(f"/v1/recordings/{recording}/cancel", headers=API).status_code == 200
    response = client.post(
        f"/v1/attempts/{identifier}/status",
        headers={**headers, "X-Worker-ID": "owner"},
        json={"participation": "capturing"},
    )
    assert response.json()["stop_requested"]
    assert response.json()["stop_reason"] == "cancelled"
    controller_pass(database, cluster.apis)
    deadline_at = cluster.jobs[name].status.start_time + timedelta(
        seconds=cluster.jobs[name].spec.active_deadline_seconds
    )
    assert deadline_at <= datetime.now(UTC) + timedelta(seconds=1)
    assert name in cluster.secrets
    assert (
        client.post(
            f"/v1/attempts/{identifier}/claim", headers=headers, json={"worker_id": "owner"}
        ).status_code
        == 409
    )
    running.status = pod(cluster.jobs[name], "Failed").status
    controller_pass(database, cluster.apis)
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert status["participation"] == "ended"
    assert status["attempts"][0]["end_reason"] == "cancelled"
    assert status["attempts"][0]["process_ended_at"] is not None
    assert name not in cluster.secrets


def test_terminal_pod_cleanup_retries_after_persisting_exit_and_preserves_foreign_finalizers(
    client, database, cluster
):
    recording = create(client)
    identifier, name, _headers = prepared(database, cluster)
    terminal = pod(cluster.jobs[name], "Failed")
    terminal.metadata.finalizers.append("other.example/retain")
    foreign = pod(cluster.jobs[name], "Failed")
    foreign.metadata.name += "-foreign"
    foreign.metadata.owner_references[0].uid = str(uuid.uuid4())
    cluster.pods.extend([terminal, foreign])
    original = cluster.apis[1].patch_namespaced_pod.side_effect

    def lost_cleanup_response(*args, **kwargs):
        with Session(database) as db:
            attempt = db.get(Attempt, identifier)
            assert attempt.process_ended_at is not None
            assert attempt.secret_deleted_at is None
        original(*args, **kwargs)
        raise TimeoutError("Controlled lost Pod cleanup response")

    cluster.apis[1].patch_namespaced_pod.side_effect = lost_cleanup_response
    controller_pass(database, cluster.apis)
    assert terminal.metadata.finalizers == ["other.example/retain"]
    assert foreign.metadata.finalizers == [POD_FINALIZER]
    assert name in cluster.secrets
    assert client.get(f"/v1/recordings/{recording}", headers=API).json()["participation"] == "ended"
    cluster.apis[1].patch_namespaced_pod.side_effect = original
    controller_pass(database, cluster.apis)
    assert name not in cluster.secrets
    with Session(database) as db:
        assert db.get(Attempt, identifier).secret_deleted_at is not None


def test_running_pod_keeps_termination_finalizer(client, database, cluster):
    recording = create(client)
    _identifier, name, _headers = prepared(database, cluster)
    running = pod(cluster.jobs[name])
    cluster.pods.append(running)
    client.post(f"/v1/recordings/{recording}/cancel", headers=API)
    controller_pass(database, cluster.apis)
    assert running.metadata.finalizers == [POD_FINALIZER]
    cluster.apis[1].patch_namespaced_pod.assert_not_called()
    assert name in cluster.secrets


def test_cancel_before_create_is_atomic_and_never_starts_a_job(client, database, cluster):
    recording = create(client)
    controller_pass(database, cluster.apis)  # Attempt/Secret committed; Job not started yet.
    assert client.post(f"/v1/recordings/{recording}/cancel", headers=API).status_code == 200
    controller_pass(database, cluster.apis)
    assert not cluster.jobs
    assert not cluster.secrets
    assert client.get(f"/v1/recordings/{recording}", headers=API).json()["participation"] == "ended"
    second = create(client, "cancel-before-scheduler")
    client.post(f"/v1/recordings/{second}/cancel", headers=API)
    controller_pass(database, cluster.apis)
    assert not cluster.jobs


def test_heartbeat_loss_is_unknown_and_late_start_is_visible(client, database, cluster):
    recording = create(client)
    identifier, name, headers = prepared(database, cluster)
    client.post(f"/v1/attempts/{identifier}/claim", headers=headers, json={"worker_id": "owner"})
    with Session(database) as db:
        db.get(Attempt, identifier).last_heartbeat_at = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()
    controller_pass(database, cluster.apis)
    assert (
        client.get(f"/v1/recordings/{recording}", headers=API).json()["participation"] == "unknown"
    )
    assert name in cluster.secrets
    body = request_body()
    body["starts_at"] = (datetime.now(UTC) - timedelta(minutes=20)).isoformat()
    missed = create(client, "missed", body)
    controller_pass(database, cluster.apis)
    assert (
        client.get(f"/v1/recordings/{missed}", headers=API).json()["participation_reason"]
        == "missed"
    )
    with Session(database) as db:
        assert db.get(Recording, uuid.UUID(missed)).active_attempt_id is None


def test_cancellation_racing_job_create_prevents_worker_claim(client, database, cluster):
    recording = create(client)
    controller_pass(database, cluster.apis)
    entered, release = Event(), Event()
    original = cluster.apis[0].create_namespaced_job.side_effect

    def delayed_create(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return original(*args, **kwargs)

    cluster.apis[0].create_namespaced_job.side_effect = delayed_create
    with ThreadPoolExecutor(2) as executor:
        starting = executor.submit(controller_pass, database, cluster.apis)
        try:
            assert entered.wait(10)
            cancelling = executor.submit(
                client.post, f"/v1/recordings/{recording}/cancel", headers=API
            )
        finally:
            release.set()
        starting.result(timeout=15)
        assert cancelling.result(timeout=15).status_code == 200
    with Session(database) as db:
        attempt = db.scalar(select(Attempt))
        credential = cluster.secrets[attempt.job_name].credential
        identifier = attempt.id
    assert (
        client.post(
            f"/v1/attempts/{identifier}/claim",
            headers={"Authorization": f"Bearer {credential}"},
            json={"worker_id": "late-pod"},
        ).status_code
        == 409
    )


def test_ambiguous_create_and_disappeared_job_cannot_create_a_replacement(
    client, database, cluster
):
    recording = create(client)
    controller_pass(database, cluster.apis)
    original = cluster.apis[0].create_namespaced_job.side_effect

    def lost_response(*args, **kwargs):
        original(*args, **kwargs)
        raise TimeoutError("Controlled lost Create response")

    cluster.apis[0].create_namespaced_job.side_effect = lost_response
    controller_pass(database, cluster.apis)
    # A restart can adopt an existing Job despite its lost create response.
    controller_pass(database, cluster.apis)
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert status["attempts"][0]["job_uid"] is not None
    cluster.jobs.clear()
    controller_pass(database, cluster.apis)
    assert (
        client.get(f"/v1/recordings/{recording}", headers=API).json()["participation"] == "unknown"
    )
    assert cluster.apis[0].create_namespaced_job.call_count == 1
    assert cluster.secrets  # No process proof: keep its ownership and credential.


def test_missing_job_after_creation_intent_retries_same_unclaimed_identity(
    client, database, cluster
):
    recording = create(client)
    controller_pass(database, cluster.apis)
    with Session(database) as db:
        attempt = db.scalar(select(Attempt))
        attempt.job_create_requested_at = datetime.now(UTC)
        identifier, name = str(attempt.id), attempt.job_name
        db.commit()  # Crash after intent; result of the network operation is unavailable.
    controller_pass(database, cluster.apis)
    assert list(cluster.jobs) == [name]
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert status["participation"] == "preparing"
    assert status["attempts"][0]["id"] == identifier
    assert status["attempts"][0]["job_uid"] == cluster.jobs[name].metadata.uid
    assert status["attempts"][0]["ended_at"] is None


def test_create_outage_retries_same_identity_but_authoritative_rejection_ends_attempt(
    client, database, cluster
):
    recording = create(client)
    controller_pass(database, cluster.apis)
    original = cluster.apis[0].create_namespaced_job.side_effect
    cluster.apis[0].create_namespaced_job.side_effect = ApiException(status=503)
    controller_pass(database, cluster.apis)
    before = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert before["participation"] == "unknown"
    assert not cluster.jobs
    cluster.apis[0].create_namespaced_job.side_effect = original
    controller_pass(database, cluster.apis)
    after = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert after["attempts"][0]["id"] == before["attempts"][0]["id"]
    assert after["attempts"][0]["job_uid"] is not None
    assert len(cluster.secrets) == 1
    second = create(client, "rejected-job")
    controller_pass(database, cluster.apis)
    cluster.apis[0].create_namespaced_job.side_effect = ApiException(status=422)
    controller_pass(database, cluster.apis)
    rejected = client.get(f"/v1/recordings/{second}", headers=API).json()
    assert rejected["participation"] == "ended"
    assert rejected["participation_reason"] == "job_create_rejected"
    assert rejected["attempts"][0]["process_ended_at"] is not None
    assert len(cluster.secrets) == 1  # Only the first running attempt retains its credential.


def test_unobserved_job_with_pod_evidence_does_not_retry_create(client, database, cluster):
    recording = create(client)
    controller_pass(database, cluster.apis)
    with Session(database) as db:
        db.scalar(select(Attempt)).job_create_requested_at = datetime.now(UTC)
        db.commit()
    cluster.pods.append(NS(metadata=NS(uid=str(uuid.uuid4()))))
    controller_pass(database, cluster.apis)
    assert not cluster.jobs
    assert cluster.apis[0].create_namespaced_job.call_count == 0
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert status["participation_reason"] == "job_missing"


def test_secret_creation_failure_does_not_roll_back_other_provider_starts(
    client, database, cluster, monkeypatch
):
    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    get_settings.cache_clear()
    webex = create(client, "failed-secret")
    meet = create(
        client,
        "healthy-secret",
        {**request_body(), "meeting_url": "https://meet.google.com/abc-defg-hij"},
    )
    with Session(database) as db:
        db.get(Recording, uuid.UUID(webex)).starts_at -= timedelta(seconds=10)
        db.commit()
    original = cluster.apis[1].create_namespaced_secret.side_effect
    calls = 0

    def reject_first(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ApiException(status=403)
        return original(*args, **kwargs)

    cluster.apis[1].create_namespaced_secret.side_effect = reject_first
    controller_pass(database, cluster.apis)
    failed = client.get(f"/v1/recordings/{webex}", headers=API).json()
    healthy = client.get(f"/v1/recordings/{meet}", headers=API).json()
    assert failed["active_attempt_id"] is not None
    assert healthy["active_attempt_id"] is not None
    controller_pass(database, cluster.apis)
    failed = client.get(f"/v1/recordings/{webex}", headers=API).json()
    assert failed["participation"] == "ended"
    assert failed["participation_reason"] == "bootstrap_secret_missing"
    assert failed["attempts"][0]["process_ended_at"] is not None
    assert len(cluster.jobs) == len(cluster.secrets) == 1
    assert healthy["active_attempt_id"] == str(
        next(iter(cluster.jobs.values())).metadata.labels["wortlaut/attempt-id"]
    )


def test_lost_secret_create_response_keeps_attempt_and_adopts_its_credential(
    client, database, cluster
):
    recording = create(client)
    original = cluster.apis[1].create_namespaced_secret.side_effect

    def lost_response(*args, **kwargs):
        original(*args, **kwargs)
        raise TimeoutError("Controlled lost Secret response")

    cluster.apis[1].create_namespaced_secret.side_effect = lost_response
    controller_pass(database, cluster.apis)
    before = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert before["active_attempt_id"] is not None
    assert len(cluster.secrets) == 1
    controller_pass(database, cluster.apis)
    after = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert after["active_attempt_id"] == before["active_attempt_id"]
    assert len(cluster.jobs) == len(cluster.secrets) == 1
    name = next(iter(cluster.jobs))
    response = client.post(
        f"/v1/attempts/{after['active_attempt_id']}/claim",
        headers={"Authorization": f"Bearer {cluster.secrets[name].credential}"},
        json={"worker_id": "secret-recovery-fixture"},
    )
    assert response.status_code == 200


def test_concurrent_secret_creation_reserves_shared_capacity_before_network_call(
    client, database, cluster, monkeypatch
):
    monkeypatch.setenv("WORTLAUT_MAX_ACTIVE_MEETINGS", "2")
    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    get_settings.cache_clear()
    first = create(client, "pending-secret")
    second = create(
        client,
        "second-provider",
        {**request_body(), "meeting_url": "https://meet.google.com/abc-defg-hij"},
    )
    third = create(client, "capacity-waiting")
    with Session(database) as db:
        db.get(Recording, uuid.UUID(first)).starts_at -= timedelta(seconds=10)
        db.get(Recording, uuid.UUID(third)).starts_at += timedelta(seconds=10)
        db.commit()
    original = cluster.apis[1].create_namespaced_secret.side_effect
    entered, release = Event(), Event()

    def delayed_first(*args, **kwargs):
        if not entered.is_set():
            entered.set()
            assert release.wait(15), "Concurrent scheduler never released Secret creation"
        return original(*args, **kwargs)

    cluster.apis[1].create_namespaced_secret.side_effect = delayed_first
    with ThreadPoolExecutor(max_workers=2) as pool:
        starting = pool.submit(controller_pass, database, cluster.apis)
        assert entered.wait(15)
        try:
            other = pool.submit(controller_pass, database, cluster.apis)
            other.result(timeout=15)
            with Session(database) as db:
                assert db.get(Recording, uuid.UUID(first)).active_attempt_id is not None
                assert db.get(Recording, uuid.UUID(second)).active_attempt_id is not None
                waiting = db.get(Recording, uuid.UUID(third))
                assert waiting.active_attempt_id is None
        finally:
            release.set()
        starting.result(timeout=15)
    controller_pass(database, cluster.apis)
    assert len(cluster.jobs) == len(cluster.secrets) == 2
    assert client.get(f"/v1/recordings/{third}", headers=API).json()["active_attempt_id"] is None


def test_local_process_runtime_reconciles_attempt_and_cleans_up_secret(
    client, database, tmp_path, monkeypatch
):
    from wortlaut.runtime_backends import LocalProcessRuntime

    monkeypatch.setattr(controller_module, "SCHEDULER_LOCK", uuid.uuid4().int >> 65)
    monkeypatch.setenv("WORTLAUT_WEBEX_SERVICE_TOKEN", "controlled-provider-not-real-webex")
    get_settings.cache_clear()

    worker_dir = tmp_path / "worker"
    entrypoint = worker_dir / "dist-worker/runtime/main.js"
    entrypoint.parent.mkdir(parents=True)
    entrypoint.write_text("process.exit(0);\n", encoding="utf-8")

    runtime = LocalProcessRuntime(root=tmp_path / "state", worker_dir=worker_dir)
    recording_id = create(client, "local-runtime-recording")

    # 1st pass: creates attempt + local secret
    controller_pass(database, (runtime, runtime))
    # 2nd pass: launches subprocess and observes pod
    controller_pass(database, (runtime, runtime))
    with Session(database) as db:
        attempt = db.scalar(select(Attempt).where(Attempt.recording_id == uuid.UUID(recording_id)))
        assert attempt is not None
        assert attempt.job_uid is not None
        proc = runtime.procs.get(attempt.job_name)
        if proc:
            proc.wait(timeout=5)

    # 3rd pass: observes process exit, removes finalizer and deletes bootstrap secret
    controller_pass(database, (runtime, runtime))
    with Session(database) as db:
        attempt = db.scalar(select(Attempt).where(Attempt.recording_id == uuid.UUID(recording_id)))
        rec = db.get(Recording, uuid.UUID(recording_id))
        assert rec.participation == "ended"
        assert attempt.secret_deleted_at is not None
        assert not (runtime.root / f"{attempt.job_name}.json").exists()


def test_docker_runtime_reconciles_container_lifecycle_via_engine_api(
    client, database, tmp_path, monkeypatch
):
    import json

    from wortlaut.runtime_backends import DockerRuntime

    monkeypatch.setattr(controller_module, "SCHEDULER_LOCK", uuid.uuid4().int >> 65)
    monkeypatch.setenv("WORTLAUT_WEBEX_SERVICE_TOKEN", "controlled-provider-not-real-webex")
    get_settings.cache_clear()

    containers = {}
    runtime = DockerRuntime(root=tmp_path / "docker-state")

    def fake_docker_request(method, path, payload=None):
        if method == "POST" and path.startswith("/containers/create?"):
            name = path.split("name=", 1)[1]
            cid = uuid.uuid4().hex
            containers[name] = {"Id": cid, "Running": False, "ExitCode": 0, "Payload": payload}
            return 201, json.dumps({"Id": cid})
        if method == "POST" and path.endswith("/start"):
            name = path.split("/")[2]
            containers[name]["Running"] = True
            return 204, ""
        if method == "POST" and "/stop" in path:
            name = path.split("/")[2]
            containers[name]["Running"] = False
            return 204, ""
        if method == "GET" and path.endswith("/json"):
            name = path.split("/")[2]
            c = containers[name]
            return 200, json.dumps({"State": {"Running": c["Running"], "ExitCode": c["ExitCode"]}})
        if method == "DELETE":
            name = path.split("/")[2].split("?")[0]
            containers.pop(name, None)
            return 204, ""
        return 404, ""

    monkeypatch.setattr(runtime, "_docker_request", fake_docker_request)
    recording_id = create(client, "docker-runtime-recording")

    controller_pass(database, (runtime, runtime))
    controller_pass(database, (runtime, runtime))
    assert len(containers) == 1
    container_name = next(iter(containers))
    assert containers[container_name]["Running"] is True

    # Simulate container exit
    containers[container_name]["Running"] = False
    controller_pass(database, (runtime, runtime))
    assert containers == {}
    with Session(database) as db:
        attempt = db.scalar(select(Attempt).where(Attempt.recording_id == uuid.UUID(recording_id)))
        assert attempt.secret_deleted_at is not None

    # Verify real TCP docker-socket-proxy transport via WORTLAUT_DOCKER_HOST
    import http.server
    import threading

    tcp_containers = {}

    class ProxyHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length else ""
            payload = json.loads(raw_body) if raw_body else None
            status, body = fake_docker_request("POST", self.path, payload)
            if status == 201:
                name = self.path.split("name=", 1)[1]
                tcp_containers[name] = payload
            self.send_response(status)
            self.end_headers()
            if body:
                self.wfile.write(body.encode("utf-8"))

        def do_GET(self):
            status, body = fake_docker_request("GET", self.path)
            self.send_response(status)
            self.end_headers()
            if body:
                self.wfile.write(body.encode("utf-8"))

        def do_DELETE(self):
            status, _ = fake_docker_request("DELETE", self.path)
            self.send_response(status)
            self.end_headers()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("WORTLAUT_DOCKER_HOST", f"tcp://127.0.0.1:{server.server_port}")
        get_settings.cache_clear()
        tcp_runtime = DockerRuntime(root=tmp_path / "docker-tcp-state")
        tcp_rec_id = create(client, "docker-tcp-proxy-recording")
        controller_pass(database, (tcp_runtime, tcp_runtime))
        controller_pass(database, (tcp_runtime, tcp_runtime))
        assert len(tcp_containers) == 1
        created_name = next(iter(tcp_containers))
        assert tcp_containers[created_name]["HostConfig"]["CapDrop"] == ["ALL"]
        containers[created_name]["Running"] = False
        controller_pass(database, (tcp_runtime, tcp_runtime))
        assert containers == {}
        with Session(database) as db:
            tcp_attempt = db.scalar(
                select(Attempt).where(Attempt.recording_id == uuid.UUID(tcp_rec_id))
            )
            assert tcp_attempt.secret_deleted_at is not None
    finally:
        server.shutdown()
        server.server_close()


def test_active_capturing_overtime_extends_deadline_and_k8s_job_up_to_cap(
    client, database, cluster, monkeypatch
):
    monkeypatch.setenv("WORTLAUT_MAX_OVERTIME_SECONDS", "3600")
    get_settings.cache_clear()
    try:
        now = datetime.now(UTC)
        scheduled_end = (now + timedelta(seconds=90)).replace(microsecond=0)
        res = client.post(
            "/v1/recordings",
            headers={**API, "Idempotency-Key": "overtime-test-rec"},
            json={
                "meeting_url": "https://fixture.webex.com/meet/overtime",
                "starts_at": (now - timedelta(minutes=2)).isoformat(),
                "ends_at": scheduled_end.isoformat(),
            },
        )
        assert res.status_code == 200
        recording_id = res.json()["id"]
        identifier, name, headers = prepared(database, cluster)
        client.post(
            f"/v1/attempts/{identifier}/claim", headers=headers, json={"worker_id": "owner"}
        )
        running = pod(cluster.jobs[name])
        cluster.pods.append(running)
        controller_pass(database, cluster.apis)
        initial_job_deadline = cluster.jobs[name].spec.active_deadline_seconds

        # Active capturing near ends_at extends recording + credential + K8s Job by +15 min.
        status_resp = client.post(
            f"/v1/attempts/{identifier}/status",
            headers={**headers, "X-Worker-ID": "owner"},
            json={
                "participation": "capturing",
                "streams": 2,
                "audio_samples": 160000,
                "active_audio_samples": 80000,
                "participant_sources": {
                    "available": True,
                    "total": 2,
                    "dom_participants": 2,
                    "sources": [],
                },
            },
        )
        assert status_resp.status_code == 200
        new_deadline = datetime.fromisoformat(status_resp.json()["deadline"])
        assert new_deadline >= scheduled_end + timedelta(minutes=14, seconds=30)

        controller_pass(database, cluster.apis)
        assert cluster.jobs[name].spec.active_deadline_seconds > initial_job_deadline + 800

        # Emptied browser room (dom_participants == 0 despite historical total == 2 and
        # advancing comfort-noise audio_samples) must NOT extend recording.ends_at.
        with Session(database) as db:
            rec = db.get(Recording, uuid.UUID(recording_id))
            near_end = (datetime.now(UTC) + timedelta(seconds=60)).replace(microsecond=0)
            rec.ends_at = near_end
            db.commit()

        empty_resp = client.post(
            f"/v1/attempts/{identifier}/status",
            headers={**headers, "X-Worker-ID": "owner"},
            json={
                "participation": "capturing",
                "streams": 2,
                "audio_samples": 240000,
                "active_audio_samples": 80000,
                "participant_sources": {
                    "available": True,
                    "total": 2,
                    "dom_participants": 0,
                    "sources": [],
                },
            },
        )
        assert empty_resp.status_code == 200
        assert datetime.fromisoformat(empty_resp.json()["deadline"]) == near_end

        # Browser worker (configured_speaker_slots is None) with omitted dom_participants
        # (e.g. DOM-only-name tiles after hangup) must also NOT extend on historical total >= 2.
        omitted_dom_resp = client.post(
            f"/v1/attempts/{identifier}/status",
            headers={**headers, "X-Worker-ID": "owner"},
            json={
                "participation": "capturing",
                "streams": 2,
                "audio_samples": 260000,
                "active_audio_samples": 80000,
                "participant_sources": {
                    "available": True,
                    "total": 2,
                    "sources": [],
                },
            },
        )
        assert omitted_dom_resp.status_code == 200
        assert datetime.fromisoformat(omitted_dom_resp.json()["deadline"]) == near_end

        # Push recording.ends_at to scheduled_end + 58 min; next tick caps at +60 min.
        with Session(database) as db:
            rec = db.get(Recording, uuid.UUID(recording_id))
            assert rec.protocol_meta["scheduled_ends_at"] == scheduled_end.isoformat()
            rec.ends_at = datetime.now(UTC) + timedelta(seconds=60)
            rec.protocol_meta = {
                **rec.protocol_meta,
                "scheduled_ends_at": (datetime.now(UTC) - timedelta(minutes=58)).isoformat(),
            }
            expected_hard_cap = datetime.fromisoformat(
                rec.protocol_meta["scheduled_ends_at"]
            ) + timedelta(seconds=3600)
            db.commit()

        capped_resp = client.post(
            f"/v1/attempts/{identifier}/status",
            headers={**headers, "X-Worker-ID": "owner"},
            json={
                "participation": "capturing",
                "streams": 2,
                "audio_samples": 320000,
                "active_audio_samples": 160000,
                "participant_sources": {
                    "available": True,
                    "total": 2,
                    "dom_participants": 2,
                    "sources": [],
                },
            },
        )
        assert capped_resp.status_code == 200
        with Session(database) as db:
            rec = db.get(Recording, uuid.UUID(recording_id))
            assert rec.ends_at == expected_hard_cap
            rec.protocol_meta = {**rec.protocol_meta, "summary_claim_until": now.isoformat()}
            db.commit()

        end_resp = client.post(
            f"/v1/attempts/{identifier}/status",
            headers={**headers, "X-Worker-ID": "owner"},
            json={"participation": "ended", "reason": "normal", "drained": True},
        )
        assert end_resp.status_code == 200
        rejoin_resp = client.post(f"/v1/recordings/{recording_id}/rejoin", headers=API)
        assert rejoin_resp.status_code == 200
        with Session(database) as db:
            rec = db.get(Recording, uuid.UUID(recording_id))
            assert "scheduled_ends_at" not in rec.protocol_meta
            assert "summary_claim_until" not in rec.protocol_meta
    finally:
        get_settings.cache_clear()
