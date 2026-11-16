"""Authenticated MCP Streamable HTTP server for wortlaut users."""

import base64
import hashlib
import hmac
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from botocore.exceptions import ClientError
from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from wortlaut.calendar import entry_json
from wortlaut.calendar_oauth import (
    connection_json,
    publish_protocol_link_to_calendar_events,
    synced_event_json,
    toggle_synced_event,
)
from wortlaut.controller import request_cancellation
from wortlaut.exports import (
    export_data,
    generate_protocol_summary,
    render_export,
    short_timestamp,
)
from wortlaut.ingest import capacity_reached
from wortlaut.languages import (
    QWEN_ASR_LANGUAGES,
    effective_recording_language,
    normalize_asr_language,
)
from wortlaut.mcp_oauth import (
    McpAuthContext,
    McpAuthError,
    authenticate_mcp_request,
    mcp_www_authenticate,
    public_origin,
)
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioControl,
    AudioStream,
    CalendarConnection,
    CalendarEntry,
    CalendarSyncedEvent,
    Recording,
    RecordingKeyframe,
    TranscriptSegment,
)
from wortlaut.oidc import Principal, can_access_recording, user_recording_access_predicate
from wortlaut.processing import is_keyframe_opted_out
from wortlaut.settings import get_settings
from wortlaut.storage import ObjectConflict, get_storage
from wortlaut.validation import normalize_meeting_url

SUPPORTED_PROTOCOL_VERSIONS: tuple[str, ...] = (
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
)
DEFAULT_PROTOCOL_VERSION = "2025-06-18"
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _principal_binding(principal: Principal) -> str:
    return f"{principal.kind}:{principal.sub or ''}:{(principal.email or '').lower()}"


def _mint_mcp_session_id(principal: Principal) -> str:
    sid = uuid.uuid4().hex
    secret = get_settings().api_token.get_secret_value().encode("utf-8")
    msg = f"wortlaut-mcp-session\0{sid}\0{_principal_binding(principal)}".encode()
    sig = hmac.new(secret, msg, hashlib.sha256).hexdigest()[:32]
    return f"{sid}.{sig}"


def _verify_mcp_session_id(session_id: str, principal: Principal) -> bool:
    if "." not in session_id:
        return False
    sid, sig = session_id.split(".", 1)
    if not sid or len(sid) > 64 or not sig:
        return False
    secret = get_settings().api_token.get_secret_value().encode("utf-8")
    msg = f"wortlaut-mcp-session\0{sid}\0{_principal_binding(principal)}".encode()
    expected = hmac.new(secret, msg, hashlib.sha256).hexdigest()[:32]
    return secrets.compare_digest(sig, expected)


def _is_allowed_mcp_origin(request: Request, origin_hdr: str) -> bool:
    parsed = urlsplit(origin_hdr)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    expected = public_origin(request).lower()
    if origin_hdr.rstrip("/").lower() == expected.rstrip("/"):
        return True
    if scheme == "https" and host:
        return True
    if scheme == "http" and host in _LOOPBACK_HOSTS:
        return True
    return False


def mcp_cors_headers(request: Request) -> dict[str, str]:
    origin_hdr = request.headers.get("origin")
    headers = {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": (
            "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id"
        ),
        "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate",
    }
    if origin_hdr and _is_allowed_mcp_origin(request, origin_hdr):
        headers["Access-Control-Allow-Origin"] = origin_hdr
        headers["Vary"] = "Origin"
    return headers


def validate_mcp_origin(request: Request) -> None:
    origin_hdr = request.headers.get("origin")
    if not origin_hdr:
        return
    if not _is_allowed_mcp_origin(request, origin_hdr):
        raise HTTPException(403, "Disallowed Origin header")


