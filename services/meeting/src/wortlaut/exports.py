import hmac
import json
from datetime import UTC, datetime, timedelta
from html import escape

from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.models import AsrJob, Attempt, AudioStream, Recording, TranscriptSegment
from wortlaut.processing import RATE, stream_quality
from wortlaut.settings import get_settings


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


def speaker_label(segment, custom_labels: dict[str, str] | None = None):
    if custom_labels and segment.get("provider_source_id") in custom_labels:
        return custom_labels[segment["provider_source_id"]]
    if segment["source_kind"] == "share_audio":
        return "Freigabe-Audio"
    if segment["attribution_unknown"]:
        return f"Quelle {segment['provider_source_id']} (Zuordnung unklar)"
    return segment.get("participant_name") or f"Sprecher {segment['speaker_id']}"


def export_data(db: Session, recording: Recording):
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    streams = db.scalars(
        select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
    ).all()
    source_labels = {
        s.contract["provider_source_id"]: s.contract["manual_speaker_name"]
        for s in streams
        if s.contract.get("provider_source_id") and s.contract.get("manual_speaker_name")
    }
    segments = [
        dict(s.result)
        for s in db.scalars(
            select(TranscriptSegment)
            .join(AsrJob)
            .where(AsrJob.stream_id.in_([s.id for s in streams]))
        ).all()
    ]
    anchors = [datetime.fromisoformat(s.contract["session_utc_origin"]) for s in streams]
    origin = min(anchors) if anchors else recording.starts_at
    for segment in segments:
        delta = (datetime.fromisoformat(segment["session_utc_origin"]) - origin).total_seconds()
        segment["start"] += delta
        segment["end"] += delta
        segment["words"] = [
            {**word, "start": word["start"] + delta, "end": word["end"] + delta}
            for word in segment["words"]
        ]
        segment["speaker_label"] = speaker_label(segment, source_labels)
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
            "attribution_unknown": any(q["attribution_unknown"] for q in qualities),
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
        "source_labels": source_labels,
        "sources_summary": _build_sources_summary(
            attempts, streams, qualities, segments, source_labels
        ),
        "segments": segments,
    }


def _build_sources_summary(attempts, streams, qualities, segments, source_labels):
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
            + [seg["provider_source_id"] for seg in segments if seg.get("provider_source_id")]
            + list(receiver_by_id.keys())
        )
    )
    summary = []
    for sid in source_ids:
        src_segs = [seg for seg in segments if seg.get("provider_source_id") == sid]
        src_quals = [q for q in qualities if q.get("provider_source_id") == sid]
        rcv = receiver_by_id.get(sid, {})
        sig_id = rcv.get("signaled_participant_id") or next(
            (
                q.get("participant_id") or q.get("speaker_id")
                for q in src_quals
                if q.get("participant_id") or q.get("speaker_id")
            ),
            None,
        )
        part_name = next(
            (q.get("participant_name") for q in src_quals if q.get("participant_name")),
            None,
        )
        summary.append(
            {
                "provider_source_id": sid,
                "manual_speaker_name": source_labels.get(sid),
                "participant_name": part_name,
                "signaled_participant_id": sig_id,
                "csi": rcv.get("csi"),
                "source_kind": rcv.get("source_kind")
                or (src_quals[0].get("source_kind") if src_quals else "speaker"),
                "segment_count": len(src_segs),
                "speech_seconds": round(
                    sum(max(0.0, seg["end"] - seg["start"]) for seg in src_segs), 2
                ),
                "accepted_seconds": round(
                    sum(q.get("accepted_samples", 0) for q in src_quals) / RATE, 2
                ),
                "first_start": src_segs[0]["start"] if src_segs else None,
                "sample_text": (
                    " ".join(src_segs[0]["text"].split())[:140] if src_segs else None
                ),
            }
        )
    return summary


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
    if format == "txt":
        lines = [header]
        for segment in data["segments"]:
            text = " ".join(segment["text"].split())
            label = " ".join(segment["speaker_label"].split())
            lines.append(
                f"[{timestamp(segment['start'])} – {timestamp(segment['end'])}] {label}: {text}"
            )
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
