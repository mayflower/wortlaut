"""Namespaced Jobs; database ownership survives a controller restart."""

import hashlib
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache

from kubernetes import client, config
from kubernetes.client.exceptions import ApiException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from wortlaut.ingest import capacity_reached
from wortlaut.models import Attempt, Recording
from wortlaut.settings import get_settings

TIMEOUT = (5, 10)
LABEL = "wortlaut/attempt-id"
POD_FINALIZER = "wortlaut/termination-observed"
SCHEDULER_LOCK = 749836124


@lru_cache
def kubernetes_api():
    configuration = client.Configuration()
    config.load_incluster_config(client_configuration=configuration)
    configuration.retries = 0
    api = client.ApiClient(configuration)
    return client.BatchV1Api(api), client.CoreV1Api(api)


def new_attempt(db, recording, now):
    token = secrets.token_urlsafe(32)
    expires = recording.ends_at + timedelta(minutes=2)
    if get_settings().bootstrap_lifetime_seconds:
        expires = min(expires, now + timedelta(seconds=get_settings().bootstrap_lifetime_seconds))
    attempt = Attempt(
        id=uuid.uuid4(),
        recording_id=recording.id,
        credential_hash=hashlib.sha256(token.encode()).hexdigest(),
        credential_expires_at=expires,
    )
    db.add(attempt)
    db.flush()
    recording.active_attempt_id = attempt.id
    recording.participation = "preparing"
    recording.participation_reason = None
    return attempt, token


def request_cancellation(recording, now):
    if recording.participation != "ended":
        recording.cancelled_at = recording.cancelled_at or now
        recording.participation_reason = "cancel_requested"
        if recording.active_attempt_id is None:
            recording.participation = "ended"
            recording.participation_reason = "cancelled"
            recording.audio_closed_at = now


def job_body(recording, attempt):
    settings = get_settings()
    seccomp = {"type": settings.worker_seccomp_type}
    if settings.worker_seccomp_type == "Localhost":
        if not settings.worker_seccomp_profile:
            raise ValueError("Localhost seccomp requires a profile already present on worker nodes")
        seccomp["localhostProfile"] = settings.worker_seccomp_profile
    labels = {"app": "wortlaut-worker", LABEL: str(attempt.id)}
    mounts = [{"name": "shm", "mountPath": "/dev/shm"}]
    volumes = [{"name": "shm", "emptyDir": {"medium": "Memory", "sizeLimit": "256Mi"}}]
    if recording.provider == "google_meet" and settings.meet_storage_state_secret:
        mounts.append({"name": "meet-browser", "mountPath": "/run/meet", "readOnly": True})
        volumes.append(
            {
                "name": "meet-browser",
                "secret": {
                    "secretName": settings.meet_storage_state_secret,
                    "defaultMode": 0o440,
                    "items": [{"key": "storage-state.json", "path": "storage-state.json"}],
                },
            }
        )
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": attempt.job_name, "labels": labels},
        "spec": {
            "parallelism": 1,
            "completions": 1,
            "backoffLimit": 0,
            "activeDeadlineSeconds": max(
                1, int((attempt.credential_expires_at - datetime.now(UTC)).total_seconds())
            ),
            # Retain evidence during reconciliation; worker Secrets are removed
            # only after observed termination, independently of this TTL.
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": {"labels": labels, "finalizers": [POD_FINALIZER]},
                "spec": {
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": False,
                    "terminationGracePeriodSeconds": 45,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 1000,
                        "runAsGroup": 1000,
                        "fsGroup": 1000,
                        "seccompProfile": seccomp,
                    },
                    "containers": [
                        {
                            "name": "worker",
                            "image": settings.worker_image,
                            "env": [
                                {"name": "WORTLAUT_API_URL", "value": settings.api_url},
                                {"name": "WORTLAUT_ATTEMPT_ID", "value": str(attempt.id)},
                                {
                                    "name": "WORTLAUT_BOOTSTRAP_CREDENTIAL",
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": attempt.job_name,
                                            "key": "credential",
                                        }
                                    },
                                },
                            ],
                            "resources": {
                                "requests": {
                                    "cpu": settings.worker_cpu_request,
                                    "memory": settings.worker_memory_request,
                                },
                                "limits": {
                                    "cpu": settings.worker_cpu_limit,
                                    "memory": settings.worker_memory_limit,
                                },
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "volumeMounts": mounts,
                        }
                    ],
                    "volumes": volumes,
                },
            },
        },
    }