MCP_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_recordings",
        "required_scope": "mcp:read",
        "description": (
            "List or search meeting recordings accessible to the authenticated user. "
            "Searches titles, bound speaker names, and full transcript text."
        ),
        "annotations": {
            "title": "List & Search Recordings",
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Optional full-text search across transcript text, speaker names, "
                        "and titles."
                    ),
                },
                "provider": {
                    "type": "string",
                    "enum": ["google_meet", "teams", "webex", "zoom"],
                    "description": "Optional conference provider filter.",
                },
                "participation": {
                    "type": "string",
                    "description": (
                        "Optional participation state (e.g. scheduled, capturing, ended)."
                    ),
                },
                "processing": {
                    "type": "string",
                    "enum": ["pending", "processing", "completed", "failed"],
                    "description": "Optional ASR processing state filter.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 20,
                    "description": "Maximum number of recordings to return (newest first).",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_recording",
        "required_scope": "mcp:read",
        "description": (
            "Retrieve metadata, live capture/pause status, executive summary, action items, notes, "
            "speaker list, screen-share keyframes, off-the-record pause windows, and raw-audio "
            "retention availability for a recording."
        ),
        "annotations": {
            "title": "Get Recording Details & Summary",
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording.",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_transcript",
        "required_scope": "mcp:read",
        "description": (
            "Read speaker-attributed verbatim transcript segments, settled screen-share keyframes "
            "(wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png), and "
            "off-the-record pause windows for a recording, with optional speaker, keyword, and "
            "timestamp filters plus isolated audio snippets."
        ),
        "annotations": {
            "title": "Read Speaker-Attributed Transcript",
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording.",
                },
                "speaker": {
                    "type": "string",
                    "description": (
                        "Optional case-insensitive substring filter on speaker name or speaker_id "
                        "(filters transcript segments, keyframes, and chat markers)."
                    ),
                },
                "query": {
                    "type": "string",
                    "description": (
                        "Optional case-insensitive substring filter on segment and "
                        "chat-marker text."
                    ),
                },
                "start_seconds": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Optional lower bound in seconds from recording start.",
                },
                "end_seconds": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Optional upper bound in seconds from recording start.",
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "default": 0,
                    "description": "Segment pagination offset.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 250,
                    "default": 100,
                    "description": "Maximum number of segments to return.",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "export_protocol",
        "required_scope": "mcp:read",
        "description": (
            "Render the formatted meeting protocol in Markdown (md), plain text (txt), "
            "WebVTT (vtt), or JSON (including executive summary, action items, chat-pinned "
            "decisions/to-dos, off-the-record pause windows, and screen-share slide references)."
        ),
        "annotations": {
            "title": "Export Formatted Protocol",
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording.",
                },
                "format": {
                    "type": "string",
                    "enum": ["md", "txt", "vtt", "json"],
                    "default": "md",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_calendar_events",
        "required_scope": "mcp:read",
        "description": (
            "List the authenticated user's connected Google/Microsoft calendars and upcoming "
            "(or recent) synced calendar meetings and .ics invitations."
        ),
        "annotations": {
            "title": "List Calendar Events",
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_past": {
                    "type": "boolean",
                    "default": False,
                    "description": "Include events from the past 7 days.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 30,
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "schedule_recording",
        "required_scope": "mcp:write",
        "description": (
            "Schedule a future recording or start an immediate ad-hoc recording for a "
            "Google Meet, Microsoft Teams, Cisco Webex, or Zoom URL."
        ),
        "annotations": {
            "title": "Schedule or Start Recording",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": False,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "meeting_url": {
                    "type": "string",
                    "description": (
                        "HTTPS URL for Google Meet, Microsoft Teams, Cisco Webex, or Zoom."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": "Optional human-readable meeting title.",
                },
                "starts_at": {
                    "type": "string",
                    "description": (
                        "Optional ISO-8601 start timestamp with timezone. Omit to join immediately."
                    ),
                },
                "duration_minutes": {
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 240,
                    "default": 60,
                    "description": "Expected duration in minutes (5-240).",
                },
                "guest_name": {
                    "type": "string",
                    "description": "Optional bot display name override.",
                },
                "language": {
                    "type": "string",
                    "description": (
                        "Optional Qwen3-ASR transcription language ('auto' for all 30 languages, "
                        "or one/comma-separated names/ISO codes such as 'English', 'German', "
                        "'French', 'Japanese', 'Chinese', 'Spanish', 'German,English')."
                    ),
                },
            },
            "required": ["meeting_url"],
            "additionalProperties": False,
        },
    },
    {
        "name": "cancel_recording",
        "required_scope": "mcp:write",
        "description": "Stop an active recording or cancel a scheduled recording.",
        "annotations": {
            "title": "Stop or Cancel Recording",
            "readOnlyHint": False,
            "destructiveHint": True,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording to stop or cancel.",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_protocol",
        "required_scope": "mcp:write",
        "description": (
            "Update a recording's title, transcription language (all 30 Qwen3-ASR languages or "
            "'auto'), human meeting notes, speaker display-name overrides, or glossary term "
            "replacements."
        ),
        "annotations": {
            "title": "Update Protocol Metadata & Replacements",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording.",
                },
                "title": {
                    "type": "string",
                    "description": "Optional updated meeting title.",
                },
                "language": {
                    "type": "string",
                    "description": (
                        "Optional Qwen3-ASR transcription language ('auto' for all 30 languages, "
                        f"or any of: {', '.join(QWEN_ASR_LANGUAGES)})."
                    ),
                },
                "notes": {
                    "type": "string",
                    "description": "Optional Markdown meeting notes.",
                },
                "speaker_overrides": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                    "description": "Map of original speaker label/ID to corrected display name.",
                },
                "term_replacements": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                    "description": "Map of misrecognized term to domain-accurate replacement.",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "generate_summary",
        "required_scope": "mcp:write",
        "description": (
            "Generate or refresh the structured executive summary, topics, and action items "
            "for a completed recording using the local self-hosted Ollama model."
        ),
        "annotations": {
            "title": "Generate Local AI Summary",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": False,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording.",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "toggle_calendar_event_recording",
        "required_scope": "mcp:write",
        "description": (
            "Enable or disable automatic recording for a synced Google Calendar or "
            "Microsoft 365 event."
        ),
        "annotations": {
            "title": "Toggle Calendar Event Auto-Record",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "event_id": {
                    "type": "string",
                    "description": "UUID of the synced calendar event from list_calendar_events.",
                },
                "enabled": {
                    "type": "boolean",
                    "description": "True to schedule/enable recording, false to disable/cancel.",
                },
            },
            "required": ["event_id", "enabled"],
            "additionalProperties": False,
        },
    },
    {
        "name": "publish_calendar_protocol_link",
        "required_scope": "mcp:write",
        "description": (
            "Write the scoped read-only protocol link back into the matching Google Calendar "
            "or Microsoft 365 invite."
        ),
        "annotations": {
            "title": "Write Protocol Link to Calendar Invite",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": True,
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the completed recording.",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    },
]

MCP_PROMPTS: list[dict[str, Any]] = [
    {
        "name": "meeting_followup",
        "description": (
            "Draft a concise follow-up summary with speaker-attributed decisions and action items."
        ),
        "arguments": [
            {
                "name": "recording_id",
                "description": "UUID of the recording to summarize.",
                "required": True,
            }
        ],
    },
    {
        "name": "decision_audit",
        "description": (
            "Verify exact verbatim quotes and timestamps for technical or product decisions "
            "in a meeting."
        ),
        "arguments": [
            {
                "name": "recording_id",
                "description": "UUID of the recording to audit.",
                "required": True,
            },
            {
                "name": "topic",
                "description": "Specific topic or question to verify.",
                "required": False,
            },
        ],
    },
]


def _public_tool_def(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": tool["name"],
        "description": tool["description"],
        "inputSchema": tool["inputSchema"],
        "annotations": tool["annotations"],
    }


def _parse_uuid(raw: Any, field_name: str = "recording_id") -> uuid.UUID:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{field_name} must be a non-empty UUID string")
    try:
        return uuid.UUID(raw.strip())
    except ValueError:
        raise ValueError(f"Invalid UUID for {field_name}: {raw}") from None


def _parse_int(raw: Any, default: int, field_name: str) -> int:
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ValueError(f"{field_name} must be an integer")
    return raw


def _parse_float(raw: Any, field_name: str) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"{field_name} must be a number")
    return float(raw)


def _parse_bool(raw: Any, field_name: str, *, default: bool | None = None) -> bool:
    if raw is None:
        if default is not None:
            return default
        raise ValueError(f"{field_name} is required and must be a boolean")
    if not isinstance(raw, bool):
        raise ValueError(f"{field_name} must be a boolean (true or false)")
    return raw


def _get_accessible_recording(
    db: Session,
    principal: Principal,
    recording_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> Recording:
    if for_update:
        rec = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    else:
        rec = db.get(Recording, recording_id)
    if (
        rec is None
        or rec.metadata_deleted_at is not None
        or not can_access_recording(db, principal, rec)
    ):
        raise LookupError(f"Recording {recording_id} not found or not accessible")
    return rec


def _tool_result(text_body: str, structured: dict[str, Any] | None = None) -> dict[str, Any]:
    res: dict[str, Any] = {
        "content": [{"type": "text", "text": text_body}],
        "isError": False,
    }
    if structured is not None:
        res["structuredContent"] = structured
    return res


def _tool_error(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": f"Error: {message}"}],
        "isError": True,
    }


def _mcp_keyframe_item(rec_id: uuid.UUID, kf: dict[str, Any]) -> dict[str, Any]:
    return {
        **kf,
        "resource_uri": f"wortlaut://recordings/{rec_id}/keyframes/{kf['id']}.png",
    }


def _execute_tool(
    request: Request,
    db: Session,
    ctx: McpAuthContext,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    origin = public_origin(request)
    principal = ctx.principal

    if name == "list_recordings":
        limit = max(1, min(50, _parse_int(arguments.get("limit"), 20, "limit")))
        q_str = str(arguments.get("query") or "").strip()
        provider = arguments.get("provider")
        participation = str(arguments.get("participation") or "").strip()
        processing = str(arguments.get("processing") or "").strip()

        stmt = select(Recording).where(Recording.metadata_deleted_at.is_(None))
        unstarted_cancelled_cal = and_(
            Recording.idempotency_key.like("cal-oauth-%"),
            Recording.participation == "ended",
            Recording.participation_reason == "cancelled",
            ~select(Attempt.id).where(Attempt.recording_id == Recording.id).exists(),
        )
        stmt = stmt.where(~unstarted_cancelled_cal)
        if not principal.is_admin:
            pred = user_recording_access_predicate(principal)
            if pred is False:
                return _tool_result("No recordings found.", {"items": [], "count": 0})
            stmt = stmt.where(pred)
        if provider:
            stmt = stmt.where(Recording.provider == str(provider))
        if participation:
            parts = [p.strip() for p in participation.split(",") if p.strip()]
            stmt = stmt.where(Recording.participation.in_(parts))
        if processing:
            stmt = stmt.where(Recording.processing == processing)
        if q_str:
            needle = f"%{q_str}%"
            segment_match = (
                select(TranscriptSegment.id)
                .join(AsrJob, AsrJob.id == TranscriptSegment.id)
                .join(AudioStream, AudioStream.id == AsrJob.stream_id)
                .join(Attempt, Attempt.id == AudioStream.attempt_id)
                .where(
                    Attempt.recording_id == Recording.id,
                    or_(
                        TranscriptSegment.result["text"].astext.ilike(needle),
                        TranscriptSegment.result["participant_name"].astext.ilike(needle),
                        TranscriptSegment.result["speaker_id"].astext.ilike(needle),
                    ),
                )
                .exists()
            )
            stream_match = (
                select(AudioStream.id)
                .join(Attempt, Attempt.id == AudioStream.attempt_id)
                .outerjoin(AudioControl, AudioControl.stream_id == AudioStream.id)
                .where(
                    Attempt.recording_id == Recording.id,
                    or_(
                        AudioStream.contract["participant_name"].astext.ilike(needle),
                        AudioStream.contract["speaker_id"].astext.ilike(needle),
                        AudioControl.contract["participant_name"].astext.ilike(needle),
                    ),
                )
                .exists()
            )
            stmt = stmt.where(
                or_(
                    Recording.title.ilike(needle),
                    Recording.guest_name.ilike(needle),
                    segment_match,
                    stream_match,
                )
            )
        rows = db.scalars(
            stmt.order_by(desc(Recording.starts_at), desc(Recording.id)).limit(limit)
        ).all()
        items = []
        lines = []
        for rec in rows:
            meta = rec.protocol_meta if isinstance(rec.protocol_meta, dict) else {}
            has_summary = bool(meta.get("summary"))
            audio_retained = rec.audio_deleted_at is None
            item = {
                "id": str(rec.id),
                "title": rec.title or f"{rec.provider} meeting",
                "provider": rec.provider,
                "starts_at": rec.starts_at.isoformat(),
                "ends_at": rec.ends_at.isoformat(),
                "participation": rec.participation,
                "processing": rec.processing,
                "summary_available": has_summary,
                "audio_snippets_available": audio_retained,
                "ui_url": f"{origin}/ui#view=meetings&id={rec.id}",
            }
            items.append(item)
            lines.append(
                f"- **{item['title']}** (`{item['id']}`) · {rec.provider} · "
                f"{rec.starts_at.strftime('%Y-%m-%d %H:%M UTC')} · "
                f"participation=`{rec.participation}`, processing=`{rec.processing}`"
            )
        summary_text = (
            f"Found {len(items)} recording(s):\n" + "\n".join(lines)
            if items
            else "No matching recordings found."
        )
        return _tool_result(summary_text, {"items": items, "count": len(items)})

    if name == "get_recording":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id)
        meta = dict(rec.protocol_meta or {})
        transcript_info: dict[str, Any] = {
            "segment_count": 0,
            "keyframe_count": 0,
            "pause_window_count": 0,
            "speakers": [],
        }
        keyframes_out: list[dict[str, Any]] = []
        pause_windows_out: list[dict[str, Any]] = []
        detected_langs: list[str] = []
        if rec.transcript_deleted_at is None:
            exp = export_data(db, rec)
            segs = exp.get("segments") or []
            detected_langs = list(exp.get("detected_languages") or [])
            keyframes_out = [
                _mcp_keyframe_item(rec.id, kf) for kf in (exp.get("keyframes") or [])
            ]
            pause_windows_out = list(exp.get("pause_windows") or [])
            speakers = sorted(
                {
                    str(s.get("speaker_label") or s.get("speaker_name") or "Unknown")
                    for s in segs
                }
            )
            transcript_info = {
                "segment_count": len(segs),
                "keyframe_count": len(keyframes_out),
                "pause_window_count": len(pause_windows_out),
                "speakers": speakers,
                "detected_languages": detected_langs,
                "opted_out_speakers": exp.get("opted_out_speakers") or [],
            }
        payload = {
            "id": str(rec.id),
            "title": rec.title,
            "provider": rec.provider,
            "language": effective_recording_language(rec, get_settings()),
            "detected_languages": detected_langs,
            "owner_email": rec.owner_email,
            "starts_at": rec.starts_at.isoformat(),
            "ends_at": rec.ends_at.isoformat(),
            "participation": rec.participation,
            "participation_reason": rec.participation_reason,
            "processing": rec.processing,
            "processing_error": rec.processing_error,
            "audio_snippets_available": rec.audio_deleted_at is None,
            "transcript_expired": rec.transcript_deleted_at is not None,
            "summary": meta.get("summary"),
            "notes": meta.get("notes") or "",
            "speaker_overrides": meta.get("speaker_overrides") or {},
            "term_replacements": meta.get("term_replacements") or {},
            "transcript": transcript_info,
            "keyframes": keyframes_out,
            "pause_windows": pause_windows_out,
            "ui_url": f"{origin}/ui#view=meetings&id={rec.id}",
        }
        return _tool_result(json.dumps(payload, ensure_ascii=False, indent=2), payload)

    if name == "get_transcript":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id)
        if rec.transcript_deleted_at is not None:
            return _tool_error("Transcript retention window has expired for this recording.")
        exp = export_data(db, rec)
        all_segments: list[dict[str, Any]] = list(exp.get("segments") or [])
        all_keyframes: list[dict[str, Any]] = list(exp.get("keyframes") or [])
        all_pauses: list[dict[str, Any]] = list(exp.get("pause_windows") or [])

        speaker_filter = str(arguments.get("speaker") or "").strip().lower()
        query_filter = str(arguments.get("query") or "").strip().lower()
        start_sec = _parse_float(arguments.get("start_seconds"), "start_seconds")
        end_sec = _parse_float(arguments.get("end_seconds"), "end_seconds")
        offset = max(0, _parse_int(arguments.get("offset"), 0, "offset"))
        limit = max(1, min(250, _parse_int(arguments.get("limit"), 100, "limit")))

        filtered = []
        for seg in all_segments:
            spk = str(
                seg.get("speaker_label") or seg.get("speaker_name") or seg.get("speaker_id") or ""
            )
            txt = str(seg.get("text") or "")
            s_start = float(seg.get("start") or 0.0)
            s_end = float(seg.get("end") or 0.0)
            spk_id = str(seg.get("speaker_id") or "").lower()
            if (
                speaker_filter
                and speaker_filter not in spk.lower()
                and speaker_filter not in spk_id
            ):
                continue
            if query_filter and query_filter not in txt.lower():
                continue
            if start_sec is not None and s_end < float(start_sec):
                continue
            if end_sec is not None and s_start > float(end_sec):
                continue
            filtered.append(seg)

        out_keyframes = []
        for kf in all_keyframes:
            pres = str(kf.get("presenter") or "").lower()
            pid = str(kf.get("participant_id") or "").lower()
            kf_offset = float(kf.get("offset_seconds") or 0.0)
            if speaker_filter and speaker_filter not in pres and speaker_filter not in pid:
                continue
            if start_sec is not None and kf_offset < float(start_sec):
                continue
            if end_sec is not None and kf_offset > float(end_sec):
                continue
            out_keyframes.append(_mcp_keyframe_item(rec.id, kf))

        out_pauses = []
        for pw in all_pauses:
            if speaker_filter or query_filter:
                continue
            pw_offset = float(pw.get("offset_seconds") or 0.0)
            if start_sec is not None and pw_offset < float(start_sec):
                continue
            if end_sec is not None and pw_offset > float(end_sec):
                continue
            out_pauses.append(pw)

        total_matching = len(filtered)
        page = filtered[offset : offset + limit]
        audio_available = rec.audio_deleted_at is None
        out_segments = []
        md_lines = [
            f"# {rec.title or rec.provider} ({rec.starts_at.strftime('%Y-%m-%d %H:%M UTC')})",
            f"Showing {len(page)} of {total_matching} matching segment(s) (offset={offset}):\n",
        ]
        for seg in page:
            s_start = round(float(seg.get("start") or 0.0), 2)
            s_end = round(float(seg.get("end") or 0.0), 2)
            speaker_label = str(
                seg.get("speaker_label")
                or seg.get("speaker_name")
                or ("Unbound Speaker" if seg.get("attribution_unknown") else "Speaker")
            )
            stream_id = str(seg.get("stream_id") or "")
            item: dict[str, Any] = {
                "segment_id": seg.get("segment_id") or seg.get("id"),
                "speaker": speaker_label,
                "speaker_id": seg.get("speaker_id"),
                "attribution_unknown": bool(seg.get("attribution_unknown")),
                "start": s_start,
                "end": s_end,
                "timestamp": f"{short_timestamp(s_start)}-{short_timestamp(s_end)}",
                "text": seg.get("text") or "",
            }
            if audio_available and stream_id:
                item["audio_snippet_path"] = (
                    f"/v1/recordings/{rec.id}/audio-snippet"
                    f"?start={s_start}&end={max(s_end, s_start + 0.5)}&stream_id={stream_id}"
                )
            out_segments.append(item)
            md_lines.append(f"[{item['timestamp']}] **{speaker_label}**: {item['text']}")

        if out_pauses:
            md_lines.append("\nOff-the-record pause windows:")
            for pw in out_pauses:
                s_ts = short_timestamp(float(pw.get("offset_seconds") or 0.0))
                end_off = pw.get("end_offset_seconds")
                e_ts = short_timestamp(float(end_off)) if end_off is not None else "ongoing"
                by = f" ({pw.get('by')})" if pw.get("by") else ""
                md_lines.append(f"- [{s_ts}-{e_ts}] **OFF THE RECORD{by}**")

        if out_keyframes:
            md_lines.append("\nScreen-share keyframes:")
            for kf in out_keyframes:
                ts = short_timestamp(float(kf.get("offset_seconds") or 0.0))
                md_lines.append(
                    f"- [{ts}] **{kf.get('presenter')}**: `{kf['resource_uri']}` "
                    f"({kf.get('width')}x{kf.get('height')})"
                )

        structured = {
            "recording_id": str(rec.id),
            "title": rec.title,
            "language": exp.get("language") or effective_recording_language(rec, get_settings()),
            "detected_languages": list(exp.get("detected_languages") or []),
            "total_matching": total_matching,
            "offset": offset,
            "returned": len(out_segments),
            "audio_snippets_available": audio_available,
            "ui_url": f"{origin}/ui#view=meetings&id={rec.id}",
            "segments": out_segments,
            "keyframes": out_keyframes,
            "pause_windows": out_pauses,
        }
        return _tool_result("\n".join(md_lines), structured)

    if name == "export_protocol":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        fmt = str(arguments.get("format") or "md").strip().lower()
        if fmt not in ("md", "txt", "vtt", "json"):
            return _tool_error("format must be one of: md, txt, vtt, json")
        rec = _get_accessible_recording(db, principal, rec_id)
        if rec.transcript_deleted_at is not None:
            return _tool_error("Transcript retention window has expired for this recording.")
        if rec.processing not in ("completed", "failed"):
            return _tool_error(f"Recording processing is still '{rec.processing}'.")
        rendered, media_type = render_export(export_data(db, rec), fmt)
        text_out = rendered.decode("utf-8") if isinstance(rendered, bytes) else str(rendered)
        return _tool_result(
            text_out,
            {"recording_id": str(rec.id), "format": fmt, "media_type": media_type},
        )

    if name == "list_calendar_events":
        include_past = _parse_bool(
            arguments.get("include_past"), "include_past", default=False
        )
        limit = max(1, min(100, _parse_int(arguments.get("limit"), 30, "limit")))
        now = datetime.now(UTC)
        user_email = (principal.email or "").lower()

        conn_query = select(CalendarConnection).order_by(CalendarConnection.created_at.desc())
        synced_query = select(CalendarSyncedEvent)
        cal_query = select(CalendarEntry).order_by(CalendarEntry.dtstamp.desc())
        if principal.kind != "operator":
            conn_query = conn_query.where(func.lower(CalendarConnection.owner_email) == user_email)
            synced_query = synced_query.where(
                func.lower(CalendarSyncedEvent.owner_email) == user_email
            )
        if not principal.is_admin:
            cal_query = cal_query.where(func.lower(CalendarEntry.organizer) == user_email)

        if include_past:
            synced_query = synced_query.where(
                CalendarSyncedEvent.ends_at >= now - timedelta(days=7)
            )
        else:
            synced_query = synced_query.where(CalendarSyncedEvent.ends_at >= now)

        connections = [connection_json(c) for c in db.scalars(conn_query).all()]
        synced_rows = db.scalars(
            synced_query.order_by(CalendarSyncedEvent.starts_at.asc()).limit(limit)
        ).all()
        rec_ids = [ev.recording_id for ev in synced_rows if ev.recording_id]
        rec_map = (
            {
                r.id: r
                for r in db.scalars(select(Recording).where(Recording.id.in_(rec_ids))).all()
            }
            if rec_ids
            else {}
        )
        synced_events = [
            synced_event_json(ev, rec_map.get(ev.recording_id) if ev.recording_id else None)
            for ev in synced_rows
        ]
        ics_entries = []
        for entry in db.scalars(cal_query.limit(limit)).all():
            recs = db.scalars(
                select(Recording).where(Recording.calendar_entry_id == entry.id)
            ).all()
            item = entry_json(entry, recs[0] if len(recs) == 1 else None)
            if not include_past and item.get("ends_at"):
                try:
                    if datetime.fromisoformat(item["ends_at"]) < now:
                        continue
                except ValueError:
                    pass
            ics_entries.append(item)

        payload = {
            "connections": connections,
            "synced_events": synced_events,
            "ics_events": ics_entries[:limit],
        }
        return _tool_result(json.dumps(payload, ensure_ascii=False, indent=2), payload)

    if name == "schedule_recording":
        raw_url = str(arguments.get("meeting_url") or "").strip()
        if not raw_url:
            return _tool_error("meeting_url is required.")
        try:
            provider, normalized_url = normalize_meeting_url(raw_url)
        except ValueError as exc:
            return _tool_error(str(exc))

        now = datetime.now(UTC)
        raw_starts = arguments.get("starts_at")
        if raw_starts:
            try:
                starts_at = datetime.fromisoformat(str(raw_starts))
            except ValueError:
                return _tool_error("starts_at must be a valid ISO-8601 datetime with timezone.")
            if starts_at.tzinfo is None:
                return _tool_error("starts_at requires an explicit timezone (e.g. Z or +01:00).")
            starts_at = starts_at.astimezone(UTC)
        else:
            starts_at = now

        duration_min = max(
            5, min(240, _parse_int(arguments.get("duration_minutes"), 60, "duration_minutes"))
        )
        ends_at = starts_at + timedelta(minutes=duration_min)
        title = " ".join(str(arguments.get("title") or "").split())[:200] or None
        guest_name = " ".join(str(arguments.get("guest_name") or "").split())[:120] or None
        raw_lang = arguments.get("language")
        norm_lang: str | None = None
        if raw_lang is not None and str(raw_lang).strip():
            try:
                norm_lang = normalize_asr_language(str(raw_lang))
            except ValueError as exc:
                return _tool_error(str(exc))

        if capacity_reached(db):
            return _tool_error("Recording capacity limit reached on this wortlaut instance.")

        idempotency_key = f"mcp-{uuid.uuid4()}"
        digest_payload: dict[str, Any] = {
            "meeting_url": normalized_url,
            "starts_at": starts_at.isoformat(),
            "ends_at": ends_at.isoformat(),
        }
        if provider != "webex":
            digest_payload["provider"] = provider
        if title is not None:
            digest_payload["title"] = title
        if guest_name is not None:
            digest_payload["guest_name"] = guest_name
        if norm_lang is not None:
            digest_payload["language"] = norm_lang
        digest = hashlib.sha256(json.dumps(digest_payload, sort_keys=True).encode()).hexdigest()

        meta: dict[str, Any] = {}
        if principal.name and principal.name.strip():
            meta["owner_name"] = " ".join(principal.name.split())[:120]
        if norm_lang is not None:
            meta["asr_language"] = norm_lang

        rec = Recording(
            idempotency_key=idempotency_key,
            request_digest=digest,
            meeting_url=normalized_url,
            provider=provider,
            title=title,
            guest_name=guest_name,
            owner_sub=principal.sub,
            owner_email=principal.email.lower() if principal.email else None,
            starts_at=starts_at,
            ends_at=ends_at,
            protocol_meta=meta,
        )
        db.add(rec)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return _tool_error("Conflicting recording schedule request.")

        out = {
            "id": str(rec.id),
            "provider": rec.provider,
            "title": rec.title,
            "language": effective_recording_language(rec, get_settings()),
            "starts_at": rec.starts_at.isoformat(),
            "ends_at": rec.ends_at.isoformat(),
            "participation": rec.participation,
            "ui_url": f"{origin}/ui#view=meetings&id={rec.id}",
        }
        return _tool_result(
            f"Scheduled {rec.provider} recording `{rec.id}` "
            f"({rec.starts_at.isoformat()} -> {rec.ends_at.isoformat()}).",
            out,
        )

    if name == "cancel_recording":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id, for_update=True)
        request_cancellation(rec, datetime.now(UTC))
        synced_for_rec = db.scalars(
            select(CalendarSyncedEvent)
            .where(CalendarSyncedEvent.recording_id == rec.id)
            .with_for_update()
        ).all()
        for sev in synced_for_rec:
            sev.recording_id = None
            sev.user_override = False
            sev.auto_record = False
        db.commit()
        out = {
            "id": str(rec.id),
            "participation": rec.participation,
            "cancelled_at": rec.cancelled_at.isoformat() if rec.cancelled_at else None,
        }
        return _tool_result(f"Cancelled recording `{rec.id}`.", out)

    if name == "update_protocol":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id, for_update=True)
        if rec.transcript_deleted_at is not None:
            return _tool_error("Transcript retention window has expired for this recording.")

        if "title" in arguments and arguments["title"] is not None:
            rec.title = " ".join(str(arguments["title"]).split())[:200] or None
        meta = dict(rec.protocol_meta or {})
        if "language" in arguments and arguments["language"] is not None:
            raw_lang = str(arguments["language"]).strip()
            if not raw_lang:
                meta.pop("asr_language", None)
            else:
                try:
                    norm_lang = normalize_asr_language(raw_lang)
                except ValueError as exc:
                    return _tool_error(str(exc))
                if norm_lang:
                    meta["asr_language"] = norm_lang
                else:
                    meta.pop("asr_language", None)
        if "notes" in arguments and arguments["notes"] is not None:
            meta["notes"] = str(arguments["notes"])[:20000]
        if isinstance(arguments.get("speaker_overrides"), dict):
            cur_speakers = dict(meta.get("speaker_overrides") or {})
            for k, v in arguments["speaker_overrides"].items():
                key = str(k).strip()[:200]
                if not key:
                    continue
                val = str(v).strip()[:120]
                if val:
                    cur_speakers[key] = val
                else:
                    cur_speakers.pop(key, None)
            meta["speaker_overrides"] = cur_speakers
        if isinstance(arguments.get("term_replacements"), dict):
            cur_terms = dict(meta.get("term_replacements") or {})
            for k, v in arguments["term_replacements"].items():
                key = str(k).strip()[:120]
                if not key:
                    continue
                val = str(v).strip()[:120]
                if val and val != key:
                    cur_terms[key] = val
                else:
                    cur_terms.pop(key, None)
            meta["term_replacements"] = cur_terms
        rec.protocol_meta = meta
        db.commit()
        out = {
            "id": str(rec.id),
            "title": rec.title,
            "language": effective_recording_language(rec, get_settings()),
            "notes": meta.get("notes") or "",
            "speaker_overrides": meta.get("speaker_overrides") or {},
            "term_replacements": meta.get("term_replacements") or {},
        }
        return _tool_result(f"Updated protocol metadata for `{rec.id}`.", out)

    if name == "generate_summary":
        if not get_settings().enable_llm_summary:
            return _tool_error(
                "Local LLM summary is disabled on this instance "
                "(WORTLAUT_ENABLE_LLM_SUMMARY=false)."
            )
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id)
        if rec.transcript_deleted_at is not None:
            return _tool_error("Transcript retention window has expired for this recording.")
        try:
            summary = generate_protocol_summary(db, rec.id)
        except RuntimeError as exc:
            return _tool_error(f"Local LLM summary failed: {exc}")
        try:
            locked = db.scalar(select(Recording).where(Recording.id == rec.id).with_for_update())
            if locked is not None:
                publish_protocol_link_to_calendar_events(db, locked)
                db.commit()
        except Exception:
            db.rollback()
        return _tool_result(
            json.dumps(summary, ensure_ascii=False, indent=2),
            {"recording_id": str(rec.id), "summary": summary},
        )

    if name == "toggle_calendar_event_recording":
        ev_id = _parse_uuid(arguments.get("event_id"), "event_id")
        enabled = _parse_bool(arguments.get("enabled"), "enabled")
        try:
            res = toggle_synced_event(db, principal, ev_id, enabled)
        except HTTPException as exc:
            return _tool_error(str(exc.detail))
        return _tool_result(json.dumps(res, ensure_ascii=False, indent=2), res)

    if name == "publish_calendar_protocol_link":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id, for_update=True)
        if rec.processing != "completed":
            return _tool_error(f"Recording processing is '{rec.processing}' (must be 'completed').")
        res = publish_protocol_link_to_calendar_events(db, rec, force_empty_audio=True)
        db.commit()
        if res.get("status") in ("no_matching_calendar_event", "error"):
            return _tool_error(f"Calendar update failed: {res.get('error') or res.get('status')}")
        return _tool_result(json.dumps(res, ensure_ascii=False, indent=2), res)

    raise JsonRpcError(-32602, f"Unknown tool: {name}")


