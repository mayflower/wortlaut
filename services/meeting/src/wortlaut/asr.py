"""One durable PostgreSQL claim at a time; the GPU owns its inference lock."""

import base64
import hashlib
import logging
import math
import re
import time
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from wortlaut.models import AsrJob, Attempt, AudioChunk, AudioStream, Recording, TranscriptSegment
from wortlaut.processing import (
    MAX_CHUNK,
    RATE,
    AudioReadError,
    collect_opted_out_speakers,
    is_speaker_opted_out,
    read_pcm,
    stream_binding_opted_out,
)
from wortlaut.settings import get_settings


class InvalidResult(ValueError):
    pass


# Qwen3-ASR byte-level BPE word probabilities (mean softmax posterior across
# subword pieces). Multi-piece German compounds and contextual phrases naturally
# average 0.40-0.85, whereas unintelligible noise stays near uniform/low mass.
MIN_SEGMENT_CONFIDENCE = 0.35
MIN_PEAK_WORD_CONFIDENCE = 0.55
MIN_SINGLE_WORD_CONFIDENCE = 0.28


def _is_low_confidence_hallucination(word_confidences: list[float], word_count: int) -> bool:
    if not word_confidences or len(word_confidences) != word_count:
        return False
    mean_conf = sum(word_confidences) / len(word_confidences)
    peak_conf = max(word_confidences)
    if word_count == 1:
        return peak_conf < MIN_SINGLE_WORD_CONFIDENCE
    return mean_conf < MIN_SEGMENT_CONFIDENCE and peak_conf < MIN_PEAK_WORD_CONFIDENCE


def _has_repetition_loop(words: list[dict]) -> bool:
    tokens = [re.sub(r"[^\w]+", "", str(w.get("word") or "").lower()) for w in words]
    if len(tokens) < 6:
        return False
    for n, min_repeats in ((1, 6), (2, 4), (3, 4)):
        span = n * min_repeats
        if len(tokens) < span:
            continue
        for idx in range(len(tokens) - span + 1):
            unit = tokens[idx : idx + n]
            if not any(unit):
                continue
            if all(tokens[idx + k * n : idx + (k + 1) * n] == unit for k in range(1, min_repeats)):
                return True
    return False


def asr_span(job: AsrJob) -> tuple[int, int]:
    """Samples sent to the ASR: the job's audio window clipped to its disjoint core.

    Neighbouring jobs never share audio, so a transcript without word
    timestamps cannot duplicate words across a long-speech cut.
    """
    return max(job.start_sample, job.core_start), min(job.end_sample, job.core_end)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def segment_result(job: AsrJob, stream: AudioStream, response: dict):
    words = response.get("words")
    if not isinstance(words, list) or (response.get("text") and not words):
        raise InvalidResult("words_unavailable")
    span_start, span_end = asr_span(job)
    duration = (span_end - span_start) / RATE
    offset = (
        stream.contract["monotonic_origin_ms"] - stream.contract["session_monotonic_origin_ms"]
    ) / 1000
    base = offset + span_start / RATE
    # Word timestamps are optional; a response either times every word or none.
    timed = any("start" in word or "end" in word for word in words)
    accepted = []
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get("word"), str):
            raise InvalidResult("invalid_word")
        raw_conf = word.get("confidence")
        if raw_conf is not None and (not _is_number(raw_conf) or not 0.0 <= raw_conf <= 1.0):
            raise InvalidResult("invalid_word_confidence")
        item = {"word": word["word"]}
        if timed:
            start, end = word.get("start"), word.get("end")
            if (
                not _is_number(start)
                or not _is_number(end)
                or start < 0
                or end < start
                or end > duration + 0.1
            ):
                raise InvalidResult("invalid_word_timestamps")
            item["start"], item["end"] = base + start, base + min(end, duration)
        if raw_conf is not None:
            item["confidence"] = round(float(raw_conf), 4)
        accepted.append(item)

    # A transcript that hit the generation budget without an end marker or
    # repeats the same n-gram in a loop is a decoder loop, not speech.
    truncated = response.get("truncated") is True
    word_confs = [w["confidence"] for w in accepted if "confidence" in w]
    if (
        truncated
        or _has_repetition_loop(accepted)
        or _is_low_confidence_hallucination(word_confs, len(accepted))
    ):
        accepted = []
        word_confs = []

    seg_confidence = round(sum(word_confs) / len(word_confs), 4) if word_confs else None
    result = {
        "id": job.id,
        "stream_id": str(stream.stream_id),
        "epoch": str(stream.epoch),
        **job.binding,
        "session_utc_origin": stream.contract["session_utc_origin"],
        "start": accepted[0]["start"] if timed and accepted else base,
        "end": accepted[-1]["end"] if timed and accepted else offset + span_end / RATE,
        "text": " ".join(word["word"] for word in accepted),
        "words": accepted,
    }
    if seg_confidence is not None:
        result["confidence"] = seg_confidence
    language = response.get("language")
    if isinstance(language, str) and language:
        result["language"] = language
    if truncated:
        result["asr_truncated"] = True
    return result


