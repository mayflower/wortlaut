# scripts

## Overview
Developer environment bootstrap, secret provisioning, Tilt startup, and Kubernetes BuildKit image build scripts for `wortlaut` on Kubernetes context `data`.

## Interface
- `[setup.sh:main]` (`scripts/setup.sh`): Validates required CLI tools (`kubectl`, `tilt`, `docker`, `uv`, `npm`), flattens context `data` from `WORTLAUT_SOURCE_KUBECONFIG` (default `~/.kube/data-lan-mayflower`) into `.dev/kubeconfig`, and installs dependencies for `services/meeting` and `worker`.
- `[dev.sh:main]` (`scripts/dev.sh`): Exports `KUBECONFIG=.dev/kubeconfig`, defaults `WORTLAUT_NAMESPACE` (`wortlaut-$(id -un)`), `TILT_HOST` (`127.0.0.1`), and `TILT_PORT` (`34604`), verifies cluster connectivity and Tilt port availability, ensures the namespace exists, and execs `tilt up`.
- `[dev-secrets.py:main]` (`scripts/dev-secrets.py`): Initializes local `.dev/*.env` secret files (`runtime.env`, `asr.env`, `storage.env`) and reconciles Kubernetes secrets (`wortlaut-asr`, `wortlaut-runtime`, `wortlaut-storage`, `wortlaut-webex`, `wortlaut-mail`, `wortlaut-meet`, `wortlaut-teams`, `wortlaut-meet-browser`) in `WORTLAUT_NAMESPACE`.
- `[build.sh:image_component]` (`scripts/build.sh <image_component>`): Builds `services/<image_component>/Dockerfile` for `linux/amd64` with `--provenance=false` and pushes `${EXPECTED_REF}` via a Kubernetes BuildKit builder (`${WORTLAUT_NAMESPACE}-builder`).

## Invariants
- `[setup.sh:tool]`: Requires `kubectl`, `tilt`, `docker`, `uv`, and `npm` in `PATH`, and verifies `.dev/kubeconfig` `current-context` equals `data` without modifying the source kubeconfig.
- `[dev.sh:KUBECONFIG]`: Requires `.dev/kubeconfig` to exist and aborts with exit status `1` if an existing Tilt instance responds on `TILT_HOST:TILT_PORT` (saving `.dev/tiltfiles.json` for inspection).
- `[build.sh:WORTLAUT_NAMESPACE]`: Requires `WORTLAUT_NAMESPACE` and `EXPECTED_REF` environment variables to be non-empty and `kubectl config current-context` to equal `data`.
- `[dev-secrets.py:WORTLAUT_NAMESPACE]`: Requires `WORTLAUT_NAMESPACE` in environment; writes generated `.dev/*.env` files exclusively with mode `0o600` without printing secret values, and skips overwriting `wortlaut-webex` when its `wortlaut/credential-file-sha256` annotation matches `.dev/webex.env` to preserve OAuth token rotation.

## Side Effects
- `[setup.sh:.dev]`: Creates `.dev` (`0700`) and `.dev/kubeconfig` (`0600`), runs `uv sync --project services/meeting`, and runs `npm --prefix worker ci`.
- `[dev.sh:tilt up]`: Writes `.dev/tiltfiles.json` when probing `TILT_HOST:TILT_PORT`, applies namespace `WORTLAUT_NAMESPACE` on context `data`, and replaces the process with `tilt up`.
- `[dev-secrets.py:subprocess.run]`: Generates `.dev/runtime.env`, `.dev/asr.env`, and `.dev/storage.env` (`0600`) with random tokens (`secrets.token_urlsafe(32)`) if missing, and creates or applies Kubernetes secrets in `WORTLAUT_NAMESPACE` on context `data`.
- `[build.sh:docker buildx]`: Creates the Kubernetes-driver buildx builder `${WORTLAUT_NAMESPACE}-builder` (`linux/amd64`, `nodeselector=kubernetes.io/arch=amd64`, `requests.cpu=1,requests.memory=2Gi,limits.cpu=4,limits.memory=4Gi`) if missing, and builds/pushes image `${EXPECTED_REF}`.

## Verification
- Run: `make test`