def read_job(batch, name, namespace):
    try:
        return batch.read_namespaced_job(name, namespace, _request_timeout=TIMEOUT)
    except ApiException as error:
        if error.status == 404:
            return None
        raise


def forget_secret(core, attempt, namespace):
    try:
        secret = core.read_namespaced_secret(attempt.job_name, namespace, _request_timeout=TIMEOUT)
        if (secret.metadata.labels or {}).get(LABEL) != str(attempt.id):
            raise ValueError("Worker Secret ownership differs")
        core.delete_namespaced_secret(
            attempt.job_name,
            namespace,
            body=client.V1DeleteOptions(
                preconditions=client.V1Preconditions(uid=secret.metadata.uid)
            ),
            _request_timeout=TIMEOUT,
        )
    except ApiException as error:
        if error.status != 404:
            raise


def release_pod_evidence(core, attempt, namespace):
    pods = core.list_namespaced_pod(
        namespace, label_selector=f"{LABEL}={attempt.id}", _request_timeout=TIMEOUT
    ).items
    for pod in pods:
        if not any(
            ref.kind == "Job" and ref.uid == attempt.job_uid
            for ref in (pod.metadata.owner_references or [])
        ):
            continue
        finalizers = pod.metadata.finalizers or []
        if POD_FINALIZER not in finalizers:
            continue
        try:
            core.patch_namespaced_pod(
                pod.metadata.name,
                namespace,
                [
                    {"op": "test", "path": "/metadata/uid", "value": pod.metadata.uid},
                    {
                        "op": "test",
                        "path": "/metadata/resourceVersion",
                        "value": pod.metadata.resource_version,
                    },
                    {
                        "op": "replace",
                        "path": "/metadata/finalizers",
                        "value": [f for f in finalizers if f != POD_FINALIZER],
                    },
                ],
                _request_timeout=TIMEOUT,
            )
        except ApiException as error:
            if error.status != 404:
                raise


