import base64
import threading

import httpx

from wortlaut.settings import get_settings

REFRESH_STATE = "wortlaut/refresh-state"
SERVICE_SECRET = "wortlaut-webex"
refresh_lock = threading.Lock()


class WebexUnavailable(Exception):
    pass


def guest_token(service_token: str | None, subject: str, display_name: str) -> dict:
    if not service_token:
        raise WebexUnavailable("Webex Service App access token is not configured")
    if get_settings().enable_webex_refresh:
        return refreshed_guest(subject, display_name)
    try:
        return issue_guest(service_token, subject, display_name)
    except PermissionError:
        raise WebexUnavailable("Webex Service App access token rejected") from None


def issue_guest(service_token, subject, display_name):
    # Never include response bodies, headers or token values in exceptions/logs.
    with httpx.Client(timeout=20, follow_redirects=False) as client:
        response = client.post(
            "https://webexapis.com/v1/guests/token",
            headers={"Authorization": f"Bearer {service_token}"},
            json={"subject": subject, "displayName": display_name},
        )
    if response.status_code == 401:
        raise PermissionError("Webex Service App access token rejected")
    if response.status_code != 200:
        raise WebexUnavailable(f"Webex guest issuance failed (HTTP {response.status_code})")
    try:
        data = response.json()
    except ValueError:
        raise WebexUnavailable("Webex returned an invalid guest response") from None
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("accessToken"), str)
        or not data["accessToken"]
        or type(data.get("expiresIn")) is not int
        or data["expiresIn"] <= 0
    ):
        raise WebexUnavailable("Webex returned an invalid guest response")
    return {"access_token": data["accessToken"], "expires_in": data["expiresIn"]}


def refreshed_guest(subject, display_name):
    from wortlaut.controller import TIMEOUT, kubernetes_api

    settings = get_settings()
    if not settings.enable_controller:
        raise WebexUnavailable("Webex refresh requires the namespaced Secret store")
    # One organization and one server process. The Secret resourceVersion also
    # protects against an operator replacing credentials during the exchange.
    with refresh_lock:
        try:
            core = kubernetes_api()[1]
            secret = core.read_namespaced_secret(
                SERVICE_SECRET, settings.namespace, _request_timeout=TIMEOUT
            )
            values = {
                key: base64.b64decode(value, validate=True).decode()
                for key, value in (secret.data or {}).items()
            }
            annotations = dict(secret.metadata.annotations or {})
            if annotations.get(REFRESH_STATE):
                raise WebexUnavailable("Webex refresh unfinished; provision current credentials")
            token = values.get("WORTLAUT_WEBEX_SERVICE_TOKEN")
            if not token:
                raise WebexUnavailable("Webex Service App access token is not configured")
            try:
                return issue_guest(token, subject, display_name)
            except PermissionError:
                pass
            required = (
                "WORTLAUT_WEBEX_CLIENT_ID",
                "WORTLAUT_WEBEX_CLIENT_SECRET",
                "WORTLAUT_WEBEX_REFRESH_TOKEN",
            )
            if not all(values.get(key) for key in required):
                raise WebexUnavailable("Webex Service App refresh credentials are missing")
            # Persist before the external exchange: after a crash or lost reply
            # never blindly reuse a refresh token that may have been rotated.
            annotations[REFRESH_STATE] = "in_progress"
            secret = core.patch_namespaced_secret(
                SERVICE_SECRET,
                settings.namespace,
                {
                    "metadata": {
                        "resourceVersion": secret.metadata.resource_version,
                        "annotations": annotations,
                    }
                },
                _request_timeout=TIMEOUT,
            )
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                response = client.post(
                    "https://webexapis.com/v1/access_token",
                    data={
                        "grant_type": "refresh_token",
                        "client_id": values[required[0]],
                        "client_secret": values[required[1]],
                        "refresh_token": values[required[2]],
                    },
                )
            if response.status_code != 200:
                raise WebexUnavailable(f"Webex refresh failed (HTTP {response.status_code})")
            data = response.json()
            if (
                not isinstance(data, dict)
                or not isinstance(data.get("access_token"), str)
                or not data["access_token"]
                or type(data.get("expires_in")) is not int
                or data["expires_in"] <= 0
                or (
                    "refresh_token" in data
                    and (not isinstance(data["refresh_token"], str) or not data["refresh_token"])
                )
            ):
                raise WebexUnavailable("Webex returned an invalid refresh response")
            updated = {
                "WORTLAUT_WEBEX_SERVICE_TOKEN": data["access_token"],
                "WORTLAUT_WEBEX_REFRESH_TOKEN": data.get("refresh_token", values[required[2]]),
            }
            core.patch_namespaced_secret(
                SERVICE_SECRET,
                settings.namespace,
                {
                    "metadata": {
                        "resourceVersion": secret.metadata.resource_version,
                        "annotations": {REFRESH_STATE: None},
                    },
                    "data": {
                        key: base64.b64encode(value.encode()).decode()
                        for key, value in updated.items()
                    },
                },
                _request_timeout=TIMEOUT,
            )
            return issue_guest(updated["WORTLAUT_WEBEX_SERVICE_TOKEN"], subject, display_name)
        except WebexUnavailable:
            raise
        except Exception:
            # Kubernetes and HTTP exceptions can contain credential values.
            raise WebexUnavailable("Webex refresh or Secret persistence unavailable") from None
