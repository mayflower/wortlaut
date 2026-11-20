"""Local CPU ONNX embeddings, protocol chunking, out-of-lock indexing, and hybrid RRF search."""

from __future__ import annotations

import copy
import logging
import re
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import onnxruntime as ort
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.orm import Session
from tokenizers import Tokenizer

from wortlaut.domain import apply_recordings_search_filters, parse_date_bound
from wortlaut.exports import (
    export_data,
    group_transcript_turns,
    short_timestamp,
    wall_clock_time_de,
)
from wortlaut.glossary import expand_query_with_local_glossary, resolve_principal_search_glossary
from wortlaut.llm import expand_search_query
from wortlaut.models import ProtocolChunk, Recording
from wortlaut.oidc import Principal
from wortlaut.settings import Settings, get_settings

logger = logging.getLogger("wortlaut")

EMBEDDING_MODEL_ID = "multilingual-e5-small-int8"
LEXICAL_ONLY_MODEL_ID = "lexical-only"
EMBEDDING_DIM = 384
MAX_VECTOR_SCAN_CHUNKS = 20_000
RRF_K = 60
VECTOR_ONLY_MIN_COSINE = 0.65

VALID_CHUNK_KINDS = (
    "decision",
    "action_item",
    "summary",
    "topic",
    "notes",
    "slide",
    "transcript",
)
VALID_SEARCH_KINDS = ("all", *VALID_CHUNK_KINDS)
VALID_PROVIDERS = ("google_meet", "teams", "webex", "zoom")

_MAX_CHUNK_CHARS = 900
_MAX_WINDOW_SECONDS = 60.0
_SILENCE_SPLIT_SECONDS = 4.0
_SILENCE_SPLIT_MIN_CHARS = 300
_MAX_OVERLAP_TURN_CHARS = 200
_EMBED_BATCH_SIZE = 32
_INDEX_BATCH_RECORDINGS = 5

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_QUERY_TOKEN_RE = re.compile(r"[0-9A-Za-zÄÖÜäöüß][0-9A-Za-zÄÖÜäöüß._/-]{1,59}")
_STRIP_WEBSEARCH_RE = re.compile(r"[\"'\\`\x00-\x1f\x7f]+")

EmbedderOverrideFn = Callable[[list[str], str], np.ndarray]

_EMBEDDER_LOCK = threading.Lock()
_EMBEDDER_CACHE: dict[Path, _OnnxEmbedder | None] = {}
_TEST_EMBEDDER_OVERRIDE: EmbedderOverrideFn | None = None

_INSERT_CHUNK_SQL = text(
    """
    INSERT INTO protocol_chunks (
        id, recording_id, chunk_index, chunk_kind, speaker_label,
        start_seconds, end_seconds, wall_clock, keyframe_id, content,
        search_tsv, embedding_model, embedding_dim, embedding
    ) VALUES (
        :id, :recording_id, :chunk_index, :chunk_kind, :speaker_label,
        :start_seconds, :end_seconds, :wall_clock, :keyframe_id, :content,
        setweight(to_tsvector('simple', :header), 'A')
        || setweight(to_tsvector('german', :header), 'A')
        || setweight(to_tsvector('english', :header), 'A')
        || setweight(to_tsvector('simple', :content), 'B')
        || setweight(to_tsvector('german', :content), 'B')
        || setweight(to_tsvector('english', :content), 'B'),
        :embedding_model, :embedding_dim, :embedding
    )
    """
)


@dataclass(frozen=True)
class ChunkSpec:
    chunk_index: int
    chunk_kind: str
    header: str
    content: str
    speaker_label: str | None = None
    start_seconds: float | None = None
    end_seconds: float | None = None
    wall_clock: str | None = None
    keyframe_id: uuid.UUID | None = None


@dataclass(frozen=True)
class SearchHit:
    chunk_id: uuid.UUID
    recording_id: uuid.UUID
    recording_title: str
    recording_provider: str
    recording_starts_at: Any
    chunk_index: int
    chunk_kind: str
    speaker_label: str | None
    start_seconds: float | None
    end_seconds: float | None
    wall_clock: str | None
    keyframe_id: uuid.UUID | None
    content: str
    rrf_score: float


@dataclass(frozen=True)
class SearchResult:
    hits: list[SearchHit]
    scanned_capped: bool
    lexical_only: bool


