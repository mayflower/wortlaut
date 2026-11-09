"""Docker and local subprocess worker runtimes implementing the controller API contract."""

import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import urllib.parse
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace as NS

from kubernetes.client.exceptions import ApiException

from wortlaut.settings import get_settings

LABEL = "wortlaut/attempt-id"
POD_FINALIZER = "wortlaut/termination-observed"


class UnixHTTPConnection(http.client.HTTPConnection):
    """Standard-library HTTP connection over a Unix domain socket (/var/run/docker.sock)."""

    def __init__(self, socket_path: str, timeout: float = 10.0):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


class LocalSecretStore:
    """File-backed secret store for non-Kubernetes controller backends (mode 0600)."""

    def __init__(self, root: Path):
        self.root = root / "secrets"
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    def _path(self, name: str) -> Path:
        return self.root / f"{name}.json"

    def create_namespaced_secret(self, _namespace: str, body: dict, **_kwargs):
        name = body["metadata"]["name"]
        path = self._path(name)
        if path.exists():
            raise ApiException(status=409, reason="Conflict")
        payload = {
            "name": name,
            "uid": str(uuid.uuid4()),
            "labels": body["metadata"].get("labels") or {},
            "credential": (body.get("stringData") or {}).get("credential", ""),
        }
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        return self._to_secret(payload)

    def read_namespaced_secret(self, name: str, _namespace: str, **_kwargs):
        path = self._path(name)
        if not path.exists():
            raise ApiException(status=404, reason="Not Found")
        payload = json.loads(path.read_text(encoding="utf-8"))
        return self._to_secret(payload)

    def delete_namespaced_secret(self, name: str, _namespace: str, body=None, **_kwargs):
        path = self._path(name)
        if not path.exists():
            raise ApiException(status=404, reason="Not Found")
        payload = json.loads(path.read_text(encoding="utf-8"))
        expected_uid = getattr(getattr(body, "preconditions", None), "uid", None)
        if expected_uid and payload.get("uid") != expected_uid:
            raise ApiException(status=409, reason="Precondition failed")
        path.unlink(missing_ok=True)

    @staticmethod
    def _to_secret(payload: dict):
        return NS(
            metadata=NS(
                name=payload["name"],
                uid=payload["uid"],
                labels=payload.get("labels") or {},
            ),
            credential=payload.get("credential", ""),
        )


