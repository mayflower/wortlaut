import hmac
import io
import json
import secrets
import wave
from datetime import UTC, datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioControl,
    AudioStream,
    Recording,
    TranscriptSegment,
)
from wortlaut.processing import (
    MAX_CHUNK,
    RATE,
    collect_opted_out_speakers,
    is_speaker_opted_out,
    read_pcm,
    stream_quality,
)
from wortlaut.settings import get_settings

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


MIN_EXPORT_SEGMENT_CONFIDENCE = 0.38
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
            if overlapped:
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
        get_settings().api_token.get_secret_value().encode(), domain.encode(), "sha256"
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
        get_settings().api_token.get_secret_value().encode(), domain.encode(), "sha256"
    ).hex()
    return "wortlaut-read-" + signature


def verify_recording_reader_token(recording: Recording | None, token: str) -> bool:
    if recording is None or not token:
        return False
    clean = token.strip()
    prefix = f"wortlaut-read-{recording.id}."
    if clean.lower().startswith(prefix.lower()):
        clean = "wortlaut-read-" + clean.split(".", 1)[1]
    for candidate in (export_reader_token(recording), chat_reader_token(recording)):
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


def export_data(db: Session, recording: Recording):
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    streams = db.scalars(
        select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
    ).all()
    participant_names: dict[str, str] = {}
    for attempt in attempts:
        for p in attempt.diagnostics.get("participant_sources", {}).get("sources", []):
            if p.get("participant_id") and p.get("participant_name"):
                participant_names[p["participant_id"]] = p["participant_name"]
        for rcv in attempt.diagnostics.get("receiver_sources", []):
            if rcv.get("signaled_participant_id") and rcv.get("participant_name"):
                participant_names[rcv["signaled_participant_id"]] = rcv["participant_name"]
    for s in streams:
        pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
        if pid and s.contract.get("participant_name"):
            participant_names[pid] = s.contract["participant_name"]
    bind_controls = (
        db.scalars(
            select(AudioControl)
            .where(
                AudioControl.stream_id.in_([s.id for s in streams]),
                AudioControl.kind == "bind",
            )
            .order_by(AudioControl.start_sample)
        ).all()
        if streams
        else []
    )
    for ctrl in bind_controls:
        pid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
        if pid and ctrl.contract.get("participant_name"):
            participant_names[pid] = ctrl.contract["participant_name"]
    segments = [
        dict(s.result)
        for s in db.scalars(
            select(TranscriptSegment)
            .join(AsrJob)
            .where(AsrJob.stream_id.in_([s.id for s in streams]))
        ).all()
    ]
    for seg in segments:
        pid = seg.get("participant_id") or seg.get("speaker_id")
        if pid and seg.get("participant_name"):
            participant_names[pid] = seg["participant_name"]
    opted_out_list, opted_out_norm = collect_opted_out_speakers(
        recording, attempts, participant_names
    )
    anchors = [datetime.fromisoformat(s.contract["session_utc_origin"]) for s in streams]
    origin = min(anchors) if anchors else recording.starts_at
    unambiguous_stream_bindings: dict[tuple[str, str], tuple[str, str | None, str]] = {}
    observed_by_stream: dict[tuple[str, str], set[tuple[str, str | None, str]]] = {}
    stream_bind_timeline: dict[tuple[str, str], list[tuple[float, str, str, str, str | None]]] = {}
    for s in streams:
        key = (str(s.stream_id), str(s.epoch))
        s_delta = (
            datetime.fromisoformat(s.contract["session_utc_origin"]) - origin
        ).total_seconds()
        s_mono_delta = (
            s.contract.get("monotonic_origin_ms", 0)
            - s.contract.get("session_monotonic_origin_ms", 0)
        ) / 1000.0
        observed: set[tuple[str, str | None, str]] = set()
        timeline: list[tuple[float, str, str, str, str | None]] = []
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

    meta = dict(recording.protocol_meta or {})
    speaker_overrides: dict[str, str] = dict(meta.get("speaker_overrides") or {})
    term_replacements: dict[str, str] = dict(meta.get("term_replacements") or {})
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
        has_stream_bindings = (
            stream_key in unambiguous_stream_bindings
            or bool(stream_bind_timeline.get(stream_key))
        )
        if segment.get("attribution_unknown") and has_stream_bindings:
            if (
                not is_protected
                and stream_key not in unambiguous_stream_bindings
                and dur <= 0.30
                and isinstance(seg_conf, (int, float))
                and seg_conf < 0.55
            ):
                continue
            if stream_key in unambiguous_stream_bindings:
                resolved_pid, resolved_spk, resolved_kind = unambiguous_stream_bindings[stream_key]
                resolved_name = participant_names.get(resolved_pid)
            else:
                tl = stream_bind_timeline[stream_key]
                before = [b for b in tl if b[0] <= segment["end"] + 0.35]
                after = [b for b in tl if b[0] > segment["start"]]
                if before and after:
                    if after[0][0] - segment["end"] <= 2.5 or before[-1][1] == after[0][1]:
                        chosen = after[0]
                    else:
                        chosen = before[-1]
                elif before:
                    chosen = before[-1]
                else:
                    chosen = after[0]
                _, resolved_pid, resolved_spk, resolved_kind, resolved_name = chosen
            segment["attribution_unknown"] = False
            segment["participant_id"] = resolved_pid
            segment["speaker_id"] = resolved_spk if resolved_kind == "speaker" else None
            segment["source_kind"] = resolved_kind
            if resolved_name and not segment.get("participant_name"):
                segment["participant_name"] = resolved_name
        elif (
            not is_protected
            and not segment.get("attribution_unknown")
            and len(observed_by_stream.get(stream_key, ())) > 1
            and dur <= 0.30
            and isinstance(seg_conf, (int, float))
            and seg_conf < 0.55
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
    if speaker_overrides:
        for k, v in speaker_overrides.items():
            if v and v.strip():
                participant_names[k] = v.strip()
        opted_out_list, opted_out_norm = collect_opted_out_speakers(
            recording, attempts, participant_names
        )
    filtered_segments: list[dict] = []
    for seg in segments:
        seg_id = str(seg.get("segment_id") or seg.get("id") or "")
        if seg_id and seg_id in segment_edits and segment_edits[seg_id].strip():
            seg["text"] = " ".join(segment_edits[seg_id].split())
        if term_replacements:
            txt = seg.get("text") or ""
            for old_t, new_t in term_replacements.items():
                if old_t:
                    txt = txt.replace(old_t, new_t)
            seg["text"] = txt
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
    return {
        "recording_id": str(recording.id),
        "provider": recording.provider,
        "title": recording.title,
        "guest_name": recording.guest_name,
        "processing": recording.processing,
        "processing_error": recording.processing_error,
        "participation": recording.participation,
        "participation_reason": recording.participation_reason,
        "scheduled_period": {
            "start": recording.starts_at.isoformat(),
            "end": recording.ends_at.isoformat(),
        },
        "time_origin_utc": origin.astimezone(UTC).isoformat(),
        "last_known_audio_utc": max(ends).isoformat() if ends else None,
        "audio_available": audio_available,
        "summary": meta.get("summary"),
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
                and not opted_out_list
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
    }


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
                sample_txt = next(
                    (
                        " ".join(g.get("text", "").split())[:140]
                        for g in group_segs
                        if " ".join(g.get("text", "").split())
                    ),
                    "",
                )
                summary.append(
                    {
                        "provider_source_id": sid,
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
            if not existing.get("participant_name") and item.get("participant_name"):
                existing["participant_name"] = item["participant_name"]
            if not existing.get("sample_text") and item.get("sample_text"):
                existing["sample_text"] = item["sample_text"]
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
    title = data.get("title") or f"Wortprotokoll ({human_provider})"
    sources = data.get("sources_summary") or []
    total_speech = sum(float(s.get("speech_seconds") or 0.0) for s in sources)
    if format == "md":
        lines = [
            f"# {title}",
            "",
            f"- **Plattform:** {human_provider} (`{data['provider']}`)",
            f"- **Termin:** {human_period}",
        ]
        if total_speech > 0:
            lines.append(f"- **Erfasste Sprechzeit:** {format_duration_de(total_speech)}")
        lines.append("")
        summary_data = data.get("summary")
        if isinstance(summary_data, dict) and summary_data.get("summary"):
            lines.extend(["## Zusammenfassung", "", str(summary_data["summary"]).strip(), ""])
            topics = summary_data.get("topics") or []
            if topics:
                lines.extend(["### Besprochene Themen & Ergebnisse", ""])
                for t in topics:
                    if isinstance(t, dict) and (t.get("title") or t.get("details")):
                        lines.append(
                            f"- **{t.get('title') or 'Thema'}:** {t.get('details') or ''}".strip()
                        )
                lines.append("")
            actions = summary_data.get("action_items") or []
            if actions:
                lines.extend(["### Aufgaben & nächste Schritte", ""])
                for a in actions:
                    if isinstance(a, dict) and a.get("task"):
                        owner = a.get("owner") or "Team"
                        lines.append(f"- [ ] **{owner}:** {a['task']}")
                lines.append("")
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
                prov_id = (src.get("provider_source_id") or "–").replace("|", "\\|")
                seg_count = src["segment_count"]
                speech_sec = src["speech_seconds"]
                lines.append(
                    f"| {p_name} | `{sig_id}` | `{prov_id}` | {seg_count} | {speech_sec} |"
                )
            lines.append("")
        lines.extend(["## Transkript", ""])
        if not data["segments"]:
            lines.append("_Keine Transkriptsegmente vorhanden._")
        else:
            for segment in data["segments"]:
                text = " ".join(segment["text"].split())
                label = " ".join(segment["speaker_label"].split())
                span = f"{timestamp(segment['start'])} – {timestamp(segment['end'])}"
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


def generate_protocol_summary(db: Session, recording: Recording) -> dict:
    settings = get_settings()
    data = export_data(db, recording)
    segments = data.get("segments") or []
    if not segments:
        raise ValueError("Kein Transkript für die KI-Zusammenfassung vorhanden.")

    origin_utc = data.get("time_origin_utc")
    transcript_lines: list[str] = []
    for seg in segments:
        txt = " ".join((seg.get("text") or "").split())
        if not txt:
            continue
        t0 = wall_clock_time_de(origin_utc, float(seg.get("start") or 0.0))
        spk = seg.get("speaker_label") or "Sprecher"
        transcript_lines.append(f"[{t0}] {spk}: {txt}")

    transcript_text = "\n".join(transcript_lines)
    if len(transcript_text) > 36000:
        transcript_text = transcript_text[:36000] + "\n...[gekürzt]"

    title = recording.title or f"Besprechung ({provider_label(recording.provider)})"
    system_prompt = (
        "Du bist ein präziser deutschsprachiger Protokollführer für Geschäftstreffen. "
        "Erstelle aus dem folgenden Wortprotokoll eine sachliche, strukturierte "
        "Zusammenfassung auf Deutsch. "
        "Antworte ausschließlich als valides JSON-Objekt mit genau diesem Schema:\n"
        "{\n"
        '  "summary": "Prägnante Management-Zusammenfassung des Gesprächs (2-4 Sätze).",\n'
        '  "topics": [\n'
        '    {"title": "Kurzer Thementitel", '
        '"details": "Besprochene Inhalte und Entscheidungen in 1 bis 3 Sätzen."}\n'
        "  ],\n"
        '  "action_items": [\n'
        '    {"owner": "Name der Person (oder \'Team\')", '
        '"task": "Konkrete vereinbarte Aufgabe oder nächster Schritt."}\n'
        "  ]\n"
        "}\n"
        "Erfinde keine Fakten oder Namen, die nicht im Transkript vorkommen."
    )
    user_prompt = f"Titel der Besprechung: {title}\n\nWortprotokoll:\n{transcript_text}"

    url = settings.ollama_url.rstrip("/") + "/api/chat"
    resp = httpx.post(
        url,
        json={
            "model": settings.ollama_model,
            "think": False,
            "stream": False,
            "format": "json",
            "options": {"num_ctx": 16384, "temperature": 0.2},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=float(settings.ollama_timeout_seconds),
    )
    if getattr(resp, "status_code", 200) != 200:
        raise RuntimeError(f"ollama_http_{resp.status_code}")

    raw_content = (resp.json().get("message") or {}).get("content") or "{}"
    parsed = json.loads(raw_content)
    summary_obj = {
        "summary": str(parsed.get("summary") or "").strip(),
        "topics": [
            {
                "title": str(t.get("title") or "").strip(),
                "details": str(t.get("details") or "").strip(),
            }
            for t in (parsed.get("topics") or [])
            if isinstance(t, dict) and (t.get("title") or t.get("details"))
        ],
        "action_items": [
            {
                "owner": str(a.get("owner") or "Team").strip(),
                "task": str(a.get("task") or "").strip(),
            }
            for a in (parsed.get("action_items") or [])
            if isinstance(a, dict) and a.get("task")
        ],
        "model": settings.ollama_model,
        "generated_at": datetime.now(UTC).isoformat(),
    }
    meta = dict(recording.protocol_meta or {})
    meta["summary"] = summary_obj
    recording.protocol_meta = meta
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
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    if not attempts:
        raise LookupError("no_audio")
    streams = db.scalars(
        select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
    ).all()
    if not streams:
        raise LookupError("no_audio")
    anchors = [datetime.fromisoformat(s.contract["session_utc_origin"]) for s in streams]
    origin = min(anchors) if anchors else recording.starts_at

    participant_names: dict[str, str] = {}
    for s in streams:
        pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
        if pid and s.contract.get("participant_name"):
            participant_names[str(pid)] = str(s.contract["participant_name"])
    bind_controls = list(
        db.scalars(
            select(AudioControl).where(
                AudioControl.stream_id.in_([s.id for s in streams]),
                AudioControl.kind == "bind",
            )
        ).all()
    )
    for ctrl in bind_controls:
        pid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
        if pid and ctrl.contract.get("participant_name"):
            participant_names[str(pid)] = str(ctrl.contract["participant_name"])
    _, opted_out_norm = collect_opted_out_speakers(recording, attempts, participant_names)

    def _stream_is_opted_out(s: AudioStream) -> bool:
        if not opted_out_norm:
            return False
        pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
        pname = s.contract.get("participant_name") or (
            participant_names.get(str(pid)) if pid else None
        )
        spk = s.contract.get("speaker_id")
        psid = s.contract.get("provider_source_id")
        if is_speaker_opted_out(
            opted_out_norm,
            participant_id=str(pid) if pid else None,
            speaker_id=str(spk) if spk else None,
            participant_name=str(pname) if pname else None,
            provider_source_id=str(psid) if psid else None,
        ):
            return True
        for ctrl in bind_controls:
            if ctrl.stream_id == s.id:
                cpid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
                cpname = ctrl.contract.get("participant_name") or (
                    participant_names.get(str(cpid)) if cpid else None
                )
                cspk = ctrl.contract.get("speaker_id")
                cpsid = ctrl.contract.get("provider_source_id")
                if is_speaker_opted_out(
                    opted_out_norm,
                    participant_id=str(cpid) if cpid else None,
                    speaker_id=str(cspk) if cspk else None,
                    participant_name=str(cpname) if cpname else None,
                    provider_source_id=str(cpsid) if cpsid else None,
                ):
                    return True
        return False

    candidates = [s for s in streams if stream_id and str(s.stream_id) == str(stream_id)]
    if candidates and all(_stream_is_opted_out(s) for s in candidates):
        raise LookupError("speaker_opted_out")
    if not candidates:
        candidates = [s for s in streams if not _stream_is_opted_out(s)]
    else:
        candidates = [s for s in candidates if not _stream_is_opted_out(s)]
    if not candidates:
        raise LookupError("speaker_opted_out")

    duration_sec = min(90.0, max(0.8, float(end_sec) - float(start_sec)))
    target_end_sec = float(start_sec) + duration_sec

    pcm_bytes = b""
    for s in candidates:
        s_delta = (
            datetime.fromisoformat(s.contract["session_utc_origin"]) - origin
        ).total_seconds()
        s_mono_delta = (
            s.contract.get("monotonic_origin_ms", 0)
            - s.contract.get("session_monotonic_origin_ms", 0)
        ) / 1000.0
        stream_offset = s_delta + s_mono_delta
        start_sample = max(0, int((float(start_sec) - stream_offset - 0.15) * RATE))
        end_sample = max(
            start_sample + int(0.5 * RATE),
            int((target_end_sec - stream_offset + 0.25) * RATE),
        )
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
        raise LookupError("audio_range_unavailable")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(RATE)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()

