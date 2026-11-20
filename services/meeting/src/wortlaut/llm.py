"""Unified OpenAI-compatible `/chat/completions` and Ollama `/api/chat` JSON client."""

from __future__ import annotations

import base64
import json
import re
import threading
import time
from typing import Any

import httpx

from wortlaut.settings import Settings, get_settings

_EXPANSION_SEMAPHORE = threading.BoundedSemaphore(4)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_UNSAFE_TERM_CHARS_RE = re.compile(r"[\"'\\`\x00-\x1f\x7f]+")
_REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")
_OPENAI_RETRY_HINTS = (
    "response_format",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
)


def _is_reasoning_model(model_name: str) -> bool:
    base = (model_name or "").strip().rsplit("/", 1)[-1].lower()
    return base.startswith(_REASONING_PREFIXES)


def _extract_json_object(raw_text: str, *, error_code: str = "llm_invalid_json") -> dict[str, Any]:
    cleaned = _FENCE_RE.sub("", (raw_text or "").strip()).strip()
    if not cleaned:
        raise RuntimeError(error_code)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
    raise RuntimeError(error_code)


def _extract_openai_content(payload: object) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("llm_invalid_json")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("llm_invalid_json")
    first = choices[0]
    if not isinstance(first, dict):
        raise RuntimeError("llm_invalid_json")
    msg = first.get("message")
    if not isinstance(msg, dict):
        raise RuntimeError("llm_invalid_json")
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    raise RuntimeError("llm_invalid_json")


def chat_completion_json(
    *,
    system_prompt: str,
    user_prompt: str,
    settings: Settings | None = None,
    timeout_seconds: float,
    max_tokens: int = 4096,
    temperature: float = 0.1,
    image_png_bytes: bytes | None = None,
    ollama_num_ctx: int | None = None,
    allow_ollama_fallback: bool = True,
    require_summary_opt_in: bool = True,
) -> dict[str, Any]:
    """Execute a JSON chat completion against OpenAI `/chat/completions` or Ollama `/api/chat`."""
    settings = settings or get_settings()
    if require_summary_opt_in and not settings.enable_llm_summary:
        raise RuntimeError("llm_summary_disabled")

    if settings.openai_chat_configured():
        url = (settings.openai_base_url or "").strip().rstrip("/") + "/chat/completions"
        headers: dict[str, str] = {}
        if settings.openai_api_key is not None:
            raw_key = settings.openai_api_key.get_secret_value().strip()
            if raw_key:
                headers["Authorization"] = f"Bearer {raw_key}"

        if image_png_bytes:
            b64 = base64.b64encode(image_png_bytes).decode("ascii")
            user_content: str | list[dict[str, Any]] = [
                {"type": "text", "text": user_prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{b64}"},
                },
            ]
        else:
            user_content = user_prompt

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        body: dict[str, Any] = {
            "model": settings.openai_model,
            "messages": messages,
            "response_format": {"type": "json_object"},
        }
        if _is_reasoning_model(settings.openai_model):
            body["max_completion_tokens"] = max(int(max_tokens), 512)
            body["reasoning_effort"] = "low"
        else:
            body["temperature"] = float(temperature)
            body["max_tokens"] = int(max_tokens)

        deadline = time.monotonic() + float(timeout_seconds)
        try:
            resp = httpx.post(
                url,
                headers=headers,
                json=body,
                follow_redirects=False,
                timeout=float(timeout_seconds),
            )
            if resp.status_code == 400:
                err_lower = (resp.text or "").lower()
                remaining = deadline - time.monotonic()
                if remaining > 0.15 and any(hint in err_lower for hint in _OPENAI_RETRY_HINTS):
                    resp = httpx.post(
                        url,
                        headers=headers,
                        json={"model": settings.openai_model, "messages": messages},
                        follow_redirects=False,
                        timeout=remaining,
                    )
        except httpx.TimeoutException as exc:
            raise RuntimeError("llm_timeout") from exc
        except httpx.HTTPError as exc:
            raise RuntimeError("llm_unreachable") from exc

        if resp.status_code != 200:
            raise RuntimeError(f"llm_http_{resp.status_code}")

        try:
            payload = resp.json()
        except ValueError as exc:
            raise RuntimeError("llm_invalid_json") from exc
        raw_content = _extract_openai_content(payload)
        return _extract_json_object(raw_content, error_code="llm_invalid_json")

    if (
        allow_ollama_fallback
        and settings.enable_llm_summary
        and bool((settings.ollama_url or "").strip())
    ):
        url = settings.ollama_url.rstrip("/") + "/api/chat"
        user_msg: dict[str, Any] = {"role": "user", "content": user_prompt}
        if image_png_bytes:
            user_msg["images"] = [base64.b64encode(image_png_bytes).decode("ascii")]
        eff_ctx = int(ollama_num_ctx or (8192 if image_png_bytes else 32768))
        try:
            resp = httpx.post(
                url,
                json={
                    "model": settings.ollama_model,
                    "think": False,
                    "stream": False,
                    "format": "json",
                    "options": {"num_ctx": eff_ctx, "temperature": float(temperature)},
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        user_msg,
                    ],
                },
                follow_redirects=False,
                timeout=float(timeout_seconds),
            )
        except httpx.TimeoutException as exc:
            raise RuntimeError("ollama_timeout") from exc
        except httpx.HTTPError as exc:
            raise RuntimeError("ollama_unreachable") from exc

        if resp.status_code != 200:
            raise RuntimeError(f"ollama_http_{resp.status_code}")
        try:
            raw_content = (resp.json().get("message") or {}).get("content") or ""
        except (ValueError, AttributeError, TypeError) as exc:
            raise RuntimeError("ollama_invalid_json") from exc
        return _extract_json_object(str(raw_content), error_code="ollama_invalid_json")

    raise RuntimeError("llm_not_configured")


