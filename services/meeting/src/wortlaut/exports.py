import hmac
import io
import json
import math
import re
import secrets
import time
import uuid
import wave
from datetime import UTC, datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

from sqlalchemy import DateTime, func, or_, select
from sqlalchemy.orm import Session

from wortlaut.languages import effective_recording_language
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioControl,
    AudioStream,
    Recording,
    RecordingKeyframe,
    TranscriptSegment,
)
from wortlaut.processing import (
    MAX_CHUNK,
    ONSET_BIND_MAX_SAMPLES,
    RATE,
    collect_opted_out_speakers,
    collect_stream_participant_names,
    is_speaker_opted_out,
    read_pcm,
    stream_quality,
)
from wortlaut.settings import derive_subkey, get_settings
from wortlaut.storage import get_storage

BERLIN_TZ = ZoneInfo("Europe/Berlin")
WEEKDAYS_DE = ("Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So.")

PROVIDER_LABELS = {
    "google_meet": "Google Meet",
    "teams": "Microsoft Teams",
    "webex": "Cisco Webex",
    "zoom": "Zoom",
}


def provider_label(provider: str | None) -> str:
    if not provider:
        return "Konferenz"
    return PROVIDER_LABELS.get(provider, provider)


def format_date_short_de(iso_str: str | None) -> str:
    if not iso_str:
        return "unbekannt"
    try:
        dt = datetime.fromisoformat(iso_str).astimezone(BERLIN_TZ)
        return dt.strftime("%d.%m.%Y")
    except ValueError:
        return iso_str


def format_period_de(start_iso: str | None, end_iso: str | None) -> str:
    if not start_iso:
        return "unbekannt"
    try:
        start_dt = datetime.fromisoformat(start_iso).astimezone(BERLIN_TZ)
        weekday = WEEKDAYS_DE[start_dt.weekday()]
        if not end_iso:
            return f"{weekday}, {start_dt:%d.%m.%Y · %H:%M} Uhr"
        end_dt = datetime.fromisoformat(end_iso).astimezone(BERLIN_TZ)
        if start_dt.date() == end_dt.date():
            return f"{weekday}, {start_dt:%d.%m.%Y · %H:%M} – {end_dt:%H:%M} Uhr"
        end_weekday = WEEKDAYS_DE[end_dt.weekday()]
        return (
            f"{weekday}, {start_dt:%d.%m.%Y %H:%M} Uhr – "
            f"{end_weekday}, {end_dt:%d.%m.%Y %H:%M} Uhr"
        )
    except ValueError:
        return f"{start_iso} bis {end_iso or 'unbekannt'}"


def format_duration_de(seconds: float) -> str:
    total = max(0, round(seconds))
    if total == 0:
        return "0 Sek."
    if total < 60:
        return f"{total} Sek."
    minutes, secs = divmod(total, 60)
    if minutes < 60:
        return f"{minutes} Min. {secs} Sek." if secs else f"{minutes} Min."
    hours, mins = divmod(minutes, 60)
    return f"{hours} Std. {mins} Min." if mins else f"{hours} Std."


def short_timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def wall_clock_time_de(origin_iso: str | None, offset_seconds: float) -> str:
    if not origin_iso:
        return short_timestamp(offset_seconds)
    try:
        origin_dt = datetime.fromisoformat(origin_iso)
        if origin_dt.tzinfo is None:
            origin_dt = origin_dt.replace(tzinfo=UTC)
        wall_dt = (origin_dt + timedelta(seconds=max(0.0, float(offset_seconds)))).astimezone(
            BERLIN_TZ
        )
        return wall_dt.strftime("%H:%M:%S")
    except (ValueError, TypeError):
        return short_timestamp(offset_seconds)


# Qwen3-ASR BPE token-probability floor (see wortlaut.asr) and a stricter bar
# for sub-300 ms fragments on shared SFU streams.
MIN_EXPORT_SEGMENT_CONFIDENCE = 0.25
MIN_SHORT_FRAGMENT_CONFIDENCE = 0.55
ONSET_BIND_MAX_SECONDS = ONSET_BIND_MAX_SAMPLES / RATE + 0.05
_MAX_ADJACENT_TURN_GAP_SECONDS = 4.5
_MAX_COALESCED_TURN_DURATION_SECONDS = 45.0


def _merge_segment_into(target: dict, source: dict) -> None:
    target["end"] = max(target["end"], source["end"])
    prev_text = target["text"].rstrip()
    next_text = source["text"].lstrip()
    if prev_text.endswith(".") and next_text and next_text[0].islower():
        prev_text = prev_text[:-1]
    target["text"] = f"{prev_text} {next_text}".strip()
    merged_words = target.get("words", []) + source.get("words", [])
    target["words"] = merged_words
    word_confs = [w["confidence"] for w in merged_words if "confidence" in w]
    if word_confs:
        target["confidence"] = round(sum(word_confs) / len(word_confs), 4)
    elif "confidence" in target and "confidence" in source:
        t_conf, s_conf = target.get("confidence"), source.get("confidence")
        if isinstance(t_conf, (int, float)) and isinstance(s_conf, (int, float)):
            target["confidence"] = round((float(t_conf) + float(s_conf)) / 2.0, 4)


def _coalesce_speaker_key(seg: dict) -> tuple[str, str]:
    identity = str(
        seg.get("speaker_id")
        or seg.get("participant_id")
        or seg.get("provider_source_id")
        or seg.get("stream_id")
        or ""
    )
    return (identity, str(seg.get("speaker_label") or ""))


def _is_short_backchannel_candidate(seg: dict) -> bool:
    dur = max(0.0, seg["end"] - seg["start"])
    return dur <= 1.6 and len(seg["text"].split()) <= 3


def _is_floor_holding_backchannel(
    seg: dict,
    speaker_merged: list[dict],
    by_speaker: dict[tuple[str, str], list[dict]],
) -> bool:
    """Detect brief isolated listener acknowledgments inside another speaker's monologue."""
    dur = max(0.0, seg["end"] - seg["start"])
    text = seg.get("text") or ""
    if dur > 1.25 or "?" in text or len(text.split()) > 2:
        return False
    seg_key = _coalesce_speaker_key(seg)
    for own in by_speaker.get(seg_key, ()):
        if own is seg or own.get("id") == seg.get("id"):
            continue
        if own["end"] <= seg["start"] and (seg["start"] - own["end"]) < 5.0:
            return False
        if own["start"] >= seg["end"] and (own["start"] - seg["end"]) < 5.0:
            return False

    by_merged_speaker: dict[tuple[str, str], list[dict]] = {}
    for item in speaker_merged:
        by_merged_speaker.setdefault(_coalesce_speaker_key(item), []).append(item)

    for other_key, other_turns in by_merged_speaker.items():
        if other_key == seg_key or len(other_turns) < 2:
            continue
        for idx in range(len(other_turns) - 1):
            pre = other_turns[idx]
            post = other_turns[idx + 1]
            if pre["start"] >= seg["start"] or post["end"] <= seg["end"]:
                continue
            if (pre.get("text") or "").rstrip().endswith("?"):
                continue
            if (seg["start"] - pre["end"]) > 2.5 or (post["start"] - seg["end"]) > 2.5:
                continue
            if (post["start"] - pre["end"]) > _MAX_ADJACENT_TURN_GAP_SECONDS:
                continue
            combined_floor = max(0.0, pre["end"] - pre["start"]) + max(
                0.0, post["end"] - post["start"]
            )
            if combined_floor >= 8.0:
                return True
    return False


def _overlap_seconds(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _voiced_overlap_seconds(start: float, end: float, raw_segments: list[dict]) -> float:
    total = 0.0
    for raw in raw_segments:
        if raw["end"] <= start:
            continue
        if raw["start"] >= end:
            break
        total += _overlap_seconds(start, end, raw["start"], raw["end"])
    return min(max(0.0, end - start), total)


def _can_merge_turn_pair(
    cur: dict,
    nxt: dict,
    protected_ids: set[str],
    edit_bounds: dict[str, float],
) -> bool:
    nxt_id = str(nxt.get("segment_id") or nxt.get("id") or "")
    if nxt_id and nxt_id in protected_ids:
        return False
    cur_id = str(cur.get("segment_id") or cur.get("id") or "")
    if cur_id and cur_id in edit_bounds:
        if float(nxt["end"]) > float(edit_bounds[cur_id]) + 1e-3:
            return False
    return True


def _coalesce_protocol_segments(
    segments: list[dict],
    *,
    protected_ids: set[str] | None = None,
    edit_bounds: dict[str, float] | None = None,
) -> list[dict]:
    if not segments:
        return []
    protected = protected_ids or set()
    bounds = edit_bounds or {}
    ordered = sorted(segments, key=lambda s: (s["start"], s["stream_id"], s["id"]))

    by_speaker: dict[tuple[str, str], list[dict]] = {}
    for seg in ordered:
        by_speaker.setdefault(_coalesce_speaker_key(seg), []).append(seg)

    # Bridge sub-second intra-sentence splits of the same speaker only when no other
    # speaker took a turn in the pause (simultaneous short backchannels spoken mostly
    # over actual voiced speech may straddle the boundary).
    speaker_merged: list[dict] = []
    for spk_key, spk_segs in by_speaker.items():
        cur: dict | None = None
        for seg in spk_segs:
            gap = seg["start"] - cur["end"] if cur is not None else 999.0
            can_bridge = (
                cur is not None
                and gap <= 1.2
                and (seg["end"] - cur["start"]) <= _MAX_COALESCED_TURN_DURATION_SECONDS
                and _can_merge_turn_pair(cur, seg, protected, bounds)
            )
            if can_bridge and cur is not None:
                for other in ordered:
                    if _coalesce_speaker_key(other) == spk_key:
                        continue
                    if other["end"] <= cur["end"] or other["start"] >= seg["start"]:
                        continue
                    other_dur = max(0.0, other["end"] - other["start"])
                    voiced_ov = _voiced_overlap_seconds(
                        other["start"], other["end"], spk_segs
                    )
                    if not (
                        _is_short_backchannel_candidate(other)
                        and voiced_ov >= max(0.2, other_dur * 0.6)
                    ):
                        can_bridge = False
                        break
            if can_bridge and cur is not None:
                _merge_segment_into(cur, seg)
            else:
                if cur is not None:
                    speaker_merged.append(cur)
                cur = dict(seg)
                cur["words"] = list(seg.get("words", []))
        if cur is not None:
            speaker_merged.append(cur)

    non_backchannel: list[dict] = []
    for seg in speaker_merged:
        seg_id = str(seg.get("segment_id") or seg.get("id") or "")
        seg_key = _coalesce_speaker_key(seg)
        dur = max(0.0, seg["end"] - seg["start"])
        if seg_id not in protected and _is_short_backchannel_candidate(seg):
            min_ov = max(0.2, dur * 0.6)
            overlapped = any(
                (other_key := _coalesce_speaker_key(other)) != seg_key
                and (other["end"] - other["start"]) >= max(4.0, dur * 2.5)
                and _overlap_seconds(seg["start"], seg["end"], other["start"], other["end"])
                >= min_ov
                and _voiced_overlap_seconds(
                    seg["start"], seg["end"], by_speaker.get(other_key, [])
                )
                >= min_ov
                for other in speaker_merged
            )
            if overlapped or _is_floor_holding_backchannel(seg, speaker_merged, by_speaker):
                continue
        non_backchannel.append(seg)

    non_backchannel.sort(key=lambda s: (s["start"], s["stream_id"], s["id"]))
    final_turns: list[dict] = []
    for seg in non_backchannel:
        if (
            final_turns
            and _coalesce_speaker_key(final_turns[-1]) == _coalesce_speaker_key(seg)
            and (seg["start"] - final_turns[-1]["end"]) <= _MAX_ADJACENT_TURN_GAP_SECONDS
            and (seg["end"] - final_turns[-1]["start"]) <= _MAX_COALESCED_TURN_DURATION_SECONDS
            and _can_merge_turn_pair(final_turns[-1], seg, protected, bounds)
        ):
            _merge_segment_into(final_turns[-1], seg)
        else:
            final_turns.append(seg)
    return final_turns


def group_transcript_turns(segments: list[dict], max_turn_chars: int = 900) -> list[dict]:
    turns: list[dict] = []
    last_key: tuple[str, str] | None = None
    for seg in segments:
        text = " ".join((seg.get("text") or "").split())
        if not text:
            continue
        label = " ".join((seg.get("speaker_label") or "Sprecher").split())
        spk_key = _coalesce_speaker_key(seg)
        start = float(seg.get("start") or 0.0)
        end = float(seg.get("end") or start)
        if (
            turns
            and last_key == spk_key
            and (start - turns[-1]["end"]) <= _MAX_ADJACENT_TURN_GAP_SECONDS
            and (end - turns[-1]["start"]) <= _MAX_COALESCED_TURN_DURATION_SECONDS
            and len(turns[-1]["text"]) + 1 + len(text) <= max_turn_chars
        ):
            turns[-1]["text"] = f"{turns[-1]['text']} {text}"
            turns[-1]["end"] = max(turns[-1]["end"], end)
        else:
            turns.append(
                {
                    "speaker": label,
                    "start": start,
                    "end": end,
                    "text": text,
                }
            )
            last_key = spk_key
    return turns


def export_reader_token(recording: Recording) -> str | None:
    if (
        recording.export_reader_nonce is None
        or recording.transcript_deleted_at is not None
        or recording.processing_finished_at is None
        or datetime.now(UTC)
        >= recording.processing_finished_at
        + timedelta(days=get_settings().transcript_retention_days)
    ):
        return None
    # Domain separation and a per-recording nonce keep this credential limited
    # to export reads. Neither the API key nor a reader secret is stored in mail state.
    domain = f"wortlaut.export.reader.v1:{recording.id}:{recording.export_reader_nonce}"
    signature = hmac.digest(
        derive_subkey(b"reader-token-v1"), domain.encode(), "sha256"
    ).hex()
    return "wortlaut-read-" + signature


def chat_reader_token(recording: Recording) -> str | None:
    if (
        not recording.request_digest
        or recording.transcript_deleted_at is not None
        or recording.metadata_deleted_at is not None
    ):
        return None
    anchor = recording.processing_finished_at or recording.ends_at
    if anchor is not None and datetime.now(UTC) >= anchor + timedelta(
        days=get_settings().transcript_retention_days
    ):
        return None
    domain = f"wortlaut.chat.reader.v1:{recording.id}:{recording.request_digest}"
    signature = hmac.digest(
        derive_subkey(b"reader-token-v1"), domain.encode(), "sha256"
    ).hex()
    return "wortlaut-read-" + signature


def _legacy_reader_candidates(recording: Recording) -> list[str]:
    out: list[str] = []
    raw_api = get_settings().api_token.get_secret_value().encode()
    if recording.export_reader_nonce and recording.processing_finished_at is not None:
        dom = f"wortlaut.export.reader.v1:{recording.id}:{recording.export_reader_nonce}"
        out.append("wortlaut-read-" + hmac.digest(raw_api, dom.encode(), "sha256").hex())
    if recording.request_digest:
        dom = f"wortlaut.chat.reader.v1:{recording.id}:{recording.request_digest}"
        out.append("wortlaut-read-" + hmac.digest(raw_api, dom.encode(), "sha256").hex())
    return out


def verify_recording_reader_token(recording: Recording | None, token: str) -> bool:
    if recording is None or not token:
        return False
    clean = token.strip()
    prefix = f"wortlaut-read-{recording.id}."
    if clean.lower().startswith(prefix.lower()):
        clean = "wortlaut-read-" + clean.split(".", 1)[1]
    if (
        recording.transcript_deleted_at is not None
        or recording.metadata_deleted_at is not None
    ):
        return False
    candidates = [export_reader_token(recording), chat_reader_token(recording)]
    if any(c is not None for c in candidates):
        candidates.extend(_legacy_reader_candidates(recording))
    for candidate in candidates:
        if candidate is not None and secrets.compare_digest(clean.encode(), candidate.encode()):
            return True
    return False


def timestamp(seconds: float):
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, fraction = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}.{fraction:03}"


