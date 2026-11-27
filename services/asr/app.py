"""Shared local ASR HTTP service supporting Qwen3-ASR (Transformers) and Parakeet TDT (ONNX)."""

import base64
import binascii
import hashlib
import math
import os
import re
import secrets
import sys
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

DEFAULT_BACKEND = "qwen3"
DEFAULT_MODEL_REPO = "Qwen/Qwen3-ASR-1.7B-hf"
DEFAULT_MODEL_REVISION = "bcd2b5b7f32b480ab5790554cfa8347f246a14f3"
DEFAULT_PARAKEET_MODEL_REPO = "istupakov/parakeet-tdt-0.6b-v3-onnx"
DEFAULT_PARAKEET_MODEL_REVISION = "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce"
DEFAULT_ASR_LANGUAGES = "*"
QWEN_ASR_LANGUAGES: tuple[str, ...] = (
    "Chinese",
    "English",
    "Cantonese",
    "Arabic",
    "German",
    "French",
    "Spanish",
    "Portuguese",
    "Indonesian",
    "Italian",
    "Korean",
    "Russian",
    "Thai",
    "Vietnamese",
    "Japanese",
    "Turkish",
    "Hindi",
    "Malay",
    "Dutch",
    "Swedish",
    "Danish",
    "Finnish",
    "Polish",
    "Czech",
    "Filipino",
    "Persian",
    "Greek",
    "Hungarian",
    "Macedonian",
    "Romanian",
)
PARAKEET_ASR_LANGUAGES: tuple[str, ...] = (
    "Bulgarian",
    "Croatian",
    "Czech",
    "Danish",
    "Dutch",
    "English",
    "Estonian",
    "Finnish",
    "French",
    "German",
    "Greek",
    "Hungarian",
    "Italian",
    "Latvian",
    "Lithuanian",
    "Maltese",
    "Polish",
    "Portuguese",
    "Romanian",
    "Russian",
    "Slovak",
    "Slovenian",
    "Spanish",
    "Swedish",
    "Ukrainian",
)
ALL_KNOWN_ASR_LANGUAGES: tuple[str, ...] = tuple(
    dict.fromkeys((*QWEN_ASR_LANGUAGES, *PARAKEET_ASR_LANGUAGES))
)
_CANONICAL_LANG_BY_LOWER = {lang.lower(): lang for lang in ALL_KNOWN_ASR_LANGUAGES}
MODEL_REPO = os.environ.get("WORTLAUT_ASR_MODEL_REPO", "").strip() or DEFAULT_MODEL_REPO
MODEL_REVISION = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip() or DEFAULT_MODEL_REVISION
SENTENCEPIECE_SPACE = "\u2581"
RATE = 16000
PAD_SAMPLES = int(0.3 * RATE)
TARGET_RMS = 0.1  # -20 dBFS target speech level for quiet microphones
MIN_ACTIVE_RMS = 0.002  # -54 dBFS floor; never amplify silence or digital comfort noise
MAX_NORMALIZE_GAIN = 5.623413251903491  # +15 dB gain ceiling
PEAK_CEILING = 0.8912509381337456  # -1 dBFS peak limit to prevent clipping
MIN_SPEECH_LANG_PROB = 0.02
SHORT_CLIP_MAX_SECONDS = 2.5
SHORT_CLIP_PRIMARY_PRIOR_NATS = 1.5
MAX_BYTES = RATE * 2 * 32
# Generation budget: the language prefix plus a generous speech rate. A
# transcript that reaches the budget without an end token is reported as
# truncated, which is how a decoder loop shows up.
PREFIX_TOKENS = 24
TOKENS_PER_SECOND = 10
ASR_TEXT_MARKER = "<asr_text>"
END_MARKER = "<|im_end|>"
SPACE_MARKER = "Ġ"  # Byte-level BPE marker for a leading space.
LATIN_SCRIPT_LANGUAGES = frozenset(
    {
        "German",
        "English",
        "French",
        "Spanish",
        "Portuguese",
        "Indonesian",
        "Italian",
        "Vietnamese",
        "Turkish",
        "Malay",
        "Dutch",
        "Swedish",
        "Danish",
        "Finnish",
        "Polish",
        "Czech",
        "Filipino",
        "Hungarian",
        "Romanian",
    }
)
_ASCII_BPE_TOKEN_RE = re.compile(r"^[\x21-\x7e\u0120\u010a]+$")
_DISALLOWED_SCRIPT_RE = re.compile(
    r"[\u0370-\u052f\u0600-\u06ff\u0900-\u0dff\u0e00-\u0eff"
    r"\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u3400-\u4dbf"
    r"\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uffef]"
)
lock = threading.Lock()
model = None
accelerator_failed = threading.Event()


def parse_allowed_languages(
    raw: str | None, *, supported: tuple[str, ...] = ALL_KNOWN_ASR_LANGUAGES
) -> tuple[str, ...] | None:
    value = DEFAULT_ASR_LANGUAGES if raw is None else raw.strip()
    if not value or value.lower() in ("*", "all", "auto"):
        return None
    allowed_lookup = (
        _CANONICAL_LANG_BY_LOWER
        if supported is ALL_KNOWN_ASR_LANGUAGES
        else {lang.lower(): lang for lang in supported}
    )
    resolved: list[str] = []
    for part in value.split(","):
        cleaned = part.strip()
        if not cleaned:
            continue
        if cleaned.lower() in ("*", "all", "auto"):
            return None
        canon = allowed_lookup.get(cleaned.lower())
        if canon is None:
            raise ValueError(f"Unsupported ASR language: {cleaned}")
        if canon not in resolved:
            resolved.append(canon)
    return tuple(resolved) or None


