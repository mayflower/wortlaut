# Security Policy

`wortlaut` joins confidential meetings, processes real-time audio streams, and handles OAuth2 / OIDC credentials. We treat security reports with the highest priority.

## Supported Versions

| Version | Supported |
| --- | --- |
| `main` / latest `0.1.x` release | Yes |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for suspected security vulnerabilities.**

Instead, please report vulnerabilities privately via **GitHub Private Vulnerability Reporting**:

- **[Report a vulnerability privately on GitHub](https://github.com/mayflower/wortlaut/security/advisories/new)**

Please include:
1. Affected component (`services/meeting`, `services/asr`, `worker`, `charts/wortlaut`, or `docker-compose.yml`).
2. Reproduction steps or proof-of-concept request/payload.
3. Impact assessment (e.g., cross-tenant data access, token leakage, SSRF, container escape).

We aim to acknowledge reports within **2 business days** and coordinate a fix and advisory before public disclosure.

## Security Architecture Highlights

- **Ephemeral Worker Isolation**: Every recording attempt runs in a dedicated, short-lived Kubernetes `Job` or unprivileged Docker container (`CapDrop: ALL`, `no-new-privileges`, scoped single-attempt bootstrap credential).
- **Restricted Docker Control Plane**: In Docker Compose deployments, the `meeting` service runs as non-root (`10001`) without `/var/run/docker.sock` mounted; container lifecycle calls are mediated through `docker-socket-proxy` with `PRIVILEGED=0`, `VOLUMES=0`, and `EXEC=0`.
- **Scoped Read-Only Protocol Tokens**: Shared protocol links (`wortlaut-read-…`) are HMAC-SHA256 bound to a single `recording_id` + per-recording rotatable nonce and grant read-only access to that recording's transcript exports only.
- **No Biometrics**: Speaker attribution relies strictly on conference signaling and isolated WebRTC receiver tracks — never voiceprints or biometric speaker embeddings.
