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


def test_accelerator_failure_rejects_jobs_and_marks_gpu_process_unhealthy(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "asr/app.py"
    spec = importlib.util.spec_from_file_location("gpu_failure_fixture", path)
    gpu = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gpu)

    class AcceleratorFailure(Exception):
        pass

    calls = []

    def fail(*args, **kwargs):
        calls.append(True)
        raise AcceleratorFailure("fixture CUDA client failure")

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(AcceleratorError=AcceleratorFailure, inference_mode=nullcontext),
    )
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-gpu-token")
    gpu.model = SimpleNamespace(transcribe=fail)
    client = TestClient(gpu.app)
    assert client.get("/health/ready").status_code == 200
    assert client.get("/health/live").status_code == 200
    headers = {"Authorization": "Bearer fixture-gpu-token", "X-Job-ID": "a" * 64}
    for _ in range(2):
        response = client.post("/v1/transcribe", content=b"\0\0", headers=headers)
        assert response.status_code == 503
        assert response.json() == {"detail": "GPU unavailable"}
    assert calls == [True]
    assert client.get("/health/ready").status_code == 503
    assert client.get("/health/live").status_code == 503


def test_cpu_fallback_loads_model_on_cpu_when_enabled(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "asr/app.py"
    spec = importlib.util.spec_from_file_location("cpu_fallback_fixture", path)
    asr_service = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(asr_service)

    restored = {}

    class DummyModel:
        def freeze(self):
            restored["frozen"] = True

        def eval(self):
            restored["eval"] = True

    class DummyASRModel:
        @staticmethod
        def restore_from(filename, map_location):
            restored["filename"] = filename
            restored["map_location"] = map_location
            return DummyModel()

        @staticmethod
        def from_pretrained(model_name, map_location):
            restored["pretrained"] = model_name
            restored["map_location"] = map_location
            return DummyModel()

    asr_models = SimpleNamespace(ASRModel=DummyASRModel)
    nemo_pkg = SimpleNamespace(
        collections=SimpleNamespace(asr=SimpleNamespace(models=asr_models))
    )
    monkeypatch.setitem(sys.modules, "nemo", nemo_pkg)
    monkeypatch.setitem(sys.modules, "nemo.collections", nemo_pkg.collections)
    monkeypatch.setitem(sys.modules, "nemo.collections.asr", nemo_pkg.collections.asr)
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
    )
    monkeypatch.setitem(
        sys.modules,
        "huggingface_hub",
        SimpleNamespace(
            hf_hub_download=lambda repo, name, revision: f"/tmp/{repo}:{name}@{revision}"
        ),
    )
    monkeypatch.setattr(asr_service, "MODEL_REVISION", asr_service.DEFAULT_MODEL_REVISION)
    monkeypatch.setenv("WORTLAUT_ASR_ALLOW_CPU", "true")
    loaded = asr_service.load_model()
    assert isinstance(loaded, DummyModel)
    assert asr_service.MODEL_REVISION == "541d1f99c6b0c3cd0b11a95167540bb8edefd82b"
    assert restored == {
        "filename": (
            "/tmp/nvidia/parakeet-tdt-0.6b-v3:"
            "parakeet-tdt-0.6b-v3.nemo@541d1f99c6b0c3cd0b11a95167540bb8edefd82b"
        ),
        "map_location": "cpu",
        "frozen": True,
        "eval": True,
    }

    restored.clear()
    monkeypatch.setenv("WORTLAUT_ASR_MODEL_REPO", "primeline/parakeet-primeline")
    loaded_primeline = asr_service.load_model()
    assert isinstance(loaded_primeline, DummyModel)
    assert asr_service.MODEL_REVISION == "3f1a9bcb611dfeda53fe74fe5f1a3d5701e8023e"
    assert restored == {
        "filename": (
            "/tmp/primeline/parakeet-primeline:"
            "2_95_WER.nemo@3f1a9bcb611dfeda53fe74fe5f1a3d5701e8023e"
        ),
        "map_location": "cpu",
        "frozen": True,
        "eval": True,
    }

    restored.clear()
    monkeypatch.setenv("WORTLAUT_ASR_MODEL_REPO", "custom-org/parakeet-custom")
    loaded_custom = asr_service.load_model()
    assert isinstance(loaded_custom, DummyModel)
    assert asr_service.MODEL_REVISION == "custom-org/parakeet-custom"
    assert restored == {
        "pretrained": "custom-org/parakeet-custom",
        "map_location": "cpu",
        "frozen": True,
        "eval": True,
    }
