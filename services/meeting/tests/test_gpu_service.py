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
        def transcribe(self, audio, **_):
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

    def fail(audio, **_):
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

    def transcribe(audio, **_):
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


def test_padding_chat_template_dtype_and_step1_language_gate(monkeypatch):
    service = load_service("gate_fixture")

    class FakeTensor:
        def __init__(self, arr, floating=True):
            self.arr = np.array(arr, dtype=np.float64 if floating else np.int64)
            self._floating = floating
            self.moves = []

        @property
        def shape(self):
            return self.arr.shape

        def is_floating_point(self):
            return self._floating

        def to(self, device=None, dtype=None):
            self.moves.append((device, dtype))
            return self

        def float(self):
            return self

        def clone(self):
            return FakeTensor(self.arr.copy(), self._floating)

        def __getitem__(self, idx):
            val = self.arr[idx]
            if np.ndim(val) == 0:
                return float(val) if self._floating else int(val)
            return FakeTensor(val, self._floating)

        def __setitem__(self, idx, value):
            self.arr[idx] = value.arr if isinstance(value, FakeTensor) else value

    def fake_softmax(tensor, dim=-1):
        shifted = tensor.arr - np.max(tensor.arr, axis=dim, keepdims=True)
        exps = np.exp(shifted)
        return FakeTensor(exps / np.sum(exps, axis=dim, keepdims=True))

    def fake_full_like(tensor, fill_value):
        return FakeTensor(np.full_like(tensor.arr, fill_value, dtype=np.float64))

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            inference_mode=nullcontext,
            softmax=fake_softmax,
            full_like=fake_full_like,
        ),
    )

    vocab = {
        "language": 10,
        " None": 11,
        " German": 12,
        " English": 13,
        " Dutch": 14,
        " Danish": 15,
        " Chinese": 16,
        " Japanese": 17,
    }
    allowed_ids = {"German": 12, "English": 13}

    # 1. CJK breath hallucination (P(de+en+kin) = 0.004 < 0.10) -> forces None (11).
    breath_probs = np.full((1, 20), 1e-6)
    breath_probs[0, 16] = 0.92
    breath_probs[0, 17] = 0.07
    breath_probs[0, 12] = 0.002
    breath_probs[0, 13] = 0.002
    breath_probs[0, 11] = 0.006
    gated_breath = service.apply_language_step_gate(
        FakeTensor(np.log(breath_probs)), allowed_ids, 11, (14, 15)
    )
    assert int(np.argmax(gated_breath.arr[0])) == 11

    # 2. Short German phrase misclassified as Dutch -> transfers kinship mass to German (12).
    dutch_german_probs = np.full((1, 20), 1e-6)
    dutch_german_probs[0, 14] = 0.98
    dutch_german_probs[0, 13] = 0.003
    dutch_german_probs[0, 12] = 0.001
    dutch_german_probs[0, 11] = 0.001
    gated_de = service.apply_language_step_gate(
        FakeTensor(np.log(dutch_german_probs)), allowed_ids, 11, (14, 15)
    )
    assert int(np.argmax(gated_de.arr[0])) == 12

    # 3. Genuine English clip -> keeps English (13).
    en_probs = np.full((1, 20), 1e-6)
    en_probs[0, 13] = 0.94
    en_probs[0, 14] = 0.02
    en_probs[0, 12] = 0.01
    en_probs[0, 11] = 0.01
    gated_en = service.apply_language_step_gate(
        FakeTensor(np.log(en_probs)), allowed_ids, 11, (14, 15)
    )
    assert int(np.argmax(gated_en.arr[0])) == 13

    # 4. End-to-end QwenASR check: 0.3s padding, unpadded budget, chat template, dtype-safe .to().
    seen = {}
    input_ids_tensor = FakeTensor([[1, 2, 3]], floating=False)
    features_tensor = FakeTensor([[0.1, 0.2]], floating=True)

    class Tokenizer:
        def encode(self, text, add_special_tokens=False):
            return [vocab[text]] if text in vocab else []

        def convert_ids_to_tokens(self, generated):
            return ["language", "ĠNone", "<asr_text>", "<|im_end|>"]

        def convert_tokens_to_string(self, group):
            return "".join(group).replace("Ġ", " ")

    class Processor:
        tokenizer = Tokenizer()

        def apply_chat_template(self, conversations, tokenize, add_generation_prompt):
            seen["padded_len"] = len(conversations[0][0]["content"][0]["audio"])
            return "<prompt>"

        def __call__(self, text, audio, return_tensors):
            seen["call"] = (text, len(audio[0]), return_tensors)
            return {"input_ids": input_ids_tensor, "input_features": features_tensor}

        def decode(self, generated, return_format):
            return [{"language": "None", "transcription": ""}]

    class Network:
        device, dtype = "cuda", "bf16"

        def generate(self, **kwargs):
            seen["budget"] = kwargs["max_new_tokens"]
            gate = kwargs["logits_processor"][0]
            step1 = gate(
                FakeTensor([[1, 2, 3, 10]], floating=False),
                FakeTensor(np.log(breath_probs)),
            )
            seen["step1_choice"] = int(np.argmax(step1.arr[0]))
            seq = np.array([[1, 2, 3, 10, 11, 18, 19]])
            return SimpleNamespace(sequences=seq, scores=None)

        def compute_transition_scores(self, sequences, scores, normalize_logits):
            ones = [1.0, 1.0, 1.0, 1.0]
            return [SimpleNamespace(exp=lambda: SimpleNamespace(tolist=lambda: ones))]

    asr = service.QwenASR(Processor(), Network(), allowed_languages="German,English")
    out = asr.transcribe(np.ones(32000, np.float32) * 0.25)
    assert seen["padded_len"] == 32000 + 2 * 4800
    assert seen["call"] == ("<prompt>", 41600, "pt")
    assert seen["budget"] == 44
    assert seen["step1_choice"] == 11
    assert input_ids_tensor.moves == [("cuda", None)]
    assert features_tensor.moves == [("cuda", "bf16")]
    assert out == {"text": "", "language": None, "words": [], "truncated": False}
    assert service.parse_allowed_languages("*") is None

    # 5. Short German utterance with low speech mass (0.05 >= 0.02) stays German,
    #    primary_language="German" short-clip prior wins over ambiguous English,
    #    and mass preservation ensures true short non-speech (`None` = 0.70) stays `None`.
    short_de_probs = np.full((1, 20), 1e-6)
    short_de_probs[0, 16] = 0.85
    short_de_probs[0, 13] = 0.03
    short_de_probs[0, 12] = 0.02
    short_de_probs[0, 11] = 0.03
    gated_short_de = service.apply_language_step_gate(
        FakeTensor(np.log(short_de_probs)),
        allowed_ids,
        11,
        (14, 15),
        duration=1.2,
        primary_language="German",
    )
    assert int(np.argmax(gated_short_de.arr[0])) == 12
    short_nonspeech_probs = np.full((1, 20), 1e-6)
    short_nonspeech_probs[0, 11] = 0.70
    short_nonspeech_probs[0, 12] = 0.20
    short_nonspeech_probs[0, 13] = 0.05
    gated_short_nonspeech = service.apply_language_step_gate(
        FakeTensor(np.log(short_nonspeech_probs)),
        allowed_ids,
        11,
        (14, 15),
        duration=1.2,
        primary_language="German",
    )
    assert int(np.argmax(gated_short_nonspeech.arr[0])) == 11
    # Genuine strong English (0.94) on a short clip still wins over German prior.
    gated_short_en = service.apply_language_step_gate(
        FakeTensor(np.log(en_probs)),
        allowed_ids,
        11,
        (14, 15),
        duration=1.2,
        primary_language="German",
    )
    assert int(np.argmax(gated_short_en.arr[0])) == 13


