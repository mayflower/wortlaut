#!/usr/bin/env python3
"""Initialize persistent developer Kubernetes Secrets without writing cleartext passwords."""

import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        values[key.strip()] = val.strip().strip("'\"")
    return values


def ensure_secret(base: list[str], name: str, data: dict[str, str]) -> None:
    existing = subprocess.run(
        [*base, "get", "secret", name, "--ignore-not-found", "-o", "name"],
        check=True,
        capture_output=True,
        text=True,
    )
    if existing.stdout.strip():
        return
    manifest = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": name},
        "type": "Opaque",
        "stringData": data,
    }
    subprocess.run([*base, "apply", "-f", "-"], input=json.dumps(manifest).encode(), check=True)


namespace = os.environ["WORTLAUT_NAMESPACE"]
kube_context = os.environ.get("WORTLAUT_KUBE_CONTEXT", "").strip()
if not kube_context:
    kube_context = subprocess.run(
        ["kubectl", "config", "current-context"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

base = ["kubectl", "--context", kube_context, "--namespace", namespace, "--request-timeout=10s"]

# Persistent core secrets: honor optional user-provided .dev/*.env files, otherwise generate
# directly into Kubernetes Secrets (never writing cleartext passwords to disk).
runtime_vals = parse_env_file(Path(".dev/runtime.env"))
pg_password = runtime_vals.get("POSTGRES_PASSWORD") or secrets.token_urlsafe(32)
db_url = runtime_vals.get("WORTLAUT_DATABASE_URL", "")
if "@postgres:" in db_url:
    db_url = db_url.replace("@postgres:", "@wortlaut-postgres:", 1)
if not db_url:
    db_url = f"postgresql+psycopg://wortlaut:{pg_password}@wortlaut-postgres:5432/wortlaut"
ensure_secret(
    base,
    "wortlaut-bundled-postgres",
    {"POSTGRES_USER": "wortlaut", "POSTGRES_DB": "wortlaut", "POSTGRES_PASSWORD": pg_password},
)
ensure_secret(
    base,
    "wortlaut-runtime",
    {
        "WORTLAUT_DATABASE_URL": db_url,
        "WORTLAUT_API_TOKEN": runtime_vals.get("WORTLAUT_API_TOKEN") or secrets.token_urlsafe(32),
        "WORTLAUT_ENCRYPTION_KEY": runtime_vals.get("WORTLAUT_ENCRYPTION_KEY")
        or secrets.token_urlsafe(32),
    },
)

asr_vals = parse_env_file(Path(".dev/asr.env"))
ensure_secret(
    base,
    "wortlaut-asr",
    {
        "WORTLAUT_ASR_URL": asr_vals.get("WORTLAUT_ASR_URL") or "http://wortlaut-asr:8000",
        "WORTLAUT_ASR_TOKEN": asr_vals.get("WORTLAUT_ASR_TOKEN") or secrets.token_urlsafe(32),
    },
)

storage_vals = parse_env_file(Path(".dev/storage.env"))
ensure_secret(
    base,
    "wortlaut-storage",
    {
        "WORTLAUT_S3_ENDPOINT": storage_vals.get("WORTLAUT_S3_ENDPOINT")
        or "http://wortlaut-rustfs:9000",
        "WORTLAUT_S3_ACCESS_KEY": storage_vals.get("WORTLAUT_S3_ACCESS_KEY") or "wortlaut-dev",
        "WORTLAUT_S3_SECRET_KEY": storage_vals.get("WORTLAUT_S3_SECRET_KEY")
        or secrets.token_urlsafe(32),
    },
)

# Optional provider & mail secrets (always synced from ignored .dev/*.env when present).
for supplied_file, secret_name in (
    (Path(".dev/webex.env"), "wortlaut-webex"),
    (Path(".dev/mail.env"), "wortlaut-mail"),
    (Path(".dev/meet.env"), "wortlaut-meet"),
    (Path(".dev/teams.env"), "wortlaut-teams"),
    (Path(".dev/zoom.env"), "wortlaut-zoom"),
):
    if not supplied_file.exists():
        continue
    file_digest = hashlib.sha256(supplied_file.read_bytes()).hexdigest()
    if secret_name == "wortlaut-webex":
        existing_webex = subprocess.run(
            [*base, "get", "secret", secret_name, "--ignore-not-found", "-o", "json"],
            check=True,
            capture_output=True,
            text=True,
        )
        if (
            existing_webex.stdout.strip()
            and (
                json.loads(existing_webex.stdout).get("metadata", {}).get("annotations") or {}
            ).get("wortlaut/credential-file-sha256")
            == file_digest
        ):
            continue  # Preserve token rotation when the seed file is unchanged.
    generated = subprocess.run(
        [
            *base,
            "create",
            "secret",
            "generic",
            secret_name,
            f"--from-env-file={supplied_file}",
            "--dry-run=client",
            "-o",
            "json",
        ],
        check=True,
        capture_output=True,
    )
    body = json.loads(generated.stdout)
    if secret_name == "wortlaut-webex":
        body["metadata"]["annotations"] = {
            "wortlaut/credential-file-sha256": file_digest,
            "wortlaut/refresh-state": None,
        }
    subprocess.run([*base, "apply", "-f", "-"], input=json.dumps(body).encode(), check=True)

browser_state = Path(".dev/meet-storage-state.json")
if browser_state.exists():
    meet_vals = parse_env_file(Path(".dev/meet.env"))
    meet_secret_name = meet_vals.get("WORTLAUT_MEET_STORAGE_STATE_SECRET") or "wortlaut-meet-browser"
    generated = subprocess.run(
        [
            *base,
            "create",
            "secret",
            "generic",
            meet_secret_name,
            f"--from-file=storage-state.json={browser_state}",
            "--dry-run=client",
            "-o",
            "json",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run([*base, "apply", "-f", "-"], input=generated.stdout, check=True)