def reconcile_attempt(db, recording, attempt, batch, core, now):
    namespace = get_settings().namespace
    if attempt.process_ended_at is not None:
        release_pod_evidence(core, attempt, namespace)
        forget_secret(core, attempt, namespace)
        attempt.secret_deleted_at = now
        return
    job = read_job(batch, attempt.job_name, namespace)
    if job is not None:
        if (job.metadata.labels or {}).get(LABEL) != str(attempt.id) or (
            attempt.job_uid and job.metadata.uid != attempt.job_uid
        ):
            recording.participation, recording.participation_reason = (
                "unknown",
                "job_identity_changed",
            )
            return
        attempt.job_uid = job.metadata.uid
    elif attempt.job_uid or attempt.worker_id or attempt.pod_uids:
        # A deleted/force-deleted object is not evidence that its process ended.
        recording.participation, recording.participation_reason = "unknown", "job_missing"
        return
    elif recording.cancelled_at or recording.audio_closed_at or recording.ends_at <= now:
        # No Job has ever been observed. Never create it after an atomic cancellation.
        # Inspect Pods too: a lost Create response may have preceded Job deletion.
        pods = core.list_namespaced_pod(
            namespace, label_selector=f"{LABEL}={attempt.id}", _request_timeout=TIMEOUT
        ).items
        if not pods and not attempt.worker_id:
            attempt.ended_at = attempt.process_ended_at = now
            attempt.end_reason = "cancelled" if recording.cancelled_at else "deadline"
            recording.participation = "ended"
            recording.participation_reason = attempt.end_reason
            db.commit()
            forget_secret(core, attempt, namespace)
            attempt.secret_deleted_at = now
        else:
            recording.participation, recording.participation_reason = "unknown", "job_missing"
        return
    else:
        # An intent without observed identity or claim is retryable with the
        # same Job/attempt/credential. A Pod from a lost Create still fences it.
        if attempt.job_create_requested_at:
            pods = core.list_namespaced_pod(
                namespace, label_selector=f"{LABEL}={attempt.id}", _request_timeout=TIMEOUT
            ).items
            if pods:
                recording.participation, recording.participation_reason = "unknown", "job_missing"
                return
        # A persisted attempt precedes Secret creation. Recover a lost Secret
        # response, but never launch a Job with a missing bootstrap credential.
        try:
            secret = core.read_namespaced_secret(
                attempt.job_name, namespace, _request_timeout=TIMEOUT
            )
        except ApiException as error:
            if error.status != 404:
                raise
            pods = core.list_namespaced_pod(
                namespace, label_selector=f"{LABEL}={attempt.id}", _request_timeout=TIMEOUT
            ).items
            if not attempt.job_create_requested_at and not pods:
                attempt.ended_at = attempt.process_ended_at = now
                attempt.end_reason = "bootstrap_secret_missing"
                recording.participation, recording.participation_reason = (
                    "ended",
                    attempt.end_reason,
                )
                db.commit()
                forget_secret(core, attempt, namespace)
                attempt.secret_deleted_at = now
            else:
                recording.participation, recording.participation_reason = (
                    "unknown",
                    "bootstrap_secret_missing",
                )
            return
        if (secret.metadata.labels or {}).get(LABEL) != str(attempt.id):
            recording.participation, recording.participation_reason = (
                "unknown",
                "bootstrap_secret_identity_changed",
            )
            return
        # Record intent before the network call. If its result is lost and the
        # Job later disappears, even a restart cannot mistake that for no start.
        attempt.job_create_requested_at = attempt.job_create_requested_at or now
        db.commit()
        recording = db.scalar(
            select(Recording).where(Recording.id == attempt.recording_id).with_for_update()
        )
        db.refresh(attempt)
        if recording.cancelled_at or recording.audio_closed_at or recording.ends_at <= now:
            if attempt.worker_id:
                recording.participation, recording.participation_reason = "unknown", "job_missing"
                return
            attempt.ended_at = attempt.process_ended_at = now
            attempt.end_reason = "cancelled" if recording.cancelled_at else "deadline"
            recording.participation, recording.participation_reason = "ended", attempt.end_reason
            db.commit()
            forget_secret(core, attempt, namespace)
            attempt.secret_deleted_at = now
            return
        # A Create conflict means adopting this same named Job, never a new name.
        try:
            job = batch.create_namespaced_job(
                namespace, job_body(recording, attempt), _request_timeout=TIMEOUT
            )
        except ApiException as error:
            if error.status in (400, 401, 403, 422):
                # An authoritative rejection did not create a process. Preserve
                # the attempt tombstone, prohibit claims and release its Secret.
                attempt.ended_at = attempt.process_ended_at = now
                attempt.end_reason = "job_create_rejected"
                recording.participation = "ended"
                recording.participation_reason = attempt.end_reason
                db.commit()
                forget_secret(core, attempt, namespace)
                attempt.secret_deleted_at = now
                return
            if error.status != 409:
                raise
            job = read_job(batch, attempt.job_name, namespace)
        if job is None or (job.metadata.labels or {}).get(LABEL) != str(attempt.id):
            recording.participation, recording.participation_reason = (
                "unknown",
                "job_identity_changed",
            )
            return
        attempt.job_uid = job.metadata.uid
        if attempt.worker_id is None:
            recording.participation, recording.participation_reason = "preparing", None
    pods = core.list_namespaced_pod(
        namespace, label_selector=f"{LABEL}={attempt.id}", _request_timeout=TIMEOUT
    ).items
    owned = [
        p
        for p in pods
        if any(
            ref.kind == "Job" and ref.uid == attempt.job_uid
            for ref in (p.metadata.owner_references or [])
        )
    ]
    previous = set(attempt.pod_uids)
    current = {p.metadata.uid for p in owned}
    attempt.pod_uids = sorted(previous | current)
    terminated = (
        bool(owned)
        and not (previous - current)
        and all(
            p.status.phase in ("Succeeded", "Failed")
            and p.status.container_statuses
            and all(
                s.state.terminated and s.state.terminated.finished_at
                for s in p.status.container_statuses
            )
            for p in owned
        )
    )
    if terminated:
        attempt.process_ended_at = now
        if attempt.ended_at is None:
            attempt.ended_at = now
            attempt.end_reason = "cancelled" if recording.cancelled_at else "failed"
        recording.participation = "ended"
        recording.participation_reason = attempt.end_reason
        db.commit()  # Persist termination before removing credentials.
        release_pod_evidence(core, attempt, namespace)
        forget_secret(core, attempt, namespace)
        attempt.secret_deleted_at = now
        return
    if recording.cancelled_at or recording.audio_closed_at or recording.ends_at <= now:
        # The deadline sends SIGTERM and deletes Pods. Our finalizer retains
        # their exit status until termination is durably recorded above.
        elapsed = int((now - job.status.start_time).total_seconds()) if job.status.start_time else 0
        deadline = max(1, elapsed)
        if not job.spec.active_deadline_seconds or job.spec.active_deadline_seconds > deadline:
            batch.patch_namespaced_job(
                attempt.job_name,
                namespace,
                {
                    "metadata": {"resourceVersion": job.metadata.resource_version},
                    "spec": {"activeDeadlineSeconds": deadline},
                },
                _request_timeout=TIMEOUT,
            )
    if previous - current:
        recording.participation, recording.participation_reason = "unknown", "pod_missing"
    elif (
        attempt.last_heartbeat_at
        and (now - attempt.last_heartbeat_at).total_seconds()
        > get_settings().heartbeat_timeout_seconds
    ):
        recording.participation, recording.participation_reason = "unknown", "heartbeat_missing"
    elif attempt.last_heartbeat_at is None and any(
        status.state.running
        and status.state.running.started_at
        and (now - status.state.running.started_at).total_seconds()
        > get_settings().heartbeat_timeout_seconds
        for p in owned
        for status in (p.status.container_statuses or [])
    ):
        recording.participation, recording.participation_reason = "unknown", "heartbeat_missing"