def speaker_label(segment, participant_names: dict[str, str] | None = None):
    if segment["source_kind"] == "share_audio":
        return "Freigabe-Audio"
    if segment["attribution_unknown"]:
        return f"Quelle {segment['provider_source_id']} (Zuordnung unklar)"
    pid = segment.get("participant_id") or segment.get("speaker_id")
    resolved_name = segment.get("participant_name") or (
        participant_names.get(pid) if participant_names and pid else None
    )
    return resolved_name or f"Sprecher {segment['speaker_id']}"


def _parse_iso_utc(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        dt = datetime.fromisoformat(raw.strip())
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except ValueError:
        return None


def _collect_raw_pause_windows(attempts: list[Attempt]) -> list[dict]:
    pauses_by_start: dict[str, dict] = {}
    for attempt in attempts:
        ps = (attempt.diagnostics or {}).get("participant_sources")
        if not isinstance(ps, dict):
            continue
        for item in ps.get("pause_windows") or []:
            if not isinstance(item, dict):
                continue
            start_dt = _parse_iso_utc(item.get("started_at"))
            if start_dt is None:
                continue
            end_dt = _parse_iso_utc(item.get("ended_at"))
            if end_dt is not None and end_dt < start_dt:
                end_dt = start_dt
            key = start_dt.isoformat()
            by_val = _single_line(item.get("by"))[:200] or None
            existing = pauses_by_start.get(key)
            if existing is None:
                if len(pauses_by_start) < 64:
                    pauses_by_start[key] = {
                        "started_dt": start_dt,
                        "ended_dt": end_dt,
                        "by": by_val,
                    }
            else:
                if existing["ended_dt"] is None and end_dt is not None:
                    existing["ended_dt"] = end_dt
                if not existing["by"] and by_val:
                    existing["by"] = by_val

    return sorted(pauses_by_start.values(), key=lambda w: w["started_dt"])


def _format_pause_windows(
    raw_pauses: list[dict],
    origin_utc_dt: datetime,
    speaker_overrides: dict[str, str],
    opted_out_norm: set[str],
) -> list[dict]:
    def _resolve_label(raw_name: str | None) -> str | None:
        override = speaker_overrides.get(raw_name) if raw_name else None
        return _single_line(override) or raw_name

    pause_windows: list[dict] = []
    for w in raw_pauses:
        raw_by = w["by"]
        by_label = _resolve_label(raw_by)
        if raw_by and is_speaker_opted_out(
            opted_out_norm,
            participant_name=raw_by,
            speaker_label=by_label,
        ):
            by_label = None
        start_offset = round(max(0.0, (w["started_dt"] - origin_utc_dt).total_seconds()), 3)
        end_offset = (
            round(max(start_offset, (w["ended_dt"] - origin_utc_dt).total_seconds()), 3)
            if w["ended_dt"] is not None
            else None
        )
        pause_windows.append(
            {
                "started_at": w["started_dt"].isoformat(),
                "ended_at": w["ended_dt"].isoformat() if w["ended_dt"] is not None else None,
                "offset_seconds": start_offset,
                "end_offset_seconds": end_offset,
                "by": by_label,
            }
        )
    return pause_windows


def _collect_opted_out_windows(
    db: Session,
    attempts: list[Attempt],
    streams: list[AudioStream],
    origin_utc_dt: datetime,
    participant_names: dict[str, str],
    opted_out_norm: set[str],
) -> list[dict]:
    """Build anonymous chronological time windows for opted-out utterances (no PII, no text)."""
    if not opted_out_norm:
        return []
    raw_spans: list[tuple[float, float | None]] = []
    for attempt in attempts:
        ps = (attempt.diagnostics or {}).get("participant_sources")
        if not isinstance(ps, dict):
            continue
        for item in ps.get("opted_out_windows") or []:
            if not isinstance(item, dict):
                continue
            start_dt = _parse_iso_utc(item.get("started_at"))
            if start_dt is None:
                continue
            end_dt = _parse_iso_utc(item.get("ended_at"))
            start_off = max(0.0, (start_dt - origin_utc_dt).total_seconds())
            end_off = (
                max(start_off, (end_dt - origin_utc_dt).total_seconds())
                if end_dt is not None
                else None
            )
            raw_spans.append((start_off, end_off))

    if streams:
        stream_by_id = {s.id: s for s in streams}
        jobs = list(
            db.scalars(
                select(AsrJob).where(AsrJob.stream_id.in_(list(stream_by_id.keys())))
            ).all()
        )
        for job in jobs:
            binding = job.binding if isinstance(job.binding, dict) else {}
            pid = binding.get("participant_id") or binding.get("speaker_id")
            pname = binding.get("participant_name") or (
                participant_names.get(str(pid)) if pid else None
            )
            if not is_speaker_opted_out(
                opted_out_norm,
                participant_id=str(pid) if pid else None,
                speaker_id=str(binding.get("speaker_id")) if binding.get("speaker_id") else None,
                participant_name=str(pname) if pname else None,
                provider_source_id=(
                    str(binding.get("provider_source_id"))
                    if binding.get("provider_source_id")
                    else None
                ),
            ):
                continue
            stream = stream_by_id.get(job.stream_id)
            if stream is None or not isinstance(stream.contract, dict):
                continue
            try:
                base_off = (
                    float(stream.contract["monotonic_origin_ms"])
                    - float(stream.contract["session_monotonic_origin_ms"])
                ) / 1000.0
                s_off = max(0.0, base_off + job.core_start / RATE)
                e_off = max(s_off, base_off + job.core_end / RATE)
            except (KeyError, TypeError, ValueError):
                continue
            if e_off - s_off >= 0.3:
                raw_spans.append((s_off, e_off))

    if not raw_spans:
        return []
    raw_spans.sort(key=lambda pair: (pair[0], float("inf") if pair[1] is None else pair[1]))
    merged: list[tuple[float, float | None]] = []
    for s_off, e_off in raw_spans:
        if not merged:
            merged.append((s_off, e_off))
            continue
        prev_s, prev_e = merged[-1]
        if prev_e is None:
            continue
        if s_off <= prev_e + 2.5:
            merged[-1] = (prev_s, None if e_off is None else max(prev_e, e_off))
        else:
            merged.append((s_off, e_off))

    out: list[dict] = []
    for s_off, e_off in merged[:128]:
        r_start = round(s_off, 3)
        r_end = round(e_off, 3) if e_off is not None else None
        out.append(
            {
                "started_at": (origin_utc_dt + timedelta(seconds=r_start)).isoformat(),
                "ended_at": (
                    (origin_utc_dt + timedelta(seconds=r_end)).isoformat()
                    if r_end is not None
                    else None
                ),
                "offset_seconds": r_start,
                "end_offset_seconds": r_end,
            }
        )
    return out


def export_data(
    db: Session,
    recording: Recording,
    *,
    tail_segments_limit: int | None = None,
):
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    raw_pauses = _collect_raw_pause_windows(attempts)
    streams = list(
        db.scalars(
            select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
        ).all()
    )
    participant_names, bind_controls = collect_stream_participant_names(
        db, streams, attempts=list(attempts), order_binds=True
    )
    meta = dict(recording.protocol_meta or {})
    speaker_overrides: dict[str, str] = dict(meta.get("speaker_overrides") or {})
    term_replacements: dict[str, str] = dict(meta.get("term_replacements") or {})
    from wortlaut.glossary import resolve_recording_glossary

    _, glossary_alias_replacements = resolve_recording_glossary(
        db, recording, get_settings()
    )
    effective_term_replacements: dict[str, str] = {
        **glossary_alias_replacements,
        **term_replacements,
    }
    segment_edits: dict[str, str] = dict(meta.get("segment_edits") or {})
    raw_edit_bounds = meta.get("segment_edit_bounds") or {}
    segment_edit_bounds: dict[str, float] = {
        str(k): float(v)
        for k, v in raw_edit_bounds.items()
        if isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    protected_segment_ids = {
        str(k) for k, v in segment_edits.items() if isinstance(v, str) and v.strip()
    }
    if not streams:
        seg_rows = []
    elif tail_segments_limit is not None:
        seg_query = (
            select(TranscriptSegment)
            .join(AsrJob)
            .where(AsrJob.stream_id.in_([s.id for s in streams]))
        )
        non_empty_text = (
            func.trim(func.coalesce(TranscriptSegment.result["text"].as_string(), "")) != ""
        )
        tail_filter = (
            or_(non_empty_text, TranscriptSegment.id.in_(protected_segment_ids))
            if protected_segment_ids
            else non_empty_text
        )
        seg_utc_epoch = (
            func.extract(
                "epoch",
                func.cast(
                    TranscriptSegment.result["session_utc_origin"].as_string(),
                    DateTime(timezone=True),
                ),
            )
            + func.coalesce(TranscriptSegment.result["start"].as_float(), 0.0)
        )
        seg_rows = list(
            reversed(
                db.scalars(
                    seg_query.where(tail_filter)
                    .order_by(seg_utc_epoch.desc(), TranscriptSegment.id.desc())
                    .limit(tail_segments_limit)
                ).all()
            )
        )
    else:
        seg_rows = db.scalars(
            select(TranscriptSegment)
            .join(AsrJob)
            .where(AsrJob.stream_id.in_([s.id for s in streams]))
        ).all()
    segments = [dict(s.result) for s in seg_rows]
    authoritative_pids: set[str] = set()
    for att in attempts:
        diag = att.diagnostics if isinstance(att.diagnostics, dict) else {}
        for p in (diag.get("participant_sources") or {}).get("sources") or []:
            if isinstance(p, dict) and p.get("participant_id") and p.get("participant_name"):
                if " ".join(str(p["participant_name"]).split()):
                    authoritative_pids.add(str(p["participant_id"]))
    seg_name_weights: dict[str, dict[str, float]] = {}
    for seg in segments:
        pid = seg.get("participant_id") or seg.get("speaker_id")
        raw_pname = " ".join(str(seg.get("participant_name") or "").split())
        if pid and raw_pname:
            dur_w = max(0.05, float(seg.get("end") or 0.0) - float(seg.get("start") or 0.0))
            by_name = seg_name_weights.setdefault(str(pid), {})
            by_name[raw_pname] = by_name.get(raw_pname, 0.0) + dur_w
    for pid_s, by_name in seg_name_weights.items():
        if pid_s not in authoritative_pids and by_name:
            participant_names[pid_s] = max(
                reversed(list(by_name.items())),
                key=lambda kv: kv[1],
            )[0]
    keyframe_rows = (
        list(
            db.scalars(
                select(RecordingKeyframe)
                .where(
                    RecordingKeyframe.recording_id == recording.id,
                    RecordingKeyframe.deleted_at.is_(None),
                )
                .order_by(
                    RecordingKeyframe.captured_at.asc(),
                    RecordingKeyframe.sequence.asc(),
                    RecordingKeyframe.id.asc(),
                )
            ).all()
        )
        if tail_segments_limit is None
        else []
    )
    for kf in keyframe_rows:
        if kf.participant_id and kf.participant_name and kf.participant_id not in participant_names:
            participant_names[kf.participant_id] = kf.participant_name
    opted_out_list, opted_out_norm = collect_opted_out_speakers(
        recording, attempts, participant_names
    )
    anchors = [datetime.fromisoformat(s.contract["session_utc_origin"]) for s in streams]
    if anchors:
        origin = min(anchors)
    elif keyframe_rows:
        origin = min(kf.captured_at.astimezone(UTC) for kf in keyframe_rows)
    elif raw_pauses:
        origin = min(w["started_dt"] for w in raw_pauses)
    else:
        origin = recording.starts_at
    unambiguous_stream_bindings: dict[tuple[str, str], tuple[str, str | None, str]] = {}
    observed_by_stream: dict[tuple[str, str], set[tuple[str, str | None, str]]] = {}
    stream_bind_timeline: dict[tuple[str, str], list[tuple[float, str, str, str, str | None]]] = {}
    stream_onset_windows: dict[
        tuple[str, str], list[tuple[float, float, str, str, str, str | None]]
    ] = {}
    for s in streams:
        key = (str(s.stream_id), str(s.epoch))
        s_delta = (
            datetime.fromisoformat(s.contract["session_utc_origin"]) - origin
        ).total_seconds()
        s_mono_delta = (
            s.contract.get("monotonic_origin_ms", 0)
            - s.contract.get("session_monotonic_origin_ms", 0)
        ) / 1000.0
        s_base_sec = s_delta + s_mono_delta
        observed: set[tuple[str, str | None, str]] = set()
        timeline: list[tuple[float, str, str, str, str | None]] = []
        s_binds = sorted(
            [c for c in bind_controls if c.stream_id == s.id],
            key=lambda c: (
                int(c.start_sample)
                if c.start_sample is not None
                else int((c.contract or {}).get("start_sample") or 0)
            ),
        )
        ctrl_intervals: list[tuple[float, float | None, dict]] = []
        first_s = (
            (
                int(s_binds[0].start_sample)
                if s_binds[0].start_sample is not None
                else int((s_binds[0].contract or {}).get("start_sample") or 0)
            )
            if s_binds
            else None
        )
        if first_s is None or first_s > 0:
            first_end = (s_base_sec + first_s / RATE) if first_s is not None else None
            ctrl_intervals.append((s_base_sec, first_end, s.contract))
        for idx, ctrl in enumerate(s_binds):
            cur_s = (
                int(ctrl.start_sample)
                if ctrl.start_sample is not None
                else int((ctrl.contract or {}).get("start_sample") or 0)
            )
            nxt_s = (
                (
                    int(s_binds[idx + 1].start_sample)
                    if s_binds[idx + 1].start_sample is not None
                    else int((s_binds[idx + 1].contract or {}).get("start_sample") or 0)
                )
                if idx + 1 < len(s_binds)
                else None
            )
            ctrl_intervals.append(
                (
                    s_base_sec + cur_s / RATE,
                    (s_base_sec + nxt_s / RATE) if nxt_s is not None else None,
                    ctrl.contract,
                )
            )
        onset_list: list[tuple[float, float, str, str, str, str | None]] = []
        for idx in range(len(ctrl_intervals) - 1):
            iv_start, iv_end, cdict = ctrl_intervals[idx]
            _, _, nxt_cdict = ctrl_intervals[idx + 1]
            if (
                iv_end is not None
                and cdict.get("attribution_unknown")
                and not nxt_cdict.get("attribution_unknown")
                and 0.0 < (iv_end - iv_start) <= ONSET_BIND_MAX_SECONDS
                and cdict.get("source_kind", "speaker") == nxt_cdict.get("source_kind", "speaker")
            ):
                nxt_pid = nxt_cdict.get("participant_id") or nxt_cdict.get("speaker_id")
                if nxt_pid:
                    nxt_spk = nxt_cdict.get("speaker_id") or nxt_pid
                    nxt_kind = nxt_cdict.get("source_kind", "speaker")
                    nxt_name = nxt_cdict.get("participant_name") or participant_names.get(nxt_pid)
                    onset_list.append((iv_start, iv_end, nxt_pid, nxt_spk, nxt_kind, nxt_name))
        if onset_list:
            stream_onset_windows[key] = onset_list
        if not s.contract.get("attribution_unknown"):
            pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
            if pid:
                spk = s.contract.get("speaker_id") or pid
                kind = s.contract.get("source_kind", "speaker")
                observed.add((pid, spk, kind))
                timeline.append(
                    (
                        s_delta + s_mono_delta,
                        pid,
                        spk,
                        kind,
                        s.contract.get("participant_name") or participant_names.get(pid),
                    )
                )
        for ctrl in bind_controls:
            if ctrl.stream_id == s.id and not ctrl.contract.get("attribution_unknown"):
                pid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
                if pid:
                    spk = ctrl.contract.get("speaker_id") or pid
                    kind = ctrl.contract.get("source_kind", "speaker")
                    observed.add((pid, spk, kind))
                    ctrl_sec = s_delta + s_mono_delta + (ctrl.start_sample or 0) / RATE
                    timeline.append(
                        (
                            ctrl_sec,
                            pid,
                            spk,
                            kind,
                            ctrl.contract.get("participant_name") or participant_names.get(pid),
                        )
                    )
        for seg in segments:
            if (
                (seg.get("stream_id"), seg.get("epoch")) == key
                and not seg.get("attribution_unknown")
            ):
                pid = seg.get("participant_id") or seg.get("speaker_id")
                if pid:
                    spk = seg.get("speaker_id") or pid
                    kind = seg.get("source_kind", "speaker")
                    observed.add((pid, spk, kind))
                    seg_delta = (
                        datetime.fromisoformat(seg["session_utc_origin"]) - origin
                    ).total_seconds()
                    timeline.append(
                        (
                            seg["start"] + seg_delta,
                            pid,
                            spk,
                            kind,
                            seg.get("participant_name") or participant_names.get(pid),
                        )
                    )
        observed_by_stream[key] = observed
        if len(observed) == 1:
            unambiguous_stream_bindings[key] = next(iter(observed))
        if timeline:
            timeline.sort(key=lambda x: x[0])
            stream_bind_timeline[key] = timeline

    apply_protocol_cleanup = len(segments) > 3
    resolved_segments: list[dict] = []
    for segment in segments:
        raw_seg_id = str(segment.get("id") or "")
        is_protected = raw_seg_id in protected_segment_ids
        clean_text = " ".join((segment.get("text") or "").split())
        if not clean_text and not is_protected:
            continue
        segment["text"] = clean_text
        delta = (datetime.fromisoformat(segment["session_utc_origin"]) - origin).total_seconds()
        segment["start"] += delta
        segment["end"] += delta
        segment["words"] = [
            {**word, "start": word["start"] + delta, "end": word["end"] + delta}
            if "start" in word and "end" in word
            else word
            for word in segment["words"]
        ]
        stream_key = (segment.get("stream_id"), segment.get("epoch"))
        dur = max(0.0, segment["end"] - segment["start"])
        seg_conf = segment.get("confidence")
        if (
            not is_protected
            and isinstance(seg_conf, (int, float))
            and not isinstance(seg_conf, bool)
            and seg_conf < MIN_EXPORT_SEGMENT_CONFIDENCE
        ):
            continue
        if segment.get("attribution_unknown") and stream_key in unambiguous_stream_bindings:
            resolved_pid, resolved_spk, resolved_kind = unambiguous_stream_bindings[stream_key]
            resolved_name = participant_names.get(resolved_pid)
            segment["attribution_unknown"] = False
            segment["participant_id"] = resolved_pid
            segment["speaker_id"] = resolved_spk if resolved_kind == "speaker" else None
            segment["source_kind"] = resolved_kind
            segment["participant_name"] = resolved_name
        elif segment.get("attribution_unknown") and stream_key in stream_onset_windows:
            matched_onset = next(
                (
                    w
                    for w in stream_onset_windows[stream_key]
                    if segment["start"] >= w[0] - 0.08 and segment["end"] <= w[1] + 0.08
                ),
                None,
            )
            if matched_onset is not None:
                _, _, w_pid, w_spk, w_kind, w_name = matched_onset
                segment["attribution_unknown"] = False
                segment["participant_id"] = w_pid
                segment["speaker_id"] = w_spk if w_kind == "speaker" else None
                segment["source_kind"] = w_kind
                segment["participant_name"] = w_name or participant_names.get(str(w_pid))
            elif (
                not is_protected
                and bool(stream_bind_timeline.get(stream_key))
                and dur <= 0.30
                and isinstance(seg_conf, (int, float))
                and seg_conf < MIN_SHORT_FRAGMENT_CONFIDENCE
            ):
                continue
        elif (
            not is_protected
            and segment.get("attribution_unknown")
            and bool(stream_bind_timeline.get(stream_key))
            and dur <= 0.30
            and isinstance(seg_conf, (int, float))
            and seg_conf < MIN_SHORT_FRAGMENT_CONFIDENCE
        ):
            continue
        elif (
            not is_protected
            and not segment.get("attribution_unknown")
            and len(observed_by_stream.get(stream_key, ())) > 1
            and dur <= 0.30
            and isinstance(seg_conf, (int, float))
            and seg_conf < MIN_SHORT_FRAGMENT_CONFIDENCE
        ):
            continue
        pid = segment.get("participant_id") or segment.get("speaker_id")
        if (
            not segment.get("attribution_unknown")
            and segment.get("source_kind") != "share_audio"
            and pid
            and str(pid) in participant_names
            and participant_names[str(pid)]
        ):
            segment["participant_name"] = participant_names[str(pid)]
        segment["speaker_label"] = speaker_label(segment, participant_names)
        segment["segment_id"] = segment["id"]
        segment["speaker_name"] = segment.get("participant_name")
        segment["attribution_status"] = (
            "unknown"
            if segment.get("attribution_unknown")
            else ("bound" if pid else "unbound")
        )
        if is_speaker_opted_out(
            opted_out_norm,
            participant_id=segment.get("participant_id"),
            speaker_id=segment.get("speaker_id"),
            participant_name=segment.get("participant_name"),
            speaker_label=segment.get("speaker_label"),
            provider_source_id=segment.get("provider_source_id"),
        ):
            continue
        resolved_segments.append(segment)
    segments = (
        _coalesce_protocol_segments(
            resolved_segments,
            protected_ids=protected_segment_ids,
            edit_bounds=segment_edit_bounds,
        )
        if apply_protocol_cleanup
        else resolved_segments
    )
    segments.sort(key=lambda s: (s["start"], s["stream_id"], s["id"]))
    resolved_speaker_overrides: dict[str, str] = {}
    if speaker_overrides:
        for k, v in speaker_overrides.items():
            if v and v.strip():
                clean_v = v.strip()
                resolved_speaker_overrides[k] = clean_v
                if k in participant_names and participant_names[k]:
                    resolved_speaker_overrides.setdefault(participant_names[k], clean_v)
                participant_names[k] = clean_v
        opted_out_list, opted_out_norm = collect_opted_out_speakers(
            recording, attempts, participant_names
        )
    filtered_segments: list[dict] = []
    for seg in segments:
        seg_id = str(seg.get("segment_id") or seg.get("id") or "")
        if seg_id and seg_id in segment_edits and segment_edits[seg_id].strip():
            seg["text"] = " ".join(segment_edits[seg_id].split())
        if effective_term_replacements:
            seg["text"] = _apply_text_replacements(
                seg.get("text") or "", effective_term_replacements
            )
        if speaker_overrides:
            pid = seg.get("participant_id") or seg.get("speaker_id")
            orig_label = seg.get("speaker_label") or ""
            prov_src = seg.get("provider_source_id") or ""
            override = (
                (speaker_overrides.get(str(pid)) if pid else None)
                or speaker_overrides.get(orig_label)
                or speaker_overrides.get(prov_src)
            )
            if override and override.strip():
                clean_override = override.strip()
                if orig_label:
                    resolved_speaker_overrides.setdefault(orig_label, clean_override)
                seg["participant_name"] = clean_override
                seg["speaker_name"] = clean_override
                seg["speaker_label"] = clean_override
        if is_speaker_opted_out(
            opted_out_norm,
            participant_id=seg.get("participant_id"),
            speaker_id=seg.get("speaker_id"),
            participant_name=seg.get("participant_name"),
            speaker_label=seg.get("speaker_label"),
            provider_source_id=seg.get("provider_source_id"),
        ):
            continue
        filtered_segments.append(seg)
    segments = filtered_segments
    origin_utc_dt = origin.astimezone(UTC)
    pause_windows = _format_pause_windows(
        raw_pauses,
        origin_utc_dt,
        speaker_overrides,
        opted_out_norm,
    )
    if tail_segments_limit is not None:
        return {
            "segments": segments,
            "opted_out_speakers": opted_out_list,
        }
    opted_out_windows = _collect_opted_out_windows(
        db,
        attempts,
        streams,
        origin_utc_dt,
        participant_names,
        opted_out_norm,
    )
    raw_kf_ctx_map = meta.get("keyframe_context")
    kf_ctx_map = raw_kf_ctx_map if isinstance(raw_kf_ctx_map, dict) else {}
    origin_utc_iso = origin_utc_dt.isoformat()
    keyframes: list[dict] = []
    for kf in keyframe_rows:
        raw_name = kf.participant_name or participant_names.get(kf.participant_id)
        base_label = raw_name or f"Sprecher {kf.participant_id}"
        override = (
            speaker_overrides.get(str(kf.participant_id))
            or (speaker_overrides.get(raw_name) if raw_name else None)
            or speaker_overrides.get(base_label)
            or speaker_overrides.get(kf.provider_source_id)
        )
        presenter = override.strip() if override and override.strip() else base_label
        if is_speaker_opted_out(
            opted_out_norm,
            participant_id=kf.participant_id,
            participant_name=raw_name,
            speaker_label=presenter,
            provider_source_id=kf.provider_source_id,
        ):
            continue
        offset_seconds = round(
            max(0.0, (kf.captured_at.astimezone(UTC) - origin_utc_dt).total_seconds()),
            3,
        )
        kf_entry: dict = {
            "id": str(kf.id),
            "captured_at": kf.captured_at.astimezone(UTC).isoformat(),
            "offset_seconds": offset_seconds,
            "wall_clock": wall_clock_time_de(origin_utc_iso, offset_seconds),
            "presenter": presenter,
            "participant_id": kf.participant_id,
            "provider_source_id": kf.provider_source_id,
            "width": kf.width,
            "height": kf.height,
            "image_path": f"/v1/recordings/{recording.id}/keyframes/{kf.id}.png",
        }
        norm_vc = _normalize_keyframe_context_entry(kf_ctx_map.get(str(kf.id)))
        if norm_vc is not None:
            vc_view = norm_vc["view"]
            vc_items = list(norm_vc["items"])
            vc_terms = list(norm_vc["terms"])
            if effective_term_replacements:
                vc_view = _apply_text_replacements(vc_view, effective_term_replacements)
                vc_items = [
                    _apply_text_replacements(it, effective_term_replacements) for it in vc_items
                ]
                vc_terms = [
                    _apply_text_replacements(t, effective_term_replacements) for t in vc_terms
                ]
            summary_parts: list[str] = []
            if vc_view:
                summary_parts.append(vc_view)
            if vc_items:
                summary_parts.append("Sichtbar: " + "; ".join(vc_items[:10]))
            kf_entry["visual_context"] = {
                "view": vc_view,
                "items": vc_items,
                "terms": vc_terms,
                "summary": " | ".join(summary_parts),
            }
        keyframes.append(kf_entry)
    qualities = [
        {
            "stream_id": str(s.stream_id),
            "epoch": str(s.epoch),
            "provider_source_id": s.contract["provider_source_id"],
            **stream_quality(db, s),
        }
        for s in streams
    ]
    ends = [
        datetime.fromisoformat(s.contract["session_utc_origin"])
        + timedelta(
            seconds=(s.contract["monotonic_origin_ms"] - s.contract["session_monotonic_origin_ms"])
            / 1000
            + (s.final_sample if s.final_sample is not None else q["last_durable_sample"]) / RATE
        )
        for s, q in zip(streams, qualities, strict=True)
    ]
    audio_available = bool(
        recording.audio_deleted_at is None
        and streams
        and any(q.get("accepted_samples", 0) > 0 and not q.get("audio_deleted") for q in qualities)
    )
    detected_languages = list(
        dict.fromkeys(
            seg["language"]
            for seg in segments
            if isinstance(seg.get("language"), str) and seg.get("language")
        )
    )
    live_active_sources: list[dict] = []
    if recording.participation == "capturing" and attempts:
        latest_diag = attempts[-1].diagnostics if attempts[-1].diagnostics else {}
        if not bool((latest_diag.get("participant_sources") or {}).get("paused")):
            for rcv in latest_diag.get("receiver_sources", []):
                lvl = (rcv.get("rtp_stats") or {}).get("audio_level")
                if not (isinstance(lvl, (int, float)) and lvl >= 0.01):
                    continue
                r_pid = rcv.get("signaled_participant_id")
                r_sid = rcv.get("provider_source_id") or ""
                r_name = rcv.get("participant_name") or (
                    participant_names.get(r_pid) if r_pid else None
                )
                if not (r_name or r_pid):
                    continue
                r_label = (
                    resolved_speaker_overrides.get(str(r_pid))
                    if r_pid and str(r_pid) in resolved_speaker_overrides
                    else (
                        resolved_speaker_overrides.get(str(r_name))
                        if r_name and str(r_name) in resolved_speaker_overrides
                        else (r_name or r_pid or r_sid)
                    )
                )
                live_active_sources.append(
                    {
                        "provider_source_id": r_sid,
                        "signaled_participant_id": str(r_pid) if r_pid else None,
                        "participant_name": str(r_name).strip() if r_name else None,
                        "speaker_label": str(r_label).strip(),
                        "csi": rcv.get("csi"),
                        "source_kind": rcv.get("source_kind") or "speaker",
                    }
                )
    if recording.processing not in ("completed", "failed") and streams:
        stream_by_id = {s.id: s for s in streams}
        for pending_job in db.scalars(
            select(AsrJob).where(
                AsrJob.stream_id.in_([s.id for s in streams]),
                AsrJob.status.in_(("pending", "processing")),
            )
        ):
            jb = pending_job.binding if isinstance(pending_job.binding, dict) else {}
            st = stream_by_id.get(pending_job.stream_id)
            st_c = st.contract if st and isinstance(st.contract, dict) else {}
            j_pid = (
                jb.get("participant_id")
                or jb.get("speaker_id")
                or st_c.get("participant_id")
                or st_c.get("speaker_id")
            )
            j_name = (
                jb.get("participant_name")
                or (participant_names.get(j_pid) if j_pid else None)
                or st_c.get("participant_name")
            )
            j_sid = jb.get("provider_source_id") or st_c.get("provider_source_id") or ""
            if not (j_name or j_pid):
                continue
            j_label = (
                resolved_speaker_overrides.get(str(j_pid))
                if j_pid and str(j_pid) in resolved_speaker_overrides
                else (
                    resolved_speaker_overrides.get(str(j_name))
                    if j_name and str(j_name) in resolved_speaker_overrides
                    else (j_name or j_pid or j_sid)
                )
            )
            live_active_sources.append(
                {
                    "provider_source_id": str(j_sid),
                    "signaled_participant_id": str(j_pid) if j_pid else None,
                    "participant_name": str(j_name).strip() if j_name else None,
                    "speaker_label": str(j_label).strip(),
                    "csi": None,
                    "source_kind": jb.get("source_kind") or st_c.get("source_kind") or "speaker",
                }
            )
    return {
        "recording_id": str(recording.id),
        "provider": recording.provider,
        "title": recording.title,
        "guest_name": recording.guest_name,
        "language": effective_recording_language(recording, get_settings()),
        "detected_languages": detected_languages,
        "processing": recording.processing,
        "processing_error": recording.processing_error,
        "participation": recording.participation,
        "participation_reason": recording.participation_reason,
        "scheduled_period": {
            "start": recording.starts_at.isoformat(),
            "end": (
                str(meta["scheduled_ends_at"])
                if isinstance(meta.get("scheduled_ends_at"), str) and meta.get("scheduled_ends_at")
                else recording.ends_at.isoformat()
            ),
        },
        "time_origin_utc": origin.astimezone(UTC).isoformat(),
        "last_known_audio_utc": max(ends).isoformat() if ends else None,
        "audio_available": audio_available,
        "summary": _resolve_summary(
            meta.get("summary"), resolved_speaker_overrides, effective_term_replacements
        ),
        "notes": meta.get("notes") or "",
        "speaker_overrides": speaker_overrides,
        "term_replacements": term_replacements,
        "opted_out_speakers": opted_out_list,
        "calendar_link_synced_at": meta.get("calendar_link_synced_at"),
        "calendar_link_error": meta.get("calendar_link_error"),
        "calendar_link_provider": meta.get("calendar_link_provider"),
        "attempts": [
            {
                "id": str(a.id),
                "end_reason": a.end_reason,
                "ended_at": a.ended_at.isoformat() if a.ended_at else None,
                "capability": a.diagnostics.get("capability", "unverified"),
                "configured_speaker_slots": a.diagnostics.get("configured_speaker_slots"),
                "configured_share_slots": a.diagnostics.get("configured_share_slots"),
                "last_observed_streams": a.diagnostics.get("streams"),
                "drained": a.diagnostics.get("drained"),
                "audio_clock": a.diagnostics.get(
                    "audio_clock",
                    {"state": "unknown", "total_interruptions": 0, "interruptions": []},
                ),
                "keyframes": a.diagnostics.get("keyframes"),
            }
            for a in attempts
        ],
        "quality": {
            # Continuity of received tracks does not prove coverage of sources
            # that the provider never delivered. No complete-coverage proof yet.
            "source_coverage": "unknown",
            "has_audio_gaps": any(q["known_gaps"] for q in qualities),
            "capture_end_unknown": not streams or any(q["capture_end_unknown"] for q in qualities),
            "no_audio_received": not any(q["accepted_samples"] for q in qualities),
            "capture_anomaly": bool(
                not segments
                and not keyframes
                and not opted_out_list
                and not pause_windows
                and not opted_out_windows
                and recording.participation_reason
                not in ("lobby_timeout", "admission_denied", "prejoin_denied")
                and any(
                    a.end_reason not in ("lobby_timeout", "admission_denied", "prejoin_denied")
                    and (a.diagnostics.get("participant_sources", {}).get("total") or 0) > 0
                    and (a.diagnostics.get("active_audio_samples") or 0) == 0
                    for a in attempts
                )
            ),
            "incomplete_drain": any(a.diagnostics.get("drained") is False for a in attempts),
            "audio_clock_interrupted": any(
                a.diagnostics.get("audio_clock", {}).get("total_interruptions", 0) > 0
                for a in attempts
            ),
            "attribution_unknown": (
                any(s.get("attribution_unknown") for s in segments)
                if segments
                else any(q["attribution_unknown"] for q in qualities)
            ),
            "unprocessed_audio": any(q["unprocessed_ranges"] for q in qualities),
            "failed_asr_ranges": [
                {
                    "stream_id": str(job.stream_id),
                    "start_sample": job.core_start,
                    "end_sample": job.core_end,
                    "reason": job.error,
                }
                for job in db.scalars(
                    select(AsrJob).where(
                        AsrJob.stream_id.in_([s.id for s in streams]), AsrJob.status == "failed"
                    )
                )
            ],
            "participant_identity_requirement": "required",
            "streams": qualities,
        },
        "sources_summary": _build_sources_summary(
            attempts,
            streams,
            qualities,
            segments,
            participant_names,
            bind_controls,
            opted_out_norm,
            live_active_sources=live_active_sources,
        ),
        "segments": segments,
        "keyframes": keyframes,
        "pause_windows": pause_windows,
        "opted_out_windows": opted_out_windows,
    }


def _pick_representative_sample_text(texts) -> str:
    cleaned = [" ".join(str(t or "").split()) for t in texts]
    non_empty = [t for t in cleaned if t]
    if not non_empty:
        return ""
    for t in non_empty:
        if len(t) >= 48 and len(t.split()) >= 6:
            return t[:140]
    for t in non_empty:
        if len(t) >= 28:
            return t[:140]
    return max(non_empty, key=len)[:140]


def _format_markdown_source_ids(src: dict, recording_id: str | None = None) -> str:
    raw_ids = [
        str(s)
        for s in (src.get("provider_source_ids") or [src.get("provider_source_id") or ""])
        if str(s).strip()
    ]
    if not raw_ids:
        return "–"
    if len(raw_ids) == 1:
        return raw_ids[0]
    prefix = f":{recording_id}:" if recording_id else ""
    if prefix and all(prefix in s for s in raw_ids):
        short = [s.split(prefix, 1)[1] for s in raw_ids]
        return ", ".join(short)
    return ", ".join(raw_ids)


_GENERIC_SPEAKER_PREFIXES = (
    "quelle ",
    "sprecher ",
    "teilnehmer ",
    "speaker ",
    "participant ",
    "source ",
    "freigabe-audio",
    "screen share",
)


def _is_generic_speaker_label(
    label: str | None,
    pid: str | None = None,
    sid: str | None = None,
) -> bool:
    clean = " ".join(str(label or "").split())
    if not clean:
        return True
    if pid and clean == str(pid).strip():
        return True
    if sid and clean == str(sid).strip():
        return True
    low = clean.lower()
    if low in ("unbekannt", "unknown", "sprecher", "teilnehmer", "speaker", "participant"):
        return True
    return low.startswith(_GENERIC_SPEAKER_PREFIXES)


def _build_sources_summary(
    attempts,
    streams,
    qualities,
    segments,
    participant_names,
    bind_controls=(),
    opted_out_norm: set[str] | None = None,
    live_active_sources=(),
):
    receiver_by_id = {}
    for attempt in attempts:
        for rcv in attempt.diagnostics.get("receiver_sources", []):
            if rcv.get("provider_source_id"):
                receiver_by_id[rcv["provider_source_id"]] = rcv
    source_ids = list(
        dict.fromkeys(
            [
                s.contract["provider_source_id"]
                for s in streams
                if s.contract.get("provider_source_id")
            ]
            + [
                c.contract["provider_source_id"]
                for c in bind_controls
                if c.contract.get("provider_source_id")
            ]
            + [seg["provider_source_id"] for seg in segments if seg.get("provider_source_id")]
            + list(receiver_by_id.keys())
        )
    )
    summary = []
    for sid in source_ids:
        src_segs = [seg for seg in segments if seg.get("provider_source_id") == sid]
        src_quals = [q for q in qualities if q.get("provider_source_id") == sid]
        src_streams = [s for s in streams if s.contract.get("provider_source_id") == sid]
        src_stream_ids = {s.id for s in src_streams}
        src_binds = [
            c
            for c in bind_controls
            if c.contract.get("provider_source_id") == sid or c.stream_id in src_stream_ids
        ]
        rcv = receiver_by_id.get(sid, {})
        sig_id = (
            rcv.get("signaled_participant_id")
            or next(
                (
                    s.contract.get("participant_id") or s.contract.get("speaker_id")
                    for s in src_streams
                    if s.contract.get("participant_id") or s.contract.get("speaker_id")
                ),
                None,
            )
            or next(
                (
                    c.contract.get("participant_id") or c.contract.get("speaker_id")
                    for c in src_binds
                    if c.contract.get("participant_id") or c.contract.get("speaker_id")
                ),
                None,
            )
            or next(
                (
                    seg.get("participant_id") or seg.get("speaker_id")
                    for seg in src_segs
                    if seg.get("participant_id") or seg.get("speaker_id")
                ),
                None,
            )
        )
        part_name = (
            rcv.get("participant_name")
            or (participant_names.get(sig_id) if sig_id else None)
            or next(
                (
                    s.contract.get("participant_name")
                    for s in src_streams
                    if s.contract.get("participant_name")
                ),
                None,
            )
            or next(
                (
                    c.contract.get("participant_name")
                    for c in src_binds
                    if c.contract.get("participant_name")
                ),
                None,
            )
            or next(
                (seg.get("participant_name") for seg in src_segs if seg.get("participant_name")),
                None,
            )
        )
        if segments and not src_segs:
            continue
        accepted_sec = round(
            sum(q.get("accepted_samples", 0) for q in src_quals) / RATE, 2
        )
        kind = rcv.get("source_kind") or (
            src_quals[0].get("source_kind") if src_quals else "speaker"
        )
        if src_segs:
            grouped: dict[tuple[str | None, str], list[dict]] = {}
            for seg in src_segs:
                seg_pid_raw = seg.get("participant_id") or seg.get("speaker_id")
                seg_pid_str = str(seg_pid_raw) if seg_pid_raw else None
                seg_lbl_str = str(seg.get("speaker_label") or "")
                grouped.setdefault((seg_pid_str, seg_lbl_str), []).append(seg)
            for (seg_pid, seg_lbl), group_segs in grouped.items():
                eff_sig_id = seg_pid or (str(sig_id) if sig_id else None)
                name_weights: dict[str, float] = {}
                for g in group_segs:
                    g_name = " ".join(str(g.get("participant_name") or "").split())
                    if g_name:
                        dur_g = max(0.05, float(g.get("end") or 0.0) - float(g.get("start") or 0.0))
                        name_weights[g_name] = name_weights.get(g_name, 0.0) + dur_g
                dominant_group_name = (
                    max(reversed(list(name_weights.items())), key=lambda kv: kv[1])[0]
                    if name_weights
                    else None
                )
                eff_name = (
                    dominant_group_name
                    or (participant_names.get(eff_sig_id) if eff_sig_id else None)
                    or part_name
                )
                sample_txt = _pick_representative_sample_text(
                    g.get("text", "") for g in group_segs
                )
                summary.append(
                    {
                        "provider_source_id": sid,
                        "provider_source_ids": [sid],
                        "participant_name": eff_name,
                        "signaled_participant_id": eff_sig_id,
                        "signaled_participant_ids": [eff_sig_id] if eff_sig_id else [],
                        "speaker_label": seg_lbl or eff_name or eff_sig_id or sid,
                        "csi": rcv.get("csi"),
                        "source_kind": kind,
                        "segment_count": len(group_segs),
                        "speech_seconds": round(
                            sum(max(0.0, seg["end"] - seg["start"]) for seg in group_segs), 2
                        ),
                        "accepted_seconds": accepted_sec,
                        "first_start": group_segs[0]["start"],
                        "sample_text": sample_txt,
                    }
                )
        else:
            summary.append(
                {
                    "provider_source_id": sid,
                    "provider_source_ids": [sid],
                    "participant_name": part_name,
                    "signaled_participant_id": sig_id,
                    "signaled_participant_ids": [str(sig_id)] if sig_id else [],
                    "speaker_label": part_name or sig_id or sid,
                    "csi": rcv.get("csi"),
                    "source_kind": kind,
                    "segment_count": 0,
                    "speech_seconds": 0.0,
                    "accepted_seconds": accepted_sec,
                    "first_start": None,
                    "sample_text": None,
                }
            )
    for live_src in live_active_sources or ():
        l_sid = str(live_src.get("provider_source_id") or "")
        l_pid = live_src.get("signaled_participant_id")
        l_pid_str = str(l_pid) if l_pid else None
        l_name = live_src.get("participant_name")
        l_lbl = str(live_src.get("speaker_label") or l_name or l_pid_str or l_sid)
        summary.append(
            {
                "provider_source_id": l_sid,
                "provider_source_ids": [l_sid] if l_sid else [],
                "participant_name": l_name,
                "signaled_participant_id": l_pid_str,
                "signaled_participant_ids": [l_pid_str] if l_pid_str else [],
                "speaker_label": l_lbl,
                "csi": live_src.get("csi"),
                "source_kind": live_src.get("source_kind") or "speaker",
                "segment_count": 0,
                "speech_seconds": 0.0,
                "accepted_seconds": 0.0,
                "first_start": None,
                "sample_text": None,
            }
        )
    merged: list[dict] = []
    by_participant: dict[tuple[str, str], dict] = {}
    for item in summary:
        pid = item.get("signaled_participant_id")
        sid = item.get("provider_source_id")
        lbl = " ".join(str(item.get("speaker_label") or "").split())
        p_name = " ".join(str(item.get("participant_name") or "").split())
        resolved_name = (
            lbl
            if not _is_generic_speaker_label(lbl, pid, sid)
            else (p_name if not _is_generic_speaker_label(p_name, pid, sid) else "")
        )
        candidate_keys: list[tuple[str, str]] = []
        if resolved_name:
            candidate_keys.append(("name", resolved_name.casefold()))
        if pid:
            candidate_keys.append(("pid", str(pid)))
        existing = next(
            (by_participant[k] for k in candidate_keys if k in by_participant),
            None,
        )
        if existing is not None:
            existing["segment_count"] += item["segment_count"]
            existing["speech_seconds"] = round(
                existing["speech_seconds"] + item["speech_seconds"], 2
            )
            if item["first_start"] is not None and (
                existing["first_start"] is None or item["first_start"] < existing["first_start"]
            ):
                existing["first_start"] = item["first_start"]
            for src_id in item.get("provider_source_ids") or []:
                if src_id and src_id not in existing["provider_source_ids"]:
                    existing["provider_source_ids"].append(src_id)
            if not existing.get("provider_source_id") and item.get("provider_source_id"):
                existing["provider_source_id"] = item["provider_source_id"]
            for p_id in item.get("signaled_participant_ids") or []:
                if p_id and p_id not in existing["signaled_participant_ids"]:
                    existing["signaled_participant_ids"].append(p_id)
            if not existing.get("signaled_participant_id") and pid:
                existing["signaled_participant_id"] = pid
            if not existing.get("participant_name") and item.get("participant_name"):
                existing["participant_name"] = item["participant_name"]
            if (
                existing.get("source_kind") == "screen_share"
                and item.get("source_kind") == "speaker"
            ):
                existing["source_kind"] = "speaker"
            cand_sample = _pick_representative_sample_text(
                [existing.get("sample_text") or "", item.get("sample_text") or ""]
            )
            if cand_sample:
                existing["sample_text"] = cand_sample
            for k in candidate_keys:
                by_participant.setdefault(k, existing)
        else:
            for k in candidate_keys:
                by_participant[k] = item
            merged.append(item)
    if opted_out_norm:
        for item in merged:
            if is_speaker_opted_out(
                opted_out_norm,
                participant_id=item.get("signaled_participant_id"),
                participant_name=item.get("participant_name"),
                speaker_label=item.get("speaker_label"),
                provider_source_id=item.get("provider_source_id"),
            ):
                item["opted_out"] = True
                item["segment_count"] = 0
                item["speech_seconds"] = 0.0
                item["sample_text"] = None
    return merged


def _apply_text_replacements(value: str, term_replacements: dict[str, str]) -> str:
    if not value or not term_replacements:
        return value
    valid = [(k, v) for k, v in term_replacements.items() if k]
    if not valid:
        return value
    # Single-pass longest-first match with word boundaries so replacements never corrupt
    # substrings inside unrelated words (e.g. "ai" -> "AI" in "said") or chain into each other.
    valid.sort(key=lambda kv: len(kv[0]), reverse=True)
    parts: list[str] = []
    lookup: dict[str, str] = {}
    for old_t, new_t in valid:
        lookup[old_t] = new_t
        esc = re.escape(old_t)
        prefix = r"(?<!\w)" if (old_t[0].isalnum() or old_t[0] == "_") else ""
        suffix = r"(?!\w)" if (old_t[-1].isalnum() or old_t[-1] == "_") else ""
        parts.append(f"{prefix}{esc}{suffix}")
    pattern = re.compile("|".join(parts))
    return pattern.sub(lambda m: lookup.get(m.group(0), m.group(0)), value)


def _single_line(value: object) -> str:
    return " ".join(str(value or "").split())


_CITATION_TS_RE = re.compile(r"^\s*\[?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*\]?\s*$")


def resolve_citation_timestamp(
    raw_timestamp: object,
    raw_offset: object = None,
    *,
    origin_utc: str | None = None,
    segments: list[dict] | tuple = (),
    keyframes: list[dict] | tuple = (),
) -> tuple[str | None, float | None]:
    """Validate and snap a wall-clock or relative citation timestamp to a recording offset."""
    max_span = max(
        [
            *(float(s.get("end") or 0.0) for s in segments if isinstance(s, dict)),
            *(float(k.get("offset_seconds") or 0.0) for k in keyframes if isinstance(k, dict)),
            0.0,
        ]
    )
    has_timeline = bool(segments or keyframes)
    upper_bound = max_span + 90.0 if has_timeline else 86400.0 * 3

    cand_offset: float | None = None
    if (
        isinstance(raw_offset, (int, float))
        and not isinstance(raw_offset, bool)
        and math.isfinite(raw_offset)
        and 0.0 <= float(raw_offset) <= upper_bound
    ):
        cand_offset = float(raw_offset)

    ts_str = _single_line(raw_timestamp)
    if cand_offset is None and ts_str:
        m = _CITATION_TS_RE.match(ts_str)
        if m:
            p1 = int(m.group(1))
            p2 = int(m.group(2))
            p3 = int(m.group(3)) if m.group(3) is not None else None
            if p2 < 60 and (p3 is None or p3 < 60):
                origin_dt = _parse_iso_utc(origin_utc) if origin_utc else None
                if origin_dt is not None and p1 < 24:
                    origin_berlin = origin_dt.astimezone(BERLIN_TZ)
                    sec_val = p3 if p3 is not None else 0
                    for day_shift in (0, 1, -1):
                        base_day = origin_berlin + timedelta(days=day_shift)
                        wall_dt = base_day.replace(
                            hour=p1, minute=p2, second=sec_val, microsecond=0
                        )
                        wall_off = (wall_dt - origin_berlin).total_seconds()
                        if -20.0 <= wall_off <= upper_bound:
                            cand_offset = max(0.0, wall_off)
                            break
                if cand_offset is None:
                    rel_off = (
                        float(p1 * 3600 + p2 * 60 + p3)
                        if p3 is not None
                        else float(p1 * 60 + p2)
                    )
                    if 0.0 <= rel_off <= upper_bound:
                        cand_offset = rel_off

    if cand_offset is None:
        return None, None

    snapped = cand_offset
    overlapping = [
        float(s.get("start") or 0.0)
        for s in segments
        if isinstance(s, dict)
        and float(s.get("start") or 0.0) - 2.5
        <= cand_offset
        <= float(s.get("end") or 0.0) + 2.0
    ]
    if overlapping:
        snapped = min(overlapping, key=lambda st: abs(st - cand_offset))
    else:
        anchors = [
            *(float(s.get("start") or 0.0) for s in segments if isinstance(s, dict)),
            *(float(k.get("offset_seconds") or 0.0) for k in keyframes if isinstance(k, dict)),
        ]
        near = [a for a in anchors if abs(a - cand_offset) <= 15.0]
        if near:
            snapped = min(near, key=lambda a: abs(a - cand_offset))

    snapped = round(max(0.0, snapped), 2)
    label = (
        wall_clock_time_de(origin_utc, snapped)
        if origin_utc
        else short_timestamp(snapped)
    )
    return label, snapped


def _attach_resolved_citation(target: dict, source: dict) -> None:
    ts = _single_line(source.get("timestamp"))
    off = source.get("offset_seconds")
    if ts:
        target["timestamp"] = ts
    if isinstance(off, (int, float)) and not isinstance(off, bool) and math.isfinite(off):
        target["offset_seconds"] = round(max(0.0, float(off)), 2)


def _resolve_summary(
    raw_summary: object,
    speaker_overrides: dict[str, str],
    term_replacements: dict[str, str],
) -> dict | None:
    if not isinstance(raw_summary, dict):
        return None
    summary_text = _apply_text_replacements(
        str(raw_summary.get("summary") or "").strip(), term_replacements
    )
    decisions: list[dict] = []
    for d in raw_summary.get("decisions") or []:
        if isinstance(d, str):
            d_txt = _single_line(_apply_text_replacements(d, term_replacements))
            if d_txt:
                decisions.append({"text": d_txt})
            continue
        if not isinstance(d, dict):
            continue
        raw_d = str(d.get("text") or d.get("decision") or "")
        d_txt = _single_line(_apply_text_replacements(raw_d, term_replacements))
        if not d_txt:
            continue
        d_item: dict = {"text": d_txt}
        _attach_resolved_citation(d_item, d)
        decisions.append(d_item)
    topics: list[dict] = []
    for t in raw_summary.get("topics") or []:
        if not isinstance(t, dict):
            continue
        t_title = _single_line(
            _apply_text_replacements(str(t.get("title") or ""), term_replacements)
        )
        t_details = _single_line(
            _apply_text_replacements(str(t.get("details") or ""), term_replacements)
        )
        if t_title or t_details:
            t_item: dict = {"title": t_title, "details": t_details}
            _attach_resolved_citation(t_item, t)
            topics.append(t_item)
    action_items: list[dict] = []
    for a in raw_summary.get("action_items") or []:
        if not isinstance(a, dict):
            continue
        task = _single_line(_apply_text_replacements(str(a.get("task") or ""), term_replacements))
        if not task:
            continue
        raw_owner = _single_line(a.get("owner")) or "Team"
        override = speaker_overrides.get(raw_owner)
        owner = (
            _single_line(override)
            if override and _single_line(override)
            else _single_line(_apply_text_replacements(raw_owner, term_replacements))
        )
        due = _single_line(_apply_text_replacements(str(a.get("due") or ""), term_replacements))
        item: dict = {"owner": owner, "task": task}
        if due:
            item["due"] = due
        _attach_resolved_citation(item, a)
        action_items.append(item)
    if not summary_text and not decisions and not topics and not action_items:
        return None
    resolved: dict = {
        "summary": summary_text,
        "decisions": decisions,
        "topics": topics,
        "action_items": action_items,
    }
    if raw_summary.get("model"):
        resolved["model"] = str(raw_summary["model"])
    if raw_summary.get("generated_at"):
        resolved["generated_at"] = str(raw_summary["generated_at"])
    return resolved


def render_export(data, format):
    if format == "json":
        return json.dumps(data, ensure_ascii=False, indent=2), "application/json"
    reasons = (
        ", ".join(a["end_reason"] or "unknown" for a in data["attempts"])
        or data["participation_reason"]
        or "unknown"
    )
    quality = data["quality"]
    unprocessed = quality["unprocessed_audio"] or bool(quality["failed_asr_ranges"])
    status = (
        f"Provider: {data['provider']}; "
        f"Termin: {data['scheduled_period']['start']} bis {data['scheduled_period']['end']}; "
        f"Letztes bekanntes Audio: {data['last_known_audio_utc'] or 'unbekannt'}; "
        f"Verarbeitung: {data['processing']}; Ende: {reasons}; "
        f"Audiolücken: {quality['has_audio_gaps']}; "
        f"Audio-Uhr unterbrochen: {quality['audio_clock_interrupted']}; "
        f"Aufnahmeende unbekannt: {quality['capture_end_unknown']}; "
        f"Zuordnung unklar: {quality['attribution_unknown']}; Quellenabdeckung: unbekannt; "
        f"Audioabschluss unvollstaendig: {quality['incomplete_drain']}"
        f"; Verarbeitungsfehler: {data['processing_error'] or 'keiner'}"
        f"; Unverarbeitete Bereiche: {unprocessed}"
    )
    header = f"wortlaut {data['recording_id']}\nZeitursprung: {data['time_origin_utc']}\n{status}\n"
    period = data["scheduled_period"]
    human_period = format_period_de(period.get("start"), period.get("end"))
    human_provider = provider_label(data.get("provider"))
    title = _single_line(data.get("title")) or f"Wortprotokoll ({human_provider})"
    sources = data.get("sources_summary") or []
    total_speech = sum(float(s.get("speech_seconds") or 0.0) for s in sources)
    notes_text = str(data.get("notes") or "").strip()
    summary_data = data.get("summary") if isinstance(data.get("summary"), dict) else None
    summary_text = str(summary_data.get("summary") or "").strip() if summary_data else ""
    decisions = [
        d
        for d in ((summary_data.get("decisions") if summary_data else None) or [])
        if isinstance(d, dict) and _single_line(d.get("text"))
    ]
    topics = [
        t
        for t in ((summary_data.get("topics") if summary_data else None) or [])
        if isinstance(t, dict) and (_single_line(t.get("title")) or _single_line(t.get("details")))
    ]
    actions = [
        a
        for a in ((summary_data.get("action_items") if summary_data else None) or [])
        if isinstance(a, dict) and _single_line(a.get("task"))
    ]
    pause_windows_list = [
        w for w in (data.get("pause_windows") or []) if isinstance(w, dict)
    ]
    has_summary_content = bool(summary_text or decisions or topics or actions)
    ui_url = f"{get_settings().public_base_url()}/ui"
    protocol_link = f"{ui_url}#view=meetings&id={data['recording_id']}"

    def _md_citation_suffix(item_obj: dict) -> str:
        ts_val = _single_line(item_obj.get("timestamp"))
        off_val = item_obj.get("offset_seconds")
        if not ts_val:
            return ""
        if isinstance(off_val, (int, float)) and not isinstance(off_val, bool):
            return f" · [`{ts_val}`]({protocol_link}&t={max(0, round(float(off_val)))})"
        return f" · `{ts_val}`"

    def _txt_citation_suffix(item_obj: dict) -> str:
        ts_val = _single_line(item_obj.get("timestamp"))
        return f" [{ts_val}]" if ts_val else ""

    if format == "md":
        lines = [
            f"# {title}",
            "",
            f"- **Plattform:** {human_provider} (`{data['provider']}`)",
            f"- **Termin:** {human_period}",
        ]
        if total_speech > 0:
            lines.append(f"- **Erfasste Sprechzeit:** {format_duration_de(total_speech)}")
        if pause_windows_list:
            lines.append(f"- **Off-the-Record-Pausen:** {len(pause_windows_list)}")
        lines.append("")
        if summary_text or decisions or topics:
            lines.extend(["## Zusammenfassung", ""])
            if summary_text:
                lines.extend([summary_text, ""])
            if decisions:
                lines.extend(["### Entscheidungen", ""])
                for d in decisions:
                    d_text = _single_line(d["text"])
                    lines.append(f"- {d_text}{_md_citation_suffix(d)}")
                lines.append("")
            if topics:
                lines.extend(["### Besprochene Themen & Ergebnisse", ""])
                for t in topics:
                    t_title = _single_line(t.get("title")) or "Thema"
                    t_details = _single_line(t.get("details"))
                    t_cite = _md_citation_suffix(t)
                    lines.append(
                        f"- **{t_title}:** {t_details}{t_cite}"
                        if t_details
                        else f"- **{t_title}**{t_cite}"
                    )
                lines.append("")
        if has_summary_content:
            lines.extend(["## To-Do-Liste", ""])
            if actions:
                for a in actions:
                    owner = _single_line(a.get("owner")) or "Team"
                    task = _single_line(a["task"])
                    due = _single_line(a.get("due"))
                    suffix = f" _(Fällig: {due})_" if due else ""
                    lines.append(
                        f"- [ ] **{owner}:** {task}{suffix}{_md_citation_suffix(a)}"
                    )
            else:
                lines.append("_Keine offenen Aufgaben vereinbart._")
            lines.append("")
        if notes_text:
            lines.extend(["## Notizen", "", notes_text, ""])
        if sources:
            lines.extend(
                [
                    "## Sprecher & Quellen",
                    "",
                    "| Teilnehmer | Sitzungs-ID | Quelle | Segmente | Sprechzeit (s) |",
                    "| --- | --- | --- | ---: | ---: |",
                ]
            )
            for src in sources:
                p_name = (src.get("participant_name") or "–").replace("|", "\\|")
                sig_id = (src.get("signaled_participant_id") or "–").replace("|", "\\|")
                prov_id = _format_markdown_source_ids(src, data.get("recording_id")).replace(
                    "|", "\\|"
                )
                seg_count = src["segment_count"]
                speech_sec = src["speech_seconds"]
                lines.append(
                    f"| {p_name} | `{sig_id}` | `{prov_id}` | {seg_count} | {speech_sec} |"
                )
            lines.append("")
        lines.extend(["## Transkript", ""])
        keyframes_list = data.get("keyframes") or []
        opted_out_windows_list = data.get("opted_out_windows") or []
        if (
            not data["segments"]
            and not keyframes_list
            and not pause_windows_list
            and not opted_out_windows_list
        ):
            lines.append("_Keine Transkriptsegmente vorhanden._")
        else:
            total_slides = len(keyframes_list)
            timeline_items: list[tuple[float, int, int, str, dict]] = []
            for idx, kf in enumerate(keyframes_list):
                timeline_items.append(
                    (float(kf.get("offset_seconds") or 0.0), 0, idx, "keyframe", kf)
                )
            for idx, pw in enumerate(pause_windows_list):
                timeline_items.append(
                    (float(pw.get("offset_seconds") or 0.0), 1, idx, "pause", pw)
                )
            for idx, ow in enumerate(opted_out_windows_list):
                timeline_items.append(
                    (float(ow.get("offset_seconds") or 0.0), 1, idx, "opted_out", ow)
                )
            for idx, segment in enumerate(data["segments"]):
                timeline_items.append(
                    (float(segment.get("start") or 0.0), 2, idx, "segment", segment)
                )
            timeline_items.sort(key=lambda item: (item[0], item[1], item[2]))
            for _, _, item_idx, kind, item in timeline_items:
                if kind == "keyframe":
                    ts = short_timestamp(float(item.get("offset_seconds") or 0.0))
                    pres = _single_line(item.get("presenter")) or "Teilnehmer"
                    kf_id = _single_line(item.get("id"))
                    kf_link = f"{protocol_link}&keyframe={kf_id}" if kf_id else protocol_link
                    slide_suffix = (
                        f" _(Folie {item_idx + 1}/{total_slides})_" if total_slides > 1 else ""
                    )
                    lines.append(
                        f"> **[{ts}] Screen share ({pres}):** "
                        f"[{protocol_link}]({kf_link}){slide_suffix}"
                    )
                    lines.append("")
                elif kind == "pause":
                    ts_start = short_timestamp(float(item.get("offset_seconds") or 0.0))
                    end_off = item.get("end_offset_seconds")
                    span_label = (
                        f"{ts_start} – {short_timestamp(float(end_off))}"
                        if isinstance(end_off, (int, float))
                        else f"ab {ts_start}"
                    )
                    lines.append(
                        f"> **[{span_label}] Off-the-Record-Pause:** "
                        f"_Audio- und Bildschirmerfassung vorübergehend pausiert._"
                    )
                    lines.append("")
                elif kind == "opted_out":
                    ts_start = short_timestamp(float(item.get("offset_seconds") or 0.0))
                    end_off = item.get("end_offset_seconds")
                    span_label = (
                        f"{ts_start} – {short_timestamp(float(end_off))}"
                        if isinstance(end_off, (int, float))
                        else f"ab {ts_start}"
                    )
                    lines.append(
                        f"> **[{span_label}] (OPTED OUT COMMENT):** "
                        f"_Beitrag aufgrund von Opt-out nicht aufgezeichnet._"
                    )
                    lines.append("")
                else:
                    text = " ".join(item["text"].split())
                    label = " ".join(item["speaker_label"].split())
                    span = f"{timestamp(item['start'])} – {timestamp(item['end'])}"
                    lines.append(f"**{label}** (`{span}`): {text}")
                    lines.append("")
        return "\n".join(lines).rstrip() + "\n", "text/markdown; charset=utf-8"
    if format == "txt":
        lines = [
            f"WORTPROTOKOLL · {title}",
            f"Plattform: {human_provider} ({data['provider']})",
            f"Termin:    {human_period}",
            "-" * 72,
            "",
        ]
        if summary_text or decisions or topics:
            lines.extend(["ZUSAMMENFASSUNG", "-" * 72])
            if summary_text:
                lines.extend([summary_text, ""])
            if decisions:
                lines.append("Entscheidungen:")
                for d in decisions:
                    d_text = _single_line(d["text"])
                    lines.append(f"✓ {d_text}{_txt_citation_suffix(d)}")
                lines.append("")
            if topics:
                lines.append("Besprochene Themen & Ergebnisse:")
                for t in topics:
                    t_title = _single_line(t.get("title")) or "Thema"
                    t_details = _single_line(t.get("details"))
                    t_cite = _txt_citation_suffix(t)
                    lines.append(
                        f"• {t_title}: {t_details}{t_cite}"
                        if t_details
                        else f"• {t_title}{t_cite}"
                    )
                lines.append("")
        if has_summary_content:
            lines.extend(["TO-DO-LISTE", "-" * 72])
            if actions:
                for a in actions:
                    owner = _single_line(a.get("owner")) or "Team"
                    task = _single_line(a["task"])
                    due = _single_line(a.get("due"))
                    suffix = f" (Fällig: {due})" if due else ""
                    lines.append(
                        f"[ ] {owner}: {task}{suffix}{_txt_citation_suffix(a)}"
                    )
            else:
                lines.append("Keine offenen Aufgaben vereinbart.")
            lines.append("")
        if pause_windows_list:
            lines.extend(["OFF-THE-RECORD-PAUSEN", "-" * 72])
            for pw in pause_windows_list:
                ts_start = short_timestamp(float(pw.get("offset_seconds") or 0.0))
                end_off = pw.get("end_offset_seconds")
                span_label = (
                    f"{ts_start} – {short_timestamp(float(end_off))}"
                    if isinstance(end_off, (int, float))
                    else f"ab {ts_start}"
                )
                lines.append(f"[{span_label}] OFF-THE-RECORD-PAUSE")
            lines.append("")
        if notes_text:
            lines.extend(["NOTIZEN", "-" * 72, notes_text, ""])
        txt_entries: list[tuple[float, int, str]] = []
        for idx, ow in enumerate(data.get("opted_out_windows") or []):
            s_off = float(ow.get("offset_seconds") or 0.0)
            e_off = ow.get("end_offset_seconds")
            span = (
                f"{timestamp(s_off)} – {timestamp(float(e_off))}"
                if isinstance(e_off, (int, float))
                else timestamp(s_off)
            )
            txt_entries.append((s_off, idx, f"[{span}] (OPTED OUT COMMENT)"))
        for idx, segment in enumerate(data["segments"]):
            text = " ".join(segment["text"].split())
            label = " ".join(segment["speaker_label"].split())
            seg_span = f"{timestamp(segment['start'])} – {timestamp(segment['end'])}"
            txt_entries.append(
                (float(segment["start"]), 10000 + idx, f"[{seg_span}] {label}: {text}")
            )
        txt_entries.sort(key=lambda item: (item[0], item[1]))
        for _, _, line in txt_entries:
            lines.append(line)
        lines.extend(["", "-" * 72, header.rstrip()])
        return "\n".join(lines) + "\n", "text/plain; charset=utf-8"
    lines = ["WEBVTT", "", "NOTE " + status, ""]
    for segment in data["segments"]:
        if not segment["text"]:
            continue
        label = escape(" ".join(segment["speaker_label"].split()).replace("-->", "→"))
        text = escape(" ".join(segment["text"].split()).replace("-->", "→"))
        lines.extend(
            [
                segment["id"],
                f"{timestamp(segment['start'])} --> {timestamp(segment['end'])}",
                f"{label}: {text}",
                "",
            ]
        )
    return "\n".join(lines), "text/vtt; charset=utf-8"


def _opted_out_set(meta: object) -> set[str]:
    if not isinstance(meta, dict):
        return set()
    return {
        str(x).strip().lower()
        for x in (meta.get("opted_out_speakers") or [])
        if str(x).strip()
    }


_FREEMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "outlook.de",
        "hotmail.com",
        "live.com",
        "icloud.com",
        "me.com",
        "gmx.de",
        "gmx.net",
        "web.de",
        "t-online.de",
        "yahoo.com",
        "proton.me",
        "protonmail.com",
        "posteo.de",
        "mailbox.org",
        "localhost",
        "example.org",
        "example.com",
    }
)