class _OnnxEmbedder:
    def __init__(self, model_dir: Path) -> None:
        onnx_path = model_dir / "model_quantized.onnx"
        tok_path = model_dir / "tokenizer.json"
        self.tokenizer = Tokenizer.from_file(str(tok_path))
        tok_id = self.tokenizer.token_to_id("<pad>")
        pad_id = tok_id if tok_id is not None else 0
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=pad_id, pad_token="<pad>")

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(onnx_path),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        self.input_names = {inp.name for inp in self.session.get_inputs()}

    def encode(self, texts: list[str], *, prefix: str) -> np.ndarray:
        if not texts:
            return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
        batches: list[np.ndarray] = []
        for i in range(0, len(texts), _EMBED_BATCH_SIZE):
            batch = [f"{prefix}{t}" for t in texts[i : i + _EMBED_BATCH_SIZE]]
            encs = self.tokenizer.encode_batch(batch)
            input_ids = np.asarray([e.ids for e in encs], dtype=np.int64)
            attention_mask = np.asarray([e.attention_mask for e in encs], dtype=np.int64)
            feed: dict[str, np.ndarray] = {}
            if "input_ids" in self.input_names:
                feed["input_ids"] = input_ids
            if "attention_mask" in self.input_names:
                feed["attention_mask"] = attention_mask
            if "token_type_ids" in self.input_names:
                feed["token_type_ids"] = np.zeros_like(input_ids, dtype=np.int64)

            hidden = np.asarray(self.session.run(None, feed)[0], dtype=np.float32)
            if hidden.ndim == 3:
                mask_f = attention_mask[:, :, None].astype(np.float32)
                summed = (hidden * mask_f).sum(axis=1)
                denom = np.maximum(mask_f.sum(axis=1), 1e-9)
                pooled = summed / denom
            else:
                pooled = hidden
            norms = np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
            batches.append((pooled / norms).astype(np.float32, copy=False))
        return np.vstack(batches)


def set_embedder_override_for_tests(fn: EmbedderOverrideFn | None) -> None:
    global _TEST_EMBEDDER_OVERRIDE
    with _EMBEDDER_LOCK:
        _TEST_EMBEDDER_OVERRIDE = fn


def _reset_embedder_for_tests() -> None:
    global _TEST_EMBEDDER_OVERRIDE
    with _EMBEDDER_LOCK:
        _TEST_EMBEDDER_OVERRIDE = None
        _EMBEDDER_CACHE.clear()


def _get_onnx_embedder(settings: Settings | None = None) -> _OnnxEmbedder | None:
    settings = settings or get_settings()
    model_dir = Path(settings.embedding_model_dir)
    with _EMBEDDER_LOCK:
        if model_dir in _EMBEDDER_CACHE:
            return _EMBEDDER_CACHE[model_dir]
        onnx_path = model_dir / "model_quantized.onnx"
        tok_path = model_dir / "tokenizer.json"
        if not (onnx_path.is_file() and tok_path.is_file()):
            logger.warning(
                "rag_onnx_model_unavailable dir=%s; operating in lexical-only mode",
                model_dir,
            )
            _EMBEDDER_CACHE[model_dir] = None
            return None
        embedder = _OnnxEmbedder(model_dir)
        _EMBEDDER_CACHE[model_dir] = embedder
        return embedder


def embedder_is_available(settings: Settings | None = None) -> bool:
    with _EMBEDDER_LOCK:
        if _TEST_EMBEDDER_OVERRIDE is not None:
            return True
    return _get_onnx_embedder(settings) is not None


def active_embedding_model_id(settings: Settings | None = None) -> str:
    return EMBEDDING_MODEL_ID if embedder_is_available(settings) else LEXICAL_ONLY_MODEL_ID


def embed_texts(
    texts: list[str],
    *,
    prefix: Literal["query: ", "passage: "],
    settings: Settings | None = None,
) -> np.ndarray:
    """Return L2-normalized `float32` embeddings `(N, 384)` (or `(N, 0)` in lexical-only mode)."""
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    with _EMBEDDER_LOCK:
        override = _TEST_EMBEDDER_OVERRIDE
    if override is not None:
        vecs = np.asarray(override(list(texts), prefix), dtype=np.float32)
        if vecs.ndim == 1:
            vecs = vecs.reshape(1, -1)
        norms = np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
        return (vecs / norms).astype(np.float32, copy=False)
    embedder = _get_onnx_embedder(settings)
    if embedder is None:
        return np.zeros((len(texts), 0), dtype=np.float32)
    return embedder.encode(texts, prefix=prefix)


def pack_float16_embedding(vec: np.ndarray) -> bytes:
    if vec.size == 0:
        return b""
    return np.asarray(vec, dtype="<f2").tobytes()


def unpack_float16_embeddings(blobs: list[bytes]) -> np.ndarray:
    if not blobs:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    raw = b"".join(blobs)
    return np.frombuffer(raw, dtype="<f2").reshape(len(blobs), EMBEDDING_DIM).astype(np.float32)


def _single_line(raw: object) -> str:
    return " ".join(str(raw or "").split())


