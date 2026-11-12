"""GPU HTTP admission and Qwen3-ASR output parsing with controlled models.

These tests do not load Qwen3-ASR or CUDA; the real-model path is checked
separately against downloaded checkpoints.
"""

import hashlib
import importlib.util
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from fastapi.testclient import TestClient

SERVICE = Path(__file__).resolve().parents[2] / "asr/app.py"


def load_service(name):
    spec = importlib.util.spec_from_file_location(name, SERVICE)
    service = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(service)
    return service


def result(text="Wortlaut", language="German"):
    return {
        "text": text,
        "language": language,
        "words": [{"word": w, "confidence": 0.9} for w in text.split()],
        "truncated": False,
    }


def test_busy_inference_is_rejected_without_running_a_second_model_call(monkeypatch):
    service = load_service("fixture_gpu_service")
    entered, release = threading.Event(), threading.Event()
    calls = []

    class FixtureModel:
        def transcribe(self, audio):
            calls.append(audio)
            entered.set()
            assert release.wait(5)
            return result()

    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-token")
    monkeypatch.setattr(service, "load_model", lambda: FixtureModel())
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(inference_mode=nullcontext))
    headers = {"Authorization": "Bearer fixture-token", "X-Job-ID": "a" * 64}
    pcm = np.array([0, 16384, -32768], dtype="<i2").tobytes() * 1000
    with TestClient(service.app) as client, ThreadPoolExecutor(1) as pool:
        first = pool.submit(client.post, "/v1/transcribe", headers=headers, content=pcm)
        assert entered.wait(3)
        try:
            busy = client.post("/v1/transcribe", headers=headers, content=pcm)
            assert busy.status_code == 429
            assert len(calls) == 1
        finally:
            release.set()
        response = first.result(timeout=5)
        assert response.status_code == 200
        body = response.json()
        assert body["pcm_sha256"] == hashlib.sha256(pcm).hexdigest()
        assert body["words"] == [{"word": "Wortlaut", "confidence": 0.9}]
        assert body["language"] == "German"
        assert body["truncated"] is False
        # PCM16 is handed to the model as float32 in [-1, 1).
        assert calls[0].dtype == np.float32
        assert calls[0][:3].tolist() == [0.0, 0.5, -1.0]
        assert client.post("/v1/transcribe", headers=headers, content=b"x").status_code == 400
        assert (
            client.post(
                "/v1/transcribe", headers={**headers, "Authorization": "Bearer wrong"}, content=pcm
            ).status_code
            == 401
        )


def test_accelerator_failure_rejects_jobs_and_marks_gpu_process_unhealthy(monkeypatch):
    gpu = load_service("gpu_failure_fixture")

    class AcceleratorFailure(Exception):
        pass

    calls = []

    def fail(audio):
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


def test_shared_gpu_out_of_memory_is_retryable_and_keeps_process_healthy(monkeypatch):
    gpu = load_service("gpu_oom_fixture")

    class AcceleratorFailure(Exception):
        pass

    class OutOfMemory(Exception):
        pass

    emptied, calls = [], []

    def transcribe(audio):
        calls.append(True)
        if len(calls) == 1:
            raise OutOfMemory("fixture shared GPU allocation failure")
        return result()

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            AcceleratorError=AcceleratorFailure,
            OutOfMemoryError=OutOfMemory,
            cuda=SimpleNamespace(empty_cache=lambda: emptied.append(True)),
            inference_mode=nullcontext,
        ),
    )
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-oom-token")
    gpu.model = SimpleNamespace(transcribe=transcribe)
    client = TestClient(gpu.app)
    headers = {"Authorization": "Bearer fixture-oom-token", "X-Job-ID": "c" * 64}
    failed = client.post("/v1/transcribe", content=b"\0\0", headers=headers)
    assert failed.status_code == 503
    assert failed.headers["retry-after"] == "30"
    assert emptied == [True]
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200
    retried = client.post("/v1/transcribe", content=b"\0\0", headers=headers)
    assert retried.status_code == 200
    assert retried.json()["words"][0]["word"] == "Wortlaut"


def test_model_loads_pinned_checkpoint_on_cpu_only_when_enabled(monkeypatch):
    service = load_service("cpu_fallback_fixture")
    loaded = {}

    class Network:
        def to(self, device):
            loaded["device"] = device
            return self

        def eval(self):
            loaded["eval"] = True
            return self

    class AutoProcessor:
        @staticmethod
        def from_pretrained(repo, revision):
            loaded["processor"] = (repo, revision)
            return SimpleNamespace(tokenizer=object())

    class AutoModelForMultimodalLM:
        @staticmethod
        def from_pretrained(repo, revision, dtype):
            loaded["model"] = (repo, revision, dtype)
            return Network()

    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            AutoProcessor=AutoProcessor, AutoModelForMultimodalLM=AutoModelForMultimodalLM
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False), float32="f32", bfloat16="bf16"
        ),
    )
    monkeypatch.delenv("WORTLAUT_ASR_ALLOW_CPU", raising=False)
    try:
        service.load_model()
        raise AssertionError("CPU inference must be opt-in")
    except RuntimeError as error:
        assert "requires an NVIDIA GPU" in str(error)

    monkeypatch.setenv("WORTLAUT_ASR_ALLOW_CPU", "true")
    asr = service.load_model()
    assert isinstance(asr, service.QwenASR)
    pinned = ("Qwen/Qwen3-ASR-1.7B-hf", "bcd2b5b7f32b480ab5790554cfa8347f246a14f3")
    assert loaded == {
        "processor": pinned,
        "model": (*pinned, "f32"),
        "device": "cpu",
        "eval": True,
    }