def test_cjk_token_masking_none_suppression_and_context_prompt_header(monkeypatch):
    import base64

    service = load_service("cjk_context_fixture")

    class FakeTensor:
        def __init__(self, arr, floating=True):
            self.arr = np.array(arr, dtype=np.float64 if floating else np.int64)
            self._floating = floating

        @property
        def shape(self):
            return self.arr.shape

        def is_floating_point(self):
            return self._floating

        def to(self, device=None, dtype=None):
            return self

        def float(self):
            return self

        def clone(self):
            return FakeTensor(self.arr.copy(), self._floating)

        def __getitem__(self, idx):
            val = self.arr[idx]
            if np.ndim(val) == 0:
                return float(val) if self._floating else int(val)
            return FakeTensor(val, self._floating)

        def __setitem__(self, idx, value):
            self.arr[idx] = value.arr if isinstance(value, FakeTensor) else value

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            AcceleratorError=RuntimeError,
            OutOfMemoryError=MemoryError,
            inference_mode=nullcontext,
            softmax=lambda t, dim=-1: FakeTensor(
                np.exp(t.arr) / np.sum(np.exp(t.arr), axis=dim, keepdims=True)
            ),
            full_like=lambda t, v: FakeTensor(np.full_like(t.arr, v, dtype=np.float64)),
        ),
    )

    vocab = {
        "language": 10,
        " None": 11,
        " German": 12,
        " English": 13,
        "<asr_text>": 14,
        "<|im_end|>": 15,
        "ĠAcmeCorp": 16,
        "啊": 18,
        "叫": 19,
    }
    captured = {}

    class Tokenizer:
        def get_vocab(self):
            return vocab

        def encode(self, text, add_special_tokens=False):
            return [vocab[text]] if text in vocab else []

        def convert_tokens_to_ids(self, tok):
            return vocab.get(tok, -1)

        def convert_ids_to_tokens(self, generated):
            rev = {v: k for k, v in vocab.items()}
            return [rev.get(i, "?") for i in generated]

        def convert_tokens_to_string(self, group):
            return "".join(group).replace("Ġ", " ")

    class Processor:
        tokenizer = Tokenizer()
        mode = "german"

        def apply_chat_template(self, conversations, tokenize, add_generation_prompt):
            captured["messages"] = conversations[0]
            return "<prompt-with-context>"

        def __call__(self, text, audio, return_tensors):
            return {
                "input_ids": FakeTensor([[1, 2, 3]], floating=False),
                "input_features": FakeTensor([[0.1, 0.2]], floating=True),
            }

        def decode(self, generated, return_format):
            if self.mode == "none_with_cjk":
                return [{"language": "None", "transcription": "啊，所以啊。"}]
            return [{"language": "German", "transcription": "AcmeCorp"}]

    class Network:
        device, dtype = "cpu", "fp32"

        def generate(self, **kwargs):
            gate = kwargs["logits_processor"][0]
            step2_scores = FakeTensor(np.zeros((1, 20)))
            masked_step2 = gate(FakeTensor([[1, 2, 3, 10, 12, 14]], floating=False), step2_scores)
            captured["cjk_masked"] = (
                masked_step2.arr[0, 18] == float("-inf")
                and masked_step2.arr[0, 19] == float("-inf")
                and masked_step2.arr[0, 16] == 0.0
            )
            if Processor.mode == "none_with_cjk":
                seq = np.array([[1, 2, 3, 10, 11, 14, 18, 15]])
            else:
                seq = np.array([[1, 2, 3, 10, 12, 14, 16, 15]])
            return SimpleNamespace(sequences=seq, scores=None)

        def compute_transition_scores(self, sequences, scores, normalize_logits):
            vals = [0.95] * (sequences.shape[1] - 3)
            return [SimpleNamespace(exp=lambda: SimpleNamespace(tolist=lambda: vals))]

    proc = Processor()
    asr = service.QwenASR(proc, Network(), allowed_languages="German,English")
    assert asr.forbidden_script_token_ids == [18, 19]

    # Even if Qwen3-ASR emitted CJK tokens after `language None`, output MUST be empty.
    proc.mode = "none_with_cjk"
    none_res = asr.transcribe(np.zeros(16000, np.float32))
    assert none_res == {"text": "", "language": None, "words": [], "truncated": False}
    assert bool(captured["cjk_masked"]) is True

    # HTTP /v1/transcribe forwards UTF-8 base64 context glossary + primary language.
    proc.mode = "german"
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "ctx-token")
    service.model = asr
    client = TestClient(service.app)
    ctx_str = "Thema: AcmeStack Sync | Teilnehmende: Björn Müller | Glossar: AcmeCorp, CloudSync"
    ctx_b64 = base64.b64encode(ctx_str.encode("utf-8")).decode("ascii")
    resp = client.post(
        "/v1/transcribe",
        content=np.zeros(8000, dtype="<i2").tobytes(),
        headers={
            "Authorization": "Bearer ctx-token",
            "X-Job-ID": "b" * 64,
            "X-ASR-Context-B64": ctx_b64,
            "X-Primary-Language": "German",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == "AcmeCorp"
    assert captured["messages"][0] == {
        "role": "system",
        "content": [{"type": "text", "text": ctx_str}],
    }


def test_all_30_qwen_asr_languages_and_per_request_language_switching(monkeypatch):
    service = load_service("multilingual_switch_fixture")
    assert len(service.QWEN_ASR_LANGUAGES) == 30
    assert service.DEFAULT_ASR_LANGUAGES == "*"
    assert service.parse_allowed_languages(None) is None
    assert service.parse_allowed_languages("japanese, english") == ("Japanese", "English")

    # Fullwidth whitespace (\u3000) in CJK/Japanese tokens splits cleanly and keeps confidence.
    cjk_words = service.assemble_words(
        ["你好", "\u3000世界", "<|im_end|>"],
        [0.9, 0.8, 1.0],
        lambda grp: "".join(grp),
    )
    assert cjk_words == [
        {"word": "你好", "confidence": 0.85},
        {"word": "世界", "confidence": 0.85},
    ]

    class FakeTensor:
        def __init__(self, arr, floating=True):
            self.arr = np.array(arr, dtype=np.float64 if floating else np.int64)
            self._floating = floating

        @property
        def shape(self):
            return self.arr.shape

        def is_floating_point(self):
            return self._floating

        def to(self, device=None, dtype=None):
            return self

        def float(self):
            return self

        def clone(self):
            return FakeTensor(self.arr.copy(), self._floating)

        def __getitem__(self, idx):
            val = self.arr[idx]
            if np.ndim(val) == 0:
                return float(val) if self._floating else int(val)
            return FakeTensor(val, self._floating)

        def __setitem__(self, idx, value):
            self.arr[idx] = value.arr if isinstance(value, FakeTensor) else value

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            AcceleratorError=RuntimeError,
            OutOfMemoryError=MemoryError,
            inference_mode=nullcontext,
            softmax=lambda t, dim=-1: FakeTensor(
                np.exp(t.arr) / np.sum(np.exp(t.arr), axis=dim, keepdims=True)
            ),
            full_like=lambda t, v: FakeTensor(np.full_like(t.arr, v, dtype=np.float64)),
        ),
    )

    vocab: dict[str, int] = {"language": 10, " None": 11, "<asr_text>": 50, "<|im_end|>": 51}
    for idx, lang in enumerate(service.QWEN_ASR_LANGUAGES, start=12):
        vocab[" " + lang] = idx
    vocab["ĠBonjour"] = 52
    vocab["こんにちは"] = 53
    vocab["Ελληνικά"] = 54

    class Tokenizer:
        def get_vocab(self):
            return vocab

        def encode(self, text, add_special_tokens=False):
            return [vocab[text]] if text in vocab else []

        def convert_tokens_to_ids(self, tok):
            return vocab.get(tok, -1)

        def convert_ids_to_tokens(self, generated):
            rev = {v: k for k, v in vocab.items()}
            return [rev.get(i, "?") for i in generated]

        def convert_tokens_to_string(self, group):
            return "".join(group).replace("Ġ", " ")

    observed: dict[str, object] = {}

    class Processor:
        tokenizer = Tokenizer()
        target_lang = "Japanese"
        target_text = "こんにちは"
        target_tok = 53

        def apply_chat_template(self, conversations, tokenize, add_generation_prompt):
            return "<prompt>"

        def __call__(self, text, audio, return_tensors):
            return {
                "input_ids": FakeTensor([[1, 2, 3]], floating=False),
                "input_features": FakeTensor([[0.1, 0.2]], floating=True),
            }

        def decode(self, generated, return_format):
            return [{"language": self.target_lang, "transcription": self.target_text}]

    class Network:
        device, dtype = "cpu", "fp32"

        def generate(self, **kwargs):
            gate = kwargs["logits_processor"][0]
            lang_id = vocab[" " + Processor.target_lang]
            step1_scores = FakeTensor(np.zeros((1, 60)))
            step1_scores.arr[0, lang_id] = 2.0
            gated_step1 = gate(FakeTensor([[1, 2, 3, 10]], floating=False), step1_scores)
            observed["step1_allowed"] = [
                i for i in range(60) if gated_step1.arr[0, i] > float("-inf")
            ]
            step2_scores = FakeTensor(np.zeros((1, 60)))
            gated_step2 = gate(
                FakeTensor([[1, 2, 3, 10, lang_id, 50]], floating=False), step2_scores
            )
            observed["jp_token_allowed"] = bool(gated_step2.arr[0, 53] > float("-inf"))
            observed["greek_token_allowed"] = bool(gated_step2.arr[0, 54] > float("-inf"))
            seq = np.array([[1, 2, 3, 10, lang_id, 50, Processor.target_tok, 51]])
            return SimpleNamespace(sequences=seq, scores=None)

        def compute_transition_scores(self, sequences, scores, normalize_logits):
            vals = [0.92] * (sequences.shape[1] - 3)
            return [SimpleNamespace(exp=lambda: SimpleNamespace(tolist=lambda: vals))]

    proc = Processor()
    asr = service.QwenASR(proc, Network())
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "lang-switch-token")
    service.model = asr
    client = TestClient(service.app)

    ready = client.get("/health/ready").json()
    assert len(ready["supported_languages"]) == 30
    assert "Japanese" in ready["supported_languages"]
    assert "Macedonian" in ready["supported_languages"]

    pcm = np.zeros(8000, dtype="<i2").tobytes()
    base_headers = {"Authorization": "Bearer lang-switch-token", "X-Job-ID": "d" * 64}

    # 1. Default / Auto (`*`): all 30 Qwen3-ASR languages + None allowed, CJK/Greek unmasked!
    res_auto = client.post(
        "/v1/transcribe", content=pcm, headers={**base_headers, "X-ASR-Languages": "*"}
    )
    assert res_auto.status_code == 200
    assert res_auto.json()["language"] == "Japanese"
    assert res_auto.json()["text"] == "こんにちは"
    assert len(observed["step1_allowed"]) == 31  # 30 languages + None
    assert observed["jp_token_allowed"] is True
    assert observed["greek_token_allowed"] is True

    # 2. Switch live to French (Latin script): only French + None allowed, CJK & Greek masked!
    Processor.target_lang = "French"
    Processor.target_text = "Bonjour"
    Processor.target_tok = 52
    res_fr = client.post(
        "/v1/transcribe", content=pcm, headers={**base_headers, "X-ASR-Languages": "French"}
    )
    assert res_fr.status_code == 200
    assert res_fr.json()["language"] == "French"
    assert observed["step1_allowed"] == sorted([vocab[" French"], vocab[" None"]])
    assert observed["jp_token_allowed"] is False
    assert observed["greek_token_allowed"] is False

    # 3. Switch live to Greek (non-Latin script): Greek + None allowed, Greek unmasked!
    Processor.target_lang = "Greek"
    Processor.target_text = "Ελληνικά"
    Processor.target_tok = 54
    res_el = client.post(
        "/v1/transcribe", content=pcm, headers={**base_headers, "X-ASR-Languages": "Greek"}
    )
    assert res_el.status_code == 200
    assert res_el.json()["language"] == "Greek"
    assert observed["step1_allowed"] == sorted([vocab[" Greek"], vocab[" None"]])
    assert observed["greek_token_allowed"] is True

    # 4. Unsupported language header rejected with HTTP 400
    bad = client.post(
        "/v1/transcribe", content=pcm, headers={**base_headers, "X-ASR-Languages": "Klingon"}
    )
    assert bad.status_code == 400

    # 5. Auto (`*`) dynamically masks CJK/Greek once step-1 selects a Latin language (German),
    # and catches space-prefixed partial CJK BPE bytes (`ĠåĹ` -> U+FFFD).
    vocab["Ġ\u00e5\u0139"] = 55
    vocab["ĠHallo"] = 56
    orig_to_str = Tokenizer.convert_tokens_to_string

    def to_str_with_partial(self, group):
        if group == ["Ġ\u00e5\u0139"]:
            return " \ufffd"
        return orig_to_str(self, group)

    monkeypatch.setattr(Tokenizer, "convert_tokens_to_string", to_str_with_partial)
    asr2 = service.QwenASR(proc, Network())
    assert 55 in asr2._latin_forbidden_token_ids
    service.model = asr2

    Processor.target_lang = "German"
    Processor.target_text = "Hallo"
    Processor.target_tok = 56
    res_auto_de = client.post(
        "/v1/transcribe", content=pcm, headers={**base_headers, "X-ASR-Languages": "*"}
    )
    assert res_auto_de.status_code == 200
    assert res_auto_de.json()["language"] == "German"
    assert observed["jp_token_allowed"] is False
    assert observed["greek_token_allowed"] is False


