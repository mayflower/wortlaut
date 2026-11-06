# wortlaut

## Overview
Core Python package for the `wortlaut` meeting service. It implements the FastAPI HTTP and WebSocket API, integrated operator and transcript Web-UI (`ui.py`), manual per-source speaker labeling (`PATCH /v1/recordings/{recording_id}/sources`), SQLAlchemy PostgreSQL models, S3 immutable audio chunk storage, per-source WebRTC VAD segmentation, Parakeet GPU ASR job orchestration, Kubernetes worker `Job`/`Secret` reconciliation, authenticated IMAP/ICS calendar intake, recurring event expansion, SMTP transcript and failure-notification delivery, and staged data retention.

## Interface
- `[app.py:app]`: FastAPI application mounting `/sdk` (when present) and exposing:
  - `GET /` and `GET /ui` (`[app.py:web_ui]`, `[ui.py:render_ui]`)
  - `GET /health/live` (`[app.py:live]`) and `GET /health/ready` (`[app.py:ready]`)
  - `POST /v1/recordings` (`[app.py:create_recording]`), `GET /v1/recordings` (`[app.py:list_recordings]`), `GET /v1/recordings/{recording_id}` (`[app.py:get_recording]`)
  - `GET /v1/recordings/{recording_id}/transcript` (`[app.py:get_transcript]`), `PATCH /v1/recordings/{recording_id}/sources` (`[app.py:update_source_labels]`, `[app.py:SourceLabelsRequest]`)
  - `POST /v1/recordings/{recording_id}/attempts` (`[app.py:prepare_attempt]`), `POST /v1/recordings/{recording_id}/cancel` (`[app.py:cancel_recording]`)
  - `POST /v1/recordings/{recording_id}/delivery/retry` (`[app.py:retry_delivery]`)
  - `GET /v1/recordings/{recording_id}/exports/{format}` (`[app.py:get_export]`)
  - `POST /v1/calendar/messages` (`[app.py:import_calendar_message]`), `GET /v1/calendar` (`[app.py:calendar_status]`)
  - `POST /v1/attempts/{attempt_id}/claim` (`[app.py:claim]`), `GET /v1/attempts/{attempt_id}/bootstrap` (`[app.py:bootstrap]`), `POST /v1/attempts/{attempt_id}/status` (`[app.py:worker_status]`)
  - `WEBSOCKET /v1/attempts/{attempt_id}/audio` (`[app.py:audio_socket]`, `[app.py:ingest_message]`)
- `[app.py:RecordingRequest]`, `[app.py:ClaimRequest]`, `[app.py:RtpSourceEvidence]`, `[app.py:EncodedFrameEvidence]`, `[app.py:EncodedTransformEvidence]`, `[app.py:ReceiverEvidence]`, `[app.py:ParticipantSourceEvidence]`, `[app.py:ParticipantEvidence]`, `[app.py:ClockInterruption]`, `[app.py:AudioClockEvidence]`, `[app.py:WorkerStatus]`: Pydantic request and diagnostic evidence schemas.
- `[app.py:processing_loop]`, `[app.py:lifespan]`, `[app.py:bearer_value]`, `[app.py:api_auth]`, `[app.py:recording_json]`, `[app.py:authenticated_attempt]`: Application lifecycle, Bearer authentication, and serialization helpers.
- `[models.py:Base]`: SQLAlchemy `DeclarativeBase` and ORM models:
  - `[models.py:Recording]` (`recordings`), `[models.py:Attempt]` (`attempts`), `[models.py:AudioStream]` (`audio_streams`), `[models.py:AudioChunk]` (`audio_chunks`), `[models.py:AudioControl]` (`audio_controls`), `[models.py:AsrJob]` (`asr_jobs`), `[models.py:TranscriptSegment]` (`transcript_segments`), `[models.py:CalendarEntry]` (`calendar_entries`), `[models.py:MailCursor]` (`mail_cursors`), `[models.py:MailImport]` (`mail_imports`), `[models.py:Delivery]` (`deliveries`).
