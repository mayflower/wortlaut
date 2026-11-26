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

from wortlaut.languages import effective_recording_language, to_asr_header_value
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioStream,
    Recording,
    RecordingKeyframe,
    TranscriptSegment,
)
from wortlaut.processing import (
    MAX_CHUNK,
    RATE,
    AudioReadError,
    collect_opted_out_speakers,
    is_keyframe_opted_out,
    is_speaker_opted_out,
    read_pcm,
    stream_binding_opted_out,
)
from wortlaut.settings import get_settings
from wortlaut.storage import get_storage


class InvalidResult(ValueError):
    pass


# Qwen3-ASR byte-level BPE word probabilities (mean softmax posterior across
# subword pieces). Multi-piece German compounds and contextual phrases naturally
# average 0.40-0.85, whereas unintelligible noise stays near uniform/low mass.
MIN_SEGMENT_CONFIDENCE = 0.35
MIN_PEAK_WORD_CONFIDENCE = 0.55
MIN_SINGLE_WORD_CONFIDENCE = 0.28
MIN_SHORT_SINGLE_WORD_CONFIDENCE = 0.42
SHORT_SINGLE_WORD_MAX_SECONDS = 0.8
SHORT_SCRIPT_HALLUCINATION_MAX_SECONDS = 2.5

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
_NON_LATIN_SCRIPT_RE = re.compile(
    r"[\u0370-\u052f\u0600-\u06ff\u0900-\u0dff\u0e00-\u0eff"
    r"\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u3400-\u4dbf"
    r"\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uffef]"
)
_LATIN_LETTER_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ]")


def _is_latin_only_spec(lang_spec: str | None) -> bool:
    if not lang_spec or lang_spec.strip().lower() in ("auto", "*", "all"):
        return False
    parts = [p.strip() for p in lang_spec.split(",") if p.strip()]
    return bool(parts) and all(p in LATIN_SCRIPT_LANGUAGES for p in parts)


def _sanitize_unexpected_script_words(
    accepted: list[dict],
    *,
    duration: float,
    detected_language: str | None,
    lang_spec: str | None,
    primary_language: str | None,
) -> list[dict]:
    """Strip stray CJK/non-Latin filler tokens in Latin speech and drop short CJK hallucinations."""
    if not accepted:
        return accepted
    joined = " ".join(str(w.get("word") or "") for w in accepted)
    if not _NON_LATIN_SCRIPT_RE.search(joined):
        return accepted

    latin_only = _is_latin_only_spec(lang_spec)
    detected_is_latin = detected_language in LATIN_SCRIPT_LANGUAGES
    primary_is_latin = primary_language in LATIN_SCRIPT_LANGUAGES
    latin_count = len(_LATIN_LETTER_RE.findall(joined))
    non_latin_count = len(_NON_LATIN_SCRIPT_RE.findall(joined))

    if latin_only or detected_is_latin or (latin_count >= 4 and latin_count > non_latin_count * 2):
        cleaned = [
            w
            for w in accepted
            if not (
                _NON_LATIN_SCRIPT_RE.search(str(w.get("word") or ""))
                and not _LATIN_LETTER_RE.search(str(w.get("word") or ""))
            )
        ]
        return cleaned

    if (
        primary_is_latin
        and latin_count == 0
        and len(accepted) <= 2
        and duration <= SHORT_SCRIPT_HALLUCINATION_MAX_SECONDS
    ):
        return []

    return accepted


def _is_low_confidence_hallucination(
    word_confidences: list[float], word_count: int, *, duration: float | None = None
) -> bool:
    if not word_confidences or len(word_confidences) != word_count:
        return False
    mean_conf = sum(word_confidences) / len(word_confidences)
    peak_conf = max(word_confidences)
    if word_count == 1:
        threshold = (
            MIN_SHORT_SINGLE_WORD_CONFIDENCE
            if duration is not None and duration < SHORT_SINGLE_WORD_MAX_SECONDS
            else MIN_SINGLE_WORD_CONFIDENCE
        )
        return peak_conf < threshold
    return mean_conf < MIN_SEGMENT_CONFIDENCE and peak_conf < MIN_PEAK_WORD_CONFIDENCE


def _has_repetition_loop(words: list[dict]) -> bool:
    joined = "".join(str(w.get("word") or "") for w in words)
    if re.search(r"([^\W\d_])\1{9,}", joined):
        return True
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