def test_normalize_audio_rms_levels_quiet_speech_without_boosting_silence_or_clipping(monkeypatch):
    service = load_service("rms_normalize_fixture")
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(inference_mode=nullcontext))
    t = np.linspace(0, 1.0, 16000, endpoint=False, dtype=np.float32)

    # 1. Pure silence and ultra-low digital floor stay untouched (no noise boost)
    zeros = np.zeros(16000, dtype=np.float32)
    assert np.array_equal(service.normalize_audio_rms(zeros), zeros)
    floor_noise = np.sin(2 * np.pi * 200 * t).astype(np.float32) * 0.001
    assert np.allclose(service.normalize_audio_rms(floor_noise), floor_noise)

    # 2. Quiet speech (-32 dBFS, ~0.025 RMS) is lifted cleanly to ~0.1 RMS (-20 dBFS)
    quiet = np.sin(2 * np.pi * 440 * t).astype(np.float32) * (0.025 * np.sqrt(2))
    leveled_quiet = service.normalize_audio_rms(quiet)
    rms_quiet = float(np.sqrt(np.mean(leveled_quiet * leveled_quiet)))
    assert abs(rms_quiet - service.TARGET_RMS) < 0.005
    assert float(np.max(np.abs(leveled_quiet))) <= service.PEAK_CEILING + 1e-5

    # 3. Very quiet speech (-46 dBFS, ~0.005 RMS) is capped at MAX_NORMALIZE_GAIN (+15 dB)
    very_quiet = np.sin(2 * np.pi * 440 * t).astype(np.float32) * (0.005 * np.sqrt(2))
    leveled_vq = service.normalize_audio_rms(very_quiet)
    effective_gain = float(np.max(np.abs(leveled_vq)) / np.max(np.abs(very_quiet)))
    assert abs(effective_gain - service.MAX_NORMALIZE_GAIN) < 0.05

    # 4. Quiet speech with a loud transient spike respects PEAK_CEILING (-1 dBFS)
    spiky = quiet.copy()
    spiky[100] = 0.5
    leveled_spiky = service.normalize_audio_rms(spiky)
    assert float(np.max(np.abs(leveled_spiky))) <= service.PEAK_CEILING + 1e-5

    # 5. Well-leveled speech (0.18 RMS, peak < PEAK_CEILING) stays untouched
    normal = np.sin(2 * np.pi * 440 * t).astype(np.float32) * (0.18 * np.sqrt(2))
    assert np.allclose(service.normalize_audio_rms(normal), normal)

    # 6. Long segment with 75% silence + 25% quiet speech uses active-sample RMS
    padded_speech = np.concatenate(
        [np.zeros(24000, dtype=np.float32), quiet, np.zeros(24000, dtype=np.float32)]
    )
    leveled_sparse = service.normalize_audio_rms(padded_speech)
    speech_slice = leveled_sparse[24000:40000]
    sparse_rms = float(np.sqrt(np.mean(speech_slice * speech_slice)))
    assert abs(sparse_rms - service.TARGET_RMS) < 0.005
    assert np.all(leveled_sparse[:24000] == 0.0)

    # 7. QwenASR.transcribe normalizes quiet audio before adding exact-zero boundary padding
    captured: list[np.ndarray] = []
    tokens = ["language", "ĠGerman", "<asr_text>", "Hallo", "<|im_end|>"]
    asr, _ = fixture_asr(service, tokens, [1.0] * 5, "Hallo", "German")
    orig_req = asr.processor.apply_transcription_request

    def spy_req(audio):
        captured.append(np.asarray(audio, dtype=np.float32))
        return orig_req(audio)

    asr.processor.apply_transcription_request = spy_req
    asr.transcribe(quiet)
    assert len(captured) == 1
    sent = captured[0]
    assert len(sent) == len(quiet) + 2 * service.PAD_SAMPLES
    assert np.all(sent[: service.PAD_SAMPLES] == 0.0)
    assert np.all(sent[-service.PAD_SAMPLES :] == 0.0)
    inner = sent[service.PAD_SAMPLES : -service.PAD_SAMPLES]
    assert abs(float(np.sqrt(np.mean(inner * inner))) - service.TARGET_RMS) < 0.005