- `[settings.py:Settings]` & `[settings.py:get_settings]`: `WORTLAUT_`-prefixed `BaseSettings` configuration and `@lru_cache` singleton accessor.
- `[database.py:get_engine]` & `[database.py:session]`: Cached SQLAlchemy engine (`pool_pre_ping=True`) and request-scoped `Session` generator.
- `[ingest.py:SourceBinding]`, `[ingest.py:StreamContract]`, `[ingest.py:ChunkContract]`, `[ingest.py:StreamBegin]`, `[ingest.py:ControlBase]`, `[ingest.py:StreamEnd]`, `[ingest.py:Gap]`, `[ingest.py:Bind]`: Per-source audio stream and control schemas.
- `[ingest.py:admit_frame]`, `[ingest.py:check_window_capacity]`, `[ingest.py:stream_for]`, `[ingest.py:verify_owner]`, `[ingest.py:pending_samples]`, `[ingest.py:capacity_reached]`, `[ingest.py:check_range]`, `[ingest.py:accept_control]`, `[ingest.py:accept_chunk]`: Ownership verification, rate/window admission, range validation, and durable chunk/control ingestion.
- `[processing.py:Run]`, `[processing.py:AudioReadError]`, `[processing.py:segmentation_pass]`, `[processing.py:segment_stream]`, `[processing.py:speech_section]`, `[processing.py:timeline]`, `[processing.py:stream_quality]`, `[processing.py:read_pcm]`: Incremental per-source WebRTC VAD segmentation and stream quality computation.
- `[asr.py:InvalidResult]`, `[asr.py:inference_pass]`, `[asr.py:claim_job]`, `[asr.py:segment_result]`, `[asr.py:commit_result]`, `[asr.py:retry_job]`, `[asr.py:finalize_processing]`: Lease-based ASR job execution against the GPU service and recording completion finalization.
- `[controller.py:kubernetes_api]`, `[controller.py:controller_pass]`, `[controller.py:reconcile_attempt]`, `[controller.py:new_attempt]`, `[controller.py:request_cancellation]`, `[controller.py:job_body]`, `[controller.py:read_job]`, `[controller.py:forget_secret]`, `[controller.py:release_pod_evidence]`: Kubernetes `Job`, `Pod` finalizer, and bootstrap `Secret` lifecycle controller.
- `[calendar.py:AmbiguousMeetingLink]`, `[calendar.py:InvitationHTML]`, `[calendar.py:utc]`, `[calendar.py:dkim_dns]`, `[calendar.py:sender]`, `[calendar.py:meeting_link]`, `[calendar.py:entry_json]`, `[calendar.py:import_event]`, `[calendar.py:recurrence_anchor]`, `[calendar.py:instant_calendar]`, `[calendar.py:import_mail]`, `[calendar.py:consume_imap_message]`, `[calendar.py:imap_pass]`: Authenticated MIME/ICS and instant-invitation ingestion.
- `[recurrence.py:recurrence_pass]` & `[recurrence.py:expand_series]`: Bounded materialization of recurring `CalendarEntry` series into `Recording` rows.
- `[exports.py:export_data]`, `[exports.py:render_export]`, `[exports.py:export_reader_token]`, `[exports.py:timestamp]`, `[exports.py:speaker_label]`: Transcript and quality assembly in `json`, `txt`, and `vtt` formats (applying `manual_speaker_name` from `AudioStream.contract` and exposing `source_labels`) plus HMAC reader token generation.
- `[mail.py:FAILURE_REASONS]`, `[mail.py:effective_participation_reason]`, `[mail.py:smtp_pass]`, `[mail.py:build_message]`, `[mail.py:transmit]`, `[mail.py:delivery_json]`: SMTP transcript and join/lobby failure notification delivery (`no_audio_received` / `FAILURE_REASONS`) with automatic ZIP compression or HTTPS `curl` download fallback when attachments exceed `mail_attachment_limit_bytes`.
- `[ui.py:UI_HTML]`, `[ui.py:render_ui]`: Self-contained German operator and live/completed transcript Web-UI served at `GET /` and `GET /ui`.
- `[retention.py:retention_pass]`, `[retention.py:remove_audio_metadata]`, `[retention.py:calendar_retention]`: Staged expiration of S3 audio objects, transcript segments, attempt/delivery metadata, and calendar PII.
- `[storage.py:AudioStorage]`, `[storage.py:get_storage]`, `[storage.py:canonical]`, `[storage.py:ObjectConflict]`: S3 object storage client framing PCM with `WORTLAUT1` headers and SHA-256 metadata verification.
- `[validation.py:Provider]`, `[validation.py:normalize_meeting_url]`, `[validation.py:validate_webex_url]`: Provider URL normalization for `webex`, `google_meet`, and `teams`.
- `[webex.py:guest_token]`, `[webex.py:issue_guest]`, `[webex.py:refreshed_guest]`, `[webex.py:WebexUnavailable]`: Webex Service App guest token issuance and Kubernetes `Secret`-backed OAuth refresh.

