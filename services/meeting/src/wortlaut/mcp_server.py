"""Authenticated MCP Streamable HTTP server built on the official `mcp` Python SDK."""

import asyncio
import contextvars
import hashlib
import hmac
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import mcp.types as mcp_types
from botocore.exceptions import ClientError
from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.server.streamable_http import (
    SUPPORTED_PROTOCOL_VERSIONS as SDK_PROTOCOL_VERSIONS,
)
from mcp.shared.exceptions import McpError
from pydantic import AnyUrl, TypeAdapter, ValidationError
from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from wortlaut.calendar_oauth import (
    publish_protocol_link_to_calendar_events,
    toggle_synced_event,
)
from wortlaut.domain import (
    apply_protocol_metadata_fields,
    apply_recordings_search_filters,
    cancel_recording_and_unlink_calendar,
    query_calendar_overview,
)
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
from wortlaut.models import Recording, RecordingKeyframe
from wortlaut.oidc import Principal, can_access_recording, user_recording_access_predicate
from wortlaut.processing import is_keyframe_opted_out
from wortlaut.settings import derive_subkey, get_settings
from wortlaut.storage import ObjectConflict, get_storage
from wortlaut.validation import normalize_meeting_url

SUPPORTED_PROTOCOL_VERSIONS: tuple[str, ...] = tuple(
    dict.fromkeys(
        [
            *SDK_PROTOCOL_VERSIONS,
            "2025-11-25",
            "2025-06-18",
            "2025-03-26",
            "2024-11-05",
        ]
    )
)
DEFAULT_PROTOCOL_VERSION = "2025-06-18"
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

_JSONRPC_ADAPTER: TypeAdapter[mcp_types.JSONRPCMessage] = TypeAdapter(mcp_types.JSONRPCMessage)
_CLIENT_REQ_ADAPTER: TypeAdapter[mcp_types.ClientRequest] = TypeAdapter(mcp_types.ClientRequest)


@dataclass(frozen=True)
class _McpCallScope:
    request: Request
    db: Session
    auth: McpAuthContext


_ACTIVE_CALL_SCOPE: contextvars.ContextVar[_McpCallScope] = contextvars.ContextVar(
    "wortlaut_mcp_call_scope"
)

mcp_app = Server("wortlaut")


def _principal_binding(principal: Principal) -> str:
    return f"{principal.kind}:{principal.sub or ''}:{(principal.email or '').lower()}"


def _mint_mcp_session_id(principal: Principal) -> str:
    sid = uuid.uuid4().hex
    subkey = derive_subkey(b"mcp-session-v1")
    msg = f"wortlaut-mcp-session\0{sid}\0{_principal_binding(principal)}".encode()
    sig = hmac.new(subkey, msg, hashlib.sha256).hexdigest()[:32]
    return f"{sid}.{sig}"


def _verify_mcp_session_id(session_id: str, principal: Principal) -> bool:
    if "." not in session_id:
        return False
    sid, sig = session_id.split(".", 1)
    if not sid or len(sid) > 64 or not sig:
        return False
    subkey = derive_subkey(b"mcp-session-v1")
    msg = f"wortlaut-mcp-session\0{sid}\0{_principal_binding(principal)}".encode()
    expected = hmac.new(subkey, msg, hashlib.sha256).hexdigest()[:32]
    return secrets.compare_digest(sig, expected)


def _is_allowed_mcp_origin(request: Request, origin_hdr: str) -> bool:
    parsed = urlsplit(origin_hdr)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    if not scheme or not host:
        return False
    norm_origin = origin_hdr.rstrip("/").lower()
    expected = public_origin(request).rstrip("/").lower()
    if norm_origin == expected:
        return True
    settings = get_settings()
    allowed_cfg = {
        o.strip().rstrip("/").lower() for o in settings.mcp_allowed_origins if o and o.strip()
    }
    if norm_origin in allowed_cfg:
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


