"""Real DB/API ownership; controlled Kubernetes responses, not cluster proof."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from kubernetes.client.exceptions import ApiException
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_recordings import API, create, request_body

from wortlaut.controller import controller_pass
from wortlaut.models import Attempt, Recording
from wortlaut.settings import get_settings


@pytest.fixture
def cluster(monkeypatch):
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
        metadata=NS(uid=str(uuid.uuid4()), owner_references=[NS(kind="Job", uid=job.metadata.uid)]),
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


def test_missing_job_after_creation_intent_stays_unknown(client, database, cluster):
    recording = create(client)
    controller_pass(database, cluster.apis)
    with Session(database) as db:
        db.scalar(select(Attempt)).job_create_requested_at = datetime.now(UTC)
        db.commit()  # Crash after intent; result of the network operation is unavailable.
    controller_pass(database, cluster.apis)
    assert not cluster.jobs
    status = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert status["participation"] == "unknown"
    assert status["attempts"][0]["ended_at"] is None
