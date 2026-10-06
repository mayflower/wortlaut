import base64
import json
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest

from wortlaut import controller, webex


@pytest.fixture
def webex_exchange(monkeypatch):
    """Controlled REST/Secret boundaries; not a live Webex or Kubernetes proof."""
    values = {
        "WORTLAUT_WEBEX_SERVICE_TOKEN": "fixture-access-old",
        "WORTLAUT_WEBEX_REFRESH_TOKEN": "fixture-refresh-old",
        "WORTLAUT_WEBEX_CLIENT_ID": "fixture-client",
        "WORTLAUT_WEBEX_CLIENT_SECRET": "fixture-secret",
    }

    class Store:
        def __init__(self):
            self.annotations = {"operator": "preserved"}
            self.data = {
                key: base64.b64encode(value.encode()).decode() for key, value in values.items()
            }
            self.version = 1
            self.fail_commit = False

        def read_namespaced_secret(self, name, namespace, **kwargs):
            assert (name, namespace) == (webex.SERVICE_SECRET, "fixture-namespace")
            return SimpleNamespace(
                data=dict(self.data),
                metadata=SimpleNamespace(
                    annotations=dict(self.annotations), resource_version=str(self.version)
                ),
            )

        def patch_namespaced_secret(self, name, namespace, body, **kwargs):
            assert body["metadata"]["resourceVersion"] == str(self.version)
            if "data" in body and self.fail_commit:
                raise RuntimeError("fixture-secret must not escape")
            for key, value in body["metadata"]["annotations"].items():
                if value is None:
                    self.annotations.pop(key, None)
                else:
                    self.annotations[key] = value
            self.data.update(body.get("data", {}))
            self.version += 1
            return self.read_namespaced_secret(name, namespace)

    store = Store()
    settings = SimpleNamespace(
        enable_webex_refresh=True, enable_controller=True, namespace="fixture-namespace"
    )
    monkeypatch.setattr(webex, "get_settings", lambda: settings)
    monkeypatch.setattr(controller, "kubernetes_api", lambda: (None, store))
    calls = []
    reply = {
        "access_token": "fixture-access-new",
        "refresh_token": "fixture-refresh-new",
        "expires_in": 3600,
    }
    failure = []

    def handle(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/access_token":
            assert store.annotations[webex.REFRESH_STATE] == "in_progress"
            assert parse_qs(request.content.decode()) == {
                "grant_type": ["refresh_token"],
                "client_id": [values["WORTLAUT_WEBEX_CLIENT_ID"]],
                "client_secret": [values["WORTLAUT_WEBEX_CLIENT_SECRET"]],
                "refresh_token": [values["WORTLAUT_WEBEX_REFRESH_TOKEN"]],
            }
            if failure:
                raise httpx.ReadTimeout("fixture-secret must not escape", request=request)
            return httpx.Response(200, json=reply)
        assert request.url.path == "/v1/guests/token"
        assert json.loads(request.content) == {
            "subject": "fixture-subject",
            "displayName": "wortlaut",
        }
        if request.headers["Authorization"] == "Bearer fixture-access-old":
            return httpx.Response(401, json={"private": "fixture-secret"})
        assert request.headers["Authorization"] == "Bearer fixture-access-new"
        return httpx.Response(200, json={"accessToken": "fixture-guest", "expiresIn": 90})

    factory = httpx.Client
    monkeypatch.setattr(
        webex.httpx,
        "Client",
        lambda **kwargs: factory(**kwargs, transport=httpx.MockTransport(handle)),
    )
    return store, calls, reply, failure, settings


@pytest.mark.parametrize("replacement_refresh", [True, False])
def test_refresh_persists_pair_and_next_issuance_reads_current_secret(
    webex_exchange, replacement_refresh
):
    store, calls, reply, _, _ = webex_exchange
    if not replacement_refresh:
        del reply["refresh_token"]
    for _ in range(2):
        # The process environment remains stale after Secret rotation.
        assert webex.guest_token("fixture-access-old", "fixture-subject", "wortlaut") == {
            "access_token": "fixture-guest",
            "expires_in": 90,
        }
    assert calls == ["/v1/guests/token", "/v1/access_token", "/v1/guests/token", "/v1/guests/token"]
    assert store.annotations == {"operator": "preserved"}
    assert (
        base64.b64decode(store.data["WORTLAUT_WEBEX_SERVICE_TOKEN"]).decode()
        == "fixture-access-new"
    )
    assert base64.b64decode(store.data["WORTLAUT_WEBEX_REFRESH_TOKEN"]).decode() == (
        "fixture-refresh-new" if replacement_refresh else "fixture-refresh-old"
    )
    assert base64.b64decode(store.data["WORTLAUT_WEBEX_CLIENT_SECRET"]).decode() == "fixture-secret"


@pytest.mark.parametrize("failure_kind", ["lost_reply", "persistence"])
def test_uncertain_refresh_is_not_replayed_or_exposed(webex_exchange, failure_kind):
    store, calls, _, failure, _ = webex_exchange
    if failure_kind == "lost_reply":
        failure.append(True)
    else:
        store.fail_commit = True
    with pytest.raises(webex.WebexUnavailable, match="Secret persistence unavailable"):
        webex.guest_token("fixture-access-old", "fixture-subject", "wortlaut")
    assert store.annotations[webex.REFRESH_STATE] == "in_progress"
    before = list(calls)
    with pytest.raises(webex.WebexUnavailable, match="provision current credentials"):
        webex.guest_token("fixture-access-old", "fixture-subject", "wortlaut")
    assert calls == before


def test_access_only_rejection_is_a_safe_unavailable_result(webex_exchange):
    _, calls, _, _, settings = webex_exchange
    settings.enable_webex_refresh = False
    with pytest.raises(webex.WebexUnavailable, match="access token rejected"):
        webex.guest_token("fixture-access-old", "fixture-subject", "wortlaut")
    assert calls == ["/v1/guests/token"]