def test_words_group_byte_level_tokens_with_mean_probability():
    service = load_service("assemble_fixture")
    # Raw byte-level BPE tokens after "<asr_text>", as convert_ids_to_tokens
    # returns them; "Ġ" marks a leading space.
    tokens = ["L", "Ã¶", "wen", "Ġunter", "Ġdem", "ĠZug", "?", "<|im_end|>", "Ġignored"]
    probs = [0.9, 1.0, 0.8, 1.0, 0.5, 0.6, 1.0, 1.0, 0.1]

    def to_text(group):
        return "".join(group).replace("Ġ", " ").replace("Ã¶", "ö")

    words = service.assemble_words(tokens, probs, to_text)
    assert words == [
        {"word": "Löwen", "confidence": 0.9},
        {"word": "unter", "confidence": 1.0},
        {"word": "dem", "confidence": 0.5},
        {"word": "Zug?", "confidence": 0.8},
    ]
    assert service.assemble_words(["<|im_end|>"], [1.0], to_text) == []


def fixture_asr(service, generated_tokens, generated_probs, transcription, language):
    vocab = {token: index for index, token in enumerate(sorted(set(generated_tokens)), 100)}
    names = {index: token for token, index in vocab.items()}
    prompt = [1, 2, 3]
    ids = [vocab[t] for t in generated_tokens]
    sequences = np.array([prompt + ids])
    logprobs = np.log(np.array([generated_probs]))

    class Inputs(dict):
        def to(self, device, dtype):
            return self

    class Probs:
        def __getitem__(self, index):
            row = np.exp(logprobs[index]).tolist()
            return SimpleNamespace(exp=lambda: SimpleNamespace(tolist=lambda: row))

    budgets = []

    class Network:
        device, dtype = "cpu", "f32"

        def generate(self, **kwargs):
            budgets.append(kwargs["max_new_tokens"])
            return SimpleNamespace(sequences=Seq(sequences), scores=None)

        def compute_transition_scores(self, sequences, scores, normalize_logits):
            assert normalize_logits is True
            return Probs()

    class Seq:
        def __init__(self, values):
            self.values = values

        def __getitem__(self, index):
            return SimpleNamespace(tolist=lambda: self.values[index].tolist())

    class Tokenizer:
        def convert_ids_to_tokens(self, generated):
            return [names[i] for i in generated]

        def convert_tokens_to_string(self, group):
            return "".join(group).replace("Ġ", " ")

    class Processor:
        tokenizer = Tokenizer()

        def apply_transcription_request(self, audio):
            return Inputs(input_ids=SimpleNamespace(shape=(1, len(prompt))))

        def decode(self, generated, return_format):
            assert return_format == "parsed"
            return [{"language": language, "transcription": transcription}]

    return service.QwenASR(Processor(), Network()), budgets


def test_transcribe_parses_language_words_and_truncation(monkeypatch):
    service = load_service("transcribe_fixture")
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(inference_mode=nullcontext))
    tokens = ["language", "ĠGerman", "<asr_text>", "Mit", "Ġdem", "ĠZug", "?", "<|im_end|>"]
    probs = [1.0, 1.0, 1.0, 0.92, 0.88, 0.96, 0.90, 1.0]
    asr, budgets = fixture_asr(service, tokens, probs, "Mit dem Zug?", "German")
    out = asr.transcribe(np.zeros(32000, np.float32))
    assert out["text"] == "Mit dem Zug?"
    assert out["language"] == "German"
    assert out["truncated"] is False
    assert out["words"] == [
        {"word": "Mit", "confidence": 0.92},
        {"word": "dem", "confidence": 0.88},
        {"word": "Zug?", "confidence": 0.93},
    ]
    # 2 s of audio: 24 prefix tokens plus 10 tokens per second.
    assert budgets == [44]

    # Non-speech: the model reports no language and an empty transcript.
    tokens = ["language", "ĠNone", "<asr_text>", "<|im_end|>"]
    asr, _ = fixture_asr(service, tokens, [1.0] * 4, "", None)
    assert asr.transcribe(np.zeros(16000, np.float32)) == {
        "text": "",
        "language": None,
        "words": [],
        "truncated": False,
    }

    # Budget exhausted without an end marker: reported as truncated.
    tokens = ["language", "ĠGerman", "<asr_text>", "ja", "Ġja", "Ġja"]
    asr, _ = fixture_asr(service, tokens, [1.0] * 6, "ja ja ja", "German")
    assert asr.transcribe(np.zeros(16000, np.float32))["truncated"] is True

    # Token grouping that does not reproduce the parsed transcript keeps the
    # transcript words but no confidence rather than misaligned scores.
    tokens = ["language", "ĠGerman", "<asr_text>", "Mit", "Ġdem", "<|im_end|>"]
    asr, _ = fixture_asr(service, tokens, [1.0, 1.0, 1.0, 0.5, 0.5, 1.0], "Mit dem Zug", "German")
    assert asr.transcribe(np.zeros(16000, np.float32))["words"] == [
        {"word": "Mit"},
        {"word": "dem"},
        {"word": "Zug"},
    ]
