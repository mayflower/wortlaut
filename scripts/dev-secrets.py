#!/usr/bin/env python3
"""Initialize private developer credentials without printing secret values."""

import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path

namespace = os.environ["WORTLAUT_NAMESPACE"]
runtime_file = Path(".dev/runtime.env")
if not runtime_file.exists():
    password = secrets.token_urlsafe(32)
    content = {
        "POSTGRES_PASSWORD": password,
        "WORTLAUT_DATABASE_URL": f"postgresql+psycopg://wortlaut:{password}@postgres:5432/wortlaut",
        "WORTLAUT_API_TOKEN": secrets.token_urlsafe(32),
    }
    with open(runtime_file, "x", opener=lambda p, f: os.open(p, f, 0o600)) as file:
        file.write("".join(f"{key}={value}\n" for key, value in content.items()))

base = ["kubectl", "--context", "data", "--namespace", namespace, "--request-timeout=10s"]
asr_file = Path(".dev/asr.env")
if not asr_file.exists():
    with open(asr_file, "x", opener=lambda p, f: os.open(p, f, 0o600)) as file:
        file.write(f"WORTLAUT_ASR_TOKEN={secrets.token_urlsafe(32)}\n")
existing_asr = subprocess.run(
    [*base, "get", "secret", "wortlaut-asr", "--ignore-not-found", "-o", "name"],
    check=True, capture_output=True, text=True,
)
if not existing_asr.stdout.strip():
    subprocess.run([*base, "create", "secret", "generic", "wortlaut-asr",
                    f"--from-env-file={asr_file}"], check=True)
existing = subprocess.run(
    [*base, "get", "secret", "wortlaut-runtime", "--ignore-not-found", "-o", "name"],
    check=True, capture_output=True, text=True,
)
if not existing.stdout.strip():
    subprocess.run(
        [*base, "create", "secret", "generic", "wortlaut-runtime",
         f"--from-env-file={runtime_file}"], check=True,
    )

webex_file = Path(".dev/webex.env")
storage_file = Path(".dev/storage.env")
if not storage_file.exists():
    with open(storage_file, "x", opener=lambda p, f: os.open(p, f, 0o600)) as file:
        file.write("WORTLAUT_S3_ACCESS_KEY=wortlaut-dev\n")
        file.write(f"WORTLAUT_S3_SECRET_KEY={secrets.token_urlsafe(32)}\n")
existing_storage = subprocess.run(
    [*base, "get", "secret", "wortlaut-storage", "--ignore-not-found", "-o", "name"],
    check=True, capture_output=True, text=True,
)
if not existing_storage.stdout.strip():
    subprocess.run([*base, "create", "secret", "generic", "wortlaut-storage",
                    f"--from-env-file={storage_file}"], check=True)

for supplied_file, secret_name in (
    (webex_file, "wortlaut-webex"), (Path(".dev/mail.env"), "wortlaut-mail"),
    (Path(".dev/meet.env"), "wortlaut-meet")
):
    if not supplied_file.exists():
        continue
    file_digest = hashlib.sha256(supplied_file.read_bytes()).hexdigest()
    if secret_name == "wortlaut-webex":
        existing_webex = subprocess.run(
            [*base, "get", "secret", secret_name, "--ignore-not-found", "-o", "json"],
            check=True, capture_output=True, text=True,
        )
        if existing_webex.stdout.strip() and (json.loads(existing_webex.stdout).get(
            "metadata", {}
        ).get("annotations") or {}).get("wortlaut/credential-file-sha256") == file_digest:
            continue  # Preserve token rotation when the seed file is unchanged.
    # Explicitly supplied settings are separate secrets; never print them.
    generated = subprocess.run(
        [*base, "create", "secret", "generic", secret_name,
         f"--from-env-file={supplied_file}", "--dry-run=client", "-o", "json"],
        check=True, capture_output=True,
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
    generated = subprocess.run(
        [*base, "create", "secret", "generic", "wortlaut-meet-browser",
         f"--from-file=storage-state.json={browser_state}", "--dry-run=client", "-o", "json"],
        check=True, capture_output=True,
    )
    subprocess.run([*base, "apply", "-f", "-"], input=generated.stdout, check=True)