def test_asr_backend_device_and_quantization_resolution(monkeypatch):
    service = load_service("backend_config_fixture")

    monkeypatch.delenv("WORTLAUT_ASR_BACKEND", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_DEVICE", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_QUANTIZATION", raising=False)
    assert service.resolve_asr_backend() == "qwen3"
    assert service._resolve_device_setting() == "auto"
    assert service._resolve_quantization_setting("qwen3", "cuda") == "bfloat16"
    assert service._resolve_quantization_setting("qwen3", "mps") == "float16"
    assert service._resolve_quantization_setting("qwen3", "cpu") == "float32"
    assert service._resolve_quantization_setting("parakeet", "cpu") == "int8"
    assert service._resolve_quantization_setting("parakeet", "cuda") == "fp32"

    for alias in ("parakeet", "Parakeet-TDT", "parakeet-onnx"):
        monkeypatch.setenv("WORTLAUT_ASR_BACKEND", alias)
        assert service.resolve_asr_backend() == "parakeet"

    monkeypatch.setenv("WORTLAUT_ASR_BACKEND", "whisper-v99")
    try:
        service.resolve_asr_backend()
        raise AssertionError("Unsupported backend must fail fast")
    except ValueError as error:
        assert "Unsupported ASR backend" in str(error)

    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "gpu")
    assert service._resolve_device_setting() == "cuda"
    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "mps")
    assert service._resolve_device_setting() == "mps"
    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "tpu")
    try:
        service._resolve_device_setting()
        raise AssertionError("Unsupported device must fail fast")
    except ValueError as error:
        assert "Unsupported ASR device" in str(error)

    monkeypatch.setenv("WORTLAUT_ASR_QUANTIZATION", "float32")
    assert service._resolve_quantization_setting("parakeet", "cpu") == "fp32"
    monkeypatch.setenv("WORTLAUT_ASR_QUANTIZATION", "bfloat16")
    try:
        service._resolve_quantization_setting("parakeet", "cpu")
        raise AssertionError("bfloat16 is unsupported for Parakeet ONNX")
    except ValueError as error:
        assert "Unsupported Parakeet quantization" in str(error)