def normalize_audio_rms(audio):
    """Lift quiet speech toward -20 dBFS RMS with +15 dB gain cap and -1 dBFS ceiling.

    Uses active-sample RMS (excluding silence below MIN_ACTIVE_RMS) so pauses inside
    longer segments do not over-amplify speech, and leaves silence or well-leveled
    speech untouched.
    """
    import numpy as np

    if len(audio) == 0:
        return audio
    arr = np.asarray(audio, dtype=np.float32)
    abs_audio = np.abs(arr)
    peak = float(np.max(abs_audio))
    if not math.isfinite(peak) or peak < MIN_ACTIVE_RMS:
        return arr
    active = arr[abs_audio >= MIN_ACTIVE_RMS]
    if len(active) >= max(1, len(arr) // 100):
        rms = float(np.sqrt(np.mean(active * active, dtype=np.float64)))
    else:
        rms = float(np.sqrt(np.mean(arr * arr, dtype=np.float64)))
    if not math.isfinite(rms) or rms < MIN_ACTIVE_RMS:
        return arr
    if rms < TARGET_RMS:
        gain = min(TARGET_RMS / rms, MAX_NORMALIZE_GAIN, PEAK_CEILING / peak)
    elif peak > PEAK_CEILING:
        gain = PEAK_CEILING / peak
    else:
        return arr
    if abs(gain - 1.0) < 0.02:
        return arr
    return np.clip(arr * gain, -1.0, 1.0).astype(np.float32, copy=False)


def apply_language_step_gate(
    scores,
    allowed_lang_ids: dict[str, int],
    none_token_id: int | None,
    germanic_kin_ids: tuple[int, ...] = (),
    *,
    duration: float | None = None,
    primary_language: str | None = None,
):
    """Gate and constrain Qwen3-ASR's step-1 language token distribution.

    At step 1 (after `language`), Qwen3-ASR predicts the spoken language or
    `None`. Breaths, coughs, and mic clicks place >85% probability on CJK
    tokens and emit filler hallucinations (`嗯。`, `はい。`). When the acoustic
    probability mass on allowed languages (plus continental West-Germanic
    neighbors for short German interjections) is below `MIN_SPEECH_LANG_PROB`,
    selecting `None` suppresses the non-speech hallucination cleanly.
    """
    import torch

    probs = torch.softmax(scores.float(), dim=-1)
    p_allowed = sum(float(probs[0, tid]) for tid in allowed_lang_ids.values())
    p_kin = sum(float(probs[0, tid]) for tid in germanic_kin_ids)
    if p_allowed + p_kin < MIN_SPEECH_LANG_PROB and none_token_id is not None:
        masked = torch.full_like(scores, float("-inf"))
        masked[:, none_token_id] = scores[:, none_token_id]
        return masked

    adjusted = scores.clone()
    german_id = allowed_lang_ids.get("German")
    if german_id is not None and p_kin > 0.0:
        p_de = max(float(probs[0, german_id]), 1e-12)
        adjusted[0, german_id] = scores[0, german_id] + math.log(1.0 + p_kin / p_de)

    if (
        duration is not None
        and duration < SHORT_CLIP_MAX_SECONDS
        and primary_language
        and primary_language in allowed_lang_ids
        and len(allowed_lang_ids) > 1
    ):
        # Tilt relative odds among allowed languages toward primary_language
        # while preserving total allowed-language probability mass vs `None`.
        max_a = max(float(adjusted[0, tid]) for tid in allowed_lang_ids.values())
        w_before = sum(
            math.exp(float(adjusted[0, tid]) - max_a) for tid in allowed_lang_ids.values()
        )
        prim_id = allowed_lang_ids[primary_language]
        adjusted[0, prim_id] = adjusted[0, prim_id] + SHORT_CLIP_PRIMARY_PRIOR_NATS
        max_b = max(float(adjusted[0, tid]) for tid in allowed_lang_ids.values())
        w_after = sum(
            math.exp(float(adjusted[0, tid]) - max_b) for tid in allowed_lang_ids.values()
        )
        if w_before > 0.0 and w_after > 0.0:
            norm_shift = (max_a + math.log(w_before)) - (max_b + math.log(w_after))
            for tid in allowed_lang_ids.values():
                adjusted[0, tid] = adjusted[0, tid] + norm_shift

    masked = torch.full_like(adjusted, float("-inf"))
    keep = list(allowed_lang_ids.values())
    if none_token_id is not None:
        keep.append(none_token_id)
    masked[:, keep] = adjusted[:, keep]
    return masked


def _clamp_confidence(value) -> float | None:
    try:
        score = float(value)
    except TypeError, ValueError:
        return None
    if not math.isfinite(score):
        return None
    return max(0.0, min(1.0, score))


def assemble_words(tokens: list[str], probs: list[float], to_text) -> list[dict]:
    """Group generated transcript tokens into words with mean token probability.

    `tokens` are raw byte-level BPE tokens after the `<asr_text>` marker. A token
    starting with the space marker opens a new word; punctuation and subword
    pieces join the current word. `to_text` turns a token group into text.
    """
    groups: list[tuple[list[str], list[float]]] = []
    for token, prob in zip(tokens, probs, strict=True):
        if token == END_MARKER:
            break
        if not groups or token.startswith(SPACE_MARKER):
            groups.append(([], []))
        groups[-1][0].append(token)
        groups[-1][1].append(prob)
    words = []
    for group_tokens, group_probs in groups:
        pieces = to_text(group_tokens).split()
        if not pieces:
            continue
        valid = [p for p in (_clamp_confidence(p) for p in group_probs) if p is not None]
        conf = round(sum(valid) / len(valid), 4) if valid else None
        for piece in pieces:
            item = {"word": piece}
            if conf is not None:
                item["confidence"] = conf
            words.append(item)
    return words


class QwenASR:
    backend = "qwen3"
    supports_context_prompt = True
    supported_languages = QWEN_ASR_LANGUAGES

    def __init__(
        self,
        processor,
        network,
        allowed_languages=...,
        *,
        device: str = "cuda",
        quantization: str = "bfloat16",
        model_repo: str = DEFAULT_MODEL_REPO,
        model_revision: str = DEFAULT_MODEL_REVISION,
    ):
        self.processor = processor
        self.network = network
        self.device = device
        self.quantization = quantization
        self.model_repo = model_repo
        self.model_revision = model_revision
        self.tokenizer = processor.tokenizer
        raw_langs = (
            os.environ.get("WORTLAUT_ASR_LANGUAGES")
            if allowed_languages is ...
            else allowed_languages
        )
        self.allowed_languages = parse_allowed_languages(raw_langs, supported=QWEN_ASR_LANGUAGES)
        self.language_token_id = self._language_marker_token_id()
        self.none_token_id = self._first_lang_token_id("None")
        self.all_lang_ids = {
            lang: tid
            for lang in QWEN_ASR_LANGUAGES
            if (tid := self._first_lang_token_id(lang)) is not None
        }
        self.allowed_lang_ids = (
            {
                lang: tid
                for lang in self.allowed_languages
                if (tid := self.all_lang_ids.get(lang) or self._first_lang_token_id(lang))
                is not None
            }
            if self.allowed_languages
            else {}
        )
        self.germanic_kin_ids = (
            tuple(
                tid
                for kin in ("Dutch", "Danish")
                if kin not in self.allowed_lang_ids
                and (tid := self.all_lang_ids.get(kin) or self._first_lang_token_id(kin))
                is not None
            )
            if "German" in self.allowed_lang_ids
            else ()
        )
        self.end_token_id = self._end_marker_token_id()
        self.latin_lang_token_ids = frozenset(
            tid for lang, tid in self.all_lang_ids.items() if lang in LATIN_SCRIPT_LANGUAGES
        )
        self._latin_forbidden_token_ids = self._scan_non_latin_script_token_ids()
        self.forbidden_script_token_ids = (
            list(self._latin_forbidden_token_ids)
            if self.allowed_languages
            and all(lang in LATIN_SCRIPT_LANGUAGES for lang in self.allowed_languages)
            else []
        )
        self._forbidden_tensor_cache: dict[str, object] = {}

    def _end_marker_token_id(self) -> int | None:
        if hasattr(self.tokenizer, "convert_tokens_to_ids"):
            tid = self.tokenizer.convert_tokens_to_ids(END_MARKER)
            return tid if isinstance(tid, int) and tid >= 0 else None
        return None

    def _scan_non_latin_script_token_ids(self) -> list[int]:
        if not hasattr(self.tokenizer, "get_vocab") or not hasattr(
            self.tokenizer, "convert_tokens_to_string"
        ):
            return []
        forbidden: list[int] = []
        for tok, tid in self.tokenizer.get_vocab().items():
            if not isinstance(tok, str) or not isinstance(tid, int) or tid < 0:
                continue
            if _ASCII_BPE_TOKEN_RE.match(tok) or (tok.startswith("<|") and tok.endswith("|>")):
                continue
            if tok == ASR_TEXT_MARKER:
                continue
            piece = self.tokenizer.convert_tokens_to_string([tok])
            raw_body = tok.lstrip(SPACE_MARKER)
            if piece and (
                _DISALLOWED_SCRIPT_RE.search(piece)
                or (
                    "\ufffd" in piece
                    and bool(raw_body)
                    and any(0xE3 <= ord(ch) <= 0xED for ch in raw_body)
                )
            ):
                forbidden.append(tid)
        return sorted(set(forbidden))

    def _resolve_gate_params(
        self, allowed_languages
    ) -> tuple[dict[str, int], tuple[int, ...], list[int]]:
        if allowed_languages is ...:
            req_langs = self.allowed_languages
        else:
            req_langs = parse_allowed_languages(allowed_languages, supported=QWEN_ASR_LANGUAGES)
        if req_langs is None:
            if len(self.all_lang_ids) == len(QWEN_ASR_LANGUAGES):
                return self.all_lang_ids, (), []
            return {}, (), []
        if req_langs == self.allowed_languages:
            return self.allowed_lang_ids, self.germanic_kin_ids, self.forbidden_script_token_ids
        req_ids = {
            lang: tid
            for lang in req_langs
            if (tid := self.all_lang_ids.get(lang) or self._first_lang_token_id(lang)) is not None
        }
        kin_ids = (
            tuple(
                tid
                for kin in ("Dutch", "Danish")
                if kin not in req_ids
                and (tid := self.all_lang_ids.get(kin) or self._first_lang_token_id(kin))
                is not None
            )
            if "German" in req_ids
            else ()
        )
        forb_ids = (
            self._latin_forbidden_token_ids
            if all(lang in LATIN_SCRIPT_LANGUAGES for lang in req_langs)
            else []
        )
        return req_ids, kin_ids, forb_ids

    def _first_lang_token_id(self, lang: str) -> int | None:
        if hasattr(self.tokenizer, "encode"):
            ids = self.tokenizer.encode(" " + lang, add_special_tokens=False)
            return ids[0] if ids else None
        if hasattr(self.tokenizer, "convert_tokens_to_ids"):
            tid = self.tokenizer.convert_tokens_to_ids(SPACE_MARKER + lang)
            return tid if isinstance(tid, int) and tid >= 0 else None
        return None

    def _language_marker_token_id(self) -> int | None:
        if hasattr(self.tokenizer, "encode"):
            ids = self.tokenizer.encode("language", add_special_tokens=False)
            return ids[0] if ids else None
        if hasattr(self.tokenizer, "convert_tokens_to_ids"):
            tid = self.tokenizer.convert_tokens_to_ids("language")
            return tid if isinstance(tid, int) and tid >= 0 else None
        return None

    def transcribe(
        self,
        audio,
        *,
        context_prompt: str | None = None,
        primary_language: str | None = None,
        allowed_languages=...,
    ) -> dict:
        import numpy as np
        import torch

        duration = len(audio) / RATE
        budget = PREFIX_TOKENS + math.ceil(duration * TOKENS_PER_SECOND)
        clean_prompt = " ".join((context_prompt or "").split())[:600] or None
        allowed_ids, kin_ids, forbidden_ids = self._resolve_gate_params(allowed_languages)
        # Gently normalize quiet microphone segments before boundary padding so
        # synthetic silence stays exact zero and never skews active-speech RMS.
        leveled = normalize_audio_rms(audio)
        # 0.3 s of silence on each boundary prevents Qwen3-ASR's Conv2d audio
        # frontend from clipping segment-initial or segment-final words.
        padded = np.pad(leveled, (PAD_SAMPLES, PAD_SAMPLES)) if len(leveled) else leveled
        if hasattr(self.processor, "apply_chat_template") and callable(self.processor):
            messages = []
            if clean_prompt is not None:
                messages.append(
                    {"role": "system", "content": [{"type": "text", "text": clean_prompt}]}
                )
            messages.append({"role": "user", "content": [{"type": "audio", "audio": padded}]})
            conversations = [messages]
            prompt = self.processor.apply_chat_template(
                conversations, tokenize=False, add_generation_prompt=True
            )
            inputs = self.processor(text=prompt, audio=[padded], return_tensors="pt")
        elif clean_prompt is not None:
            inputs = self.processor.apply_transcription_request(audio=padded, prompt=clean_prompt)
        else:
            inputs = self.processor.apply_transcription_request(audio=padded)
        if hasattr(inputs, "items") and any(
            hasattr(v, "is_floating_point") for v in inputs.values()
        ):
            inputs = {
                k: v.to(
                    device=self.network.device,
                    dtype=self.network.dtype if v.is_floating_point() else None,
                )
                if hasattr(v, "to")
                else v
                for k, v in inputs.items()
            }
        else:
            inputs = inputs.to(self.network.device, self.network.dtype)

        prompt_len = inputs["input_ids"].shape[1]
        gen_kwargs = {}
        latin_lang_ids = self.latin_lang_token_ids
        dynamic_latin_forbidden = self._latin_forbidden_token_ids
        if allowed_ids or forbidden_ids or (latin_lang_ids and dynamic_latin_forbidden):
            lang_marker_id = self.language_token_id
            none_id = self.none_token_id
            end_id = self.end_token_id

            def _apply_forbidden_mask(scores, token_ids: list[int], cache_suffix: str):
                if hasattr(torch, "tensor") and hasattr(scores, "device"):
                    dev_key = f"{scores.device}:{cache_suffix}"
                    idx = self._forbidden_tensor_cache.get(dev_key)
                    if idx is None:
                        idx = torch.tensor(token_ids, dtype=torch.long, device=scores.device)
                        self._forbidden_tensor_cache[dev_key] = idx
                else:
                    idx = token_ids
                masked = scores.clone()
                masked[:, idx] = float("-inf")
                return masked

            def gate_step(input_ids, scores):
                step_pos = input_ids.shape[1] - prompt_len
                if (
                    allowed_ids
                    and step_pos == 1
                    and (lang_marker_id is None or int(input_ids[0, -1]) == lang_marker_id)
                ):
                    return apply_language_step_gate(
                        scores,
                        allowed_ids,
                        none_id,
                        kin_ids,
                        duration=duration,
                        primary_language=primary_language,
                    )
                if (
                    none_id is not None
                    and end_id is not None
                    and step_pos >= 3
                    and int(input_ids[0, prompt_len + 1]) == none_id
                ):
                    masked = torch.full_like(scores, float("-inf"))
                    masked[:, end_id] = scores[:, end_id]
                    return masked
                if forbidden_ids and step_pos >= 2:
                    return _apply_forbidden_mask(scores, forbidden_ids, "explicit")
                if (
                    not forbidden_ids
                    and dynamic_latin_forbidden
                    and latin_lang_ids
                    and step_pos >= 2
                    and input_ids.shape[1] > prompt_len + 1
                    and int(input_ids[0, prompt_len + 1]) in latin_lang_ids
                ):
                    return _apply_forbidden_mask(scores, dynamic_latin_forbidden, "latin_dynamic")
                return scores

            gen_kwargs["logits_processor"] = [gate_step]

        with torch.inference_mode():
            out = self.network.generate(
                **inputs,
                max_new_tokens=budget,
                do_sample=False,
                output_scores=True,
                return_dict_in_generate=True,
                **gen_kwargs,
            )
            probs = (
                self.network.compute_transition_scores(
                    out.sequences, out.scores, normalize_logits=True
                )[0]
                .exp()
                .tolist()
            )
        generated = out.sequences[0, inputs["input_ids"].shape[1] :].tolist()
        tokens = self.tokenizer.convert_ids_to_tokens(generated)
        parsed = self.processor.decode([generated], return_format="parsed")[0]
        language = parsed.get("language")
        if language == "None" or (
            len(tokens) >= 2
            and tokens[0] == "language"
            and tokens[1] in (SPACE_MARKER + "None", "None")
        ):
            return {
                "text": "",
                "language": None,
                "words": [],
                "truncated": False,
            }
        text = " ".join(str(parsed.get("transcription") or "").split())
        truncated = END_MARKER not in tokens
        words = []
        if ASR_TEXT_MARKER in tokens:
            start = tokens.index(ASR_TEXT_MARKER) + 1
            words = assemble_words(
                tokens[start:], probs[start:], self.tokenizer.convert_tokens_to_string
            )
        if " ".join(w["word"] for w in words) != text:
            # Token grouping must reproduce the parsed transcript exactly;
            # otherwise keep the words and leave confidence unknown.
            words = [{"word": word} for word in text.split()]
        return {
            "text": text,
            "language": language if isinstance(language, str) and language != "None" else None,
            "words": words,
            "truncated": truncated,
        }


def assemble_parakeet_words(
    tokens: list[str] | None,
    timestamps: list[float] | None,
    logprobs: list[float] | None,
    *,
    text: str,
    duration: float,
    pad_seconds: float = 0.0,
) -> list[dict]:
    """Group Parakeet SentencePiece tokens into timed words with calibrated confidence."""
    clean_text = " ".join((text or "").split())
    if not clean_text:
        return []
    if not tokens:
        return [{"word": w} for w in clean_text.split()]

    has_ts = timestamps is not None and len(timestamps) == len(tokens)
    has_lp = logprobs is not None and len(logprobs) == len(tokens)

    groups: list[dict] = []
    for idx, raw_tok in enumerate(tokens):
        tok = str(raw_tok or "")
        if not tok:
            continue
        starts_word = tok.startswith((SENTENCEPIECE_SPACE, " "))
        piece = tok.lstrip(SENTENCEPIECE_SPACE + " ")
        if not piece:
            continue
        ts_val = float(timestamps[idx]) if has_ts and timestamps is not None else None
        prob_val: float | None = None
        if has_lp and logprobs is not None:
            try:
                raw_lp = float(logprobs[idx])
                if math.isfinite(raw_lp):
                    prob_val = _clamp_confidence(math.exp(min(0.0, raw_lp)))
            except TypeError, ValueError, OverflowError:
                prob_val = None
        if not groups or starts_word:
            groups.append({"pieces": [piece], "timestamps": [], "probs": []})
        else:
            groups[-1]["pieces"].append(piece)
        if ts_val is not None and math.isfinite(ts_val):
            groups[-1]["timestamps"].append(ts_val)
        if prob_val is not None:
            groups[-1]["probs"].append(prob_val)

    words: list[dict] = []
    safe_dur = max(0.0, float(duration))
    for g_idx, grp in enumerate(groups):
        word_str = "".join(grp["pieces"]).strip()
        if not word_str:
            continue
        item: dict = {"word": word_str}
        if has_ts and grp["timestamps"]:
            raw_start = grp["timestamps"][0] - pad_seconds
            start_s = max(0.0, min(safe_dur, raw_start))
            next_start: float | None = None
            for nxt in groups[g_idx + 1 :]:
                if nxt["timestamps"]:
                    next_start = max(start_s, min(safe_dur, nxt["timestamps"][0] - pad_seconds))
                    break
            raw_last = min(
                safe_dur,
                max(start_s + 0.08, grp["timestamps"][-1] - pad_seconds + 0.08),
            )
            end_s = min(raw_last, next_start) if next_start is not None else raw_last
            end_s = max(start_s, min(safe_dur, end_s))
            item["start"] = round(start_s, 3)
            item["end"] = round(end_s, 3)
        if grp["probs"]:
            item["confidence"] = round(sum(grp["probs"]) / len(grp["probs"]), 4)
        words.append(item)

    if not words:
        return [{"word": w} for w in clean_text.split()]
    if has_ts and any("start" not in w or "end" not in w for w in words):
        # segment_result requires either every word timed or none.
        for w in words:
            w.pop("start", None)
            w.pop("end", None)
    return words


class ParakeetASR:
    backend = "parakeet"
    supports_context_prompt = False
    supported_languages = PARAKEET_ASR_LANGUAGES

    def __init__(
        self,
        adapter,
        *,
        device: str = "cpu",
        quantization: str = "int8",
        model_repo: str = DEFAULT_PARAKEET_MODEL_REPO,
        model_revision: str = DEFAULT_PARAKEET_MODEL_REVISION,
    ):
        self.adapter = adapter
        self.device = device
        self.quantization = quantization
        self.model_repo = model_repo
        self.model_revision = model_revision

    def transcribe(
        self,
        audio,
        *,
        context_prompt: str | None = None,
        primary_language: str | None = None,
        allowed_languages=...,
    ) -> dict:
        import numpy as np

        _ = (context_prompt, primary_language, allowed_languages)
        duration = len(audio) / RATE
        leveled = normalize_audio_rms(audio)
        pad_samples = PAD_SAMPLES if len(leveled) else 0
        padded = np.pad(leveled, (pad_samples, pad_samples)) if pad_samples else leveled
        raw = self.adapter.recognize(padded, sample_rate=RATE)
        text = " ".join(str(getattr(raw, "text", raw) or "").split())
        tokens = getattr(raw, "tokens", None)
        timestamps = getattr(raw, "timestamps", None)
        logprobs = getattr(raw, "logprobs", None)
        words = assemble_parakeet_words(
            tokens,
            timestamps,
            logprobs,
            text=text,
            duration=duration,
            pad_seconds=pad_samples / RATE,
        )
        return {
            "text": text,
            "language": None,
            "words": words,
            "truncated": False,
        }


def resolve_asr_backend() -> str:
    raw = os.environ.get("WORTLAUT_ASR_BACKEND", DEFAULT_BACKEND).strip().lower()
    if raw in ("", "qwen3", "qwen3-asr", "qwen"):
        return "qwen3"
    if raw in ("parakeet", "parakeet-tdt", "parakeet-onnx"):
        return "parakeet"
    raise ValueError(f"Unsupported ASR backend '{raw}'. Supported: qwen3, parakeet")


def _resolve_allow_cpu() -> bool:
    return os.environ.get("WORTLAUT_ASR_ALLOW_CPU", "").strip().lower() in ("1", "true", "yes")


def _resolve_device_setting() -> str:
    raw = os.environ.get("WORTLAUT_ASR_DEVICE", "auto").strip().lower()
    if raw in ("", "auto"):
        return "auto"
    if raw in ("cuda", "gpu"):
        return "cuda"
    if raw in ("cpu", "mps"):
        return raw
    raise ValueError(f"Unsupported ASR device '{raw}'. Supported: auto, cuda, cpu, mps")


def _resolve_quantization_setting(backend: str, device: str) -> str:
    raw = os.environ.get("WORTLAUT_ASR_QUANTIZATION", "auto").strip().lower()
    if raw in ("", "auto"):
        if backend == "parakeet":
            return "int8" if device == "cpu" else "fp32"
        if device == "cuda":
            return "bfloat16"
        if device == "mps":
            return "float16"
        return "float32"
    if backend == "parakeet":
        if raw in ("int8", "fp32", "float32"):
            return "fp32" if raw == "float32" else raw
        raise ValueError(f"Unsupported Parakeet quantization '{raw}'. Supported: auto, int8, fp32")
    if raw in ("bfloat16", "bf16"):
        return "bfloat16"
    if raw in ("float16", "fp16"):
        return "float16"
    if raw in ("float32", "fp32"):
        return "float32"
    raise ValueError(
        f"Unsupported Qwen3 quantization '{raw}'. Supported: auto, bfloat16, float16, float32"
    )


def _move_network_to_device(network, device: str) -> None:
    if device == "cuda" and hasattr(network, "parameters") and hasattr(network, "buffers"):
        # Safetensors mmaps weight files; copying directly from file-backed
        # mmap pages into CUDA can stall dramatically on unified memory and
        # container filesystems. Cloning each unique CPU tensor first avoids
        # file-backed page faults inside cudaMemcpy.
        for param in network.parameters():
            if getattr(getattr(param, "device", None), "type", None) == "cpu":
                param.data = param.data.clone().to(device)
        for buf in network.buffers():
            if getattr(getattr(buf, "device", None), "type", None) == "cpu":
                buf.data = buf.data.clone().to(device)
    network.to(device)


def _load_qwen3_model() -> QwenASR:
    import torch
    from transformers import AutoModelForMultimodalLM, AutoProcessor

    requested_device = _resolve_device_setting()
    allow_cpu = _resolve_allow_cpu()
    cuda_available = bool(torch.cuda.is_available())
    mps_backend = getattr(getattr(torch, "backends", None), "mps", None)
    mps_available = bool(mps_backend and mps_backend.is_available())

    if requested_device == "cuda":
        if not cuda_available:
            raise RuntimeError("Qwen3-ASR service requires an NVIDIA GPU")
        device = "cuda"
    elif requested_device == "mps":
        if not mps_available:
            raise RuntimeError("Qwen3-ASR MPS device is unavailable")
        device = "mps"
    elif requested_device == "cpu":
        device = "cpu"
    elif cuda_available:
        device = "cuda"
    elif mps_available:
        device = "mps"
    elif allow_cpu:
        device = "cpu"
    else:
        raise RuntimeError("Qwen3-ASR service requires an NVIDIA GPU")

    quant = _resolve_quantization_setting("qwen3", device)
    dtype_map = {
        "bfloat16": torch.bfloat16,
        "float16": getattr(torch, "float16", torch.float32),
        "float32": torch.float32,
    }
    dtype = dtype_map[quant]

    repo = os.environ.get("WORTLAUT_ASR_MODEL_REPO", "").strip() or MODEL_REPO
    revision = os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip() or MODEL_REVISION
    processor = AutoProcessor.from_pretrained(repo, revision=revision)
    network = AutoModelForMultimodalLM.from_pretrained(repo, revision=revision, dtype=dtype)
    _move_network_to_device(network, device)
    network.eval()
    return QwenASR(
        processor,
        network,
        device=device,
        quantization=quant,
        model_repo=repo,
        model_revision=revision,
    )


def _parakeet_snapshot_patterns(quantization: str) -> list[str]:
    base = ["config.json", "vocab.txt", "nemo128.onnx"]
    if quantization == "int8":
        return [*base, "encoder-model.int8.onnx", "decoder_joint-model.int8.onnx"]
    return [*base, "encoder-model.onnx", "encoder-model.onnx.data", "decoder_joint-model.onnx"]


def _cuda_device_present() -> bool:
    """Verify at runtime that at least one NVIDIA CUDA device is actually accessible."""
    torch_mod = sys.modules.get("torch")
    if torch_mod is not None:
        cuda_mod = getattr(torch_mod, "cuda", None)
        if cuda_mod is not None and callable(getattr(cuda_mod, "is_available", None)):
            return bool(cuda_mod.is_available())
    try:
        import ctypes

        libcuda = ctypes.CDLL("libcuda.so.1")
        if libcuda.cuInit(0) != 0:
            return False
        count = ctypes.c_int(0)
        if libcuda.cuDeviceGetCount(ctypes.byref(count)) != 0:
            return False
        return count.value > 0
    except OSError, AttributeError:
        return False


def _parakeet_cuda_available(ort) -> bool:
    return "CUDAExecutionProvider" in ort.get_available_providers() and _cuda_device_present()


def _parakeet_local_dir(repo: str, revision: str) -> str:
    """Return a symlink-free cache directory for Parakeet ONNX external data files.

    ONNX Runtime >= 1.20 rejects external `.onnx.data` files when Hugging Face's
    default blob cache resolves the model and its external data symlinks into
    different `blobs/<prefix>/` directories.
    """
    cache_root = (
        os.environ.get("HF_HOME", "").strip()
        or os.environ.get("XDG_CACHE_HOME", "").strip()
        or "/tmp"  # noqa: S108
    )
    safe_repo = re.sub(r"[^A-Za-z0-9._-]+", "_", repo).strip("_") or "parakeet"
    safe_rev = re.sub(r"[^A-Za-z0-9._-]+", "_", revision).strip("_") or "default"
    return os.path.join(cache_root, "parakeet-onnx", safe_repo, safe_rev)


def _load_parakeet_model() -> ParakeetASR:
    import onnx_asr
    import onnxruntime as ort
    from huggingface_hub import snapshot_download

    requested_device = _resolve_device_setting()
    allow_cpu = _resolve_allow_cpu()
    cuda_available = _parakeet_cuda_available(ort)

    if requested_device == "cuda":
        if not cuda_available:
            raise RuntimeError("Parakeet GPU inference requires CUDAExecutionProvider")
        device = "cuda"
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    elif requested_device == "cpu":
        device = "cpu"
        providers = ["CPUExecutionProvider"]
    elif requested_device == "mps":
        # ONNX Runtime on macOS runs Parakeet TDT most reliably on CPU (INT8).
        device = "cpu"
        providers = ["CPUExecutionProvider"]
    elif cuda_available:
        device = "cuda"
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    elif allow_cpu:
        device = "cpu"
        providers = ["CPUExecutionProvider"]
    else:
        raise RuntimeError(
            "Parakeet ASR requires an NVIDIA GPU unless WORTLAUT_ASR_DEVICE=cpu "
            "or WORTLAUT_ASR_ALLOW_CPU=true"
        )

    quant = _resolve_quantization_setting("parakeet", device)
    repo = os.environ.get("WORTLAUT_ASR_MODEL_REPO", "").strip() or DEFAULT_PARAKEET_MODEL_REPO
    revision = (
        os.environ.get("WORTLAUT_ASR_MODEL_REVISION", "").strip() or DEFAULT_PARAKEET_MODEL_REVISION
    )
    target_dir = _parakeet_local_dir(repo, revision)
    local_dir = snapshot_download(
        repo_id=repo,
        revision=revision,
        allow_patterns=_parakeet_snapshot_patterns(quant),
        local_dir=target_dir,
    )
    if device == "cuda" and hasattr(ort, "preload_dlls"):
        ort.preload_dlls(cuda=True, cudnn=True)
    loaded = onnx_asr.load_model(
        "nemo-parakeet-tdt-0.6b-v3",
        path=local_dir,
        quantization="int8" if quant == "int8" else None,
        providers=providers,
    )
    adapter = loaded.with_timestamps() if hasattr(loaded, "with_timestamps") else loaded
    return ParakeetASR(
        adapter,
        device=device,
        quantization=quant,
        model_repo=repo,
        model_revision=revision,
    )


def load_model():
    backend = resolve_asr_backend()
    if backend == "parakeet":
        return _load_parakeet_model()
    return _load_qwen3_model()


@asynccontextmanager
async def lifespan(app):
    global model
    if not os.environ.get("WORTLAUT_ASR_TOKEN"):
        raise RuntimeError("ASR credential missing")
    model = await run_in_threadpool(load_model)
    yield


app = FastAPI(title="wortlaut ASR", lifespan=lifespan)


@app.get("/health/ready")
def ready():
    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable; process restart required")
    if model is None:
        raise HTTPException(503, "Model loading")
    supported_langs = getattr(model, "supported_languages", QWEN_ASR_LANGUAGES)
    return {
        "status": "ready",
        "backend": getattr(model, "backend", DEFAULT_BACKEND),
        "device": getattr(model, "device", "unknown"),
        "quantization": getattr(model, "quantization", "unknown"),
        "model": getattr(model, "model_repo", MODEL_REPO),
        "model_revision": getattr(model, "model_revision", MODEL_REVISION),
        "supports_context_prompt": bool(getattr(model, "supports_context_prompt", True)),
        "supported_languages": list(supported_langs),
        "default_languages": os.environ.get("WORTLAUT_ASR_LANGUAGES", DEFAULT_ASR_LANGUAGES),
    }


@app.get("/health/live")
def live():
    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable; process restart required")
    return {"status": "alive"}


def _torch_error_types():
    torch_mod = sys.modules.get("torch")
    if torch_mod is None:
        return (), (), None
    accel = getattr(torch_mod, "AcceleratorError", None)
    oom = getattr(torch_mod, "OutOfMemoryError", None)
    return (
        (accel,) if isinstance(accel, type) and issubclass(accel, BaseException) else (),
        (oom,) if isinstance(oom, type) and issubclass(oom, BaseException) else (),
        torch_mod,
    )


def _classify_onnx_gpu_error(exc: Exception) -> str | None:
    mod_name = type(exc).__module__ or ""
    if not mod_name.startswith("onnxruntime"):
        return None
    msg = str(exc).lower()
    if any(
        needle in msg
        for needle in (
            "out of memory",
            "failed to allocate memory",
            "cudamalloc",
            "bfcarena",
            "bfc_arena",
        )
    ):
        return "oom"
    if any(
        needle in msg
        for needle in (
            "cudaerror",
            "cuda failure",
            "cuda runtime",
            "cudnn",
            "cublas",
            "cuda execution provider",
        )
    ):
        return "fatal"
    return None


def infer(
    pcm,
    identifier,
    context_prompt: str | None = None,
    primary_language: str | None = None,
    allowed_languages=...,
):
    import numpy as np

    if accelerator_failed.is_set():
        raise HTTPException(503, "GPU unavailable")
    if model is None:
        raise HTTPException(503, "Model loading")
    if not lock.acquire(blocking=False):
        raise HTTPException(429, "Inference busy", headers={"Retry-After": "5"})
    accel_errors, oom_errors, torch_mod = _torch_error_types()
    try:
        if accelerator_failed.is_set():
            raise HTTPException(503, "GPU unavailable")
        if model is None:
            raise HTTPException(503, "Model loading")
        # The lock belongs to the synchronous inference thread. Disconnecting
        # the HTTP client never releases it while CUDA is still working.
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        extra = {} if allowed_languages is ... else {"allowed_languages": allowed_languages}
        result = model.transcribe(
            audio,
            context_prompt=context_prompt,
            primary_language=primary_language,
            **extra,
        )
        return {"job_id": identifier, "pcm_sha256": hashlib.sha256(pcm).hexdigest(), **result}
    except Exception as exc:
        onnx_gpu_err = _classify_onnx_gpu_error(exc)
        if (accel_errors and isinstance(exc, accel_errors)) or onnx_gpu_err == "fatal":
            # An unusable CUDA/MPS client must stop receiving more jobs. The
            # liveness probe replaces only this process, not shared GPU services.
            accelerator_failed.set()
            raise HTTPException(503, "GPU unavailable") from None
        if (oom_errors and isinstance(exc, oom_errors)) or onnx_gpu_err == "oom":
            # The GPU is shared; a transient allocation failure leaves this CUDA
            # client usable. Release cached blocks and let the job retry later.
            cuda_mod = getattr(torch_mod, "cuda", None)
            if cuda_mod is not None and hasattr(cuda_mod, "empty_cache"):
                cuda_mod.empty_cache()
            raise HTTPException(
                503, "GPU memory exhausted", headers={"Retry-After": "30"}
            ) from None
        raise
    finally:
        lock.release()


def _decode_context_header(raw_b64: str | None) -> str | None:
    if not raw_b64:
        return None
    if len(raw_b64) > 2048:
        raise HTTPException(400, "Context prompt exceeds limit")
    try:
        decoded = base64.b64decode(raw_b64.encode("ascii"), validate=True).decode("utf-8")
    except binascii.Error, UnicodeDecodeError:
        raise HTTPException(400, "Invalid context prompt encoding") from None
    cleaned = " ".join(decoded.split())[:600]
    return cleaned or None


@app.post("/v1/transcribe")
async def transcribe(
    request: Request,
    authorization: str | None = Header(default=None),
    x_job_id: str = Header(min_length=64, max_length=64),
    x_asr_context_b64: str | None = Header(default=None, max_length=2048),
    x_primary_language: str | None = Header(default=None, max_length=64),
    x_asr_languages: str | None = Header(default=None, max_length=512),
):
    token = os.environ.get("WORTLAUT_ASR_TOKEN", "")
    if not token or not secrets.compare_digest(authorization or "", "Bearer " + token):
        raise HTTPException(401, "Invalid ASR credential")
    if any(c not in "0123456789abcdef" for c in x_job_id):
        raise HTTPException(400, "Invalid job identifier")
    context_prompt = _decode_context_header(x_asr_context_b64)
    primary_lang = (x_primary_language or "").strip()[:64] or None
    req_languages = ...
    if x_asr_languages is not None and x_asr_languages.strip():
        supported_langs = (
            QWEN_ASR_LANGUAGES
            if getattr(model, "backend", None) == "qwen3"
            else ALL_KNOWN_ASR_LANGUAGES
        )
        try:
            parse_allowed_languages(x_asr_languages, supported=supported_langs)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        req_languages = x_asr_languages.strip()
    pcm = bytearray()
    async for part in request.stream():
        pcm.extend(part)
        if len(pcm) > MAX_BYTES:
            raise HTTPException(413, "Audio exceeds segment limit")
    if not pcm or len(pcm) % 2:
        raise HTTPException(400, "Expected mono PCM16/16kHz")
    return await run_in_threadpool(
        infer, bytes(pcm), x_job_id, context_prompt, primary_lang, req_languages
    )