class LocalProcessRuntime(LocalSecretStore):
    """Spawns each worker attempt as an isolated local Node.js subprocess."""

    def __init__(self, root: Path | None = None, worker_dir: Path | None = None):
        settings = get_settings()
        base = root or settings.runtime_state_dir
        base.mkdir(parents=True, exist_ok=True)
        super().__init__(base)
        self.worker_dir = (worker_dir or settings.local_worker_dir).resolve()
        self.jobs: dict[str, dict] = {}
        self.procs: dict[str, subprocess.Popen] = {}

    def read_namespaced_job(self, name: str, _namespace: str, **_kwargs):
        entry = self.jobs.get(name)
        if not entry:
            raise ApiException(status=404, reason="Not Found")
        return self._to_job(entry)

    def create_namespaced_job(self, namespace: str, body: dict, **_kwargs):
        name = body["metadata"]["name"]
        if name in self.jobs:
            raise ApiException(status=409, reason="Conflict")
        secret = self.read_namespaced_secret(name, namespace)
        labels = dict(body["metadata"].get("labels") or {})
        attempt_id = labels.get(LABEL, "")
        settings = get_settings()
        profile_dir = Path(tempfile.mkdtemp(prefix=f"wortlaut-local-{attempt_id[:8]}-"))
        os.chmod(profile_dir, 0o700)
        env = {
            **os.environ,
            "HOME": str(profile_dir),
            "TMPDIR": str(profile_dir),
            "WORTLAUT_API_URL": settings.api_url,
            "WORTLAUT_ATTEMPT_ID": attempt_id,
            "WORTLAUT_BOOTSTRAP_CREDENTIAL": secret.credential,
        }
        entrypoint = self.worker_dir / "dist-worker/runtime/main.js"
        cmd = ["node", str(entrypoint)] if entrypoint.exists() else ["npm", "start"]
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(self.worker_dir) if self.worker_dir.exists() else None,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as error:
            shutil.rmtree(profile_dir, ignore_errors=True)
            raise ApiException(status=422, reason=str(error)) from error
        now = datetime.now(UTC)
        entry = {
            "name": name,
            "uid": str(uuid.uuid4()),
            "pod_uid": str(uuid.uuid4()),
            "labels": labels,
            "resource_version": "1",
            "active_deadline_seconds": body["spec"].get("activeDeadlineSeconds"),
            "start_time": now,
            "finished_at": None,
            "finalizers": [POD_FINALIZER],
            "profile_dir": profile_dir,
        }
        self.jobs[name] = entry
        self.procs[name] = proc
        return self._to_job(entry)

    def patch_namespaced_job(self, name: str, _namespace: str, body: dict, **_kwargs):
        entry = self.jobs.get(name)
        if not entry:
            raise ApiException(status=404, reason="Not Found")
        deadline = (body.get("spec") or {}).get("activeDeadlineSeconds")
        if deadline is not None:
            entry["active_deadline_seconds"] = deadline
        proc = self.procs.get(name)
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
        return self._to_job(entry)

    def list_namespaced_pod(self, _namespace: str, label_selector: str = "", **_kwargs):
        target_attempt = label_selector.split("=", 1)[1] if "=" in label_selector else None
        items = []
        for name, entry in list(self.jobs.items()):
            if target_attempt and entry["labels"].get(LABEL) != target_attempt:
                continue
            proc = self.procs.get(name)
            rc = proc.poll() if proc else 0
            if rc is not None and entry["finished_at"] is None:
                entry["finished_at"] = datetime.now(UTC)
            running = rc is None
            phase = "Running" if running else ("Succeeded" if rc == 0 else "Failed")
            items.append(
                NS(
                    metadata=NS(
                        name=f"{name}-pod",
                        uid=entry["pod_uid"],
                        resource_version=entry["resource_version"],
                        finalizers=list(entry["finalizers"]),
                        owner_references=[NS(kind="Job", uid=entry["uid"])],
                    ),
                    status=NS(
                        phase=phase,
                        container_statuses=[
                            NS(
                                state=NS(
                                    running=NS(started_at=entry["start_time"]) if running else None,
                                    terminated=(
                                        NS(finished_at=entry["finished_at"], exit_code=rc)
                                        if not running
                                        else None
                                    ),
                                )
                            )
                        ],
                    ),
                )
            )
        return NS(items=items)

    def patch_namespaced_pod(self, name: str, _namespace: str, body: list, **_kwargs):
        job_name = name[:-4] if name.endswith("-pod") else name
        entry = self.jobs.get(job_name)
        if not entry:
            raise ApiException(status=404, reason="Not Found")
        for op in body:
            if op.get("path") == "/metadata/finalizers":
                entry["finalizers"] = list(op.get("value") or [])
        if POD_FINALIZER not in entry["finalizers"]:
            shutil.rmtree(entry["profile_dir"], ignore_errors=True)
            self.procs.pop(job_name, None)
            self.jobs.pop(job_name, None)

    @staticmethod
    def _to_job(entry: dict):
        return NS(
            metadata=NS(
                name=entry["name"],
                uid=entry["uid"],
                labels=dict(entry["labels"]),
                resource_version=entry["resource_version"],
            ),
            spec=NS(active_deadline_seconds=entry["active_deadline_seconds"]),
            status=NS(start_time=entry["start_time"]),
        )