def extract_org_glossary_hints(attendee_emails: object) -> list[str]:
    if not isinstance(attendee_emails, list):
        return []
    hints: list[str] = []
    seen: set[str] = set()
    for raw in attendee_emails:
        email = str(raw or "").strip().lower()
        if "@" not in email:
            continue
        domain = email.rsplit("@", 1)[1].strip(".")
        if not domain or domain in _FREEMAIL_DOMAINS:
            continue
        parts = [p for p in domain.split(".") if p]
        generic_tlds = ("com", "org", "net", "edu", "gov")
        if len(parts) == 2 and len(parts[1]) >= 3 and parts[1] not in generic_tlds:
            cand = f"{parts[0].capitalize()}.{parts[1].upper()}"
        else:
            stem = parts[-2] if len(parts) >= 2 else parts[0]
            if len(stem) < 3:
                continue
            cand = stem.capitalize()
        if cand.lower() not in seen:
            seen.add(cand.lower())
            hints.append(cand[:60])
    return hints


def _normalize_keyframe_context_entry(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    view = _single_line(raw.get("view") or raw.get("summary") or "")[:220]
    items: list[str] = []
    seen_items: set[str] = set()
    for it in raw.get("items") or []:
        if isinstance(it, dict):
            item_id = _single_line(it.get("id") or it.get("key") or "")
            item_title = _single_line(
                it.get("title") or it.get("name") or it.get("summary") or ""
            )
            label = (
                f"{item_id}: {item_title}"
                if item_id and item_title
                else (item_id or item_title)
            )
        else:
            label = _single_line(it)
        label = label[:160]
        if label and label.lower() not in seen_items and len(items) < 16:
            seen_items.add(label.lower())
            items.append(label)
    terms: list[str] = []
    seen_terms: set[str] = set()
    for raw_t in raw.get("terms") or []:
        clean_t = _single_line(raw_t)[:60]
        if (
            len(clean_t) >= 2
            and any(ch.isalnum() for ch in clean_t)
            and clean_t.lower() not in seen_terms
            and len(terms) < 24
        ):
            seen_terms.add(clean_t.lower())
            terms.append(clean_t)
    if not view and not items and not terms:
        return None
    return {"view": view, "items": items, "terms": terms}


def extract_keyframe_visual_context(
    png_bytes: bytes,
    *,
    summary_lang: str = "German",
    settings=None,
    timeout: float = 35.0,
) -> dict | None:
    """Extract visible ticket IDs, headings, and domain terms from a redacted keyframe PNG."""
    if not png_bytes:
        return None
    settings = settings or get_settings()
    if not settings.llm_summary_configured():
        return None
    if summary_lang == "German":
        sys_prompt = (
            "Extrahiere aus dem geteilten Konferenz-Bildschirmfoto präzise den sichtbaren "
            "Arbeitskontext als JSON-Objekt mit genau diesen Feldern:\n"
            '{"view": "Kurze Beschreibung der Ansicht (max. 1 Satz)", '
            '"items": ["Sichtbare Ticket-IDs mit Titel (z. B. MAIS-270: ...), PR-Nummern, '
            'Folienüberschriften oder Dateinamen"], '
            '"terms": ["Sichtbare Produktnamen, Modell-IDs, Bibliotheken und Fachbegriffe in '
            'exakter Originalschreibweise"]}\n'
            "Übernimm Ziffern, Versionsnummern (z. B. 3.0 vs. 3.8), Modell-IDs und Dateinamen "
            "zeichengetreu; erfinde nichts hinzu und lasse unscharfen Text weg."
        )
        usr_prompt = "Analysiere diesen geteilten Bildschirm-Ausschnitt."
    else:
        sys_prompt = (
            "Extract the visible workspace context from this shared conference screen frame "
            "strictly as a JSON object with these fields:\n"
            f'{{"view": "Concise 1-sentence description in {summary_lang}", '
            '"items": ["Visible ticket IDs with title, PR numbers, slide headings, or files"], '
            '"terms": ["Visible product names, model IDs, libraries, and technical terms in '
            'exact spelling"]}\n'
            "Transcribe digits, version numbers, model IDs, and filenames verbatim; "
            "do not guess blurry text."
        )
        usr_prompt = "Analyze this shared screen frame."
    from wortlaut.llm import chat_completion_json

    try:
        parsed = chat_completion_json(
            system_prompt=sys_prompt,
            user_prompt=usr_prompt,
            settings=settings,
            timeout_seconds=float(timeout),
            max_tokens=600,
            temperature=0.1,
            image_png_bytes=png_bytes,
            ollama_num_ctx=8192,
        )
    except RuntimeError:
        return None
    return _normalize_keyframe_context_entry(parsed)


def _select_representative_keyframes(
    keyframes: list[dict],
    *,
    max_count: int = 10,
    burst_gap_seconds: float = 15.0,
) -> list[dict]:
    if not keyframes:
        return []
    clusters: list[list[dict]] = []
    for kf in keyframes:
        if not clusters:
            clusters.append([kf])
            continue
        prev = clusters[-1][-1]
        gap = float(kf.get("offset_seconds") or 0.0) - float(prev.get("offset_seconds") or 0.0)
        same_presenter = kf.get("participant_id") == prev.get("participant_id")
        if same_presenter and 0.0 <= gap < burst_gap_seconds:
            clusters[-1].append(kf)
        else:
            clusters.append([kf])
    selected: list[dict] = []
    for idx, cluster in enumerate(clusters):
        if (
            idx == 0
            and len(cluster) > 1
            and (
                float(cluster[-1].get("offset_seconds") or 0.0)
                - float(cluster[0].get("offset_seconds") or 0.0)
            )
            >= 20.0
        ):
            selected.append(cluster[0])
        selected.append(cluster[-1])
    if len(selected) <= max_count:
        return selected
    if max_count <= 1:
        return [selected[-1]]
    step = (len(selected) - 1) / (max_count - 1)
    indices = sorted({round(i * step) for i in range(max_count)})
    return [selected[i] for i in indices]


def _format_keyframe_context_line(
    kf: dict,
    ctx: dict,
    origin_utc: str | None,
    term_replacements: dict[str, str] | None = None,
) -> str | None:
    view = _single_line(ctx.get("view") or "")
    items = [_single_line(x) for x in (ctx.get("items") or []) if _single_line(x)]
    if not view and not items:
        return None
    t_label = wall_clock_time_de(origin_utc, float(kf.get("offset_seconds") or 0.0))
    presenter = _single_line(kf.get("presenter") or "Präsentation")
    parts: list[str] = []
    if view:
        parts.append(view)
    if items:
        parts.append("Sichtbar: " + "; ".join(items[:10]))
    body = " | ".join(parts)
    if term_replacements:
        body = _apply_text_replacements(body, term_replacements)
    return f"- [{t_label}] {presenter}: {body}"


def generate_protocol_summary(db: Session, recording_id: uuid.UUID) -> dict:
    settings = get_settings()
    if not settings.llm_summary_configured():
        db.rollback()
        raise RuntimeError("llm_summary_disabled")
    recording = db.get(Recording, recording_id)
    if recording is None or recording.transcript_deleted_at is not None:
        db.rollback()
        raise LookupError("recording_not_found")
    prior_meta = dict(recording.protocol_meta or {})
    prior_opted_out = _opted_out_set(prior_meta)
    prior_participation = recording.participation
    from wortlaut.glossary import resolve_recording_glossary

    resolved_glossary_terms, glossary_alias_repls = resolve_recording_glossary(
        db, recording, settings
    )
    data = export_data(db, recording)
    kf_object_keys: dict[str, str] = {
        str(r.id): r.object_key
        for r in db.scalars(
            select(RecordingKeyframe).where(
                RecordingKeyframe.recording_id == recording.id,
                RecordingKeyframe.deleted_at.is_(None),
            )
        ).all()
        if r.object_key
    }
    title = _single_line(recording.title) or f"Besprechung ({provider_label(recording.provider)})"
    # End the read transaction before calling Ollama so no DB snapshot or row lock is held.
    db.rollback()

    segments = data.get("segments") or []
    origin_utc = data.get("time_origin_utc")
    timed_lines: list[tuple[float, int, str]] = []
    known_speakers: list[str] = []
    seen_speakers: set[str] = set()
    total_speech_seconds = 0.0
    for idx, seg in enumerate(segments):
        txt = _single_line(seg.get("text"))
        if not txt:
            continue
        seg_start = float(seg.get("start") or 0.0)
        seg_end = float(seg.get("end") or seg_start)
        total_speech_seconds += max(0.0, seg_end - seg_start)
        t0 = wall_clock_time_de(origin_utc, seg_start)
        spk = _single_line(seg.get("speaker_label")) or "Sprecher"
        if (
            spk
            and spk.lower() not in seen_speakers
            and not spk.lower().startswith(
                ("sprecher", "teilnehmer", "freigabe-audio", "screen share")
            )
        ):
            seen_speakers.add(spk.lower())
            known_speakers.append(spk)
        timed_lines.append((seg_start, idx, f"[{t0}] {spk}: {txt}"))
    if timed_lines:
        for idx, ow in enumerate(data.get("opted_out_windows") or []):
            ow_start = float(ow.get("offset_seconds") or 0.0)
            t0 = wall_clock_time_de(origin_utc, ow_start)
            timed_lines.append((ow_start, 100000 + idx, f"[{t0}] (OPTED OUT COMMENT)"))
        timed_lines.sort(key=lambda item: (item[0], item[1]))
    transcript_lines: list[str] = [line for _, _, line in timed_lines]
    for src in data.get("sources_summary") or []:
        if src.get("opted_out"):
            continue
        s_name = _single_line(src.get("participant_name") or src.get("speaker_label"))
        if (
            s_name
            and s_name.lower() not in seen_speakers
            and not s_name.lower().startswith(
                ("sprecher", "teilnehmer", "freigabe-audio", "screen share", "quelle ")
            )
            and s_name.lower() not in prior_opted_out
        ):
            seen_speakers.add(s_name.lower())
            known_speakers.append(s_name)
    for att_name in prior_meta.get("attendee_names") or []:
        clean_att = _single_line(att_name)[:60]
        if (
            clean_att
            and clean_att.lower() not in seen_speakers
            and clean_att.lower() not in prior_opted_out
        ):
            seen_speakers.add(clean_att.lower())
            known_speakers.append(clean_att)
    if not transcript_lines:
        raise ValueError("Kein Transkript für die KI-Zusammenfassung vorhanden.")

    transcript_text = "\n".join(transcript_lines)
    if len(transcript_text) > 84000:
        transcript_text = (
            transcript_text[:52000]
            + "\n...[Mittelteil gekürzt]...\n"
            + transcript_text[-32000:]
        )

    lang_spec = effective_recording_language(prior_meta, settings)
    if lang_spec and lang_spec != "auto" and "," not in lang_spec:
        summary_lang = lang_spec
    else:
        lang_weights: dict[str, int] = {}
        for seg in segments:
            s_lang = seg.get("language")
            s_txt = _single_line(seg.get("text"))
            if isinstance(s_lang, str) and s_lang and s_txt:
                lang_weights[s_lang] = lang_weights.get(s_lang, 0) + len(s_txt)
        if lang_weights:
            summary_lang = max(lang_weights.items(), key=lambda kv: kv[1])[0]
        else:
            summary_lang = "German" if settings.default_locale == "de" else "English"

    active_keyframes = data.get("keyframes") or []
    raw_cached_ctx = prior_meta.get("keyframe_context")
    cached_kf_ctx: dict[str, dict] = {}
    if isinstance(raw_cached_ctx, dict):
        for kf_id_k, kf_val in raw_cached_ctx.items():
            norm_entry = _normalize_keyframe_context_entry(kf_val)
            if norm_entry is not None:
                cached_kf_ctx[str(kf_id_k)] = norm_entry

    newly_extracted_kf_ctx: dict[str, dict] = {}
    if active_keyframes and settings.s3_access_key and settings.s3_secret_key:
        rep_keyframes = _select_representative_keyframes(active_keyframes, max_count=10)
        vision_budget = min(55.0, float(settings.llm_summary_timeout_seconds()) * 0.45)
        vision_deadline = time.monotonic() + vision_budget
        extracted_now = 0
        for rep_kf in rep_keyframes:
            rep_id = str(rep_kf.get("id") or "")
            if not rep_id or rep_id in cached_kf_ctx or extracted_now >= 6:
                continue
            if time.monotonic() >= vision_deadline:
                break
            obj_key = kf_object_keys.get(rep_id)
            if not obj_key:
                continue
            try:
                png_bytes = get_storage().read(obj_key)
            except Exception:
                continue
            rem_timeout = max(8.0, min(30.0, vision_deadline - time.monotonic()))
            extracted = extract_keyframe_visual_context(
                png_bytes,
                summary_lang=summary_lang,
                settings=settings,
                timeout=rem_timeout,
            )
            extracted_now += 1
            if extracted is not None:
                cached_kf_ctx[rep_id] = extracted
                newly_extracted_kf_ctx[rep_id] = extracted

    term_repls = prior_meta.get("term_replacements")
    effective_repls = {
        **glossary_alias_repls,
        **(term_repls if isinstance(term_repls, dict) else {}),
    }
    screen_context_lines: list[str] = []
    visual_terms: list[str] = []
    last_kf_sig: tuple[str, tuple[str, ...]] | None = None
    for kf in _select_representative_keyframes(active_keyframes, max_count=12):
        kf_ctx = cached_kf_ctx.get(str(kf.get("id") or ""))
        if not kf_ctx:
            continue
        kf_sig = (
            _single_line(kf_ctx.get("view") or "").lower(),
            tuple(
                _single_line(x).lower()
                for x in (kf_ctx.get("items") or [])[:10]
                if _single_line(x)
            ),
        )
        for vt in kf_ctx.get("terms") or []:
            visual_terms.append(vt)
        if kf_sig == last_kf_sig:
            continue
        last_kf_sig = kf_sig
        line = _format_keyframe_context_line(kf, kf_ctx, origin_utc, effective_repls)
        if line:
            screen_context_lines.append(line)

    is_detailed_meeting = (
        total_speech_seconds >= 900.0
        or len(transcript_lines) >= 80
        or len(screen_context_lines) >= 3
    )

    if summary_lang == "German":
        summary_len_hint = (
            "Prägnante Management-Zusammenfassung der Ergebnisse (3-6 Sätze)."
            if is_detailed_meeting
            else "Prägnante Management-Zusammenfassung des Gesprächs (2-4 Sätze)."
        )
        topics_len_hint = (
            "Besprochene Inhalte, Status, Entscheidungen und ggf. zugehörige Ticket-/PR-Nummern "
            "in 2 bis 5 präzisen Sätzen; bilde bei längeren Reviews alle eigenständigen "
            "Themenblöcke ab."
            if is_detailed_meeting
            else "Besprochene Inhalte und Entscheidungen in 1 bis 3 Sätzen."
        )
        system_prompt = (
            "Du bist ein präziser deutschsprachiger Protokollführer für Geschäftstreffen. "
            "Erstelle aus dem folgenden Wortprotokoll eine sachliche, strukturierte "
            "Zusammenfassung, Entscheidungs- und To-Do-Liste auf Deutsch. "
            "Antworte ausschließlich als valides JSON-Objekt mit genau diesem Schema:\n"
            "{\n"
            f'  "summary": "{summary_len_hint}",\n'
            '  "decisions": [\n'
            '    {"text": "Konkreter getroffener Beschluss oder verbindliche Festlegung.", '
            '"timestamp": "Exakter Zeitstempel HH:MM:SS der belegenden Stelle aus dem Protokoll"}\n'
            "  ],\n"
            '  "topics": [\n'
            f'    {{"title": "Kurzer Thementitel", "details": "{topics_len_hint}", '
            '"timestamp": "Start-Zeitstempel HH:MM:SS dieses Themenblocks aus dem Protokoll"}\n'
            "  ],\n"
            '  "action_items": [\n'
            '    {"owner": "Name der Person (oder \'Team\')", '
            '"task": "Konkrete vereinbarte Aufgabe oder nächster Schritt.", '
            '"due": "Im Gespräch genannter Termin/Zeitraum oder leerer String \\"\\"", '
            '"timestamp": "Exakter Zeitstempel HH:MM:SS der Vereinbarung aus dem Protokoll"}\n'
            "  ]\n"
            "}\n"
            "Wichtige Regeln:\n"
            "- Erfinde keine Fakten, Fristen, Zeitstempel oder Namen, die nicht im Gespräch "
            "oder im nachgewiesenen Bildschirmkontext vorkommen.\n"
            "- Führe unter `decisions` ausschließlich tatsächlich getroffene Entscheidungen, "
            "Beschlüsse oder verbindliche Richtungsfestlegungen auf (keine Statusmeldungen); "
            'wurde nichts entschieden, gib `"decisions": []` zurück.\n'
            "- Gib bei jedem Eintrag in `decisions`, `topics` und `action_items` im Feld "
            '`"timestamp"` den exakten `[HH:MM:SS]`-Zeitstempel der belegenden Zeile aus dem '
            "Wortprotokoll an.\n"
            "- Erfasse in `action_items` alle konkret zugesagten Folgeaufgaben, PR-Reviews, "
            "Konfigurationsprüfungen, Testzugänge und anzulegenden Tickets mit der zuständigen "
            'Person; wenn nichts vereinbart wurde, gib `"action_items": []` zurück.\n'
            "- Ordne Vorschläge, Bewertungen und Zusagen namentlich den Personen zu, die sie "
            "tatsächlich eingebracht haben.\n"
            "- Wenn Teilnehmende zeigend auf den geteilten Bildschirm verweisen (z. B. 'der hier', "
            "'das Ticket', 'kann rüber') und ein zeitlich passender Eintrag unter "
            "'Sichtbarer Bildschirmkontext' vorliegt, nutze die dort sichtbare Ticket-ID bzw. "
            "Bezeichnung zur Präzisierung. Verschmelze niemals zwei benachbarte Karten/Tickets "
            "auf einem Board zu einer erfundenen Misch-Aufgabe.\n"
            "- Übernimm die exakte Schreibweise der Teilnehmendennamen und Fachbegriffe. "
            "Sichtbare Begriffe, Dateinamen und Überschriften aus 'Sichtbarer Bildschirmkontext' "
            "und 'Fachbegriffe / Glossar' haben stets Vorrang vor phonetisch ähnlichen "
            "Spracherkennungsfehlern im Wortprotokoll (z. B. Resale/Token-Reselling statt "
            "'Token-Recycling' bei sichtbarer Resale-Datei, Voicebot statt 'Voiceboard', "
            "Jitsi statt 'Jetzti'/'Chitzy', Wortlaut statt 'Wordlaut'/'Wortcloud', "
            "MkDocs statt 'MakeDocs', Diataxis statt 'Diary-Taxus', RAG statt 'Rack', "
            "Databricks statt 'DataWorks', KEDA/Coder/SeaweedFS/MinIO/Argo CD/SonarQube "
            "statt phonetischer Verhörer, Langfuse/LangGraph statt 'Langviews'/'Langraft', "
            "HubSpot statt 'Hopspot', Jira statt 'Chirer').\n"
            "- Trenne Nebenbemerkungen zu Alternativmodellen, Smalltalk oder Drittsystemen sauber "
            "von der tatsächlich besprochenen bzw. gezeigten Lösung."
        )
    else:
        summary_len_en = (
            f"Concise executive summary in {summary_lang} (3-6 sentences)."
            if is_detailed_meeting
            else f"Concise executive summary in {summary_lang} (2-4 sentences)."
        )
        topics_len_en = (
            f"Discussed points, outcomes, and matching ticket/PR IDs in {summary_lang} "
            "(2-5 sentences); cover all distinct agenda blocks."
            if is_detailed_meeting
            else f"Discussed points and outcomes in {summary_lang} (1-3 sentences)."
        )
        system_prompt = (
            "You are a precise meeting minutes secretary. "
            "Produce a factual, structured executive summary, decisions log, and action-item list "
            f"written in {summary_lang} from the verbatim transcript below. "
            "Respond strictly as a valid JSON object matching this exact schema:\n"
            "{\n"
            f'  "summary": "{summary_len_en}",\n'
            '  "decisions": [\n'
            f'    {{"text": "Concrete agreed decision in {summary_lang}.", '
            '"timestamp": "Exact HH:MM:SS timestamp from the transcript"}\n'
            "  ],\n"
            '  "topics": [\n'
            f'    {{"title": "Short topic title in {summary_lang}", '
            f'"details": "{topics_len_en}", '
            '"timestamp": "Starting HH:MM:SS timestamp of this topic from the transcript"}\n'
            "  ],\n"
            '  "action_items": [\n'
            '    {"owner": "Person name (or \'Team\')", '
            f'"task": "Concrete agreed action item in {summary_lang}.", '
            '"due": "Mentioned deadline/timeframe or empty string \\"\\"", '
            '"timestamp": "Exact HH:MM:SS timestamp from the transcript"}\n'
            "  ]\n"
            "}\n"
            "Rules:\n"
            "- Never invent facts, deadlines, timestamps, or names not present in the transcript "
            "or verified screen-share context.\n"
            "- List only explicit decisions or binding agreements under `decisions`; if none were "
            'made, return `"decisions": []`.\n'
            "- Provide the exact `[HH:MM:SS]` source timestamp from the transcript on every entry "
            "in `decisions`, `topics`, and `action_items`.\n"
            "- Capture all concrete follow-ups, PR reviews, test setups, and ticket actions "
            'with their owner; if none were agreed, return `"action_items": []`.\n'
            "- Attribute proposals and commitments to the actual speaker by name.\n"
            "- When speakers refer deictically to shared screen items ('this ticket', 'this one') "
            "and a timestamp-matching screen-share context entry exists, cite the visible ticket "
            "ID/title accurately; never conflate two adjacent cards on a board into one task.\n"
            "- Preserve exact spelling of participant names and domain terminology. Visible "
            "terms, filenames, and headings from screen-share context and the glossary are "
            "authoritative over phonetically similar ASR misspellings in the transcript "
            "(e.g. Resale/Token-Reselling instead of 'Token-Recycling' when a resale file is "
            "shown, Voicebot instead of 'Voiceboard', Jitsi instead of 'Jetzti', Wortlaut "
            "instead of 'Wordlaut'/'Wortcloud', MkDocs instead of 'MakeDocs', RAG instead of "
            "'Rack', Databricks instead of 'DataWorks', KEDA/Coder/SeaweedFS/MinIO/"
            "Argo CD/SonarQube, Langfuse/LangGraph, HubSpot, Jira).\n"
            "- Keep side remarks or small talk distinct from the demonstrated solution."
        )
    meta_lines = [f"Titel der Besprechung: {title}"]
    if known_speakers:
        meta_lines.append(f"Bekannte Teilnehmende: {', '.join(known_speakers)}")
    repl_values = list(term_repls.values()) if isinstance(term_repls, dict) else []
    assistant_hint = _single_line(settings.assistant_name)
    builtin_hints = (
        [assistant_hint]
        if assistant_hint and assistant_hint.lower() != "wortlaut"
        else []
    )
    org_hints = extract_org_glossary_hints(prior_meta.get("attendee_emails"))
    merged_glossary: list[str] = []
    seen_glossary: set[str] = set()
    for raw_term in [
        *repl_values,
        *resolved_glossary_terms,
        *visual_terms,
        *builtin_hints,
        *org_hints,
    ]:
        term = _single_line(raw_term)[:60]
        if term and term.lower() not in seen_glossary and len(merged_glossary) < 80:
            seen_glossary.add(term.lower())
            merged_glossary.append(term)
    if merged_glossary:
        meta_lines.append(f"Fachbegriffe / Glossar: {', '.join(merged_glossary)}")
    prompt_sections = ["\n".join(meta_lines)]
    if screen_context_lines:
        prompt_sections.append(
            "Sichtbarer Bildschirmkontext (zeitlich passend zur Bildschirmfreigabe):\n"
            + "\n".join(screen_context_lines)
        )
    prompt_sections.append(f"Wortprotokoll:\n{transcript_text}")
    user_prompt = "\n\n".join(prompt_sections)
    ctx_window = 40960 if len(user_prompt) > 48000 else 32768

    from wortlaut.llm import chat_completion_json

    parsed = chat_completion_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        settings=settings,
        timeout_seconds=float(settings.llm_summary_timeout_seconds()),
        max_tokens=4096,
        temperature=0.2,
        ollama_num_ctx=ctx_window,
    )
    decisions_list: list[dict] = []
    for raw_dec in parsed.get("decisions") or []:
        if isinstance(raw_dec, str):
            dec_txt = _single_line(raw_dec)
            if dec_txt:
                decisions_list.append({"text": dec_txt})
            continue
        if not isinstance(raw_dec, dict):
            continue
        dec_txt = _single_line(raw_dec.get("text") or raw_dec.get("decision"))
        if not dec_txt:
            continue
        dec_item: dict = {"text": dec_txt}
        dec_ts, dec_off = resolve_citation_timestamp(
            raw_dec.get("timestamp"),
            raw_dec.get("offset_seconds"),
            origin_utc=origin_utc,
            segments=segments,
            keyframes=active_keyframes,
        )
        if dec_ts and dec_off is not None:
            dec_item["timestamp"] = dec_ts
            dec_item["offset_seconds"] = dec_off
        decisions_list.append(dec_item)

    action_items: list[dict] = []
    for a in parsed.get("action_items") or []:
        if not isinstance(a, dict) or not _single_line(a.get("task")):
            continue
        item: dict = {
            "owner": _single_line(a.get("owner")) or "Team",
            "task": _single_line(a.get("task")),
        }
        due = _single_line(a.get("due"))
        if due:
            item["due"] = due
        act_ts, act_off = resolve_citation_timestamp(
            a.get("timestamp"),
            a.get("offset_seconds"),
            origin_utc=origin_utc,
            segments=segments,
            keyframes=active_keyframes,
        )
        if act_ts and act_off is not None:
            item["timestamp"] = act_ts
            item["offset_seconds"] = act_off
        action_items.append(item)

    topics_list: list[dict] = []
    for t in parsed.get("topics") or []:
        if not isinstance(t, dict):
            continue
        t_title = _single_line(t.get("title"))
        t_details = _single_line(t.get("details"))
        if not (t_title or t_details):
            continue
        t_item: dict = {"title": t_title, "details": t_details}
        top_ts, top_off = resolve_citation_timestamp(
            t.get("timestamp"),
            t.get("offset_seconds"),
            origin_utc=origin_utc,
            segments=segments,
            keyframes=active_keyframes,
        )
        if top_ts and top_off is not None:
            t_item["timestamp"] = top_ts
            t_item["offset_seconds"] = top_off
        topics_list.append(t_item)

    cleaned_summary = str(parsed.get("summary") or "").strip()
    if not cleaned_summary and not decisions_list and not topics_list and not action_items:
        raise RuntimeError(
            "llm_empty_summary" if settings.openai_chat_configured() else "ollama_empty_summary"
        )
    summary_obj = {
        "summary": cleaned_summary,
        "decisions": decisions_list,
        "topics": topics_list,
        "action_items": action_items,
        "model": settings.active_llm_model(),
        "generated_at": datetime.now(UTC).isoformat(),
    }

    locked_rec = db.scalar(
        select(Recording).where(Recording.id == recording_id).with_for_update()
    )
    if locked_rec is None or locked_rec.transcript_deleted_at is not None:
        db.rollback()
        raise LookupError("recording_not_found")
    if prior_participation == "ended" and locked_rec.participation != "ended":
        db.rollback()
        raise ValueError("Aufnahme wurde während der Zusammenfassung neu gestartet.")
    if _opted_out_set(locked_rec.protocol_meta) != prior_opted_out:
        db.rollback()
        raise ValueError("Teilnehmer-Opt-out während der Zusammenfassung erkannt.")
    meta = dict(locked_rec.protocol_meta or {})
    if newly_extracted_kf_ctx:
        live_kf_ids = {
            str(kid)
            for kid in db.scalars(
                select(RecordingKeyframe.id).where(
                    RecordingKeyframe.recording_id == recording_id,
                    RecordingKeyframe.deleted_at.is_(None),
                )
            ).all()
        }
        merged_kf_ctx = dict(
            meta.get("keyframe_context")
            if isinstance(meta.get("keyframe_context"), dict)
            else {}
        )
        for kid, kval in newly_extracted_kf_ctx.items():
            if kid in live_kf_ids:
                merged_kf_ctx[kid] = kval
        if merged_kf_ctx:
            meta["keyframe_context"] = merged_kf_ctx
    from wortlaut.rag import invalidate_recording_rag_index

    meta["summary"] = summary_obj
    invalidate_recording_rag_index(meta)
    locked_rec.protocol_meta = meta
    db.commit()
    return summary_obj