def controller_pass(engine, apis=None):
    settings = get_settings()
    batch, core = apis or kubernetes_api()
    now = datetime.now(UTC)
    with Session(engine) as db:
        identifiers = db.scalars(
            select(Attempt.id).where(
                Attempt.job_name.is_not(None), Attempt.secret_deleted_at.is_(None)
            )
        ).all()
    for identifier in identifiers:
        with Session(engine) as db:
            attempt = db.get(Attempt, identifier)
            recording = db.scalar(
                select(Recording)
                .where(Recording.id == attempt.recording_id)
                .with_for_update(skip_locked=True)
            )
            if recording is None:
                continue
            try:
                reconcile_attempt(db, recording, attempt, batch, core, now)
                db.commit()
            except Exception as error:
                db.rollback()
                recording = db.scalar(
                    select(Recording)
                    .where(Recording.id == attempt.recording_id)
                    .with_for_update(skip_locked=True)
                )
                if recording is not None and recording.participation != "ended":
                    recording.participation = "unknown"
                    recording.participation_reason = "kubernetes_unavailable"
                    db.commit()
                logging.getLogger("wortlaut").error(
                    "job_reconcile_failed attempt=%s type=%s", identifier, type(error).__name__
                )
    with Session(engine) as db:
        if not db.scalar(select(func.pg_try_advisory_xact_lock(SCHEDULER_LOCK))):
            return
        due = (
            Recording.participation == "scheduled",
            Recording.active_attempt_id.is_(None),
            Recording.calendar_conflict.is_(False),
            Recording.starts_at <= now + timedelta(seconds=settings.join_lead_seconds),
        )
        expired = (
            Recording.cancelled_at.is_not(None)
            | (Recording.ends_at <= now)
            | (Recording.starts_at < now - timedelta(seconds=settings.late_start_tolerance_seconds))
        )
        enabled = []
        for provider, configured in (
            ("webex", settings.enable_webex_browser or bool(settings.webex_service_token)),
            ("google_meet", settings.enable_google_meet),
        ):
            if configured:
                enabled.append(provider)
            else:
                reason = f"{provider}_not_configured"
                db.execute(
                    update(Recording)
                    .where(
                        *due,
                        Recording.provider == provider,
                        ~expired,
                        Recording.participation_reason.is_distinct_from(reason),
                    )
                    .values(participation_reason=reason)
                )
        candidates = db.scalars(
            select(Recording.id)
            # Unconfigured providers must not consume the bounded start page.
            # Their expired/cancelled meetings still receive a terminal state.
            .where(*due, Recording.provider.in_(enabled) | expired)
            .order_by(Recording.starts_at)
            .limit(16)
        ).all()
        db.commit()
    for identifier in candidates:
        with Session(engine) as db:
            if not db.scalar(select(func.pg_try_advisory_xact_lock(SCHEDULER_LOCK))):
                return
            recording = db.scalar(
                select(Recording)
                .where(Recording.id == identifier, *due)
                .with_for_update(skip_locked=True)
            )
            if recording is None:
                continue
            if (
                recording.cancelled_at
                or recording.ends_at <= now
                or recording.starts_at
                < (now - timedelta(seconds=settings.late_start_tolerance_seconds))
            ):
                recording.participation = "ended"
                recording.participation_reason = "cancelled" if recording.cancelled_at else "missed"
                recording.audio_closed_at = now
                db.commit()
                continue
            active = db.scalar(
                select(func.count())
                .select_from(Recording)
                .where(Recording.active_attempt_id.is_not(None), Recording.participation != "ended")
            )
            if active >= settings.max_active_meetings:
                recording.participation_reason = "worker_capacity_limit"
                db.commit()
                continue
            if capacity_reached(db):
                recording.participation_reason = "audio_capacity_limit"
                db.commit()
                continue
            if (recording.provider == "webex" and not settings.enable_webex_browser
                    and not settings.webex_service_token):
                recording.participation_reason = "webex_not_configured"
                db.commit()
                continue
            if recording.provider == "google_meet" and not settings.enable_google_meet:
                recording.participation_reason = "google_meet_not_configured"
                db.commit()
                continue
            attempt, token = new_attempt(db, recording, now)
            attempt.job_name = "wortlaut-worker-" + attempt.id.hex
            # Commit ownership before the network operation; otherwise a lost
            # response/crash leaves an orphan Secret and rolls back other starts.
            db.commit()
            recording = db.scalar(
                select(Recording).where(Recording.id == identifier).with_for_update()
            )
            db.refresh(attempt)
            if attempt.ended_at or recording.cancelled_at or recording.audio_closed_at:
                continue
            try:
                core.create_namespaced_secret(
                    settings.namespace,
                    {
                        "apiVersion": "v1",
                        "kind": "Secret",
                        "type": "Opaque",
                        "metadata": {
                            "name": attempt.job_name,
                            "labels": {"app": "wortlaut-worker", LABEL: str(attempt.id)},
                        },
                        "stringData": {"credential": token},
                    },
                    _request_timeout=TIMEOUT,
                )
            except Exception as error:
                recording.participation_reason = "bootstrap_secret_create_failed"
                logging.getLogger("wortlaut").error(
                    "bootstrap_secret_create_failed attempt=%s type=%s status=%s",
                    attempt.id,
                    type(error).__name__,
                    error.status if isinstance(error, ApiException) else "unavailable",
                )
            db.commit()