def test_assemble_parakeet_words_groups_sentencepiece_timestamps_and_confidence():
    service = load_service("parakeet_words_fixture")
    tokens = ["▁Hall", "o", "▁Welt", "!"]
    # Pad was 0.30s; first token at 0.35s -> 0.05s unpadded, second word at 0.80s -> 0.50s.
    timestamps = [0.35, 0.48, 0.80, 0.92]
    logprobs = [float(np.log(0.9)), float(np.log(0.8)), float(np.log(0.95)), float(np.log(0.85))]
    words = service.assemble_parakeet_words(
        tokens,
        timestamps,
        logprobs,
        text="Hallo Welt!",
        duration=1.2,
        pad_seconds=0.3,
    )
    assert words == [
        {"word": "Hallo", "start": 0.05, "end": 0.26, "confidence": 0.85},
        {"word": "Welt!", "start": 0.5, "end": 0.7, "confidence": 0.9},
    ]
    assert service.assemble_parakeet_words([], [], [], text="", duration=1.0) == []
    assert service.assemble_parakeet_words(None, None, None, text="Hallo Welt", duration=1.0) == [
        {"word": "Hallo"},
        {"word": "Welt"},
    ]
    # Clamped leading timestamp (0.22 < 0.30 pad) still yields positive non-overlapping duration
    # and handles tuple/ndarray sequences.
    clamped = service.assemble_parakeet_words(
        ["▁Der", "▁zweite"],
        np.array([0.22, 0.48]),
        (-0.01, -0.02),
        text="Der zweite",
        duration=1.0,
        pad_seconds=0.3,
    )
    assert clamped[0]["start"] == 0.0
    assert clamped[0]["end"] == 0.08
    assert clamped[1]["start"] == 0.18
    assert clamped[1]["end"] == 0.26