def segment_result(
    job: AsrJob,
    stream: AudioStream,
    response: dict,
    *,
    lang_spec: str | None = None,
    primary_language: str | None = None,
):
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
    detected_language = (
        response.get("language") if isinstance(response.get("language"), str) else None
    )
    accepted = _sanitize_unexpected_script_words(
        accepted,
        duration=duration,
        detected_language=detected_language,
        lang_spec=lang_spec,
        primary_language=primary_language,
    )
    word_confs = [w["confidence"] for w in accepted if "confidence" in w]
    if (
        truncated
        or _has_repetition_loop(accepted)
        or _is_low_confidence_hallucination(word_confs, len(accepted), duration=duration)
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


def retry_job(
    engine, identifier: str, reason: str, permanent: bool, *, delay_seconds: int = 30
):
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
        job.retry_at = datetime.now(UTC) + timedelta(seconds=max(1, min(120, delay_seconds)))
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

    from wortlaut.processing import collect_stream_participant_names

    collected, _ = collect_stream_participant_names(db, list(streams), attempts=list(attempts))
    raw_names: dict[str, str] = {
        pid: " ".join(name.split()) for pid, name in collected.items() if name.strip()
    }
    if isinstance(job.binding, dict) and job.binding.get("participant_name"):
        b_pid = str(
            job.binding.get("participant_id") or job.binding.get("speaker_id") or "current"
        )
        raw_names[b_pid] = " ".join(str(job.binding["participant_name"]).split())

    meta = (
        recording.protocol_meta
        if recording and isinstance(recording.protocol_meta, dict)
        else {}
    )
    _, opted_out_norm = (
        collect_opted_out_speakers(recording, attempts, raw_names)
        if recording is not None
        else ([], set())
    )
    speaker_overrides = meta.get("speaker_overrides")
    if isinstance(speaker_overrides, dict):
        for ov_key, ov_val in speaker_overrides.items():
            clean_ov = " ".join(str(ov_val or "").split())
            if not clean_ov:
                continue
            if is_speaker_opted_out(
                opted_out_norm,
                participant_id=str(ov_key),
                participant_name=clean_ov,
            ):
                continue
            raw_names[f"override:{ov_key}"] = clean_ov
    for idx_att, att_name in enumerate(meta.get("attendee_names") or []):
        clean_att = " ".join(str(att_name or "").split())
        if not clean_att:
            continue
        if is_speaker_opted_out(opted_out_norm, participant_name=clean_att):
            continue
        raw_names.setdefault(f"attendee:{idx_att}", clean_att)

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

    from wortlaut.exports import extract_org_glossary_hints
    from wortlaut.glossary import resolve_recording_glossary

    assistant_hint = " ".join(str(settings.assistant_name or "").split())
    builtin_hints = (
        [assistant_hint]
        if assistant_hint and assistant_hint.lower() != "wortlaut"
        else []
    )
    org_hints = extract_org_glossary_hints(meta.get("attendee_emails"))
    resolved_glossary_terms, _ = resolve_recording_glossary(db, recording, settings)
    glossary_terms: list[str] = []
    seen_terms: set[str] = set()
    term_replacements = meta.get("term_replacements")
    replacement_targets = (
        list(term_replacements.values()) if isinstance(term_replacements, dict) else []
    )
    visual_terms: list[str] = []
    raw_kf_ctx = meta.get("keyframe_context")
    if recording is not None and isinstance(raw_kf_ctx, dict) and raw_kf_ctx:
        live_kfs = list(
            db.scalars(
                select(RecordingKeyframe).where(
                    RecordingKeyframe.recording_id == recording.id,
                    RecordingKeyframe.deleted_at.is_(None),
                )
            ).all()
        )
        job_utc: datetime | None = None
        if isinstance(stream.contract, dict) and stream.contract.get("session_utc_origin"):
            try:
                origin_dt = datetime.fromisoformat(str(stream.contract["session_utc_origin"]))
                if origin_dt.tzinfo is None:
                    origin_dt = origin_dt.replace(tzinfo=UTC)
                mono_delta = (
                    float(stream.contract.get("monotonic_origin_ms") or 0)
                    - float(stream.contract.get("session_monotonic_origin_ms") or 0)
                ) / 1000.0
                job_utc = origin_dt + timedelta(seconds=mono_delta + job.start_sample / RATE)
            except (ValueError, TypeError):
                job_utc = None
        if job_utc is not None:
            live_kfs.sort(
                key=lambda k: abs((k.captured_at.astimezone(UTC) - job_utc).total_seconds())
            )
        for kf_row in live_kfs:
            pname_kf = kf_row.participant_name or raw_names.get(str(kf_row.participant_id))
            if is_speaker_opted_out(
                opted_out_norm,
                participant_id=kf_row.participant_id,
                participant_name=pname_kf,
                provider_source_id=kf_row.provider_source_id,
            ):
                continue
            entry_kf = raw_kf_ctx.get(str(kf_row.id))
            if isinstance(entry_kf, dict):
                for vt in entry_kf.get("terms") or []:
                    if isinstance(vt, str) and vt.strip():
                        visual_terms.append(vt)
    for raw_term in [
        *replacement_targets,
        *resolved_glossary_terms,
        *builtin_hints,
        *org_hints,
        *visual_terms,
    ]:
        term = " ".join(str(raw_term or "").split())[:60]
        if term and term.lower() not in seen_terms and len(glossary_terms) < 48:
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
            prior_conf = prior_seg.result.get("confidence")
            conf_ok = not _is_number(prior_conf) or float(prior_conf) >= 0.45
            if conf_ok and not stream_binding_opted_out(db, stream, prior_seg.result):
                candidate = " ".join(str(prior_seg.result.get("text") or "").split())
                if candidate:
                    prior_text = candidate[-120:]

    lang_spec = effective_recording_language(recording, settings)
    use_de_labels = lang_spec == "German" or (
        lang_spec in ("auto", "German,English", "English,German")
        and settings.default_locale == "de"
    )
    parts: list[str] = []
    clean_title = ""
    if recording is not None and recording.title:
        clean_title = " ".join(recording.title.split())[:120]
        if clean_title:
            parts.append(f"{'Thema' if use_de_labels else 'Topic'}: {clean_title}")
    if recording is not None and isinstance(recording.protocol_meta, dict):
        raw_agenda = recording.protocol_meta.get("calendar_agenda")
        clean_agenda = " ".join(str(raw_agenda or "").split())[:140]
        if clean_agenda and clean_agenda.lower() != clean_title.lower():
            parts.append(f"Agenda: {clean_agenda}")
    if participant_list:
        parts.append(
            f"{'Teilnehmende' if use_de_labels else 'Participants'}: "
            f"{', '.join(participant_list)}"
        )
    prior_part = (
        f"{'Vorheriger Kontext' if use_de_labels else 'Prior context'}: {prior_text}"
        if prior_text
        else ""
    )
    if glossary_terms:
        prefix_len = sum(len(p) + 3 for p in parts)
        prior_reserve = (len(prior_part) + 3) if prior_part else 0
        glossary_label = f"{'Glossar' if use_de_labels else 'Glossary'}: "
        available = 600 - prefix_len - prior_reserve - len(glossary_label)
        glossary_budget = min(250, available) if available >= 20 else 0
        glossary_line = ""
        for term in glossary_terms:
            next_val = f"{glossary_line}, {term}" if glossary_line else term
            if len(next_val) > glossary_budget:
                break
            glossary_line = next_val
        if glossary_line:
            parts.append(f"{glossary_label}{glossary_line}")
    if prior_part:
        parts.append(prior_part)
    if not parts:
        return None
    return " | ".join(parts)[:600]


def _resolve_primary_language(
    db: Session, job: AsrJob, stream: AudioStream, lang_spec: str, settings
) -> str | None:
    if lang_spec and lang_spec != "auto":
        langs = [part.strip() for part in lang_spec.split(",") if part.strip()]
        if len(langs) == 1:
            return langs[0]
        locale_pref = "German" if settings.default_locale == "de" else "English"
        if locale_pref in langs:
            return locale_pref
        return langs[0] if langs else None
    if stream.id is not None:
        prior_seg = db.scalar(
            select(TranscriptSegment)
            .join(AsrJob, AsrJob.id == TranscriptSegment.id)
            .where(
                AsrJob.stream_id == stream.id,
                AsrJob.id != job.id,
                AsrJob.end_sample <= job.start_sample + RATE,
                AsrJob.end_sample >= max(0, job.start_sample - 30 * RATE),
            )
            .order_by(AsrJob.end_sample.desc())
            .limit(1)
        )
        if prior_seg is not None and isinstance(prior_seg.result, dict):
            prior_lang = prior_seg.result.get("language")
            prior_conf = prior_seg.result.get("confidence")
            if (
                isinstance(prior_lang, str)
                and prior_lang
                and (not _is_number(prior_conf) or float(prior_conf) >= 0.55)
            ):
                return prior_lang
    attempt = db.get(Attempt, stream.attempt_id) if stream.attempt_id else None
    if attempt is not None:
        rec_stream_ids = list(
            db.scalars(
                select(AudioStream.id)
                .join(Attempt, Attempt.id == AudioStream.attempt_id)
                .where(Attempt.recording_id == attempt.recording_id)
            ).all()
        )
        if rec_stream_ids:
            recent_segs = list(
                db.scalars(
                    select(TranscriptSegment)
                    .join(AsrJob, AsrJob.id == TranscriptSegment.id)
                    .where(
                        AsrJob.stream_id.in_(rec_stream_ids),
                        AsrJob.id != job.id,
                    )
                    .order_by(AsrJob.created_at.desc())
                    .limit(16)
                ).all()
            )
            lang_weights: dict[str, int] = {}
            for seg in recent_segs:
                if not isinstance(seg.result, dict):
                    continue
                seg_lang = seg.result.get("language")
                seg_text = " ".join(str(seg.result.get("text") or "").split())
                seg_conf = seg.result.get("confidence")
                if (
                    isinstance(seg_lang, str)
                    and seg_lang
                    and len(seg_text) >= 12
                    and (not _is_number(seg_conf) or float(seg_conf) >= 0.55)
                ):
                    lang_weights[seg_lang] = lang_weights.get(seg_lang, 0) + len(seg_text)
            if lang_weights:
                return max(lang_weights.items(), key=lambda kv: kv[1])[0]
    return None


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
        attempt = db.get(Attempt, stream.attempt_id) if stream.attempt_id else None
        recording = db.get(Recording, attempt.recording_id) if attempt else None
        lang_spec = effective_recording_language(recording, settings)
        context_prompt = build_asr_context_prompt(db, job, stream, settings)
        primary_language = _resolve_primary_language(db, job, stream, lang_spec, settings)
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
                "X-ASR-Languages": to_asr_header_value(lang_spec),
            }
            if primary_language:
                req_headers["X-Primary-Language"] = primary_language
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
                retry_delay = 30
                if response.status_code == 429:
                    raw_ra = (response.headers.get("Retry-After") or "").strip()
                    retry_delay = int(raw_ra) if raw_ra.isdigit() else 5
                retry_job(
                    engine,
                    identifier,
                    f"gpu_http_{response.status_code}",
                    response.status_code in (400, 413, 422),
                    delay_seconds=retry_delay,
                )
                return True
            payload = response.json()
            if (
                payload.get("job_id") != identifier
                or payload.get("pcm_sha256") != hashlib.sha256(pcm).hexdigest()
            ):
                raise InvalidResult("gpu_result_identity_mismatch")
            result = segment_result(
                job,
                stream,
                payload,
                lang_spec=lang_spec,
                primary_language=primary_language,
            )
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
    settings = get_settings()
    ready_ids = []
    failed_count = 0
    with Session(engine) as db:
        now = datetime.now(UTC)
        recordings = db.scalars(
            select(Recording)
            .where(
                Recording.participation == "ended",
                Recording.processing.in_(["pending", "processing"]),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for recording in recordings:
            meta = dict(recording.protocol_meta or {})
            raw_claim = meta.get("summary_claim_until")
            if isinstance(raw_claim, str) and raw_claim:
                try:
                    if datetime.fromisoformat(raw_claim).astimezone(UTC) > now:
                        continue
                except ValueError:
                    pass
            ready, unreadable, failed = _streams_and_jobs_ready(db, recording.id)
            if not ready:
                continue
            if failed:
                meta.pop("summary_claim_until", None)
                recording.protocol_meta = meta
                recording.processing = "failed"
                if unreadable:
                    recording.processing_error = unreadable
                recording.processing_finished_at = now
                recording.audio_closed_at = now
                failed_count += 1
            else:
                meta["summary_claim_until"] = (
                    now + timedelta(seconds=settings.llm_summary_timeout_seconds() + 30)
                ).isoformat()
                recording.protocol_meta = meta
                recording.processing = "processing"
                ready_ids.append(recording.id)
        db.commit()

    completed_ids = []
    for rec_id in ready_ids:
        if settings.llm_summary_configured():
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
                reason = (
                    str(exc)
                    if isinstance(exc, RuntimeError) and str(exc).startswith(("ollama_", "llm_"))
                    else type(exc).__name__
                )
                logging.getLogger("wortlaut").warning(
                    "llm_summary_auto_failed recording=%s error=%s", rec_id, reason
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
            meta = dict(rec.protocol_meta or {})
            meta.pop("summary_claim_until", None)
            rec.protocol_meta = meta
            ready, unreadable, failed = _streams_and_jobs_ready(db, rec.id)
            if not ready:
                db.commit()
                continue
            now = datetime.now(UTC)
            if failed:
                rec.processing = "failed"
                if unreadable:
                    rec.processing_error = unreadable
                failed_count += 1
            else:
                from wortlaut.rag import invalidate_recording_rag_index

                rec.processing = "completed"
                next_meta = dict(rec.protocol_meta or {})
                invalidate_recording_rag_index(next_meta)
                rec.protocol_meta = next_meta
                completed_ids.append(rec.id)
            rec.processing_finished_at = now
            rec.audio_closed_at = now
            db.commit()

    if completed_ids:
        from wortlaut.calendar_oauth import publish_protocol_link_to_calendar_events

        for rec_id in completed_ids:
            try:
                with Session(engine) as db:
                    rec = db.get(Recording, rec_id)
                    if rec is not None:
                        publish_protocol_link_to_calendar_events(db, rec)
                        db.commit()
            except Exception as exc:
                logging.getLogger("wortlaut").warning(
                    "calendar_link_auto_failed recording=%s error=%s", rec_id, exc
                )

    return bool(completed_ids or failed_count)


MAX_EXTRACTED_KEYFRAMES_PER_RECORDING = 16


def keyframe_context_pass(engine) -> bool:
    """Incrementally extract screen-share visual context during or right after a meeting."""
    settings = get_settings()
    if (
        not settings.llm_summary_configured()
        or not settings.enable_keyframes
        or not settings.s3_access_key
        or not settings.s3_secret_key
    ):
        return False

    now = datetime.now(UTC)
    claim_kf_id: str | None = None
    claim_rec_id = None
    claim_obj_key = ""
    claim_lang = "German" if settings.default_locale == "de" else "English"

    with Session(engine) as db:
        candidates = list(
            db.execute(
                select(RecordingKeyframe, Recording)
                .join(Recording, Recording.id == RecordingKeyframe.recording_id)
                .where(
                    RecordingKeyframe.deleted_at.is_(None),
                    RecordingKeyframe.object_key != "",
                    Recording.transcript_deleted_at.is_(None),
                    Recording.metadata_deleted_at.is_(None),
                    Recording.processing.in_(["pending", "processing"]),
                )
                .order_by(RecordingKeyframe.captured_at.asc(), RecordingKeyframe.sequence.asc())
                .limit(48)
            ).all()
        )
        for kf_row, rec_row in candidates:
            kf_id_str = str(kf_row.id)
            meta_peek = dict(rec_row.protocol_meta or {})
            ctx_map_peek = (
                meta_peek.get("keyframe_context")
                if isinstance(meta_peek.get("keyframe_context"), dict)
                else {}
            )
            if kf_id_str in ctx_map_peek:
                continue
            extracted_count = sum(
                1
                for val in ctx_map_peek.values()
                if isinstance(val, dict) and not val.get("skipped") and not val.get("empty")
            )
            if extracted_count >= MAX_EXTRACTED_KEYFRAMES_PER_RECORDING:
                continue
            claims_peek = (
                meta_peek.get("keyframe_context_claims")
                if isinstance(meta_peek.get("keyframe_context_claims"), dict)
                else {}
            )
            existing_claim = claims_peek.get(kf_id_str)
            if isinstance(existing_claim, str) and existing_claim:
                try:
                    if datetime.fromisoformat(existing_claim).astimezone(UTC) > now:
                        continue
                except ValueError:
                    pass
            if (
                rec_row.participation != "ended"
                and kf_row.captured_at.astimezone(UTC) > now - timedelta(seconds=8)
            ):
                continue

            locked_rec = db.scalar(
                select(Recording)
                .where(
                    Recording.id == rec_row.id,
                    Recording.transcript_deleted_at.is_(None),
                    Recording.metadata_deleted_at.is_(None),
                )
                .with_for_update(skip_locked=True)
            )
            if locked_rec is None:
                continue
            fresh_kf = db.get(RecordingKeyframe, kf_row.id)
            if fresh_kf is None or fresh_kf.deleted_at is not None or not fresh_kf.object_key:
                continue
            if is_keyframe_opted_out(db, locked_rec, fresh_kf):
                continue

            meta = dict(locked_rec.protocol_meta or {})
            ctx_map = dict(
                meta.get("keyframe_context")
                if isinstance(meta.get("keyframe_context"), dict)
                else {}
            )
            if kf_id_str in ctx_map:
                continue

            superseded = db.scalar(
                select(RecordingKeyframe.id)
                .where(
                    RecordingKeyframe.recording_id == locked_rec.id,
                    RecordingKeyframe.deleted_at.is_(None),
                    RecordingKeyframe.participant_id == fresh_kf.participant_id,
                    RecordingKeyframe.captured_at > fresh_kf.captured_at,
                    RecordingKeyframe.captured_at
                    < fresh_kf.captured_at + timedelta(seconds=12),
                )
                .limit(1)
            )
            if superseded is not None:
                ctx_map[kf_id_str] = {"skipped": True}
                meta["keyframe_context"] = ctx_map
                locked_rec.protocol_meta = meta
                db.commit()
                return True

            claims = {
                k: v
                for k, v in (
                    meta.get("keyframe_context_claims")
                    if isinstance(meta.get("keyframe_context_claims"), dict)
                    else {}
                ).items()
                if isinstance(v, str)
            }
            claims[kf_id_str] = (now + timedelta(seconds=50)).isoformat()
            meta["keyframe_context_claims"] = claims
            locked_rec.protocol_meta = meta
            lang_spec = effective_recording_language(locked_rec, settings)
            if lang_spec and lang_spec != "auto" and "," not in lang_spec:
                claim_lang = lang_spec
            claim_kf_id = kf_id_str
            claim_rec_id = locked_rec.id
            claim_obj_key = fresh_kf.object_key
            db.commit()
            break

    if not claim_kf_id or claim_rec_id is None:
        return False

    from wortlaut.exports import extract_keyframe_visual_context

    extracted: dict | None = None
    read_failed = False
    try:
        png_bytes = get_storage().read(claim_obj_key)
        extracted = extract_keyframe_visual_context(
            png_bytes,
            summary_lang=claim_lang,
            settings=settings,
            timeout=min(40.0, float(settings.llm_summary_timeout_seconds())),
        )
    except Exception:
        read_failed = True

    with Session(engine) as db:
        locked_rec = db.scalar(
            select(Recording)
            .where(
                Recording.id == claim_rec_id,
                Recording.transcript_deleted_at.is_(None),
                Recording.metadata_deleted_at.is_(None),
            )
            .with_for_update()
        )
        if locked_rec is None:
            return True
        meta = dict(locked_rec.protocol_meta or {})
        claims = dict(
            meta.get("keyframe_context_claims")
            if isinstance(meta.get("keyframe_context_claims"), dict)
            else {}
        )
        claims.pop(claim_kf_id, None)
        if claims:
            meta["keyframe_context_claims"] = claims
        else:
            meta.pop("keyframe_context_claims", None)

        fresh_kf = next(
            (
                k
                for k in db.scalars(
                    select(RecordingKeyframe).where(
                        RecordingKeyframe.recording_id == claim_rec_id,
                        RecordingKeyframe.deleted_at.is_(None),
                    )
                ).all()
                if str(k.id) == claim_kf_id
            ),
            None,
        )
        if (
            fresh_kf is not None
            and not read_failed
            and not is_keyframe_opted_out(db, locked_rec, fresh_kf)
        ):
            ctx_map = dict(
                meta.get("keyframe_context")
                if isinstance(meta.get("keyframe_context"), dict)
                else {}
            )
            ctx_map[claim_kf_id] = extracted if extracted is not None else {"empty": True}
            meta["keyframe_context"] = ctx_map
            if extracted is not None:
                from wortlaut.rag import invalidate_recording_rag_index

                invalidate_recording_rag_index(meta)
        locked_rec.protocol_meta = meta
        db.commit()
    return True
