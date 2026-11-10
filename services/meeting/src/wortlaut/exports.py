import hmac
import json
from datetime import UTC, datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.models import AsrJob, Attempt, AudioControl, AudioStream, Recording, TranscriptSegment
from wortlaut.processing import RATE, stream_quality
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


_BOUNDARY_NOISE_PHRASES = frozenset(
    {
        "yeah",
        "yeah.",
        "okay",
        "okay.",
        "mm",
        "mm.",
        "mm-hmm",
        "mm-hmm.",
        "oh",
        "oh.",
        "yes",
        "yes.",
        "uh",
        "um",
        "and",
        "well",
        "well.",
        "so",
        "thank you",
        "thank you.",
        "thanks",
        "thanks.",
        "right",
        "right.",
        "sure",
        "sure.",
        "i don't know.",
        "i don't want to.",
        "that's okay.",
        "second.",
        "six.",
        "talk to",
    }
)

_SHORT_BOUND_NOISE_TOKENS = frozenset(
    {
        "yeah",
        "yeah.",
        "okay",
        "okay.",
        "mm",
        "mm.",
        "mm-hmm",
        "mm-hmm.",
        "oh",
        "oh.",
        "well.",
        "so",
        "sure.",
        "talk to",
    }
)


def group_transcript_turns(segments: list[dict], max_turn_chars: int = 900) -> list[dict]:
    turns: list[dict] = []
    for seg in segments:
        text = " ".join((seg.get("text") or "").split())
        if not text:
            continue
        label = " ".join((seg.get("speaker_label") or "Sprecher").split())
        start = float(seg.get("start") or 0.0)
        end = float(seg.get("end") or start)
        if (
            turns
            and turns[-1]["speaker"] == label
            and (start - turns[-1]["end"]) <= 15.0
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

    resolved_segments: list[dict] = []
    for segment in segments:
        clean_text = " ".join((segment.get("text") or "").split())
        if not clean_text:
            continue
        delta = (datetime.fromisoformat(segment["session_utc_origin"]) - origin).total_seconds()
        segment["start"] += delta
        segment["end"] += delta
        segment["words"] = [
            {**word, "start": word["start"] + delta, "end": word["end"] + delta}
            for word in segment["words"]
        ]
        stream_key = (segment.get("stream_id"), segment.get("epoch"))
        dur = max(0.0, segment["end"] - segment["start"])
        has_stream_bindings = (
            stream_key in unambiguous_stream_bindings
            or bool(stream_bind_timeline.get(stream_key))
        )
        if segment.get("attribution_unknown") and has_stream_bindings:
            if (
                stream_key not in unambiguous_stream_bindings
                and clean_text.lower() in _BOUNDARY_NOISE_PHRASES
                and dur <= 0.65
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
            not segment.get("attribution_unknown")
            and len(observed_by_stream.get(stream_key, ())) > 1
            and clean_text.lower() in _SHORT_BOUND_NOISE_TOKENS
            and dur <= 0.35
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
        resolved_segments.append(segment)
    segments = resolved_segments
    segments.sort(key=lambda s: (s["start"], s["stream_id"], s["id"]))
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
            attempts, streams, qualities, segments, participant_names, bind_controls
        ),
        "segments": segments,
    }


def _build_sources_summary(
    attempts, streams, qualities, segments, participant_names, bind_controls=()
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