def _dispatch_rpc_method(
    request: Request,
    db: Session,
    ctx: McpAuthContext,
    method: str,
    params: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, str]]:
    extra_headers: dict[str, str] = {}
    origin = public_origin(request)

    if method == "initialize":
        client_ver = str(params.get("protocolVersion") or "").strip()
        negotiated = (
            client_ver if client_ver in SUPPORTED_PROTOCOL_VERSIONS else DEFAULT_PROTOCOL_VERSION
        )
        session_id = _mint_mcp_session_id(ctx.principal)
        extra_headers["Mcp-Session-Id"] = session_id
        extra_headers["MCP-Protocol-Version"] = negotiated
        return (
            {
                "protocolVersion": negotiated,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"subscribe": False, "listChanged": False},
                    "prompts": {"listChanged": False},
                },
                "serverInfo": {
                    "name": get_settings().assistant_name,
                    "version": "0.1.0",
                },
                "instructions": (
                    "wortlaut provides pre-mix WebRTC speaker-isolated meeting transcripts "
                    "(Google Meet, Microsoft Teams, Cisco Webex, Zoom) scoped to the authenticated "
                    "user. Prefer get_transcript with pagination or filters for verbatim speaker "
                    "statements, off-the-record pause_windows (#pause / #resume), and settled "
                    "screen-share keyframes (readable as image/png via "
                    "wortlaut://recordings/{id}/keyframes/{kf_id}.png)."
                ),
            },
            extra_headers,
        )

    if method == "ping":
        return {}, extra_headers

    if method == "tools/list":
        visible = [
            _public_tool_def(t)
            for t in MCP_TOOLS
            if t["required_scope"] in ctx.scopes
        ]
        return {"tools": visible}, extra_headers

    if method == "tools/call":
        tool_name = str(params.get("name") or "").strip()
        raw_args = params.get("arguments")
        if raw_args is None:
            args: dict[str, Any] = {}
        elif isinstance(raw_args, dict):
            args = raw_args
        else:
            raise JsonRpcError(-32602, "Tool arguments must be a JSON object")

        tool_spec = next((t for t in MCP_TOOLS if t["name"] == tool_name), None)
        if tool_spec is None:
            raise JsonRpcError(-32602, f"Unknown tool: {tool_name}")

        if tool_spec["required_scope"] not in ctx.scopes:
            raise McpAuthError(
                403,
                f"Insufficient scope: {tool_spec['required_scope']} is required for {tool_name}",
                www_authenticate=mcp_www_authenticate(
                    origin,
                    error="insufficient_scope",
                    error_description=f"Tool {tool_name} requires {tool_spec['required_scope']}",
                ),
            )

        try:
            result = _execute_tool(request, db, ctx, tool_name, args)
        except (ValueError, LookupError) as exc:
            result = _tool_error(str(exc))
        return result, extra_headers

    if method == "resources/list":
        if "mcp:read" not in ctx.scopes:
            raise McpAuthError(
                403,
                "Insufficient scope: mcp:read is required",
                www_authenticate=mcp_www_authenticate(origin, error="insufficient_scope"),
            )
        stmt = select(Recording).where(
            Recording.metadata_deleted_at.is_(None),
            Recording.transcript_deleted_at.is_(None),
            Recording.processing == "completed",
        )
        if not ctx.principal.is_admin:
            pred = user_recording_access_predicate(ctx.principal)
            if pred is False:
                return {"resources": []}, extra_headers
            stmt = stmt.where(pred)
        recs = db.scalars(stmt.order_by(desc(Recording.starts_at)).limit(25)).all()
        resources = [
            {
                "uri": f"wortlaut://recordings/{r.id}/protocol.md",
                "name": r.title or f"{r.provider} ({r.starts_at.strftime('%Y-%m-%d %H:%M UTC')})",
                "description": (
                    f"Markdown protocol for {r.provider} meeting on {r.starts_at.isoformat()}"
                ),
                "mimeType": "text/markdown",
            }
            for r in recs
        ]
        return {"resources": resources}, extra_headers

    if method == "resources/templates/list":
        return (
            {
                "resourceTemplates": [
                    {
                        "uriTemplate": "wortlaut://recordings/{recording_id}/protocol.md",
                        "name": "Meeting Protocol (Markdown)",
                        "description": "Formatted speaker-attributed meeting protocol in Markdown.",
                        "mimeType": "text/markdown",
                    },
                    {
                        "uriTemplate": "wortlaut://recordings/{recording_id}/transcript.json",
                        "name": "Meeting Transcript (JSON)",
                        "description": "Structured speaker-attributed transcript segments.",
                        "mimeType": "application/json",
                    },
                    {
                        "uriTemplate": (
                            "wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png"
                        ),
                        "name": "Screen-Share Slide Keyframe (PNG)",
                        "description": (
                            "Settled static PNG snapshot captured from an active screen share."
                        ),
                        "mimeType": "image/png",
                    },
                ]
            },
            extra_headers,
        )

    if method == "resources/read":
        if "mcp:read" not in ctx.scopes:
            raise McpAuthError(
                403,
                "Insufficient scope: mcp:read is required",
                www_authenticate=mcp_www_authenticate(origin, error="insufficient_scope"),
            )
        uri = str(params.get("uri") or "").strip()
        prefix = "wortlaut://recordings/"
        if not uri.startswith(prefix):
            raise JsonRpcError(-32602, f"Unsupported resource URI: {uri}")
        rest = uri.removeprefix(prefix)
        parts = rest.split("/", 1)
        if len(parts) != 2:
            raise JsonRpcError(-32602, f"Invalid wortlaut resource path: {uri}")
        subpath = parts[1]
        is_keyframe_uri = (
            subpath.startswith("keyframes/")
            and subpath.endswith(".png")
            and "/" not in subpath.removeprefix("keyframes/")
        )
        if subpath not in ("protocol.md", "transcript.json") and not is_keyframe_uri:
            raise JsonRpcError(-32602, f"Invalid wortlaut resource path: {uri}")
        try:
            rec_id = _parse_uuid(parts[0])
            rec = _get_accessible_recording(db, ctx.principal, rec_id)
        except (ValueError, LookupError) as exc:
            raise JsonRpcError(-32002, str(exc)) from None
        if rec.transcript_deleted_at is not None:
            raise JsonRpcError(-32002, "Transcript retention expired")
        if is_keyframe_uri:
            raw_kf_id = subpath.removeprefix("keyframes/").removesuffix(".png")
            try:
                kf_id = _parse_uuid(raw_kf_id)
            except ValueError as exc:
                raise JsonRpcError(-32002, str(exc)) from None
            kf = db.get(RecordingKeyframe, kf_id)
            if (
                kf is None
                or kf.recording_id != rec.id
                or kf.deleted_at is not None
                or not kf.object_key
                or is_keyframe_opted_out(db, rec, kf)
            ):
                raise JsonRpcError(-32002, "Keyframe not found")
            try:
                png_bytes = get_storage().read(kf.object_key)
            except (ClientError, ObjectConflict):
                raise JsonRpcError(-32002, "Keyframe not found") from None
            if hashlib.sha256(png_bytes).hexdigest() != kf.sha256:
                raise JsonRpcError(-32002, "Invalid keyframe object integrity")
            return (
                {
                    "contents": [
                        {
                            "uri": uri,
                            "mimeType": "image/png",
                            "blob": base64.b64encode(png_bytes).decode("ascii"),
                        }
                    ]
                },
                extra_headers,
            )
        fmt = "md" if subpath == "protocol.md" else "json"
        rendered, mime = render_export(export_data(db, rec), fmt)
        text_body = rendered.decode("utf-8") if isinstance(rendered, bytes) else str(rendered)
        return (
            {
                "contents": [
                    {
                        "uri": uri,
                        "mimeType": mime.split(";", 1)[0],
                        "text": text_body,
                    }
                ]
            },
            extra_headers,
        )

    if method == "prompts/list":
        return {"prompts": MCP_PROMPTS}, extra_headers

    if method == "prompts/get":
        p_name = str(params.get("name") or "").strip()
        p_args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        rec_id = str(p_args.get("recording_id") or "").strip()
        if p_name == "meeting_followup":
            return (
                {
                    "description": "Follow-up summary with decisions and action items",
                    "messages": [
                        {
                            "role": "user",
                            "content": {
                                "type": "text",
                                "text": (
                                    f"Call `get_recording` and `get_transcript` for `{rec_id}`. "
                                    "Produce a concise follow-up note with: (1) key decisions "
                                    "attributed to exact bound speakers, (2) concrete action items "
                                    "with owners, and (3) open questions or off-the-record "
                                    "`pause_windows`."
                                ),
                            },
                        }
                    ],
                },
                extra_headers,
            )
        if p_name == "decision_audit":
            topic = str(p_args.get("topic") or "").strip()
            topic_clause = f" focusing on '{topic}'" if topic else ""
            return (
                {
                    "description": "Verbatim decision audit with timestamps",
                    "messages": [
                        {
                            "role": "user",
                            "content": {
                                "type": "text",
                                "text": (
                                    f"Inspect `{rec_id}` using `get_transcript`{topic_clause}. "
                                    "Quote exact verbatim statements with `[MM:SS]` timestamps and "
                                    "bound speaker names, noting any `attribution_unknown` or "
                                    "`pause_windows`."
                                ),
                            },
                        }
                    ],
                },
                extra_headers,
            )
        raise JsonRpcError(-32602, f"Unknown prompt: {p_name}")

    raise JsonRpcError(-32601, f"Method not found: {method}")