def extract_audio_snippet_wav(
    db: Session,
    recording: Recording,
    stream_id: str | None,
    start_sec: float,
    end_sec: float,
) -> bytes:
    if recording.audio_deleted_at is not None:
        raise LookupError("audio_deleted")
    if not stream_id or not str(stream_id).strip():
        raise LookupError("stream_id_required")
    attempts = list(
        db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    )
    if not attempts:
        raise LookupError("no_audio")
    streams = list(
        db.scalars(
            select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
        ).all()
    )
    if not streams:
        raise LookupError("no_audio")
    anchors = [datetime.fromisoformat(s.contract["session_utc_origin"]) for s in streams]
    origin = min(anchors) if anchors else recording.starts_at

    participant_names, bind_controls = collect_stream_participant_names(
        db, streams, attempts=attempts, order_binds=True
    )
    _, opted_out_norm = collect_opted_out_speakers(recording, attempts, participant_names)

    candidates = [s for s in streams if str(s.stream_id) == str(stream_id).strip()]
    if not candidates:
        raise LookupError("stream_not_found")

    duration_sec = min(90.0, max(0.8, float(end_sec) - float(start_sec)))
    target_end_sec = float(start_sec) + duration_sec

    def _resolve_allowed_sample_window(
        s: AudioStream,
        core_start: int,
        core_end: int,
        padded_start: int,
        padded_end: int,
    ) -> tuple[int, int, str | None]:
        def _ctrl_sample(ctrl: AudioControl) -> int:
            if ctrl.start_sample is not None:
                return int(ctrl.start_sample)
            return int((ctrl.contract or {}).get("start_sample") or 0)

        s_binds = sorted(
            [c for c in bind_controls if c.stream_id == s.id],
            key=_ctrl_sample,
        )
        intervals: list[tuple[int, int | None, dict]] = []
        first_bind_sample = _ctrl_sample(s_binds[0]) if s_binds else None
        if first_bind_sample is None or first_bind_sample > 0:
            intervals.append((0, first_bind_sample, s.contract))
        for idx, ctrl in enumerate(s_binds):
            cur_s = _ctrl_sample(ctrl)
            nxt = _ctrl_sample(s_binds[idx + 1]) if idx + 1 < len(s_binds) else None
            intervals.append((cur_s, nxt, ctrl.contract))

        observed_pids: set[str] = set()
        for _, _, cdict in intervals:
            if not cdict.get("attribution_unknown"):
                opid = cdict.get("participant_id") or cdict.get("speaker_id")
                if opid:
                    observed_pids.add(str(opid))
        unambiguous_pid = next(iter(observed_pids)) if len(observed_pids) == 1 else None

        def _interval_block_reason(cdict: dict) -> str | None:
            if not opted_out_norm:
                return None
            cpid = cdict.get("participant_id") or cdict.get("speaker_id") or unambiguous_pid
            cpname = cdict.get("participant_name") or (
                participant_names.get(str(cpid)) if cpid else None
            )
            cspk = cdict.get("speaker_id") or unambiguous_pid
            cpsid = cdict.get("provider_source_id") or s.contract.get("provider_source_id")
            if is_speaker_opted_out(
                opted_out_norm,
                participant_id=str(cpid) if cpid else None,
                speaker_id=str(cspk) if cspk else None,
                participant_name=str(cpname) if cpname else None,
                provider_source_id=str(cpsid) if cpsid else None,
            ):
                return "speaker_opted_out"
            if cdict.get("attribution_unknown") and not unambiguous_pid:
                return "attribution_unverified"
            return None

        eff_start = padded_start
        eff_end = padded_end
        for idx, (iv_start, iv_end, cdict) in enumerate(intervals):
            eval_cdict = cdict
            if (
                cdict.get("attribution_unknown")
                and iv_end is not None
                and 0 < (iv_end - iv_start) <= ONSET_BIND_MAX_SAMPLES
                and idx + 1 < len(intervals)
                and not intervals[idx + 1][2].get("attribution_unknown")
                and cdict.get("source_kind", "speaker")
                == intervals[idx + 1][2].get("source_kind", "speaker")
            ):
                eval_cdict = intervals[idx + 1][2]
            reason = _interval_block_reason(eval_cdict)
            if reason is None:
                continue
            # If the core segment itself overlaps a blocked interval, reject immediately.
            if (iv_end is None or iv_end > core_start) and iv_start < core_end:
                return eff_start, eff_end, reason
            # Clamp context padding so it never bleeds into an adjacent blocked interval.
            if iv_end is not None and iv_end <= core_start and eff_start < iv_end:
                eff_start = iv_end
            if iv_start >= core_end and eff_end > iv_start:
                eff_end = iv_start
        return eff_start, max(eff_start + 1, eff_end), None

    pcm_bytes = b""
    blocked_reason: str | None = None
    for s in candidates:
        s_delta = (
            datetime.fromisoformat(s.contract["session_utc_origin"]) - origin
        ).total_seconds()
        s_mono_delta = (
            s.contract.get("monotonic_origin_ms", 0)
            - s.contract.get("session_monotonic_origin_ms", 0)
        ) / 1000.0
        stream_offset = s_delta + s_mono_delta
        core_start = max(0, int((float(start_sec) - stream_offset) * RATE))
        core_end = max(core_start + 1, int((target_end_sec - stream_offset) * RATE))
        padded_start = max(0, int((float(start_sec) - stream_offset - 0.15) * RATE))
        padded_end = max(
            padded_start + int(0.5 * RATE),
            int((target_end_sec - stream_offset + 0.25) * RATE),
        )
        start_sample, end_sample, block = _resolve_allowed_sample_window(
            s, core_start, core_end, padded_start, padded_end
        )
        if block is not None:
            blocked_reason = block
            continue
        chunks = db.scalars(
            select(AudioChunk)
            .where(
                AudioChunk.stream_id == s.id,
                AudioChunk.deleted_at.is_(None),
                AudioChunk.start_sample >= max(0, start_sample - MAX_CHUNK),
                AudioChunk.start_sample < end_sample,
                AudioChunk.start_sample + AudioChunk.sample_count > start_sample,
            )
            .order_by(AudioChunk.start_sample)
        ).all()
        if not chunks:
            continue
        clip_start = max(start_sample, chunks[0].start_sample)
        clip_end = min(end_sample, chunks[-1].start_sample + chunks[-1].sample_count)
        if clip_end <= clip_start:
            continue
        try:
            pcm_bytes = read_pcm(chunks, clip_start, clip_end)
            if pcm_bytes:
                break
        except Exception:
            continue

    if not pcm_bytes:
        raise LookupError(blocked_reason or "audio_range_unavailable")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(RATE)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()