def _tool_spec(
    name: str,
    *,
    required_scope: str,
    title: str,
    description: str,
    input_schema: dict[str, Any],
    read_only: bool,
    destructive: bool = False,
    idempotent: bool = True,
) -> tuple[str, mcp_types.Tool]:
    return (
        required_scope,
        mcp_types.Tool(
            name=name,
            description=description,
            inputSchema=input_schema,
            annotations=mcp_types.ToolAnnotations(
                title=title,
                readOnlyHint=read_only,
                destructiveHint=destructive,
                idempotentHint=idempotent,
            ),
        ),
    )


_SCOPED_TOOLS: list[tuple[str, mcp_types.Tool]] = [
    _tool_spec(
        "list_recordings",
        required_scope="mcp:read",
        title="List & Search Recordings",
        description=(
            "List or search meeting recordings accessible to the authenticated user. "
            "Searches titles, bound speaker names, and full transcript text."
        ),
        read_only=True,
        input_schema={
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
    ),
    _tool_spec(
        "get_recording",
        required_scope="mcp:read",
        title="Get Recording Details & Summary",
        description=(
            "Retrieve metadata, live capture/pause status, executive summary, action items, notes, "
            "speaker list, screen-share keyframes, off-the-record pause windows, and raw-audio "
            "retention availability for a recording."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "UUID of the recording."}
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "get_transcript",
        required_scope="mcp:read",
        title="Read Speaker-Attributed Transcript",
        description=(
            "Read speaker-attributed verbatim transcript segments, settled screen-share keyframes "
            "(wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png), and "
            "off-the-record pause windows for a recording, with optional speaker, keyword, and "
            "timestamp filters plus isolated audio snippets."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "UUID of the recording."},
                "speaker": {
                    "type": "string",
                    "description": (
                        "Optional case-insensitive substring filter on speaker name or speaker_id."
                    ),
                },
                "query": {
                    "type": "string",
                    "description": "Optional case-insensitive substring filter on segment text.",
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
    ),
    _tool_spec(
        "export_protocol",
        required_scope="mcp:read",
        title="Export Formatted Protocol",
        description=(
            "Render the formatted meeting protocol in Markdown (md), plain text (txt), "
            "WebVTT (vtt), or JSON."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "UUID of the recording."},
                "format": {
                    "type": "string",
                    "enum": ["md", "txt", "vtt", "json"],
                    "default": "md",
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "list_calendar_events",
        required_scope="mcp:read",
        title="List Calendar Events",
        description=(
            "List the authenticated user's connected Google/Microsoft calendars and upcoming "
            "(or recent) synced calendar meetings and .ics invitations."
        ),
        read_only=True,
        input_schema={
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
    ),
    _tool_spec(
        "schedule_recording",
        required_scope="mcp:write",
        title="Schedule or Start Recording",
        description=(
            "Schedule a future recording or start an immediate ad-hoc recording for a "
            "Google Meet, Microsoft Teams, Cisco Webex, or Zoom URL."
        ),
        read_only=False,
        idempotent=False,
        input_schema={
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
                    "description": "Optional Qwen3-ASR language ('auto' or name/ISO).",
                },
            },
            "required": ["meeting_url"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "cancel_recording",
        required_scope="mcp:write",
        title="Stop or Cancel Recording",
        description="Stop an active recording or cancel a scheduled recording.",
        read_only=False,
        destructive=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the recording to stop or cancel.",
                }
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "update_protocol",
        required_scope="mcp:write",
        title="Update Protocol Metadata & Replacements",
        description=(
            "Update a recording's title, transcription language (all 30 Qwen3-ASR languages or "
            "'auto'), human meeting notes, speaker display-name overrides, or glossary term "
            "replacements."
        ),
        read_only=False,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "UUID of the recording."},
                "title": {"type": "string", "description": "Optional updated meeting title."},
                "language": {
                    "type": "string",
                    "description": (
                        "Optional Qwen3-ASR transcription language ('auto' for all 30 languages, "
                        f"or any of: {', '.join(QWEN_ASR_LANGUAGES)})."
                    ),
                },
                "notes": {"type": "string", "description": "Optional Markdown meeting notes."},
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
    ),
    _tool_spec(
        "generate_summary",
        required_scope="mcp:write",
        title="Generate Local AI Summary",
        description=(
            "Generate or refresh the structured executive summary, topics, and action items "
            "for a completed recording using the local self-hosted Ollama model."
        ),
        read_only=False,
        idempotent=False,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "UUID of the recording."}
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "toggle_calendar_event_recording",
        required_scope="mcp:write",
        title="Toggle Calendar Event Auto-Record",
        description=(
            "Enable or disable automatic recording for a synced Google Calendar or "
            "Microsoft 365 event."
        ),
        read_only=False,
        input_schema={
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
    ),
    _tool_spec(
        "publish_calendar_protocol_link",
        required_scope="mcp:write",
        title="Write Protocol Link to Calendar Invite",
        description=(
            "Write the scoped read-only protocol link back into the matching Google Calendar "
            "or Microsoft 365 invite."
        ),
        read_only=False,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {
                    "type": "string",
                    "description": "UUID of the completed recording.",
                }
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
]

_TOOL_BY_NAME: dict[str, tuple[str, mcp_types.Tool]] = {
    tool.name: (scope, tool) for scope, tool in _SCOPED_TOOLS
}

_PROMPTS: list[mcp_types.Prompt] = [
    mcp_types.Prompt(
        name="meeting_followup",
        description=(
            "Draft a concise follow-up summary with speaker-attributed decisions and action items."
        ),
        arguments=[
            mcp_types.PromptArgument(
                name="recording_id",
                description="UUID of the recording to summarize.",
                required=True,
            )
        ],
    ),
    mcp_types.Prompt(
        name="decision_audit",
        description=(
            "Verify exact verbatim quotes and timestamps for technical or product decisions "
            "in a meeting."
        ),
        arguments=[
            mcp_types.PromptArgument(
                name="recording_id",
                description="UUID of the recording to audit.",
                required=True,
            ),
            mcp_types.PromptArgument(
                name="topic",
                description="Specific topic or question to verify.",
                required=False,
            ),
        ],
    ),
]


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


def _tool_result(
    text_body: str, structured: dict[str, Any] | None = None
) -> mcp_types.CallToolResult:
    return mcp_types.CallToolResult(
        content=[mcp_types.TextContent(type="text", text=text_body)],
        structuredContent=structured,
        isError=False,
    )


def _tool_error(message: str) -> mcp_types.CallToolResult:
    return mcp_types.CallToolResult(
        content=[mcp_types.TextContent(type="text", text=f"Error: {message}")],
        isError=True,
    )


def _mcp_keyframe_item(rec_id: uuid.UUID, kf: dict[str, Any]) -> dict[str, Any]:
    return {
        **kf,
        "resource_uri": f"wortlaut://recordings/{rec_id}/keyframes/{kf['id']}.png",
    }


def _execute_tool_sync(
    scope: _McpCallScope,
    name: str,
    arguments: dict[str, Any],
) -> mcp_types.CallToolResult:
    origin = public_origin(scope.request)
    db = scope.db
    principal = scope.auth.principal

    if name == "list_recordings":
        limit = max(1, min(50, _parse_int(arguments.get("limit"), 20, "limit")))
        q_str = str(arguments.get("query") or "").strip()
        provider = str(arguments["provider"]) if arguments.get("provider") else None
        participation = str(arguments.get("participation") or "").strip() or None
        processing = str(arguments.get("processing") or "").strip() or None

        stmt, empty_for_principal = apply_recordings_search_filters(
            select(Recording).where(Recording.metadata_deleted_at.is_(None)),
            principal=principal,
            provider=provider,
            participation=participation,
            processing=processing,
            q=q_str or None,
        )
        if empty_for_principal:
            return _tool_result("No recordings found.", {"items": [], "count": 0})
        rows = db.scalars(
            stmt.order_by(desc(Recording.starts_at), desc(Recording.id)).limit(limit)
        ).all()
        items = []
        lines = []
        for rec in rows:
            meta = rec.protocol_meta if isinstance(rec.protocol_meta, dict) else {}
            item = {
                "id": str(rec.id),
                "title": rec.title or f"{rec.provider} meeting",
                "provider": rec.provider,
                "starts_at": rec.starts_at.isoformat(),
                "ends_at": rec.ends_at.isoformat(),
                "participation": rec.participation,
                "processing": rec.processing,
                "summary_available": bool(meta.get("summary")),
                "audio_snippets_available": rec.audio_deleted_at is None,
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
            keyframes_out = [_mcp_keyframe_item(rec.id, kf) for kf in (exp.get("keyframes") or [])]
            pause_windows_out = list(exp.get("pause_windows") or [])
            speakers = sorted(
                {str(s.get("speaker_label") or s.get("speaker_name") or "Unknown") for s in segs}
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
        include_past = _parse_bool(arguments.get("include_past"), "include_past", default=False)
        limit = max(1, min(100, _parse_int(arguments.get("limit"), 30, "limit")))
        overview = query_calendar_overview(
            db,
            principal,
            datetime.now(UTC),
            include_past=include_past,
            synced_upcoming_limit=limit,
            synced_past_limit=0,
            ics_limit=limit,
            match_unlinked_urls=False,
        )
        payload = {
            "connections": overview["connections"],
            "synced_events": overview["synced_events"],
            "ics_events": overview["events"][:limit],
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
        _get_accessible_recording(db, principal, rec_id, for_update=False)
        rec = cancel_recording_and_unlink_calendar(db, rec_id, datetime.now(UTC))
        if rec is None:
            return _tool_error(f"Recording {rec_id} not found.")
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
        meta = dict(rec.protocol_meta or {})
        try:
            meta = apply_protocol_metadata_fields(
                rec,
                meta,
                title=arguments.get("title"),
                has_title="title" in arguments and arguments["title"] is not None,
                language=arguments.get("language"),
                has_language="language" in arguments and arguments["language"] is not None,
                notes=arguments.get("notes"),
                has_notes="notes" in arguments and arguments["notes"] is not None,
                speaker_overrides=(
                    arguments["speaker_overrides"]
                    if isinstance(arguments.get("speaker_overrides"), dict)
                    else None
                ),
                term_replacements=(
                    arguments["term_replacements"]
                    if isinstance(arguments.get("term_replacements"), dict)
                    else None
                ),
            )
        except ValueError as exc:
            return _tool_error(str(exc))
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
            fresh_rec = db.get(Recording, rec.id)
            if fresh_rec is not None:
                publish_protocol_link_to_calendar_events(db, fresh_rec)
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
        rec = _get_accessible_recording(db, principal, rec_id)
        if rec.processing != "completed":
            return _tool_error(f"Recording processing is '{rec.processing}' (must be 'completed').")
        res = publish_protocol_link_to_calendar_events(db, rec, force_empty_audio=True)
        db.commit()
        if res.get("status") in ("no_matching_calendar_event", "error"):
            return _tool_error(f"Calendar update failed: {res.get('error') or res.get('status')}")
        return _tool_result(json.dumps(res, ensure_ascii=False, indent=2), res)

    raise McpError(
        mcp_types.ErrorData(code=mcp_types.INVALID_PARAMS, message=f"Unknown tool: {name}")
    )


@mcp_app.list_tools()
async def _sdk_list_tools() -> list[mcp_types.Tool]:
    scope = _ACTIVE_CALL_SCOPE.get()
    return [tool for req_scope, tool in _SCOPED_TOOLS if req_scope in scope.auth.scopes]


@mcp_app.call_tool(validate_input=False)
async def _sdk_call_tool(name: str, arguments: dict[str, Any]) -> mcp_types.CallToolResult:
    scope = _ACTIVE_CALL_SCOPE.get()
    spec = _TOOL_BY_NAME.get(name)
    if spec is None:
        raise McpError(
            mcp_types.ErrorData(code=mcp_types.INVALID_PARAMS, message=f"Unknown tool: {name}")
        )
    req_scope, _ = spec
    if req_scope not in scope.auth.scopes:
        origin = public_origin(scope.request)
        raise McpAuthError(
            403,
            f"Insufficient scope: {req_scope} is required for {name}",
            www_authenticate=mcp_www_authenticate(
                origin,
                error="insufficient_scope",
                error_description=f"Tool {name} requires {req_scope}",
            ),
        )
    try:
        return _execute_tool_sync(scope, name, arguments)
    except (ValueError, LookupError) as exc:
        return _tool_error(str(exc))


@mcp_app.list_resources()
async def _sdk_list_resources() -> list[mcp_types.Resource]:
    scope = _ACTIVE_CALL_SCOPE.get()
    if "mcp:read" not in scope.auth.scopes:
        origin = public_origin(scope.request)
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
    if not scope.auth.principal.is_admin:
        pred = user_recording_access_predicate(scope.auth.principal)
        if pred is False:
            return []
        stmt = stmt.where(pred)
    recs = scope.db.scalars(stmt.order_by(desc(Recording.starts_at)).limit(25)).all()
    return [
        mcp_types.Resource(
            uri=AnyUrl(f"wortlaut://recordings/{r.id}/protocol.md"),
            name=r.title or f"{r.provider} ({r.starts_at.strftime('%Y-%m-%d %H:%M UTC')})",
            description=f"Markdown protocol for {r.provider} meeting on {r.starts_at.isoformat()}",
            mimeType="text/markdown",
        )
        for r in recs
    ]


@mcp_app.list_resource_templates()
async def _sdk_list_resource_templates() -> list[mcp_types.ResourceTemplate]:
    return [
        mcp_types.ResourceTemplate(
            uriTemplate="wortlaut://recordings/{recording_id}/protocol.md",
            name="Meeting Protocol (Markdown)",
            description="Formatted speaker-attributed meeting protocol in Markdown.",
            mimeType="text/markdown",
        ),
        mcp_types.ResourceTemplate(
            uriTemplate="wortlaut://recordings/{recording_id}/transcript.json",
            name="Meeting Transcript (JSON)",
            description="Structured speaker-attributed transcript segments.",
            mimeType="application/json",
        ),
        mcp_types.ResourceTemplate(
            uriTemplate="wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png",
            name="Screen-Share Slide Keyframe (PNG)",
            description="Settled static PNG snapshot captured from an active screen share.",
            mimeType="image/png",
        ),
    ]


@mcp_app.read_resource()
async def _sdk_read_resource(uri_obj: AnyUrl) -> list[ReadResourceContents]:
    scope = _ACTIVE_CALL_SCOPE.get()
    if "mcp:read" not in scope.auth.scopes:
        origin = public_origin(scope.request)
        raise McpAuthError(
            403,
            "Insufficient scope: mcp:read is required",
            www_authenticate=mcp_www_authenticate(origin, error="insufficient_scope"),
        )
    uri = str(uri_obj)
    prefix = "wortlaut://recordings/"
    if not uri.startswith(prefix):
        raise McpError(
            mcp_types.ErrorData(
                code=mcp_types.INVALID_PARAMS, message=f"Unsupported resource URI: {uri}"
            )
        )
    rest = uri.removeprefix(prefix)
    parts = rest.split("/", 1)
    if len(parts) != 2:
        raise McpError(
            mcp_types.ErrorData(
                code=mcp_types.INVALID_PARAMS, message=f"Invalid wortlaut resource path: {uri}"
            )
        )
    subpath = parts[1]
    is_keyframe_uri = (
        subpath.startswith("keyframes/")
        and subpath.endswith(".png")
        and "/" not in subpath.removeprefix("keyframes/")
    )
    if subpath not in ("protocol.md", "transcript.json") and not is_keyframe_uri:
        raise McpError(
            mcp_types.ErrorData(
                code=mcp_types.INVALID_PARAMS, message=f"Invalid wortlaut resource path: {uri}"
            )
        )
    try:
        rec_id = _parse_uuid(parts[0])
        rec = _get_accessible_recording(scope.db, scope.auth.principal, rec_id)
    except (ValueError, LookupError) as exc:
        raise McpError(mcp_types.ErrorData(code=-32002, message=str(exc))) from None
    if rec.transcript_deleted_at is not None:
        raise McpError(
            mcp_types.ErrorData(code=-32002, message="Transcript retention expired")
        )
    if is_keyframe_uri:
        raw_kf_id = subpath.removeprefix("keyframes/").removesuffix(".png")
        try:
            kf_id = _parse_uuid(raw_kf_id)
        except ValueError as exc:
            raise McpError(mcp_types.ErrorData(code=-32002, message=str(exc))) from None
        kf = scope.db.get(RecordingKeyframe, kf_id)
        if (
            kf is None
            or kf.recording_id != rec.id
            or kf.deleted_at is not None
            or not kf.object_key
            or is_keyframe_opted_out(scope.db, rec, kf)
        ):
            raise McpError(mcp_types.ErrorData(code=-32002, message="Keyframe not found"))
        try:
            png_bytes = get_storage().read(kf.object_key)
        except (ClientError, ObjectConflict):
            raise McpError(mcp_types.ErrorData(code=-32002, message="Keyframe not found")) from None
        if hashlib.sha256(png_bytes).hexdigest() != kf.sha256:
            raise McpError(
                mcp_types.ErrorData(code=-32002, message="Invalid keyframe object integrity")
            )
        return [ReadResourceContents(content=png_bytes, mime_type="image/png")]
    fmt = "md" if subpath == "protocol.md" else "json"
    rendered, mime = render_export(export_data(scope.db, rec), fmt)
    text_body = rendered.decode("utf-8") if isinstance(rendered, bytes) else str(rendered)
    return [ReadResourceContents(content=text_body, mime_type=mime.split(";", 1)[0])]


@mcp_app.list_prompts()
async def _sdk_list_prompts() -> list[mcp_types.Prompt]:
    return _PROMPTS


@mcp_app.get_prompt()
async def _sdk_get_prompt(
    name: str, arguments: dict[str, str] | None
) -> mcp_types.GetPromptResult:
    p_args = arguments or {}
    rec_id = str(p_args.get("recording_id") or "").strip()
    if name == "meeting_followup":
        return mcp_types.GetPromptResult(
            description="Follow-up summary with decisions and action items",
            messages=[
                mcp_types.PromptMessage(
                    role="user",
                    content=mcp_types.TextContent(
                        type="text",
                        text=(
                            f"Call `get_recording` and `get_transcript` for `{rec_id}`. "
                            "Produce a concise follow-up note with: (1) key decisions "
                            "attributed to exact bound speakers, (2) concrete action items "
                            "with owners, and (3) open questions or off-the-record "
                            "`pause_windows`."
                        ),
                    ),
                )
            ],
        )
    if name == "decision_audit":
        topic = str(p_args.get("topic") or "").strip()
        topic_clause = f" focusing on '{topic}'" if topic else ""
        return mcp_types.GetPromptResult(
            description="Verbatim decision audit with timestamps",
            messages=[
                mcp_types.PromptMessage(
                    role="user",
                    content=mcp_types.TextContent(
                        type="text",
                        text=(
                            f"Inspect `{rec_id}` using `get_transcript`{topic_clause}. "
                            "Quote exact verbatim statements with `[MM:SS]` timestamps and "
                            "bound speaker names, noting any `attribution_unknown` or "
                            "`pause_windows`."
                        ),
                    ),
                )
            ],
        )
    raise McpError(
        mcp_types.ErrorData(code=mcp_types.INVALID_PARAMS, message=f"Unknown prompt: {name}")
    )


async def _dispatch_via_mcp_sdk(
    scope: _McpCallScope,
    req: mcp_types.JSONRPCRequest,
) -> tuple[mcp_types.JSONRPCResponse | mcp_types.JSONRPCError, dict[str, str]]:
    extra_headers: dict[str, str] = {}
    params = dict(req.params or {})

    if req.method == "initialize":
        client_ver = str(params.get("protocolVersion") or "").strip()
        negotiated = (
            client_ver if client_ver in SUPPORTED_PROTOCOL_VERSIONS else DEFAULT_PROTOCOL_VERSION
        )
        session_id = _mint_mcp_session_id(scope.auth.principal)
        extra_headers["Mcp-Session-Id"] = session_id
        extra_headers["MCP-Protocol-Version"] = negotiated
        init_res = mcp_types.InitializeResult(
            protocolVersion=negotiated,
            capabilities=mcp_types.ServerCapabilities(
                tools=mcp_types.ToolsCapability(listChanged=False),
                resources=mcp_types.ResourcesCapability(subscribe=False, listChanged=False),
                prompts=mcp_types.PromptsCapability(listChanged=False),
            ),
            serverInfo=mcp_types.Implementation(
                name=get_settings().assistant_name,
                version="0.1.0",
            ),
            instructions=(
                "wortlaut provides pre-mix WebRTC speaker-isolated meeting transcripts "
                "(Google Meet, Microsoft Teams, Cisco Webex, Zoom) scoped to the authenticated "
                "user. Prefer get_transcript with pagination or filters for verbatim speaker "
                "statements, off-the-record pause_windows (#pause / #resume), and settled "
                "screen-share keyframes (readable as image/png via "
                "wortlaut://recordings/{id}/keyframes/{kf_id}.png)."
            ),
        )
        return (
            mcp_types.JSONRPCResponse(
                jsonrpc="2.0",
                id=req.id,
                result=init_res.model_dump(by_alias=True, mode="json", exclude_none=True),
            ),
            extra_headers,
        )

    try:
        typed_req = _CLIENT_REQ_ADAPTER.validate_python(
            {"method": req.method, "params": params or None}
        ).root
    except ValidationError as exc:
        known_methods = {
            "ping",
            "tools/list",
            "tools/call",
            "resources/list",
            "resources/templates/list",
            "resources/read",
            "prompts/list",
            "prompts/get",
        }
        code = (
            mcp_types.INVALID_PARAMS
            if req.method in known_methods
            else mcp_types.METHOD_NOT_FOUND
        )
        msg = (
            exc.errors()[0].get("msg", "Invalid parameters")
            if code == mcp_types.INVALID_PARAMS
            else f"Method not found: {req.method}"
        )
        return (
            mcp_types.JSONRPCError(
                jsonrpc="2.0",
                id=req.id,
                error=mcp_types.ErrorData(code=code, message=msg),
            ),
            extra_headers,
        )

    handler = mcp_app.request_handlers.get(type(typed_req))
    if handler is None:
        return (
            mcp_types.JSONRPCError(
                jsonrpc="2.0",
                id=req.id,
                error=mcp_types.ErrorData(
                    code=mcp_types.METHOD_NOT_FOUND,
                    message=f"Method not found: {req.method}",
                ),
            ),
            extra_headers,
        )

    tok = _ACTIVE_CALL_SCOPE.set(scope)
    try:
        if isinstance(typed_req, mcp_types.CallToolRequest):
            tool_name = typed_req.params.name
            spec = _TOOL_BY_NAME.get(tool_name)
            if spec is None:
                return (
                    mcp_types.JSONRPCError(
                        jsonrpc="2.0",
                        id=req.id,
                        error=mcp_types.ErrorData(
                            code=mcp_types.INVALID_PARAMS,
                            message=f"Unknown tool: {tool_name}",
                        ),
                    ),
                    extra_headers,
                )
            req_scope, _ = spec
            if req_scope not in scope.auth.scopes:
                origin = public_origin(scope.request)
                raise McpAuthError(
                    403,
                    f"Insufficient scope: {req_scope} is required for {tool_name}",
                    www_authenticate=mcp_www_authenticate(
                        origin,
                        error="insufficient_scope",
                        error_description=f"Tool {tool_name} requires {req_scope}",
                    ),
                )
            mcp_app._tool_cache.update({tool.name: tool for _, tool in _SCOPED_TOOLS})
        server_result = await handler(typed_req)
    except McpError as exc:
        return (
            mcp_types.JSONRPCError(jsonrpc="2.0", id=req.id, error=exc.error),
            extra_headers,
        )
    finally:
        _ACTIVE_CALL_SCOPE.reset(tok)

    return (
        mcp_types.JSONRPCResponse(
            jsonrpc="2.0",
            id=req.id,
            result=server_result.root.model_dump(by_alias=True, mode="json", exclude_none=True),
        ),
        extra_headers,
    )


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
            mcp_types.JSONRPCError(
                jsonrpc="2.0",
                id=0,
                error=mcp_types.ErrorData(
                    code=mcp_types.INVALID_REQUEST,
                    message=f"Unsupported MCP-Protocol-Version: {proto_hdr}",
                ),
            ).model_dump(by_alias=True, mode="json", exclude_none=True),
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
                "error": {"code": mcp_types.PARSE_ERROR, "message": "Parse error"},
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
                "error": {"code": mcp_types.INVALID_REQUEST, "message": "Invalid Request"},
            },
            status_code=400,
            headers=headers,
        )

    scope = _McpCallScope(request=request, db=db, auth=ctx)
    responses: list[dict[str, Any]] = []

    async def _run_batch() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in messages:
            if not isinstance(item, dict) or item.get("jsonrpc") != "2.0":
                out.append(
                    {
                        "jsonrpc": "2.0",
                        "id": item.get("id") if isinstance(item, dict) else None,
                        "error": {
                            "code": mcp_types.INVALID_REQUEST,
                            "message": "Invalid JSON-RPC 2.0 message",
                        },
                    }
                )
                continue
            if "id" not in item or item.get("method") is None:
                continue
            raw_params = item.get("params")
            if raw_params is not None and not isinstance(raw_params, dict):
                out.append(
                    {
                        "jsonrpc": "2.0",
                        "id": item.get("id"),
                        "error": {
                            "code": mcp_types.INVALID_PARAMS,
                            "message": "params must be an object",
                        },
                    }
                )
                continue
            try:
                parsed_msg = _JSONRPC_ADAPTER.validate_python(item).root
            except ValidationError:
                out.append(
                    {
                        "jsonrpc": "2.0",
                        "id": item.get("id"),
                        "error": {
                            "code": mcp_types.INVALID_REQUEST,
                            "message": "Invalid JSON-RPC 2.0 request",
                        },
                    }
                )
                continue
            if not isinstance(parsed_msg, mcp_types.JSONRPCRequest):
                continue
            rpc_out, extra_hdrs = await _dispatch_via_mcp_sdk(scope, parsed_msg)
            headers.update(extra_hdrs)
            out.append(rpc_out.model_dump(by_alias=True, mode="json", exclude_none=True))
        return out

    try:
        responses = asyncio.run(_run_batch())
    except McpAuthError as exc:
        headers["WWW-Authenticate"] = exc.www_authenticate
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": messages[0].get("id") if isinstance(messages[0], dict) else None,
                "error": {"code": -32003, "message": exc.detail},
            },
            status_code=exc.status_code,
            headers=headers,
        )

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
