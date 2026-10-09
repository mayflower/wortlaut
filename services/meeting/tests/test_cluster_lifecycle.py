"""Opt-in real Job lifecycle. Explicit HTTP fixture, never a Webex acceptance test."""

import getpass
import os
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from kubernetes import client, config
from kubernetes.client.exceptions import ApiException
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from wortlaut.controller import LABEL, POD_FINALIZER, job_body
from wortlaut.models import Attempt, Recording
from wortlaut.settings import get_settings


@pytest.mark.skipif(
    os.getenv("WORTLAUT_TEST_CLUSTER") != "true", reason="Requires explicit live cluster test"
)
def test_real_job_claim_cancel_exit_and_secret_cleanup(monkeypatch):
    root = Path(__file__).resolve().parents[3]
    values = dict(
        line.split("=", 1) for line in (root / ".dev/runtime.env").read_text().splitlines()
    )
    namespace = "wortlaut-" + getpass.getuser()
    origin = f"https://{namespace}.data.mayflower.zone/"
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("WORTLAUT_API_URL", origin)
    monkeypatch.setenv("WORTLAUT_NAMESPACE", namespace)
    configuration = client.Configuration()
    config.load_kube_config(
        str(root / ".dev/kubeconfig"), context="data", client_configuration=configuration
    )
    configuration.retries = 0
    kubernetes = client.ApiClient(configuration)
    batch, core, apps = (
        client.BatchV1Api(kubernetes),
        client.CoreV1Api(kubernetes),
        client.AppsV1Api(kubernetes),
    )
    deployment = apps.read_namespaced_deployment("wortlaut-meeting", namespace)
    worker_image = next(
        e.value
        for e in deployment.spec.template.spec.containers[0].env
        if e.name == "WORTLAUT_WORKER_IMAGE"
    )
    monkeypatch.setenv("WORTLAUT_WORKER_IMAGE", worker_image)
    get_settings.cache_clear()
    url = make_url(values["WORTLAUT_DATABASE_URL"]).set(host="127.0.0.1", port=34632)
    engine = create_engine(url)
    headers = {"Authorization": "Bearer " + values["WORTLAUT_API_TOKEN"]}
    recording_id = None
    try:
        with httpx.Client(base_url=origin, headers=headers, timeout=15) as api:
            now = datetime.now(UTC)
            response = api.post(
                "v1/recordings",
                headers={"Idempotency-Key": "lifecycle-fixture-" + uuid.uuid4().hex},
                json={
                    "meeting_url": "https://example.webex.com/meet/lifecycle-fixture",
                    "starts_at": (now + timedelta(minutes=20)).isoformat(),
                    "ends_at": (now + timedelta(minutes=25)).isoformat(),
                },
            )
            response.raise_for_status()
            recording_id = response.json()["id"]
            response = api.post(f"v1/recordings/{recording_id}/attempts")
            response.raise_for_status()
            prepared = response.json()
            identifier = uuid.UUID(prepared["attempt_id"])
            name = "wortlaut-worker-" + identifier.hex
            core.create_namespaced_secret(
                namespace,
                {
                    "apiVersion": "v1",
                    "kind": "Secret",
                    "type": "Opaque",
                    "metadata": {"name": name, "labels": {LABEL: str(identifier)}},
                    "stringData": {"credential": prepared["bootstrap_credential"]},
                },
            )
            with Session(engine) as db:
                attempt = db.get(Attempt, identifier)
                recording = db.get(Recording, attempt.recording_id)
                attempt.job_name = name
                body = job_body(recording, attempt)
                body["spec"]["template"]["spec"]["containers"][0]["command"] = [
                    "node",
                    "test/lifecycle-worker.mjs",
                ]
                body["spec"]["activeDeadlineSeconds"] = 300
                body["spec"]["ttlSecondsAfterFinished"] = 600
                job = batch.create_namespaced_job(namespace, body)
                attempt.job_uid = job.metadata.uid
                attempt.job_create_requested_at = datetime.now(UTC)
                db.commit()
            cutoff = time.monotonic() + 90
            while time.monotonic() < cutoff:
                status = api.get(f"v1/recordings/{recording_id}").json()
                if status["participation"] == "joining" and status["attempts"][0]["pod_uids"]:
                    break
                time.sleep(1)
            else:
                raise AssertionError("Real fixture did not claim before its startup timeout")
            if os.getenv("WORTLAUT_TEST_RESTART_CONTROLLER") == "true":
                old_uid = job.metadata.uid
                old_owner = status["attempts"][0]["id"]
                old_pods = {
                    p.metadata.uid
                    for p in core.list_namespaced_pod(
                        namespace,
                        label_selector="app=wortlaut-meeting",
                    ).items
                }
                apps.patch_namespaced_deployment(
                    "wortlaut-meeting",
                    namespace,
                    {
                        "spec": {
                            "template": {
                                "metadata": {
                                    "annotations": {
                                        "wortlaut/lifecycle-restart": uuid.uuid4().hex,
                                    }
                                }
                            }
                        },
                    },
                )
                cutoff = time.monotonic() + 100
                restarted = False
                while time.monotonic() < cutoff:
                    pods = core.list_namespaced_pod(
                        namespace, label_selector="app=wortlaut-meeting"
                    ).items
                    if any(
                        p.metadata.uid not in old_pods
                        and any(
                            c.type == "Ready" and c.status == "True"
                            for c in (p.status.conditions or [])
                        )
                        for p in pods
                    ):
                        restarted = True
                        break
                    time.sleep(1)
                assert restarted, "Replacement controller did not become ready"
                # The HTTP fixture uses the same reconnect code as production.
                # Its process and Job must survive the controller replacement.
                response = api.get(f"v1/recordings/{recording_id}")
                response.raise_for_status()
                status = response.json()
                assert status["attempts"][0]["id"] == old_owner
                assert status["attempts"][0]["job_uid"] == old_uid
                assert status["attempts"][0]["process_ended_at"] is None
                assert (
                    len(
                        batch.list_namespaced_job(
                            namespace, label_selector=f"{LABEL}={identifier}"
                        ).items
                    )
                    == 1
                )
            response = api.post(f"v1/recordings/{recording_id}/cancel")
            response.raise_for_status()
            cutoff = time.monotonic() + 70
            while time.monotonic() < cutoff:
                status = api.get(f"v1/recordings/{recording_id}").json()
                if status["attempts"][0]["process_ended_at"]:
                    break
                time.sleep(1)
            else:
                raise AssertionError("Container termination was not reconciled")
            assert status["participation"] == "ended"
            assert status["attempts"][0]["end_reason"] == "cancelled"
            assert status["attempts"][0]["job_uid"] == job.metadata.uid
            cancelled_job = batch.read_namespaced_job(name, namespace)
            assert any(
                condition.reason == "DeadlineExceeded" and condition.status == "True"
                for condition in (cancelled_job.status.conditions or [])
            ), "The fixture exited without exercising Kubernetes deadline termination"
            assert api.post(f"v1/recordings/{recording_id}/attempts").status_code == 409
            # A lost cleanup ACK can require one more controller pass.
            for _ in range(10):
                try:
                    core.read_namespaced_secret(name, namespace)
                except ApiException as error:
                    assert error.status == 404
                    break
                time.sleep(1)
            else:
                raise AssertionError("Ended worker Secret was not removed")
            assert all(
                POD_FINALIZER not in (pod.metadata.finalizers or [])
                for pod in core.list_namespaced_pod(
                    namespace, label_selector=f"{LABEL}={identifier}"
                ).items
            ), "Reconciled Pods still retain wortlaut's termination finalizer"
    finally:
        if recording_id:
            with httpx.Client(base_url=origin, headers=headers, timeout=15) as api:
                api.post(f"v1/recordings/{recording_id}/cancel")
        engine.dispose()
        kubernetes.close()
        get_settings.cache_clear()
