"""Canonical Qwen3-ASR 30-language registry, alias normalization, and display helpers."""

import re

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

_CANONICAL_LOWER: dict[str, str] = {lang.lower(): lang for lang in QWEN_ASR_LANGUAGES}

LANGUAGE_ALIASES: dict[str, str] = {
    **_CANONICAL_LOWER,
    # ISO-639 codes & common regional tags
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "zh-sg": "Chinese",
    "zh-tw": "Chinese",
    "zh-hans": "Chinese",
    "zh-hant": "Chinese",
    "cmn": "Chinese",
    "mandarin": "Chinese",
    "chinesisch": "Chinese",
    "中文": "Chinese",
    "汉语": "Chinese",
    "普通话": "Chinese",
    "en": "English",
    "en-us": "English",
    "en-gb": "English",
    "en-au": "English",
    "en-ca": "English",
    "eng": "English",
    "englisch": "English",
    "yue": "Cantonese",
    "zh-hk": "Cantonese",
    "zh-yue": "Cantonese",
    "kantonesisch": "Cantonese",
    "粵語": "Cantonese",
    "粤语": "Cantonese",
    "广东话": "Cantonese",
    "ar": "Arabic",
    "ara": "Arabic",
    "arabisch": "Arabic",
    "العربية": "Arabic",
    "de": "German",
    "de-de": "German",
    "de-at": "German",
    "de-ch": "German",
    "deu": "German",
    "ger": "German",
    "deutsch": "German",
    "fr": "French",
    "fr-fr": "French",
    "fr-ca": "French",
    "fr-ch": "French",
    "fra": "French",
    "fre": "French",
    "französisch": "French",
    "franzoesisch": "French",
    "français": "French",
    "francais": "French",
    "es": "Spanish",
    "es-es": "Spanish",
    "es-mx": "Spanish",
    "es-419": "Spanish",
    "spa": "Spanish",
    "spanisch": "Spanish",
    "español": "Spanish",
    "espanol": "Spanish",
    "pt": "Portuguese",
    "pt-pt": "Portuguese",
    "pt-br": "Portuguese",
    "por": "Portuguese",
    "portugiesisch": "Portuguese",
    "português": "Portuguese",
    "portugues": "Portuguese",
    "id": "Indonesian",
    "id-id": "Indonesian",
    "ind": "Indonesian",
    "indonesisch": "Indonesian",
    "bahasa indonesia": "Indonesian",
    "it": "Italian",
    "it-it": "Italian",
    "ita": "Italian",
    "italienisch": "Italian",
    "italiano": "Italian",
    "ko": "Korean",
    "ko-kr": "Korean",
    "kor": "Korean",
    "koreanisch": "Korean",
    "한국어": "Korean",
    "ru": "Russian",
    "ru-ru": "Russian",
    "rus": "Russian",
    "russisch": "Russian",
    "русский": "Russian",
    "th": "Thai",
    "th-th": "Thai",
    "tha": "Thai",
    "thailändisch": "Thai",
    "thailaendisch": "Thai",
    "ไทย": "Thai",
    "vi": "Vietnamese",
    "vi-vn": "Vietnamese",
    "vie": "Vietnamese",
    "vietnamesisch": "Vietnamese",
    "tiếng việt": "Vietnamese",
    "tieng viet": "Vietnamese",
    "ja": "Japanese",
    "ja-jp": "Japanese",
    "jp": "Japanese",
    "jpn": "Japanese",
    "japanisch": "Japanese",
    "日本語": "Japanese",
    "tr": "Turkish",
    "tr-tr": "Turkish",
    "tur": "Turkish",
    "türkisch": "Turkish",
    "tuerkisch": "Turkish",
    "türkçe": "Turkish",
    "turkce": "Turkish",
    "hi": "Hindi",
    "hi-in": "Hindi",
    "hin": "Hindi",
    "हिन्दी": "Hindi",
    "हिंदी": "Hindi",
    "ms": "Malay",
    "ms-my": "Malay",
    "msa": "Malay",
    "may": "Malay",
    "malaiisch": "Malay",
    "bahasa melayu": "Malay",
    "nl": "Dutch",
    "nl-nl": "Dutch",
    "nl-be": "Dutch",
    "nld": "Dutch",
    "dut": "Dutch",
    "niederländisch": "Dutch",
    "niederlaendisch": "Dutch",
    "holländisch": "Dutch",
    "nederlands": "Dutch",
    "sv": "Swedish",
    "sv-se": "Swedish",
    "swe": "Swedish",
    "schwedisch": "Swedish",
    "svenska": "Swedish",
    "da": "Danish",
    "da-dk": "Danish",
    "dan": "Danish",
    "dänisch": "Danish",
    "daenisch": "Danish",
    "dansk": "Danish",
    "fi": "Finnish",
    "fi-fi": "Finnish",
    "fin": "Finnish",
    "finnisch": "Finnish",
    "suomi": "Finnish",
    "pl": "Polish",
    "pl-pl": "Polish",
    "pol": "Polish",
    "polnisch": "Polish",
    "polski": "Polish",
    "cs": "Czech",
    "cs-cz": "Czech",
    "cz": "Czech",
    "ces": "Czech",
    "cze": "Czech",
    "tschechisch": "Czech",
    "čeština": "Czech",
    "cestina": "Czech",
    "fil": "Filipino",
    "tl": "Filipino",
    "tl-ph": "Filipino",
    "tagalog": "Filipino",
    "fa": "Persian",
    "fa-ir": "Persian",
    "fas": "Persian",
    "per": "Persian",
    "farsi": "Persian",
    "persisch": "Persian",
    "فارسی": "Persian",
    "el": "Greek",
    "el-gr": "Greek",
    "gr": "Greek",
    "ell": "Greek",
    "gre": "Greek",
    "griechisch": "Greek",
    "ελληνικά": "Greek",
    "hu": "Hungarian",
    "hu-hu": "Hungarian",
    "hun": "Hungarian",
    "ungarisch": "Hungarian",
    "magyar": "Hungarian",
    "mk": "Macedonian",
    "mk-mk": "Macedonian",
    "mkd": "Macedonian",
    "mac": "Macedonian",
    "mazedonisch": "Macedonian",
    "македонски": "Macedonian",
    "ro": "Romanian",
    "ro-ro": "Romanian",
    "ron": "Romanian",
    "rum": "Romanian",
    "rumänisch": "Romanian",
    "rumaenisch": "Romanian",
    "română": "Romanian",
    "romana": "Romanian",
}