def _split_long_text(raw_text: str, max_chars: int = _MAX_CHUNK_CHARS) -> list[str]:
    clean = " ".join((raw_text or "").split())
    if not clean:
        return []
    if len(clean) <= max_chars:
        return [clean]

    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(clean) if s.strip()]
    parts: list[str] = []
    buf = ""
    for sent in sentences:
        if len(sent) > max_chars:
            if buf:
                parts.append(buf)
                buf = ""
            words = sent.split()
            wbuf = ""
            for word in words:
                if len(word) > max_chars:
                    if wbuf:
                        parts.append(wbuf)
                        wbuf = ""
                    for idx in range(0, len(word), max_chars):
                        parts.append(word[idx : idx + max_chars])
                    continue
                cand = f"{wbuf} {word}" if wbuf else word
                if len(cand) <= max_chars:
                    wbuf = cand
                else:
                    if wbuf:
                        parts.append(wbuf)
                    wbuf = word
            if wbuf:
                parts.append(wbuf)
            continue
        cand = f"{buf} {sent}" if buf else sent
        if len(cand) <= max_chars:
            buf = cand
        else:
            if buf:
                parts.append(buf)
            buf = sent
    if buf:
        parts.append(buf)
    return parts


def _split_notes_markdown(notes: str) -> list[str]:
    raw = (notes or "").replace("\r\n", "\n").strip()
    if not raw:
        return []
    blocks: list[str] = []
    cur_lines: list[str] = []
    for line in raw.split("\n"):
        stripped = line.strip()
        if not stripped:
            if cur_lines:
                blocks.append("\n".join(cur_lines).strip())
                cur_lines = []
            continue
        if stripped.startswith("#") and cur_lines:
            blocks.append("\n".join(cur_lines).strip())
            cur_lines = [stripped]
        else:
            cur_lines.append(stripped)
    if cur_lines:
        blocks.append("\n".join(cur_lines).strip())

    out: list[str] = []
    for block in blocks:
        out.extend(_split_long_text(block, _MAX_CHUNK_CHARS))
    return out


def _pause_intervals(export_payload: dict[str, Any]) -> list[tuple[float, float]]:
    intervals: list[tuple[float, float]] = []
    for pw in export_payload.get("pause_windows") or []:
        if not isinstance(pw, dict):
            continue
        p_start = float(pw.get("offset_seconds") or 0.0)
        raw_end = pw.get("end_offset_seconds")
        p_end = float(raw_end) if raw_end is not None else float("inf")
        if p_end >= p_start:
            intervals.append((p_start, p_end))
    intervals.sort(key=lambda pair: pair[0])
    return intervals


def _offset_in_pause(offset: float | None, pauses: list[tuple[float, float]]) -> bool:
    if offset is None or not pauses:
        return False
    val = float(offset)
    return any(p_start <= val <= p_end for p_start, p_end in pauses)


def _segment_overlaps_pause(start: float, end: float, pauses: list[tuple[float, float]]) -> bool:
    if not pauses:
        return False
    eff_end = end if end > start else start + 1e-6
    return any(start < p_end and eff_end > p_start for p_start, p_end in pauses)


def _pause_between(prev_end: float, cur_start: float, pauses: list[tuple[float, float]]) -> bool:
    if not pauses:
        return False
    return any(prev_end <= p_start <= cur_start for p_start, _ in pauses)


def _fmt_header(title: str, label: str, wall_clock: str | None = None) -> str:
    wc = _single_line(wall_clock)
    if wc:
        return f"[{title} | {label} | {wc}]"
    return f"[{title} | {label}]"


def _parse_optional_offset(raw: object) -> float | None:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    return None