## Invariants
- `[ingest.py:SourceBinding]`: A `speaker` source must have either `speaker_id` or `attribution_unknown=True`; when `attribution_unknown` is `True`, `speaker_id`, `participant_id`, and `participant_name` must all be `None`.
- `[ingest.py:accept_chunk]` & `[ingest.py:check_range]`: Chunks and gaps within an `(attempt_id, stream_id, epoch)` must have monotonic, non-overlapping, contiguous sample boundaries starting at sample `0` for `sequence == 0`, cannot span a `bind` control boundary, and must match the active `SourceBinding`.
- `[ingest.py:accept_chunk]` & `[processing.py:segment_stream]`: Global audio capacity and open `AsrJob` admission are serialized across transactions using `pg_advisory_xact_lock(749836123)`.
- `[asr.py:commit_result]`: `TranscriptSegment` rows are immutable once written; late GPU responses for already `completed` or `failed` `AsrJob` rows are ignored.
- `[controller.py:reconcile_attempt]` & `[controller.py:controller_pass]`: Scheduler starts use `pg_try_advisory_xact_lock(749836124)` (`SCHEDULER_LOCK`). Worker Pods carry finalizer `wortlaut/termination-observed`, and worker bootstrap Secrets are deleted only after Pod termination is observed and persisted (`attempt.process_ended_at`).
- `[calendar.py:import_mail]`, `[recurrence.py:recurrence_pass]`, & `[retention.py:calendar_retention]`: All calendar mutations acquire `pg_advisory_xact_lock(749836125)` (`MAIL_LOCK`) before locking `Recording` rows to prevent lock-order deadlocks.
- `[retention.py:remove_audio_metadata]`: Audio/attempt metadata is never erased while `recording.participation != "ended"`, any `attempt.process_ended_at is None`, or `delivery.status == "sending"`.

## Side Effects
- `[database.py:get_engine]`: Reads and writes PostgreSQL tables (`recordings`, `attempts`, `audio_streams`, `audio_chunks`, `audio_controls`, `asr_jobs`, `transcript_segments`, `calendar_entries`, `mail_cursors`, `mail_imports`, `deliveries`) and acquires PostgreSQL advisory locks (`749836123`, `749836124`, `749836125`).
- `[storage.py:AudioStorage]`: Writes (`put_object` with `IfNoneMatch="*"`), reads (`get_object`), and batch-deletes (`delete_objects`) `audio/{recording_id}/...` keys in S3.
- `[controller.py:controller_pass]`: Calls in-cluster Kubernetes `BatchV1Api` and `CoreV1Api` to create/read/patch `Job`s, read/patch `Pod` finalizers, and create/delete `Secret`s in `settings.namespace`.
- `[asr.py:inference_pass]`: Sends HTTP `POST` requests with binary PCM segments to `settings.asr_url + "/v1/transcribe"`.
- `[webex.py:guest_token]`: Makes HTTPS requests to `https://webexapis.com/v1/guests/token` and `https://webexapis.com/v1/access_token`, and reads/patches the `wortlaut-webex` Kubernetes `Secret` when `enable_webex_refresh` is enabled.
- `[calendar.py:imap_pass]` & `[calendar.py:dkim_dns]`: Connects to the configured IMAP server over SSL (`imaplib.IMAP4_SSL`) to fetch messages and resolves DNS `TXT` records (`dns.resolver.resolve`) for DKIM verification.
- `[mail.py:transmit]`: Connects to the configured SMTP relay via `smtplib.SMTP` / `smtplib.SMTP_SSL` and sends result emails.

## Verification
- Run: `uv run --directory services/meeting pytest`