def claim_job(db: Session):
    now = datetime.now(UTC)
    settings = get_settings()
    job = db.scalar(
        select(AsrJob)
        .where(
            or_(
                (AsrJob.status == "pending")
                & (AsrJob.retry_at.is_(None) | (AsrJob.retry_at <= now)),
                (AsrJob.status == "processing")
                & (AsrJob.claimed_at < now - timedelta(seconds=settings.asr_lease_seconds)),
            )
        )
        .order_by(AsrJob.created_at, AsrJob.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    if job:
        job.status, job.claimed_at = "processing", now
        db.commit()
    return job


def commit_result(db: Session, identifier: str, result: dict):
    job = db.scalar(select(AsrJob).where(AsrJob.id == identifier).with_for_update())
    if job is None or job.status in ("completed", "failed"):
        return  # A late GPU result cannot revive explicitly abandoned work.
    stream = db.get(AudioStream, job.stream_id)
    opted_out = stream_binding_opted_out(db, stream, result)
    # A client timeout cannot cancel GPU work. A late valid result is identified
    # by the immutable job, and a committed segment is never duplicated/rewritten.
    if not opted_out and db.get(TranscriptSegment, identifier) is None:
        db.add(TranscriptSegment(id=identifier, result=result))
    job.status, job.error, job.retry_at = "completed", None, None
    db.commit()


def retry_job(engine, identifier: str, reason: str, permanent: bool):
    with Session(engine) as db:
        job = db.scalar(select(AsrJob).where(AsrJob.id == identifier).with_for_update())
        if job is None or job.status in ("completed", "failed"):
            return
        if permanent:
            job.attempts += 1
        job.error = reason
        job.status = (
            "failed" if job.attempts >= get_settings().asr_max_permanent_failures else "pending"
        )
        job.retry_at = datetime.now(UTC) + timedelta(seconds=30)
        db.commit()


def build_asr_context_prompt(
    db: Session, job: AsrJob, stream: AudioStream, settings=None
) -> str | None:
    settings = settings or get_settings()
    attempt = db.get(Attempt, stream.attempt_id) if stream.attempt_id else None
    recording = db.get(Recording, attempt.recording_id) if attempt else None

    attempts = (
        db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
        if recording is not None
        else ([attempt] if attempt is not None else [])
    )
    streams = (
        db.scalars(
            select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
        ).all()
        if attempts
        else [stream]
    )

    raw_names: dict[str, str] = {}
    for s in streams:
        pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
        pname = s.contract.get("participant_name")
        if pid and isinstance(pname, str) and pname.strip():
            raw_names[str(pid)] = " ".join(pname.split())
    for a in attempts:
        diag = a.diagnostics if isinstance(a.diagnostics, dict) else {}
        ps = diag.get("participant_sources")
        for src in (ps.get("sources") or []) if isinstance(ps, dict) else []:
            if isinstance(src, dict) and src.get("participant_id") and src.get("participant_name"):
                raw_names[str(src["participant_id"])] = " ".join(
                    str(src["participant_name"]).split()
                )
    if isinstance(job.binding, dict) and job.binding.get("participant_name"):
        b_pid = str(
            job.binding.get("participant_id") or job.binding.get("speaker_id") or "current"
        )
        raw_names[b_pid] = " ".join(str(job.binding["participant_name"]).split())

    _, opted_out_norm = (
        collect_opted_out_speakers(recording, attempts, raw_names)
        if recording is not None
        else ([], set())
    )
    participant_list: list[str] = []
    seen_names: set[str] = set()
    for pid, pname in raw_names.items():
        if not pname or pname.lower() in seen_names:
            continue
        if is_speaker_opted_out(opted_out_norm, participant_id=pid, participant_name=pname):
            continue
        seen_names.add(pname.lower())
        participant_list.append(pname[:60])
        if len(participant_list) >= 16:
            break

    glossary_terms: list[str] = []
    seen_terms: set[str] = set()
    meta = (
        recording.protocol_meta
        if recording and isinstance(recording.protocol_meta, dict)
        else {}
    )
    term_replacements = meta.get("term_replacements")
    replacement_targets = (
        list(term_replacements.values()) if isinstance(term_replacements, dict) else []
    )
    for raw_term in [*(settings.asr_glossary or []), *replacement_targets]:
        term = " ".join(str(raw_term or "").split())[:60]
        if term and term.lower() not in seen_terms and len(glossary_terms) < 40:
            seen_terms.add(term.lower())
            glossary_terms.append(term)

    prior_text = ""
    if stream.id is not None:
        prior_seg = db.scalar(
            select(TranscriptSegment)
            .join(AsrJob, AsrJob.id == TranscriptSegment.id)
            .where(
                AsrJob.stream_id == stream.id,
                AsrJob.id != job.id,
                AsrJob.end_sample <= job.start_sample + RATE,
                AsrJob.end_sample >= max(0, job.start_sample - 15 * RATE),
            )
            .order_by(AsrJob.end_sample.desc())
            .limit(1)
        )
        if prior_seg is not None and isinstance(prior_seg.result, dict):
            if not stream_binding_opted_out(db, stream, prior_seg.result):
                candidate = " ".join(str(prior_seg.result.get("text") or "").split())
                if candidate:
                    prior_text = candidate[-120:]

    parts: list[str] = []
    if recording is not None and recording.title:
        clean_title = " ".join(recording.title.split())[:120]
        if clean_title:
            parts.append(f"Thema: {clean_title}")
    if participant_list:
        parts.append(f"Teilnehmende: {', '.join(participant_list)}")
    if glossary_terms:
        parts.append(f"Glossar: {', '.join(glossary_terms)}")
    if prior_text:
        parts.append(f"Vorheriger Kontext: {prior_text}")
    if not parts:
        return None
    return " | ".join(parts)[:500]


def inference_pass(engine):
    settings = get_settings()
    if not settings.asr_token:
        return False  # Visible pending work, never a fabricated successful transcript.
    with Session(engine) as db:
        job = claim_job(db)
        if job is None:
            return False
        identifier = job.id
        stream = db.get(AudioStream, job.stream_id)
        context_prompt = build_asr_context_prompt(db, job, stream, settings)
        primary_language = "German" if settings.default_locale == "de" else "English"
        chunks = db.scalars(
            select(AudioChunk)
            .where(
                AudioChunk.stream_id == stream.id,
                AudioChunk.start_sample >= max(0, job.start_sample - MAX_CHUNK),
                AudioChunk.start_sample < job.end_sample,
                AudioChunk.start_sample + AudioChunk.sample_count > job.start_sample,
            )
            .order_by(AudioChunk.start_sample)
        ).all()
        inference_start, request_seconds, outcome = None, None, "storage_read"
        created_at = job.created_at
        try:
            pcm = read_pcm(chunks, *asr_span(job))
            req_headers = {
                "Authorization": "Bearer " + settings.asr_token.get_secret_value(),
                "Content-Type": "application/octet-stream",
                "X-Job-ID": identifier,
                "X-Primary-Language": primary_language,
            }
            if context_prompt:
                req_headers["X-ASR-Context-B64"] = base64.b64encode(
                    context_prompt.encode("utf-8")
                ).decode("ascii")
            with httpx.Client(
                timeout=settings.asr_timeout_seconds, follow_redirects=False
            ) as client:
                inference_start = time.perf_counter()
                response = client.post(
                    settings.asr_url + "/v1/transcribe",
                    content=pcm,
                    headers=req_headers,
                )
                request_seconds = time.perf_counter() - inference_start
            if response.status_code != 200:
                outcome = f"gpu_http_{response.status_code}"
                retry_job(
                    engine,
                    identifier,
                    f"gpu_http_{response.status_code}",
                    response.status_code in (400, 413, 422),
                )
                return True
            payload = response.json()
            if (
                payload.get("job_id") != identifier
                or payload.get("pcm_sha256") != hashlib.sha256(pcm).hexdigest()
            ):
                raise InvalidResult("gpu_result_identity_mismatch")
            result = segment_result(job, stream, payload)
            commit_result(db, identifier, result)
            outcome = "completed"
        except httpx.HTTPError:
            outcome = "gpu_unavailable"
            retry_job(engine, identifier, "gpu_unavailable", False)
        except AudioReadError as error:
            outcome = error.reason
            retry_job(engine, identifier, error.reason, error.permanent)
        except (InvalidResult, ValueError, TypeError, KeyError, AttributeError):
            outcome = "invalid_audio_or_model_result"
            retry_job(engine, identifier, "invalid_audio_or_model_result", True)
        finally:
            logging.getLogger("wortlaut").info(
                "asr_attempt_finished job=%s outcome=%s "
                "gpu_request_seconds=%s job_age_seconds=%.3f",
                identifier,
                outcome,
                round(
                    request_seconds
                    if request_seconds is not None
                    else time.perf_counter() - inference_start,
                    3,
                )
                if inference_start
                else None,
                max(0, (datetime.now(UTC) - created_at).total_seconds()),
            )
        return True


def _streams_and_jobs_ready(db: Session, recording_id) -> tuple[bool, str | None, bool]:
    streams = db.scalars(
        select(AudioStream).join(Attempt).where(Attempt.recording_id == recording_id)
    ).all()
    if not all(stream.scan_complete for stream in streams):
        return False, None, False
    stream_ids = [s.id for s in streams]
    jobs = (
        db.scalars(select(AsrJob).where(AsrJob.stream_id.in_(stream_ids))).all()
        if stream_ids
        else []
    )
    if any(job.status in ("pending", "processing") for job in jobs):
        return False, None, False
    unreadable = (
        db.scalar(
            select(AudioChunk.processing_error)
            .where(
                AudioChunk.stream_id.in_(stream_ids),
                AudioChunk.processing_error.is_not(None),
            )
            .limit(1)
        )
        if stream_ids
        else None
    )
    has_failed_job = any(job.status == "failed" for job in jobs)
    return True, unreadable, bool(unreadable or has_failed_job)


def finalize_processing(engine):
    ready_ids = []
    failed_count = 0
    with Session(engine) as db:
        recordings = db.scalars(
            select(Recording)
            .where(
                Recording.participation == "ended",
                Recording.processing.in_(["pending", "processing"]),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for recording in recordings:
            ready, unreadable, failed = _streams_and_jobs_ready(db, recording.id)
            if not ready:
                continue
            if failed:
                now = datetime.now(UTC)
                recording.processing = "failed"
                if unreadable:
                    recording.processing_error = unreadable
                recording.processing_finished_at = now
                recording.audio_closed_at = now
                failed_count += 1
            else:
                recording.processing = "processing"
                ready_ids.append(recording.id)
        db.commit()

    completed_ids = []
    for rec_id in ready_ids:
        if get_settings().enable_llm_summary:
            from wortlaut.exports import generate_protocol_summary

            try:
                with Session(engine) as db:
                    rec = db.get(Recording, rec_id)
                    has_summary = rec is not None and bool((rec.protocol_meta or {}).get("summary"))
                    db.rollback()
                    if rec is not None and not has_summary:
                        generate_protocol_summary(db, rec_id)
            except (ValueError, LookupError):
                pass
            except Exception as exc:
                logging.getLogger("wortlaut").warning(
                    "llm_summary_auto_failed recording=%s error=%s", rec_id, exc
                )

        with Session(engine) as db:
            rec = db.scalar(
                select(Recording)
                .where(
                    Recording.id == rec_id,
                    Recording.participation == "ended",
                    Recording.processing.in_(["pending", "processing"]),
                )
                .with_for_update()
            )
            if rec is None:
                continue
            ready, unreadable, failed = _streams_and_jobs_ready(db, rec.id)
            if not ready:
                continue
            now = datetime.now(UTC)
            if failed:
                rec.processing = "failed"
                if unreadable:
                    rec.processing_error = unreadable
                failed_count += 1
            else:
                rec.processing = "completed"
                completed_ids.append(rec.id)
            rec.processing_finished_at = now
            rec.audio_closed_at = now
            db.commit()

    if completed_ids:
        from wortlaut.calendar_oauth import publish_protocol_link_to_calendar_events

        for rec_id in completed_ids:
            try:
                with Session(engine) as db:
                    rec = db.scalar(
                        select(Recording).where(Recording.id == rec_id).with_for_update()
                    )
                    if rec is not None:
                        publish_protocol_link_to_calendar_events(db, rec)
                        db.commit()
            except Exception as exc:
                logging.getLogger("wortlaut").warning(
                    "calendar_link_auto_failed recording=%s error=%s", rec_id, exc
                )

    return bool(completed_ids or failed_count)
