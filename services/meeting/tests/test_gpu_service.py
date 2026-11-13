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
        "ĠMayflower": 16,
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
            return [{"language": "German", "transcription": "Mayflower"}]

    class Network:
        device, dtype = "cpu", "fp32"

        def generate(self, **kwargs):
            gate = kwargs["logits_processor"][0]
            step2_scores = FakeTensor(np.zeros((1, 20)))
            masked_step2 = gate(
                FakeTensor([[1, 2, 3, 10, 12, 14]], floating=False), step2_scores
            )
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
    ctx_str = "Thema: mAIstack Sync | Teilnehmende: Björn Müller | Glossar: Mayflower, Astryx"
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
    assert resp.json()["text"] == "Mayflower"
    assert captured["messages"][0] == {
        "role": "system",
        "content": [{"type": "text", "text": ctx_str}],
    }