def handle_mcp_post(
    request: Request,
    db: Session,
    raw_body: bytes,
    authorization: str | None,
) -> Response:
    validate_mcp_origin(request)
    headers = mcp_cors_headers(request)

    try:
        ctx = authenticate_mcp_request(request, db, authorization)
    except McpAuthError as exc:
        headers["WWW-Authenticate"] = exc.www_authenticate
        return JSONResponse(
            {"error": "unauthorized", "error_description": exc.detail},
            status_code=exc.status_code,
            headers=headers,
        )

    proto_hdr = (request.headers.get("mcp-protocol-version") or "").strip()
    if proto_hdr and proto_hdr not in SUPPORTED_PROTOCOL_VERSIONS:
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32600,
                    "message": f"Unsupported MCP-Protocol-Version: {proto_hdr}",
                },
            },
            status_code=400,
            headers=headers,
        )

    session_hdr = (request.headers.get("mcp-session-id") or "").strip()
    if session_hdr and not _verify_mcp_session_id(session_hdr, ctx.principal):
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32001, "message": "Invalid or expired Mcp-Session-Id"},
            },
            status_code=404,
            headers=headers,
        )

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Parse error"},
            },
            status_code=400,
            headers=headers,
        )

    is_batch = isinstance(payload, list)
    messages = payload if is_batch else [payload]
    if not messages:
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32600, "message": "Invalid Request"},
            },
            status_code=400,
            headers=headers,
        )

    responses: list[dict[str, Any]] = []
    for item in messages:
        if not isinstance(item, dict) or item.get("jsonrpc") != "2.0":
            responses.append(
                {
                    "jsonrpc": "2.0",
                    "id": item.get("id") if isinstance(item, dict) else None,
                    "error": {"code": -32600, "message": "Invalid JSON-RPC 2.0 message"},
                }
            )
            continue

        has_id = "id" in item
        msg_id = item.get("id")
        method = item.get("method")

        # JSON-RPC notifications or client responses carry no "id" (or no "method")
        if not has_id or method is None:
            continue

        if not isinstance(method, str):
            responses.append(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32600, "message": "Invalid method name"},
                }
            )
            continue

        raw_params = item.get("params")
        if raw_params is None:
            params: dict[str, Any] = {}
        elif isinstance(raw_params, dict):
            params = raw_params
        else:
            responses.append(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32602, "message": "params must be an object"},
                }
            )
            continue

        try:
            result, extra_hdrs = _dispatch_rpc_method(request, db, ctx, method, params)
            headers.update(extra_hdrs)
            responses.append({"jsonrpc": "2.0", "id": msg_id, "result": result})
        except McpAuthError as exc:
            headers["WWW-Authenticate"] = exc.www_authenticate
            return JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32003, "message": exc.detail},
                },
                status_code=exc.status_code,
                headers=headers,
            )
        except JsonRpcError as exc:
            err_obj: dict[str, Any] = {"code": exc.code, "message": exc.message}
            if exc.data is not None:
                err_obj["data"] = exc.data
            responses.append({"jsonrpc": "2.0", "id": msg_id, "error": err_obj})

    if not responses:
        return Response(status_code=202, headers=headers)

    body_out: Any = responses if is_batch else responses[0]
    return JSONResponse(body_out, status_code=200, headers=headers)


def handle_mcp_get(
    request: Request,
    db: Session,
    authorization: str | None,
) -> Response:
    validate_mcp_origin(request)
    headers = mcp_cors_headers(request)
    try:
        authenticate_mcp_request(request, db, authorization)
    except McpAuthError as exc:
        headers["WWW-Authenticate"] = exc.www_authenticate
        return JSONResponse(
            {"error": "unauthorized", "error_description": exc.detail},
            status_code=exc.status_code,
            headers=headers,
        )
    headers["Allow"] = "POST, DELETE, OPTIONS"
    return Response(status_code=405, headers=headers)


def handle_mcp_delete(
    request: Request,
    db: Session,
    authorization: str | None,
) -> Response:
    validate_mcp_origin(request)
    headers = mcp_cors_headers(request)
    try:
        authenticate_mcp_request(request, db, authorization)
    except McpAuthError as exc:
        headers["WWW-Authenticate"] = exc.www_authenticate
        return JSONResponse(
            {"error": "unauthorized", "error_description": exc.detail},
            status_code=exc.status_code,
            headers=headers,
        )
    return Response(status_code=204, headers=headers)
