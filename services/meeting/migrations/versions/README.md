# versions

## Overview
Alembic schema migration revisions (`0001` through `0023`) defining and evolving the PostgreSQL relational schema for `wortlaut` recordings, capture attempts, audio streams, chunks, controls, ASR jobs, transcript segments, calendar entries, mail cursors/imports, and SMTP deliveries.

## Interface
- `[0001_recordings.py:upgrade]` / `[0001_recordings.py:downgrade]`: Creates `recordings` and `attempts` tables and `ix_attempts_recording_id` index (`revision = "0001"`, `down_revision = None`).
- `[0002_worker_status.py:upgrade]` / `[0002_worker_status.py:downgrade]`: Adds worker heartbeat and diagnostics columns (`revision = "0002"`).
- `[0003_audio.py:upgrade]` / `[0003_audio.py:downgrade]`: Creates `audio_streams`, `audio_chunks`, and `audio_controls` tables (`revision = "0003"`).
- `[0004_asr.py:upgrade]` / `[0004_asr.py:downgrade]`: Creates `asr_jobs` and `transcript_segments` tables (`revision = "0004"`).
- `[0005_retention.py:upgrade]` / `[0005_retention.py:downgrade]`: Adds audio and transcript retention timestamp columns (`revision = "0005"`).
- `[0006_jobs.py:upgrade]` / `[0006_jobs.py:downgrade]`: Adds Kubernetes Job/Pod tracking columns on `attempts` (`revision = "0006"`).
- `[0007_job_intent.py:upgrade]` / `[0007_job_intent.py:downgrade]`: Adds `job_create_requested_at` on `attempts` (`revision = "0007"`).
- `[0008_calendar.py:upgrade]` / `[0008_calendar.py:downgrade]`: Creates `calendar_entries`, `mail_cursors`, and `mail_imports` tables (`revision = "0008"`).
- `[0009_occurrences.py:upgrade]` / `[0009_occurrences.py:downgrade]`: Adds `recurrence_key` support for recurring calendar occurrences (`revision = "0009"`).
- `[0010_delivery.py:upgrade]` / `[0010_delivery.py:downgrade]`: Creates `deliveries` table for SMTP result tracking (`revision = "0010"`).
- `[0011_audio_activity.py:upgrade]` / `[0011_audio_activity.py:downgrade]`: Adds `accepted_at` activity timestamp on `audio_chunks` (`revision = "0011"`).
- `[0012_recurrence_anchor.py:upgrade]` / `[0012_recurrence_anchor.py:downgrade]`: Adds `recurrence_anchor` on `calendar_entries` (`revision = "0012"`).
- `[0013_provider.py:upgrade]` / `[0013_provider.py:downgrade]`: Adds `provider` column and `recordings_provider` check constraint on `recordings` (`revision = "0013"`).
- `[0014_processing.py:upgrade]` / `[0014_processing.py:downgrade]`: Adds incremental VAD scan and chunk read-failure tracking columns (`revision = "0014"`).
- `[0015_audio_connection.py:upgrade]` / `[0015_audio_connection.py:downgrade]`: Adds `audio_connection_id` on `attempts` (`revision = "0015"`).
- `[0016_export_reader.py:upgrade]` / `[0016_export_reader.py:downgrade]`: Adds `export_reader_nonce` on `recordings` (`revision = "0016"`).
- `[0017_recording_list.py:upgrade]` / `[0017_recording_list.py:downgrade]`: Adds `ix_recordings_start_id` pagination index on `recordings` (`revision = "0017"`).
- `[0018_audio_range.py:upgrade]` / `[0018_audio_range.py:downgrade]`: Adds `start_sample` indexes on `audio_chunks` and `audio_controls` (`revision = "0018"`).
- `[0019_metadata_retention.py:upgrade]` / `[0019_metadata_retention.py:downgrade]`: Adds `metadata_deleted_at` on `recordings` (`revision = "0019"`).
- `[0020_ingest_rate.py:upgrade]` / `[0020_ingest_rate.py:downgrade]`: Adds token-bucket rate limit columns (`audio_ingest_tokens`, `audio_ingest_refilled_at`) on `attempts` (`revision = "0020"`).
- `[0021_active_sources.py:upgrade]` / `[0021_active_sources.py:downgrade]`: Adds partial index `ix_audio_streams_active_attempt` on `audio_streams` (`revision = "0021"`).
- `[0022_teams.py:upgrade]` / `[0022_teams.py:downgrade]`: Updates `recordings_provider` check constraint on `recordings` to allow `('webex', 'google_meet', 'teams')` (`revision = "0022"`, `down_revision = "0021"`).
- `[0023_recording_title_and_guest_name.py:upgrade]` / `[0023_recording_title_and_guest_name.py:downgrade]`: Adds nullable `title` (`String(200)`) and `guest_name` (`String(120)`) columns on `recordings` (`revision = "0023"`, `down_revision = "0022"`).

## Invariants
- `[0001_recordings.py:revision]` .. `[0023_recording_title_and_guest_name.py:revision]`: Revisions form a single linear chain from `0001` (`down_revision = None`) to `0023` (`down_revision = "0022"`).
- `[0022_teams.py:upgrade]`: The `recordings_provider` check constraint on `recordings` restricts `provider` values to `('webex', 'google_meet', 'teams')`.

## Side Effects
- `[0001_recordings.py:upgrade]` .. `[0023_recording_title_and_guest_name.py:upgrade]`: Executes DDL operations (`create_table`, `drop_table`, `add_column`, `drop_column`, `create_index`, `create_check_constraint`, `drop_constraint`) against the target PostgreSQL database via `alembic.op`.

## Verification
- Run: `uv run --directory services/meeting pytest`