def _pack_span_turns(turns: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Sub-split oversized turns and pack consecutive turns into bounded dialog windows."""
    atomic_turns: list[dict[str, Any]] = []
    for turn in turns:
        spk = _single_line(turn.get("speaker")) or "Sprecher"
        txt = _single_line(turn.get("text"))
        if not txt:
            continue
        t_start = float(turn.get("start") or 0.0)
        t_end = float(turn.get("end") or t_start)
        max_body = max(120, _MAX_CHUNK_CHARS - len(spk) - 2)
        pieces = _split_long_text(txt, max_body)
        if len(pieces) == 1:
            atomic_turns.append(
                {"speaker": spk, "start": t_start, "end": t_end, "text": pieces[0]}
            )
            continue
        total_len = max(1, sum(len(p) for p in pieces))
        dur = max(0.0, t_end - t_start)
        consumed = 0
        for piece in pieces:
            p_start = t_start + dur * (consumed / total_len)
            consumed += len(piece)
            p_end = t_start + dur * (consumed / total_len)
            atomic_turns.append(
                {"speaker": spk, "start": p_start, "end": p_end, "text": piece}
            )

    if not atomic_turns:
        return []

    def _turn_line_len(t: dict[str, Any]) -> int:
        return len(t["speaker"]) + 2 + len(t["text"])

    windows: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    cur_chars = 0

    for turn in atomic_turns:
        t_len = _turn_line_len(turn)
        if not cur:
            cur = [turn]
            cur_chars = t_len
            continue

        gap = float(turn["start"]) - float(cur[-1]["end"])
        span_dur = float(turn["end"]) - float(cur[0]["start"])
        next_chars = cur_chars + 1 + t_len
        should_split = (
            next_chars > _MAX_CHUNK_CHARS
            or span_dur > _MAX_WINDOW_SECONDS
            or (gap > _SILENCE_SPLIT_SECONDS and cur_chars >= _SILENCE_SPLIT_MIN_CHARS)
        )
        if not should_split:
            cur.append(turn)
            cur_chars = next_chars
            continue

        windows.append(cur)
        prev_last = cur[-1]
        prev_last_len = _turn_line_len(prev_last)
        if (
            prev_last_len <= _MAX_OVERLAP_TURN_CHARS
            and prev_last_len + 1 + t_len <= _MAX_CHUNK_CHARS
            and (float(turn["end"]) - float(prev_last["start"])) <= _MAX_WINDOW_SECONDS
        ):
            cur = [prev_last, turn]
            cur_chars = prev_last_len + 1 + t_len
        else:
            cur = [turn]
            cur_chars = t_len

    if cur:
        windows.append(cur)
    return windows


def build_protocol_chunks(
    export_payload: dict[str, Any],
    *,
    recording_title: str | None,
    provider: str,
) -> list[ChunkSpec]:
    """Deterministically build ordered `ChunkSpec` entries from curated `export_data()`."""
    effective_title = _single_line(recording_title) or f"{provider} meeting"
    pauses = _pause_intervals(export_payload)
    origin_utc = export_payload.get("time_origin_utc")
    chunks: list[ChunkSpec] = []

    def _append(
        kind: str,
        header: str,
        content: str,
        *,
        speaker_label: str | None = None,
        start_seconds: float | None = None,
        end_seconds: float | None = None,
        wall_clock: str | None = None,
        keyframe_id: uuid.UUID | None = None,
    ) -> None:
        clean_content = content.strip()
        if not clean_content:
            return
        chunks.append(
            ChunkSpec(
                chunk_index=len(chunks),
                chunk_kind=kind,
                header=header,
                content=clean_content,
                speaker_label=speaker_label,
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                wall_clock=_single_line(wall_clock) or None,
                keyframe_id=keyframe_id,
            )
        )

    summary = export_payload.get("summary")
    if isinstance(summary, dict):
        for dec in summary.get("decisions") or []:
            if not isinstance(dec, dict):
                continue
            d_text = _single_line(dec.get("text"))
            if not d_text:
                continue
            d_off = _parse_optional_offset(dec.get("offset_seconds"))
            if _offset_in_pause(d_off, pauses):
                continue
            d_wc = _single_line(dec.get("timestamp")) or None
            _append(
                "decision",
                _fmt_header(effective_title, "Decision", d_wc),
                d_text,
                start_seconds=d_off,
                end_seconds=d_off,
                wall_clock=d_wc,
            )

        for act in summary.get("action_items") or []:
            if not isinstance(act, dict):
                continue
            task = _single_line(act.get("task"))
            if not task:
                continue
            a_off = _parse_optional_offset(act.get("offset_seconds"))
            if _offset_in_pause(a_off, pauses):
                continue
            owner = _single_line(act.get("owner")) or "Team"
            due = _single_line(act.get("due"))
            a_wc = _single_line(act.get("timestamp")) or None
            body = f"{owner}: {task}" + (f" (due: {due})" if due else "")
            _append(
                "action_item",
                _fmt_header(effective_title, f"Action ({owner})", a_wc),
                body,
                speaker_label=owner,
                start_seconds=a_off,
                end_seconds=a_off,
                wall_clock=a_wc,
            )

        sum_text = _single_line(summary.get("summary"))
        if sum_text:
            _append(
                "summary",
                _fmt_header(effective_title, "Summary"),
                sum_text,
            )

        for topic in summary.get("topics") or []:
            if not isinstance(topic, dict):
                continue
            t_title = _single_line(topic.get("title"))
            t_details = _single_line(topic.get("details"))
            if not (t_title or t_details):
                continue
            t_off = _parse_optional_offset(topic.get("offset_seconds"))
            if _offset_in_pause(t_off, pauses):
                continue
            t_wc = _single_line(topic.get("timestamp")) or None
            label = f"Topic: {t_title}" if t_title else "Topic"
            body = f"{t_title}: {t_details}" if (t_title and t_details) else (t_title or t_details)
            _append(
                "topic",
                _fmt_header(effective_title, label, t_wc),
                body,
                start_seconds=t_off,
                end_seconds=t_off,
                wall_clock=t_wc,
            )

    notes_raw = str(export_payload.get("notes") or "")
    for para in _split_notes_markdown(notes_raw):
        _append("notes", _fmt_header(effective_title, "Notes"), para)

    for kf in export_payload.get("keyframes") or []:
        if not isinstance(kf, dict):
            continue
        vc = kf.get("visual_context")
        if not isinstance(vc, dict):
            continue
        kf_off = _parse_optional_offset(kf.get("offset_seconds"))
        if _offset_in_pause(kf_off, pauses):
            continue
        view = _single_line(vc.get("view"))
        items = [_single_line(it) for it in (vc.get("items") or []) if _single_line(it)]
        terms = [_single_line(t) for t in (vc.get("terms") or []) if _single_line(t)]
        slide_parts: list[str] = []
        if view:
            slide_parts.append(view)
        if items:
            slide_parts.append("Visible: " + "; ".join(items))
        if terms:
            slide_parts.append("Terms: " + ", ".join(terms))
        if not slide_parts:
            continue
        presenter = _single_line(kf.get("presenter")) or "Screen"
        kf_wc = _single_line(kf.get("wall_clock")) or (
            wall_clock_time_de(origin_utc, kf_off)
            if (origin_utc and kf_off is not None)
            else (short_timestamp(kf_off) if kf_off is not None else None)
        )
        try:
            kf_uuid = uuid.UUID(str(kf.get("id") or ""))
        except ValueError:
            kf_uuid = None
        _append(
            "slide",
            _fmt_header(effective_title, f"Slide ({presenter})", kf_wc),
            " | ".join(slide_parts),
            speaker_label=presenter,
            start_seconds=kf_off,
            end_seconds=kf_off,
            wall_clock=kf_wc,
            keyframe_id=kf_uuid,
        )

    raw_segments = export_payload.get("segments") or []
    spans: list[list[dict[str, Any]]] = []
    cur_span: list[dict[str, Any]] = []
    prev_end: float | None = None
    for seg in raw_segments:
        if not isinstance(seg, dict):
            continue
        s_start = float(seg.get("start") or 0.0)
        s_end = float(seg.get("end") or s_start)
        if _segment_overlaps_pause(s_start, s_end, pauses):
            if cur_span:
                spans.append(cur_span)
                cur_span = []
            prev_end = None
            continue
        if prev_end is not None and _pause_between(prev_end, s_start, pauses):
            if cur_span:
                spans.append(cur_span)
                cur_span = []
        cur_span.append(seg)
        prev_end = max(prev_end, s_end) if prev_end is not None else s_end
    if cur_span:
        spans.append(cur_span)

    for span_segments in spans:
        grouped = group_transcript_turns(span_segments, max_turn_chars=_MAX_CHUNK_CHARS)
        for window in _pack_span_turns(grouped):
            distinct_speakers: list[str] = []
            seen_spk: set[str] = set()
            for t in window:
                spk = t["speaker"]
                if spk.lower() not in seen_spk:
                    seen_spk.add(spk.lower())
                    distinct_speakers.append(spk)
            speaker_label = ", ".join(distinct_speakers)
            w_start = float(window[0]["start"])
            w_end = float(window[-1]["end"])
            w_wc = (
                wall_clock_time_de(origin_utc, w_start)
                if origin_utc
                else short_timestamp(w_start)
            )
            content = "\n".join(f"{t['speaker']}: {t['text']}" for t in window)
            _append(
                "transcript",
                _fmt_header(effective_title, speaker_label, w_wc),
                content,
                speaker_label=speaker_label,
                start_seconds=w_start,
                end_seconds=w_end,
                wall_clock=w_wc,
            )

    return chunks


def purge_recording_rag_chunks(
    db: Session,
    recording_id: uuid.UUID,
    *,
    keyframe_id: uuid.UUID | None = None,
) -> None:
    """Synchronously delete `protocol_chunks` rows for a recording (or one deleted keyframe)."""
    stmt = delete(ProtocolChunk).where(ProtocolChunk.recording_id == recording_id)
    if keyframe_id is not None:
        stmt = stmt.where(ProtocolChunk.keyframe_id == keyframe_id)
    db.execute(stmt)


def invalidate_recording_rag_index(meta: dict[str, Any]) -> dict[str, Any]:
    """Mark `protocol_meta` dirty so `rag_index_pass` refreshes chunks out-of-lock."""
    meta.pop("rag_indexed_model", None)
    return meta


def _index_single_recording(
    engine,
    rec_id: uuid.UUID,
    *,
    active_model: str,
    settings: Settings,
) -> bool:
    with Session(engine) as db:
        rec = db.get(Recording, rec_id)
        if (
            rec is None
            or rec.processing != "completed"
            or rec.transcript_deleted_at is not None
            or rec.metadata_deleted_at is not None
        ):
            db.rollback()
            return False
        snap_title = rec.title
        snap_provider = rec.provider
        snap_meta = copy.deepcopy(rec.protocol_meta or {})
        exp_payload = export_data(db, rec)
        db.rollback()

    chunks = build_protocol_chunks(
        exp_payload,
        recording_title=snap_title,
        provider=snap_provider,
    )
    if chunks and active_model != LEXICAL_ONLY_MODEL_ID:
        passages = [f"{c.header} {c.content}" for c in chunks]
        vecs = embed_texts(passages, prefix="passage: ", settings=settings)
    else:
        vecs = np.zeros((len(chunks), 0), dtype=np.float32)

    eff_dim = int(vecs.shape[1]) if vecs.ndim == 2 else 0
    eff_model = (
        active_model if (eff_dim == EMBEDDING_DIM or not chunks) else LEXICAL_ONLY_MODEL_ID
    )

    with Session(engine) as db:
        locked = db.scalar(
            select(Recording)
            .where(Recording.id == rec_id)
            .with_for_update(skip_locked=True)
        )
        if (
            locked is None
            or locked.processing != "completed"
            or locked.transcript_deleted_at is not None
            or locked.metadata_deleted_at is not None
            or locked.title != snap_title
            or dict(locked.protocol_meta or {}) != snap_meta
        ):
            db.rollback()
            return False

        db.execute(delete(ProtocolChunk).where(ProtocolChunk.recording_id == rec_id))
        if chunks:
            rows_params = [
                {
                    "id": uuid.uuid4(),
                    "recording_id": rec_id,
                    "chunk_index": c.chunk_index,
                    "chunk_kind": c.chunk_kind,
                    "speaker_label": c.speaker_label,
                    "start_seconds": c.start_seconds,
                    "end_seconds": c.end_seconds,
                    "wall_clock": c.wall_clock,
                    "keyframe_id": c.keyframe_id,
                    "header": c.header,
                    "content": c.content,
                    "embedding_model": eff_model,
                    "embedding_dim": eff_dim,
                    "embedding": (
                        pack_float16_embedding(vecs[idx]) if eff_dim == EMBEDDING_DIM else b""
                    ),
                }
                for idx, c in enumerate(chunks)
            ]
            db.execute(_INSERT_CHUNK_SQL, rows_params)

        next_meta = dict(locked.protocol_meta or {})
        next_meta["rag_indexed_model"] = eff_model
        locked.protocol_meta = next_meta
        db.commit()
        return True


def rag_index_batch(engine, *, settings: Settings | None = None) -> int:
    """Index up to 5 completed recordings out-of-lock; returns count of recordings processed."""
    settings = settings or get_settings()
    active_model = active_embedding_model_id(settings)
    with Session(engine) as db:
        candidate_ids = list(
            db.scalars(
                select(Recording.id)
                .where(
                    Recording.processing == "completed",
                    Recording.transcript_deleted_at.is_(None),
                    Recording.metadata_deleted_at.is_(None),
                    func.coalesce(Recording.protocol_meta["rag_indexed_model"].astext, "")
                    != active_model,
                )
                .order_by(Recording.starts_at.desc(), Recording.id.desc())
                .limit(_INDEX_BATCH_RECORDINGS)
            ).all()
        )

    indexed = 0
    for rec_id in candidate_ids:
        try:
            if _index_single_recording(
                engine, rec_id, active_model=active_model, settings=settings
            ):
                indexed += 1
        except Exception as exc:
            logger.warning("RAG indexing failed for recording %s: %s", rec_id, exc)

    return indexed


def rag_index_pass(engine) -> bool:
    """Periodic background pass; always returns False so `processing_loop` paces at 5s."""
    rag_index_batch(engine)
    return False


def _sanitize_or_phrase(raw: str) -> str:
    cleaned = " ".join(_STRIP_WEBSEARCH_RE.sub(" ", raw or "").split())[:60]
    if not cleaned:
        return ""
    if cleaned.upper() in ("OR", "AND", "NOT"):
        return ""
    return cleaned


def _build_or_disjunction_query(query: str, extra_terms: list[str]) -> str:
    terms: list[str] = []
    seen: set[str] = set()

    def _add(raw_tok: str) -> None:
        clean = _sanitize_or_phrase(raw_tok)
        if not clean or len(clean) < 2:
            return
        low = clean.lower()
        if low in seen:
            return
        seen.add(low)
        terms.append(f'"{clean}"')

    for tok in _QUERY_TOKEN_RE.findall(query):
        _add(tok)
        if len(terms) >= 12:
            break
    for ext in extra_terms:
        _add(ext)
        if len(terms) >= 24:
            break
    return " OR ".join(terms)


def search_protocol_chunks(
    db: Session,
    principal: Principal,
    *,
    query: str,
    recording_id: uuid.UUID | None = None,
    speaker: str | None = None,
    kind: str = "all",
    since: str | None = None,
    until: str | None = None,
    provider: str | None = None,
    limit: int = 10,
    settings: Settings | None = None,
) -> SearchResult:
    """Execute RBAC-pre-filtered hybrid PostgreSQL `tsvector` + local ONNX RRF search."""
    settings = settings or get_settings()
    q_clean = " ".join((query or "").split())
    if not q_clean:
        raise ValueError("query must be a non-empty string.")
    eff_kind = (kind or "all").strip().lower()
    if eff_kind not in VALID_SEARCH_KINDS:
        raise ValueError(
            f"Invalid kind {kind!r}; expected one of {', '.join(VALID_SEARCH_KINDS)}."
        )
    eff_provider = (provider or "").strip().lower() or None
    if eff_provider is not None and eff_provider not in VALID_PROVIDERS:
        raise ValueError(
            f"Invalid provider {provider!r}; expected one of {', '.join(VALID_PROVIDERS)}."
        )
    since_dt = parse_date_bound(since, "since", is_upper=False)
    until_dt = parse_date_bound(until, "until", is_upper=True)
    eff_limit = max(1, min(30, int(limit)))
    speaker_filter = (speaker or "").strip()

    lexical_only = not embedder_is_available(settings)

    # 1. Read tenant-scoped glossary, expand locally, then release DB read snapshot before HTTP.
    ordered_terms, alias_to_canonical = resolve_principal_search_glossary(db, principal, settings)
    local_expanded = expand_query_with_local_glossary(q_clean, ordered_terms, alias_to_canonical)
    db.rollback()
    llm_expanded = expand_search_query(q_clean, ordered_terms[:40], settings=settings)
    all_expanded = [*local_expanded, *llm_expanded]

    # 2. Build shared RBAC + completed + date/provider/recording pre-filter subquery.
    base_stmt = select(Recording.id).where(
        Recording.metadata_deleted_at.is_(None),
        Recording.transcript_deleted_at.is_(None),
    )
    if recording_id is not None:
        base_stmt = base_stmt.where(Recording.id == recording_id)
    if since_dt is not None:
        base_stmt = base_stmt.where(Recording.ends_at >= since_dt)
    if until_dt is not None:
        base_stmt = base_stmt.where(Recording.starts_at <= until_dt)

    auth_stmt, empty_for_principal = apply_recordings_search_filters(
        base_stmt,
        principal=principal,
        provider=eff_provider,
        processing="completed",
        q=None,
    )
    if empty_for_principal:
        return SearchResult(hits=[], scanned_capped=False, lexical_only=lexical_only)

    chunk_filters: list[Any] = [ProtocolChunk.recording_id.in_(auth_stmt)]
    if eff_kind != "all":
        chunk_filters.append(ProtocolChunk.chunk_kind == eff_kind)
    if speaker_filter:
        escaped_spk = (
            speaker_filter.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        spk_needle = f"%{escaped_spk}%"
        chunk_filters.append(
            or_(
                ProtocolChunk.speaker_label.ilike(spk_needle, escape="\\"),
                and_(
                    ProtocolChunk.speaker_label.is_(None),
                    ProtocolChunk.content.ilike(spk_needle, escape="\\"),
                ),
            )
        )

    # 3. Lexical Arm (PostgreSQL GIN tsvector across simple + german + english).
    or_query_str = _build_or_disjunction_query(q_clean, all_expanded)
    tsq_parts: list[Any] = []
    for cfg in ("simple", "german", "english"):
        tsq_parts.append(func.websearch_to_tsquery(cfg, q_clean))
        if or_query_str:
            tsq_parts.append(func.websearch_to_tsquery(cfg, or_query_str))
    combined_tsq = tsq_parts[0]
    for part in tsq_parts[1:]:
        combined_tsq = combined_tsq.op("||")(part)

    lex_ids = list(
        db.scalars(
            select(ProtocolChunk.id)
            .where(*chunk_filters, ProtocolChunk.search_tsv.op("@@")(combined_tsq))
            .order_by(
                func.ts_rank_cd(ProtocolChunk.search_tsv, combined_tsq, 32).desc(),
                ProtocolChunk.recording_id.asc(),
                ProtocolChunk.chunk_index.asc(),
            )
            .limit(100)
        ).all()
    )
    lex_ranks: dict[uuid.UUID, int] = {cid: idx for idx, cid in enumerate(lex_ids, start=1)}

    # 4. Dense Vector Arm (local ONNX query vector vs float16 BYTEA vectors in NumPy).
    scanned_capped = False
    vec_ranks: dict[uuid.UUID, int] = {}

    if not lexical_only:
        active_model = active_embedding_model_id(settings)
        vec_filters = [
            *chunk_filters,
            ProtocolChunk.embedding_model == active_model,
            ProtocolChunk.embedding_dim == EMBEDDING_DIM,
        ]
        total_chunks = int(
            db.scalar(select(func.count(ProtocolChunk.id)).where(*vec_filters)) or 0
        )
        scanned_capped = total_chunks > MAX_VECTOR_SCAN_CHUNKS
        if total_chunks > 0:
            q_mat = embed_texts([q_clean], prefix="query: ", settings=settings)
            if q_mat.shape == (1, EMBEDDING_DIM):
                q_vec = q_mat[0]
                vec_rows = list(
                    db.execute(
                        select(ProtocolChunk.id, ProtocolChunk.embedding)
                        .join(Recording, Recording.id == ProtocolChunk.recording_id)
                        .where(*vec_filters)
                        .order_by(Recording.starts_at.desc(), ProtocolChunk.chunk_index.asc())
                        .limit(MAX_VECTOR_SCAN_CHUNKS)
                    ).all()
                )
                valid_ids: list[uuid.UUID] = []
                valid_blobs: list[bytes] = []
                expected_bytes = EMBEDDING_DIM * 2
                for cid, blob in vec_rows:
                    if blob and len(blob) == expected_bytes:
                        valid_ids.append(cid)
                        valid_blobs.append(bytes(blob))
                if valid_blobs:
                    matrix = unpack_float16_embeddings(valid_blobs)
                    scores = matrix @ q_vec
                    top_n = min(100, len(valid_ids))
                    if len(valid_ids) > top_n:
                        top_idx = np.argpartition(-scores, top_n - 1)[:top_n]
                        top_idx = top_idx[np.argsort(-scores[top_idx], kind="stable")]
                    else:
                        top_idx = np.argsort(-scores, kind="stable")
                    min_cos = VECTOR_ONLY_MIN_COSINE if not lex_ranks else -2.0
                    rank = 1
                    for idx in top_idx:
                        if float(scores[idx]) < min_cos:
                            continue
                        vec_ranks[valid_ids[int(idx)]] = rank
                        rank += 1

    # 5. 1-Based RRF fusion + per-recording diversity cap.
    candidate_ids = set(lex_ranks) | set(vec_ranks)
    if not candidate_ids:
        return SearchResult(hits=[], scanned_capped=scanned_capped, lexical_only=lexical_only)

    rrf_scores: dict[uuid.UUID, float] = {}
    best_arm_rank: dict[uuid.UUID, int] = {}
    for cid in candidate_ids:
        r_vec = vec_ranks.get(cid)
        r_lex = lex_ranks.get(cid)
        rrf_scores[cid] = (
            (1.0 / (RRF_K + r_vec) if r_vec is not None else 0.0)
            + (1.0 / (RRF_K + r_lex) if r_lex is not None else 0.0)
        )
        best_arm_rank[cid] = min(
            r_vec if r_vec is not None else 10_000,
            r_lex if r_lex is not None else 10_000,
        )

    fetched = list(
        db.execute(
            select(ProtocolChunk, Recording)
            .join(Recording, Recording.id == ProtocolChunk.recording_id)
            .where(ProtocolChunk.id.in_(candidate_ids))
        ).all()
    )
    fetched.sort(
        key=lambda row: (
            -rrf_scores[row[0].id],
            best_arm_rank[row[0].id],
            -row[1].starts_at.timestamp(),
            row[0].chunk_index,
        )
    )

    if recording_id is None:
        selected: list[tuple[ProtocolChunk, Recording]] = []
        overflow: list[tuple[ProtocolChunk, Recording]] = []
        per_rec: dict[uuid.UUID, int] = {}
        for pair in fetched:
            rid = pair[0].recording_id
            if per_rec.get(rid, 0) < 3:
                per_rec[rid] = per_rec.get(rid, 0) + 1
                selected.append(pair)
                if len(selected) >= eff_limit:
                    break
            else:
                overflow.append(pair)
        if len(selected) < eff_limit and overflow:
            selected.extend(overflow[: eff_limit - len(selected)])
    else:
        selected = fetched[:eff_limit]

    hits = [
        SearchHit(
            chunk_id=chunk.id,
            recording_id=rec.id,
            recording_title=_single_line(rec.title) or f"{rec.provider} meeting",
            recording_provider=rec.provider,
            recording_starts_at=rec.starts_at,
            chunk_index=chunk.chunk_index,
            chunk_kind=chunk.chunk_kind,
            speaker_label=chunk.speaker_label,
            start_seconds=chunk.start_seconds,
            end_seconds=chunk.end_seconds,
            wall_clock=chunk.wall_clock,
            keyframe_id=chunk.keyframe_id,
            content=chunk.content,
            rrf_score=rrf_scores[chunk.id],
        )
        for chunk, rec in selected
    ]
    return SearchResult(hits=hits, scanned_capped=scanned_capped, lexical_only=lexical_only)
