"""GPU HTTP admission with a controlled model; does not test NeMo or CUDA."""

import hashlib
import importlib.util
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient


def test_busy_inference_is_rejected_without_running_a_second_model_call(monkeypatch):
    file = Path(__file__).resolve().parents[2] / "asr/app.py"
    spec = importlib.util.spec_from_file_location("fixture_gpu_service", file)
    service = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(service)
    entered, release = threading.Event(), threading.Event()
    calls = []

    class FixtureModel:
        def transcribe(self, filenames, **kwargs):
            calls.append(filenames)
            entered.set()
            assert release.wait(5)
            return [
                SimpleNamespace(
                    text="Wortlaut",
                    timestamp={"word": [{"word": "Wortlaut", "start": 0.1, "end": 0.2}]},
                )
            ]

    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-token")
    monkeypatch.setattr(service, "load_model", lambda: FixtureModel())
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(inference_mode=nullcontext))
    headers = {"Authorization": "Bearer fixture-token", "X-Job-ID": "a" * 64}
    pcm = b"\x00\x01" * 16000
    with TestClient(service.app) as client, ThreadPoolExecutor(1) as pool:
        first = pool.submit(client.post, "/v1/transcribe", headers=headers, content=pcm)
        assert entered.wait(3)
        try:
            busy = client.post("/v1/transcribe", headers=headers, content=pcm)
            assert busy.status_code == 429
            assert len(calls) == 1
        finally:
            release.set()
        result = first.result(timeout=5)
        assert result.status_code == 200
        assert result.json()["pcm_sha256"] == hashlib.sha256(pcm).hexdigest()
        assert result.json()["words"][0]["word"] == "Wortlaut"
        assert client.post("/v1/transcribe", headers=headers, content=b"x").status_code == 400
        assert (
            client.post(
                "/v1/transcribe", headers={**headers, "Authorization": "Bearer wrong"}, content=pcm
            ).status_code
            == 401
        )