def expand_search_query(
    query: str,
    glossary_terms: list[str],
    *,
    settings: Settings | None = None,
) -> list[str]:
    """Expand a short search query via OpenAI `/chat/completions` without transcript egress."""
    settings = settings or get_settings()
    q_clean = " ".join((query or "").split())[:300]
    if not q_clean or not settings.openai_chat_configured():
        return []
    if not _EXPANSION_SEMAPHORE.acquire(blocking=False):
        return []
    try:
        known = ", ".join(" ".join(str(t).split())[:60] for t in glossary_terms[:40] if t)
        sys_prompt = (
            'Return a JSON object {"terms": ["..."]} with up to 6 concise German or English '
            "synonyms, word stems, or domain abbreviations for meeting search. "
            "Do not repeat the full query or invent unrelated topics."
        )
        usr_prompt = (
            f"Query: {q_clean}\n"
            f"Known glossary terms: {known or '(none)'}\n"
            "Respond in JSON."
        )
        parsed = chat_completion_json(
            system_prompt=sys_prompt,
            user_prompt=usr_prompt,
            settings=settings,
            timeout_seconds=float(settings.rag_query_expansion_timeout_seconds),
            max_tokens=80,
            temperature=0.0,
            allow_ollama_fallback=False,
            require_summary_opt_in=False,
        )
    except Exception:
        return []
    finally:
        _EXPANSION_SEMAPHORE.release()

    raw_terms = parsed.get("terms")
    if not isinstance(raw_terms, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = {q_clean.lower()}
    for item in raw_terms:
        if not isinstance(item, str):
            continue
        sanitized = " ".join(_UNSAFE_TERM_CHARS_RE.sub(" ", item).split())[:60]
        low = sanitized.lower()
        if len(sanitized) >= 2 and low not in seen and any(ch.isalnum() for ch in sanitized):
            seen.add(low)
            cleaned.append(sanitized)
            if len(cleaned) >= 6:
                break
    return cleaned