def test_parakeet_loader_dispatches_cpu_int8_and_gpu_fp32_checkpoints(monkeypatch):
    service = load_service("parakeet_loader_fixture")
    calls: list[dict] = []

    class FakeLoaded:
        def __init__(self, kwargs):
            self.kwargs = kwargs
            self.timestamped = False

        def with_timestamps(self):
            self.timestamped = True
            return self

    def fake_snapshot_download(*, repo_id, revision, allow_patterns, local_dir=None):
        calls.append(
            {
                "op": "snapshot",
                "repo": repo_id,
                "revision": revision,
                "patterns": allow_patterns,
                "local_dir": local_dir,
            }
        )
        return "/tmp/fake-parakeet-cache"

    def fake_load_model(name, *, path, quantization, providers):
        entry = {
            "op": "load",
            "name": name,
            "path": path,
            "quantization": quantization,
            "providers": providers,
        }
        calls.append(entry)
        return FakeLoaded(entry)

    providers_state = {"available": ["CPUExecutionProvider"]}
    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        SimpleNamespace(get_available_providers=lambda: list(providers_state["available"])),
    )
    monkeypatch.setitem(sys.modules, "onnx_asr", SimpleNamespace(load_model=fake_load_model))
    monkeypatch.setitem(
        sys.modules,
        "huggingface_hub",
        SimpleNamespace(snapshot_download=fake_snapshot_download),
    )
    monkeypatch.setenv("WORTLAUT_ASR_BACKEND", "parakeet")
    monkeypatch.delenv("WORTLAUT_ASR_DEVICE", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_ALLOW_CPU", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_QUANTIZATION", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_MODEL_REPO", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_MODEL_REVISION", raising=False)

    # 1. Without GPU or CPU opt-in, Parakeet fails closed.
    try:
        service.load_model()
        raise AssertionError("Parakeet CPU inference must be opt-in when device=auto")
    except RuntimeError as error:
        assert "WORTLAUT_ASR_DEVICE=cpu" in str(error)

    # 2. Explicit CPU mode downloads only INT8 ONNX files and uses CPUExecutionProvider.
    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "cpu")
    cpu_model = service.load_model()
    assert isinstance(cpu_model, service.ParakeetASR)
    assert cpu_model.device == "cpu"
    assert cpu_model.quantization == "int8"
    assert cpu_model.adapter.timestamped is True
    assert calls[0]["op"] == "snapshot"
    assert calls[0]["repo"] == service.DEFAULT_PARAKEET_MODEL_REPO
    assert calls[0]["revision"] == service.DEFAULT_PARAKEET_MODEL_REVISION
    assert calls[0]["local_dir"].endswith(
        f"parakeet-onnx/istupakov_parakeet-tdt-0.6b-v3-onnx/{service.DEFAULT_PARAKEET_MODEL_REVISION}"
    )
    assert calls[0]["patterns"] == [
        "config.json",
        "vocab.txt",
        "nemo128.onnx",
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
    ]
    assert calls[1] == {
        "op": "load",
        "name": "nemo-parakeet-tdt-0.6b-v3",
        "path": "/tmp/fake-parakeet-cache",
        "quantization": "int8",
        "providers": ["CPUExecutionProvider"],
    }

    # 3. GPU provider registered at compile time but no physical CUDA device at runtime:
    #    device=auto with allowCpu=true falls back truthfully to CPU/int8 instead of fake CUDA,
    #    and device=cuda fails closed.
    calls.clear()
    providers_state["available"] = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    monkeypatch.setattr(service, "_cuda_device_present", lambda: False)
    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "auto")
    monkeypatch.setenv("WORTLAUT_ASR_ALLOW_CPU", "true")
    fallback_cpu = service.load_model()
    assert fallback_cpu.device == "cpu"
    assert fallback_cpu.quantization == "int8"
    assert calls[1]["providers"] == ["CPUExecutionProvider"]

    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "cuda")
    try:
        service.load_model()
        raise AssertionError("device=cuda must fail closed when no physical GPU is present")
    except RuntimeError as error:
        assert "CUDAExecutionProvider" in str(error)

    # 4. GPU mode (auto when CUDAExecutionProvider AND a real GPU are present) downloads FP32 files.
    calls.clear()
    monkeypatch.setattr(service, "_cuda_device_present", lambda: True)
    monkeypatch.setenv("WORTLAUT_ASR_DEVICE", "auto")
    monkeypatch.delenv("WORTLAUT_ASR_ALLOW_CPU", raising=False)
    gpu_model = service.load_model()
    assert isinstance(gpu_model, service.ParakeetASR)
    assert gpu_model.device == "cuda"
    assert gpu_model.quantization == "fp32"
    assert "encoder-model.onnx.data" in calls[0]["patterns"]
    assert calls[1]["quantization"] is None
    assert calls[1]["providers"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_parakeet_http_transcribe_runs_without_torch_and_feeds_segment_result(monkeypatch):
    from wortlaut.asr import segment_result

    service = load_service("parakeet_http_fixture")
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "parakeet-token")

    seen_calls: list[tuple[int, int]] = []

    class FakeAdapter:
        def recognize(self, audio, *, sample_rate):
            seen_calls.append((len(audio), sample_rate))
            return SimpleNamespace(
                text="Guten Morgen zusammen.",
                tokens=["▁Guten", "▁Morgen", "▁zu", "sammen", "."],
                timestamps=[0.40, 0.72, 1.05, 1.20, 1.38],
                logprobs=[-0.05, -0.08, -0.04, -0.06, -0.02],
            )

    service.model = service.ParakeetASR(FakeAdapter(), device="cpu", quantization="int8")
    client = TestClient(service.app)

    ready = client.get("/health/ready")
    assert ready.status_code == 200
    ready_body = ready.json()
    assert ready_body["backend"] == "parakeet"
    assert ready_body["device"] == "cpu"
    assert ready_body["quantization"] == "int8"
    assert ready_body["supports_context_prompt"] is False
    assert len(ready_body["supported_languages"]) == 25

    pcm = np.zeros(24000, dtype="<i2").tobytes()  # 1.5s @ 16kHz
    resp = client.post(
        "/v1/transcribe",
        content=pcm,
        headers={"Authorization": "Bearer parakeet-token", "X-Job-ID": "e" * 64},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert seen_calls == [(24000 + 2 * service.PAD_SAMPLES, 16000)]
    assert body["text"] == "Guten Morgen zusammen."
    assert body["language"] is None
    assert body["truncated"] is False
    assert [w["word"] for w in body["words"]] == ["Guten", "Morgen", "zusammen."]
    assert all("start" in w and "end" in w and "confidence" in w for w in body["words"])

    # Verify seamless compatibility with Meeting service segment_result()
    job = SimpleNamespace(
        id="job-1",
        start_sample=0,
        end_sample=24000,
        core_start=0,
        core_end=24000,
        binding={"participant_id": "p-1", "display_name": "Ada"},
    )
    stream = SimpleNamespace(
        stream_id="stream-1",
        epoch=1,
        contract={
            "monotonic_origin_ms": 10_000,
            "session_monotonic_origin_ms": 0,
            "session_utc_origin": "2026-11-27T10:00:00Z",
        },
    )
    seg = segment_result(job, stream, body)
    assert seg["text"] == "Guten Morgen zusammen."
    assert seg["start"] == 10.1
    assert seg["end"] == 11.16
    assert seg["confidence"] is not None
    assert len(seg["words"]) == 3


def test_qwen3_loader_supports_mps_auto_detection(monkeypatch):
    service = load_service("qwen_mps_fixture")
    loaded = {}

    class Network:
        def to(self, device):
            loaded["device"] = device
            return self

        def eval(self):
            return self

    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            AutoProcessor=SimpleNamespace(
                from_pretrained=lambda repo, revision: SimpleNamespace(tokenizer=object())
            ),
            AutoModelForMultimodalLM=SimpleNamespace(
                from_pretrained=lambda repo, revision, dtype: (
                    loaded.setdefault("dtype", dtype),
                    Network(),
                )[1]
            ),
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False),
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: True)),
            float16="fp16",
            float32="f32",
            bfloat16="bf16",
        ),
    )
    monkeypatch.setenv("WORTLAUT_ASR_BACKEND", "qwen3")
    monkeypatch.delenv("WORTLAUT_ASR_DEVICE", raising=False)
    monkeypatch.delenv("WORTLAUT_ASR_ALLOW_CPU", raising=False)
    asr = service.load_model()
    assert isinstance(asr, service.QwenASR)
    assert asr.device == "mps"
    assert asr.quantization == "float16"
    assert loaded == {"dtype": "fp16", "device": "mps"}