class DockerRuntime(LocalSecretStore):
    """Spawns each worker attempt as a short-lived container via the Docker Engine socket."""

    def __init__(self, root: Path | None = None, socket_path: str = "/var/run/docker.sock"):
        settings = get_settings()
        base = root or settings.runtime_state_dir
        base.mkdir(parents=True, exist_ok=True)
        super().__init__(base)
        self.socket_path = socket_path
        self.jobs: dict[str, dict] = {}

    def _docker_request(
        self, method: str, path: str, payload: dict | None = None
    ) -> tuple[int, str]:
        conn = UnixHTTPConnection(self.socket_path, timeout=10.0)
        try:
            headers = {"Content-Type": "application/json"} if payload is not None else {}
            body = json.dumps(payload).encode("utf-8") if payload is not None else None
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read().decode("utf-8", errors="replace")
            return resp.status, data
        finally:
            conn.close()

    def read_namespaced_job(self, name: str, _namespace: str, **_kwargs):
        entry = self.jobs.get(name)
        if not entry:
            raise ApiException(status=404, reason="Not Found")
        return LocalProcessRuntime._to_job(entry)

    def create_namespaced_job(self, namespace: str, body: dict, **_kwargs):
        name = body["metadata"]["name"]
        if name in self.jobs:
            raise ApiException(status=409, reason="Conflict")
        secret = self.read_namespaced_secret(name, namespace)
        labels = dict(body["metadata"].get("labels") or {})
        attempt_id = labels.get(LABEL, "")
        settings = get_settings()
        create_payload = {
            "Image": settings.worker_image,
            "User": "1000:1000",
            "Labels": labels,
            "Env": [
                f"WORTLAUT_API_URL={settings.api_url}",
                f"WORTLAUT_ATTEMPT_ID={attempt_id}",
                f"WORTLAUT_BOOTSTRAP_CREDENTIAL={secret.credential}",
            ],
            "HostConfig": {
                "ShmSize": 256 * 1024 * 1024,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges"],
                "NetworkMode": settings.docker_network or "bridge",
            },
        }
        query = urllib.parse.urlencode({"name": name})
        status, raw = self._docker_request("POST", f"/containers/create?{query}", create_payload)
        if status == 409:
            raise ApiException(status=409, reason="Conflict")
        if status not in (200, 201):
            raise ApiException(status=422, reason=raw or f"Docker create failed ({status})")
        container_id = json.loads(raw).get("Id", str(uuid.uuid4()))
        start_status, start_raw = self._docker_request("POST", f"/containers/{name}/start")
        if start_status not in (204, 304):
            self._docker_request("DELETE", f"/containers/{name}?force=1")
            reason = start_raw or f"Docker start failed ({start_status})"
            raise ApiException(status=422, reason=reason)
        now = datetime.now(UTC)
        entry = {
            "name": name,
            "uid": container_id[:36],
            "pod_uid": str(uuid.uuid4()),
            "labels": labels,
            "resource_version": "1",
            "active_deadline_seconds": body["spec"].get("activeDeadlineSeconds"),
            "start_time": now,
            "finished_at": None,
            "finalizers": [POD_FINALIZER],
        }
        self.jobs[name] = entry
        return LocalProcessRuntime._to_job(entry)

    def patch_namespaced_job(self, name: str, _namespace: str, body: dict, **_kwargs):
        entry = self.jobs.get(name)
        if not entry:
            raise ApiException(status=404, reason="Not Found")
        deadline = (body.get("spec") or {}).get("activeDeadlineSeconds")
        if deadline is not None:
            entry["active_deadline_seconds"] = deadline
        self._docker_request("POST", f"/containers/{name}/stop?t=15")
        return LocalProcessRuntime._to_job(entry)

    def list_namespaced_pod(self, _namespace: str, label_selector: str = "", **_kwargs):
        target_attempt = label_selector.split("=", 1)[1] if "=" in label_selector else None
        items = []
        for name, entry in list(self.jobs.items()):
            if target_attempt and entry["labels"].get(LABEL) != target_attempt:
                continue
            status, raw = self._docker_request("GET", f"/containers/{name}/json")
            running = False
            exit_code = 1
            if status == 200 and raw:
                state = json.loads(raw).get("State") or {}
                running = bool(state.get("Running"))
                exit_code = int(state.get("ExitCode", 0))
            if not running and entry["finished_at"] is None:
                entry["finished_at"] = datetime.now(UTC)
            phase = "Running" if running else ("Succeeded" if exit_code == 0 else "Failed")
            items.append(
                NS(
                    metadata=NS(
                        name=f"{name}-pod",
                        uid=entry["pod_uid"],
                        resource_version=entry["resource_version"],
                        finalizers=list(entry["finalizers"]),
                        owner_references=[NS(kind="Job", uid=entry["uid"])],
                    ),
                    status=NS(
                        phase=phase,
                        container_statuses=[
                            NS(
                                state=NS(
                                    running=NS(started_at=entry["start_time"]) if running else None,
                                    terminated=(
                                        NS(finished_at=entry["finished_at"], exit_code=exit_code)
                                        if not running
                                        else None
                                    ),
                                )
                            )
                        ],
                    ),
                )
            )
        return NS(items=items)

    def patch_namespaced_pod(self, name: str, _namespace: str, body: list, **_kwargs):
        job_name = name[:-4] if name.endswith("-pod") else name
        entry = self.jobs.get(job_name)
        if not entry:
            raise ApiException(status=404, reason="Not Found")
        for op in body:
            if op.get("path") == "/metadata/finalizers":
                entry["finalizers"] = list(op.get("value") or [])
        if POD_FINALIZER not in entry["finalizers"]:
            self._docker_request("DELETE", f"/containers/{job_name}?force=1")
            self.jobs.pop(job_name, None)