_AUTO_TOKENS = frozenset({"*", "auto", "all", "automatisch", "automatic", "multilingual", "alle"})


def normalize_asr_language(raw: str | None) -> str | None:
    """Validate and normalize an ASR language specification.

    Returns:
      - `None` if `raw` is `None` or blank (meaning unset / inherit default),
      - `"auto"` for `*` / `auto` / `all` (all 30 Qwen3-ASR languages),
      - comma-separated canonical Qwen3-ASR language names (e.g. `"Japanese"` or
        `"German,English"`).
    Raises `ValueError` on unrecognized language names.
    """
    if raw is None:
        return None
    cleaned = " ".join(str(raw).split()).strip()
    if not cleaned:
        return None
    if cleaned.lower() in _AUTO_TOKENS:
        return "auto"
    parts = [p.strip() for p in re.split(r"[,+/;&|]+", cleaned) if p.strip()]
    if not parts:
        return None
    resolved: list[str] = []
    seen: set[str] = set()
    for part in parts:
        key = part.lower().replace("_", "-")
        if key in _AUTO_TOKENS:
            return "auto"
        canon = LANGUAGE_ALIASES.get(key)
        if canon is None and "-" in key:
            canon = LANGUAGE_ALIASES.get(key.split("-", 1)[0])
        if canon is None:
            raise ValueError(
                f"Unsupported Qwen3-ASR language '{part}'. "
                f"Supported: auto (*) or {', '.join(QWEN_ASR_LANGUAGES)}"
            )
        if canon not in seen:
            seen.add(canon)
            resolved.append(canon)
    if len(resolved) >= len(QWEN_ASR_LANGUAGES):
        return "auto"
    return ",".join(resolved)


def to_asr_header_value(lang_spec: str | None) -> str:
    """Convert normalized recording language spec into `X-ASR-Languages` header value."""
    if not lang_spec or lang_spec == "auto":
        return "*"
    return lang_spec


def effective_recording_language(recording_or_meta, settings=None) -> str:
    """Resolve effective normalized ASR language for a Recording (or protocol_meta dict)."""
    meta: dict = {}
    if isinstance(recording_or_meta, dict):
        meta = recording_or_meta
    elif recording_or_meta is not None:
        raw_meta = getattr(recording_or_meta, "protocol_meta", None)
        if isinstance(raw_meta, dict):
            meta = raw_meta
    raw_rec_lang = meta.get("asr_language")
    if isinstance(raw_rec_lang, str) and raw_rec_lang.strip():
        try:
            norm = normalize_asr_language(raw_rec_lang)
            if norm:
                return norm
        except ValueError:
            pass
    if settings is not None:
        raw_default = getattr(settings, "asr_languages", None)
        if isinstance(raw_default, str) and raw_default.strip():
            try:
                norm_def = normalize_asr_language(raw_default)
                if norm_def:
                    return norm_def
            except ValueError:
                pass
    return "auto"
