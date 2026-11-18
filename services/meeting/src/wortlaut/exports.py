import hmac
import io
import json
import re
import secrets
import uuid
import wave
from datetime import UTC, datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

import httpx
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
    for seg in segments:
        pid = seg.get("participant_id") or seg.get("speaker_id")
        if pid and seg.get("participant_name"):
            participant_names[pid] = seg["participant_name"]
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
            if resolved_name and not segment.get("participant_name"):
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
                if w_name and not segment.get("participant_name"):
                    segment["participant_name"] = w_name
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
        if not segment.get("attribution_unknown") and not segment.get("participant_name") and pid:
            if pid in participant_names:
                segment["participant_name"] = participant_names[pid]
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
        keyframes.append(
            {
                "id": str(kf.id),
                "captured_at": kf.captured_at.astimezone(UTC).isoformat(),
                "offset_seconds": offset_seconds,
                "presenter": presenter,
                "participant_id": kf.participant_id,
                "provider_source_id": kf.provider_source_id,
                "width": kf.width,
                "height": kf.height,
                "image_path": f"/v1/recordings/{recording.id}/keyframes/{kf.id}.png",
            }
        )
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
        ),
        "segments": segments,
        "keyframes": keyframes,
        "pause_windows": pause_windows,
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


def _build_sources_summary(
    attempts,
    streams,
    qualities,
    segments,
    participant_names,
    bind_controls=(),
    opted_out_norm: set[str] | None = None,
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
            grouped: dict[str | None, list[dict]] = {}
            for seg in src_segs:
                key = seg.get("participant_id") or seg.get("speaker_id")
                grouped.setdefault(key, []).append(seg)
            for seg_pid, group_segs in grouped.items():
                eff_sig_id = seg_pid or sig_id
                eff_name = (
                    next(
                        (
                            g.get("participant_name")
                            for g in group_segs
                            if g.get("participant_name")
                        ),
                        None,
                    )
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
                        "speaker_label": (
                            group_segs[0].get("speaker_label") or eff_name or eff_sig_id or sid
                        ),
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
    merged: list[dict] = []
    by_participant: dict[str, dict] = {}
    for item in summary:
        pid = item.get("signaled_participant_id")
        if pid and pid in by_participant:
            existing = by_participant[pid]
            existing["segment_count"] += item["segment_count"]
            existing["speech_seconds"] = round(
                existing["speech_seconds"] + item["speech_seconds"], 2
            )
            for src_id in item.get("provider_source_ids") or []:
                if src_id not in existing["provider_source_ids"]:
                    existing["provider_source_ids"].append(src_id)
            if not existing.get("participant_name") and item.get("participant_name"):
                existing["participant_name"] = item["participant_name"]
            cand_sample = _pick_representative_sample_text(
                [existing.get("sample_text") or "", item.get("sample_text") or ""]
            )
            if cand_sample:
                existing["sample_text"] = cand_sample
        else:
            if pid:
                by_participant[pid] = item
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
    topics: list[dict[str, str]] = []
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
            topics.append({"title": t_title, "details": t_details})
    action_items: list[dict[str, str]] = []
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
        item: dict[str, str] = {"owner": owner, "task": task}
        if due:
            item["due"] = due
        action_items.append(item)
    if not summary_text and not topics and not action_items:
        return None
    resolved: dict = {
        "summary": summary_text,
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
    has_summary_content = bool(summary_text or topics or actions)
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
        if summary_text or topics:
            lines.extend(["## Zusammenfassung", ""])
            if summary_text:
                lines.extend([summary_text, ""])
            if topics:
                lines.extend(["### Besprochene Themen & Ergebnisse", ""])
                for t in topics:
                    t_title = _single_line(t.get("title")) or "Thema"
                    t_details = _single_line(t.get("details"))
                    lines.append(
                        f"- **{t_title}:** {t_details}" if t_details else f"- **{t_title}**"
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
                    lines.append(f"- [ ] **{owner}:** {task}{suffix}")
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
        if (
            not data["segments"]
            and not keyframes_list
            and not pause_windows_list
        ):
            lines.append("_Keine Transkriptsegmente vorhanden._")
        else:
            ui_url = f"{get_settings().public_base_url()}/ui"
            protocol_link = f"{ui_url}#view=meetings&id={data['recording_id']}"
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
        if summary_text or topics:
            lines.extend(["ZUSAMMENFASSUNG", "-" * 72])
            if summary_text:
                lines.extend([summary_text, ""])
            if topics:
                lines.append("Besprochene Themen & Ergebnisse:")
                for t in topics:
                    t_title = _single_line(t.get("title")) or "Thema"
                    t_details = _single_line(t.get("details"))
                    lines.append(
                        f"• {t_title}: {t_details}" if t_details else f"• {t_title}"
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
                    lines.append(f"[ ] {owner}: {task}{suffix}")
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
        for segment in data["segments"]:
            text = " ".join(segment["text"].split())
            label = " ".join(segment["speaker_label"].split())
            lines.append(
                f"[{timestamp(segment['start'])} – {timestamp(segment['end'])}] {label}: {text}"
            )
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


def generate_protocol_summary(db: Session, recording_id: uuid.UUID) -> dict:
    settings = get_settings()
    recording = db.get(Recording, recording_id)
    if recording is None or recording.transcript_deleted_at is not None:
        db.rollback()
        raise LookupError("recording_not_found")
    prior_meta = dict(recording.protocol_meta or {})
    prior_opted_out = _opted_out_set(prior_meta)
    prior_participation = recording.participation
    from wortlaut.glossary import resolve_recording_glossary

    resolved_glossary_terms, _ = resolve_recording_glossary(db, recording, settings)
    data = export_data(db, recording)
    title = _single_line(recording.title) or f"Besprechung ({provider_label(recording.provider)})"
    # End the read transaction before calling Ollama so no DB snapshot or row lock is held.
    db.rollback()

    segments = data.get("segments") or []
    origin_utc = data.get("time_origin_utc")
    transcript_lines: list[str] = []
    known_speakers: list[str] = []
    seen_speakers: set[str] = set()
    for seg in segments:
        txt = _single_line(seg.get("text"))
        if not txt:
            continue
        t0 = wall_clock_time_de(origin_utc, float(seg.get("start") or 0.0))
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
        transcript_lines.append(f"[{t0}] {spk}: {txt}")
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
    if len(transcript_text) > 64000:
        transcript_text = (
            transcript_text[:40000]
            + "\n...[Mittelteil gekürzt]...\n"
            + transcript_text[-24000:]
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

    if summary_lang == "German":
        system_prompt = (
            "Du bist ein präziser deutschsprachiger Protokollführer für Geschäftstreffen. "
            "Erstelle aus dem folgenden Wortprotokoll eine sachliche, strukturierte "
            "Zusammenfassung und To-Do-Liste auf Deutsch. "
            "Antworte ausschließlich als valides JSON-Objekt mit genau diesem Schema:\n"
            "{\n"
            '  "summary": "Prägnante Management-Zusammenfassung des Gesprächs (2-4 Sätze).",\n'
            '  "topics": [\n'
            '    {"title": "Kurzer Thementitel", '
            '"details": "Besprochene Inhalte und Entscheidungen in 1 bis 3 Sätzen."}\n'
            "  ],\n"
            '  "action_items": [\n'
            '    {"owner": "Name der Person (oder \'Team\')", '
            '"task": "Konkrete vereinbarte Aufgabe oder nächster Schritt.", '
            '"due": "Im Gespräch genannter Termin/Zeitraum oder leerer String \\"\\""}\n'
            "  ]\n"
            "}\n"
            "Wichtige Regeln:\n"
            "- Erfinde keine Fakten, Fristen oder Namen, die nicht im Transkript vorkommen.\n"
            "- Wenn keine konkreten Aufgaben oder nächsten Schritte vereinbart wurden, "
            'gib ein leeres Array `"action_items": []` zurück.\n'
            "- Übernimm die exakte Schreibweise der Teilnehmendennamen und Fachbegriffe; "
            "korrigiere offensichtliche phonetische Spracherkennungsfehler bei bekannten "
            "Eigennamen, Konferenzplattformen und Glossarbegriffen anhand des Gesprächskontexts "
            "(z. B. Jitsi statt 'Jetzti'/'Chitzy', Wortlaut statt 'Wordlaut'/'Boardlaut').\n"
            "- Trenne Nebenbemerkungen zu Alternativmodellen oder Drittsystemen sauber von der "
            "tatsächlich besprochenen bzw. gezeigten Architektur."
        )
    else:
        system_prompt = (
            "You are a precise meeting minutes secretary. "
            "Produce a factual, structured executive summary and action-item list "
            f"written in {summary_lang} from the verbatim transcript below. "
            "Respond strictly as a valid JSON object matching this exact schema:\n"
            "{\n"
            f'  "summary": "Concise executive summary in {summary_lang} (2-4 sentences).",\n'
            '  "topics": [\n'
            f'    {{"title": "Short topic title in {summary_lang}", '
            f'"details": "Discussed points and decisions in {summary_lang} (1-3 sentences)."}}\n'
            "  ],\n"
            '  "action_items": [\n'
            '    {"owner": "Person name (or \'Team\')", '
            f'"task": "Concrete agreed action item in {summary_lang}.", '
            '"due": "Mentioned deadline/timeframe or empty string \\"\\""}\n'
            "  ]\n"
            "}\n"
            "Rules:\n"
            "- Never invent facts, deadlines, or names not present in the transcript.\n"
            "- If no concrete action items were agreed, return `\"action_items\": []`.\n"
            "- Preserve exact spelling of participant names and domain terminology; normalize "
            "unambiguous phonetic ASR misspellings of known platforms, proper nouns, and glossary "
            "terms from context (e.g. Jitsi instead of 'Jetzti'/'Chitzy', Wortlaut instead of "
            "'Wordlaut'/'Boardlaut').\n"
            "- Keep side remarks about alternative models or third-party tools clearly distinct "
            "from the properties of the demonstrated solution."
        )
    meta_lines = [f"Titel der Besprechung: {title}"]
    if known_speakers:
        meta_lines.append(f"Bekannte Teilnehmende: {', '.join(known_speakers)}")
    term_repls = prior_meta.get("term_replacements")
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
    for raw_term in [*repl_values, *resolved_glossary_terms, *builtin_hints, *org_hints]:
        term = _single_line(raw_term)[:60]
        if term and term.lower() not in seen_glossary and len(merged_glossary) < 40:
            seen_glossary.add(term.lower())
            merged_glossary.append(term)
    if merged_glossary:
        meta_lines.append(f"Fachbegriffe / Glossar: {', '.join(merged_glossary)}")
    user_prompt = "\n".join(meta_lines) + f"\n\nWortprotokoll:\n{transcript_text}"

    url = settings.ollama_url.rstrip("/") + "/api/chat"
    try:
        resp = httpx.post(
            url,
            json={
                "model": settings.ollama_model,
                "think": False,
                "stream": False,
                "format": "json",
                "options": {"num_ctx": 32768, "temperature": 0.2},
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=float(settings.ollama_timeout_seconds),
        )
    except httpx.TimeoutException:
        raise RuntimeError("ollama_timeout") from None
    except httpx.HTTPError:
        raise RuntimeError("ollama_unreachable") from None
    if resp.status_code != 200:
        raise RuntimeError(f"ollama_http_{resp.status_code}")

    try:
        raw_content = (resp.json().get("message") or {}).get("content") or "{}"
        parsed = json.loads(raw_content)
    except (ValueError, TypeError, AttributeError):
        raise RuntimeError("ollama_invalid_json") from None
    if not isinstance(parsed, dict):
        raise RuntimeError("ollama_invalid_json")
    action_items: list[dict[str, str]] = []
    for a in parsed.get("action_items") or []:
        if not isinstance(a, dict) or not _single_line(a.get("task")):
            continue
        item: dict[str, str] = {
            "owner": _single_line(a.get("owner")) or "Team",
            "task": _single_line(a.get("task")),
        }
        due = _single_line(a.get("due"))
        if due:
            item["due"] = due
        action_items.append(item)
    topics_list = [
        {
            "title": _single_line(t.get("title")),
            "details": _single_line(t.get("details")),
        }
        for t in (parsed.get("topics") or [])
        if isinstance(t, dict)
        and (_single_line(t.get("title")) or _single_line(t.get("details")))
    ]
    cleaned_summary = str(parsed.get("summary") or "").strip()
    if not cleaned_summary and not topics_list and not action_items:
        raise RuntimeError("ollama_empty_summary")
    summary_obj = {
        "summary": cleaned_summary,
        "topics": topics_list,
        "action_items": action_items,
        "model": settings.ollama_model,
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
    meta["summary"] = summary_obj
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