def test_onnx_gpu_errors_model_loading_guard_and_backend_language_validation(monkeypatch):
    service = load_service("onnx_gpu_errors_fixture")
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "onnx-err-token")
    headers = {"Authorization": "Bearer onnx-err-token", "X-Job-ID": "9" * 64}
    pcm = np.zeros(8000, dtype="<i2").tobytes()

    # 1. Request while model is still None returns HTTP 503 ("Model loading"), not 500.
    service.model = None
    client = TestClient(service.app)
    loading = client.post("/v1/transcribe", content=pcm, headers=headers)
    assert loading.status_code == 503
    assert loading.json() == {"detail": "Model loading"}

    # 2. Qwen3 rejects Parakeet-only languages (Ukrainian) with HTTP 400; Parakeet accepts
    #    Qwen3-only languages (Japanese) without permanent failure during backend migration.
    service.model = SimpleNamespace(backend="qwen3", transcribe=lambda audio, **_: result())
    qwen_bad = client.post(
        "/v1/transcribe", content=pcm, headers={**headers, "X-ASR-Languages": "Ukrainian"}
    )
    assert qwen_bad.status_code == 400
    service.model = SimpleNamespace(backend="parakeet", transcribe=lambda audio, **_: result())
    parakeet_ok = client.post(
        "/v1/transcribe", content=pcm, headers={**headers, "X-ASR-Languages": "Japanese"}
    )
    assert parakeet_ok.status_code == 200

    # 3. ONNX Runtime CUDA OOM returns retryable 503 + Retry-After: 30 and keeps pod healthy.
    OnnxRuntimeException = type(
        "RuntimeException",
        (Exception,),
        {"__module__": "onnxruntime.capi.onnxruntime_pybind11_state"},
    )
    service.model = SimpleNamespace(
        backend="parakeet",
        transcribe=lambda audio, **_: (_ for _ in ()).throw(
            OnnxRuntimeException("BFCArena failed to allocate memory (CUDA out of memory)")
        ),
    )
    oom = client.post("/v1/transcribe", content=pcm, headers=headers)
    assert oom.status_code == 503
    assert oom.headers["retry-after"] == "30"
    assert client.get("/health/ready").status_code == 200
    assert client.get("/health/live").status_code == 200

    # 4. Fatal ONNX Runtime CUDA failure returns 503 and marks process unhealthy.
    service.model = SimpleNamespace(
        backend="parakeet",
        transcribe=lambda audio, **_: (_ for _ in ()).throw(
            OnnxRuntimeException("CUDA failure 700: an illegal memory access was encountered")
        ),
    )
    fatal = client.post("/v1/transcribe", content=pcm, headers=headers)
    assert fatal.status_code == 503
    assert fatal.json() == {"detail": "GPU unavailable"}
    assert client.get("/health/ready").status_code == 503
    assert client.get("/health/live").status_code == 503
