"""Authenticated MCP Streamable HTTP server built on the official `mcp` Python SDK."""

import asyncio
import base64
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
from sqlalchemy import and_, desc, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from wortlaut.domain import (
    apply_protocol_metadata_fields,
    apply_recordings_search_filters,
    cancel_recording_and_unlink_calendar,
    parse_date_bound,
)
from wortlaut.exports import (
    export_data,
    render_export,
    resolve_citation_timestamp,
    short_timestamp,
    wall_clock_time_de,
)
from wortlaut.ingest import capacity_reached
from wortlaut.languages import (
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
from wortlaut.rag import (
    VALID_PROVIDERS,
    VALID_SEARCH_KINDS,
    invalidate_recording_rag_index,
    search_protocol_chunks,
)
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
    open_world: bool = False,
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
                openWorldHint=open_world,
            ),
        ),
    )


_CITATION_ITEM_PROPS: dict[str, Any] = {
    "timestamp": {"type": "string"},
    "offset_seconds": {"type": "number"},
}

_SCOPED_TOOLS: list[tuple[str, mcp_types.Tool]] = [
    _tool_spec(
        "list_recordings",
        required_scope="mcp:read",
        title="List Recordings",
        description=(
            "List accessible meetings chronologically by date range (since/until), status, or "
            "provider. For keyword, speaker, or conceptual search across protocols, use "
            "search_protocols."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "since": {
                    "type": "string",
                    "description": "Lower date/time bound (YYYY-MM-DD or ISO-8601).",
                },
                "until": {
                    "type": "string",
                    "description": "Upper date/time bound (YYYY-MM-DD or ISO-8601).",
                },
                "status": {
                    "type": "string",
                    "enum": ["upcoming", "active", "completed", "failed"],
                },
                "provider": {
                    "type": "string",
                    "enum": list(VALID_PROVIDERS),
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
            },
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "search_protocols",
        required_scope="mcp:read",
        title="Search Meeting Protocols",
        description=(
            "Hybrid semantic + full-text search across accessible completed meeting protocols "
            "(decisions, action items, summaries, topics, notes, slides, and speaker-attributed "
            "transcripts). Returns ranked passages with recording UUIDs and [HH:MM:SS / +Ns] "
            "citations."
        ),
        read_only=True,
        idempotent=True,
        open_world=False,
        input_schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language question, topic, or exact identifier.",
                },
                "recording_id": {
                    "type": "string",
                    "description": "Optional recording UUID to restrict search to one meeting.",
                },
                "speaker": {
                    "type": "string",
                    "description": "Case-insensitive speaker or owner filter.",
                },
                "kind": {
                    "type": "string",
                    "enum": list(VALID_SEARCH_KINDS),
                    "default": "all",
                },
                "since": {
                    "type": "string",
                    "description": "Lower date/time bound (YYYY-MM-DD or ISO-8601).",
                },
                "until": {
                    "type": "string",
                    "description": "Upper date/time bound (YYYY-MM-DD or ISO-8601).",
                },
                "provider": {
                    "type": "string",
                    "enum": list(VALID_PROVIDERS),
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 30, "default": 10},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "get_recording",
        required_scope="mcp:read",
        title="Get Protocol Overview",
        description=(
            "Read a meeting's status, speakers, summary, decisions, topics, action items "
            "(with timestamps), notes, pause windows, and screen-share keyframe IDs."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "Recording UUID."},
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "get_transcript",
        required_scope="mcp:read",
        title="Read Verbatim Transcript",
        description=(
            "Read paginated speaker-attributed transcript segments, pause windows, and "
            "keyframes with optional speaker, keyword, or time-window filters."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "Recording UUID."},
                "speaker": {"type": "string", "description": "Case-insensitive speaker filter."},
                "query": {"type": "string", "description": "Case-insensitive text filter."},
                "start_seconds": {"type": "number", "minimum": 0},
                "end_seconds": {"type": "number", "minimum": 0},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 250, "default": 80},
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "get_keyframe",
        required_scope="mcp:read",
        title="View Screen-Share Slide",
        description=(
            "Fetch a screen-share keyframe PNG as native ImageContent plus extracted slide "
            "context so multimodal models can inspect shared slides, code, or diagrams."
        ),
        read_only=True,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "Recording UUID."},
                "keyframe_id": {
                    "type": "string",
                    "description": "Keyframe UUID from get_recording or get_transcript.",
                },
            },
            "required": ["recording_id", "keyframe_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "schedule_recording",
        required_scope="mcp:write",
        title="Start or Schedule Recording",
        description=(
            "Send the bot into a live call immediately (omit starts_at) or schedule a future "
            "recording for Google Meet, Teams, Webex, or Zoom."
        ),
        read_only=False,
        idempotent=False,
        open_world=True,
        input_schema={
            "type": "object",
            "properties": {
                "meeting_url": {"type": "string", "description": "Conference HTTPS URL."},
                "title": {"type": "string"},
                "starts_at": {
                    "type": "string",
                    "description": "ISO-8601 timestamp with timezone; omit to join now.",
                },
                "duration_minutes": {
                    "type": "integer",
                    "minimum": 5,
                    "maximum": 240,
                    "default": 60,
                },
                "language": {
                    "type": "string",
                    "description": "ASR language ('auto' or ISO code/name, e.g. 'de', 'en').",
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
                "recording_id": {"type": "string", "description": "Recording UUID."},
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
    _tool_spec(
        "update_protocol",
        required_scope="mcp:write",
        title="Update Protocol & Summary",
        description=(
            "Partially update a recording's title, language, notes, summary_text, decisions, "
            "topics, action_items (optional HH:MM:SS or offset_seconds citations), "
            "speaker_overrides, or term_replacements. Omitted fields are preserved."
        ),
        read_only=False,
        input_schema={
            "type": "object",
            "properties": {
                "recording_id": {"type": "string", "description": "Recording UUID."},
                "title": {"type": "string"},
                "language": {"type": "string", "description": "'auto' or ISO code/language name."},
                "notes": {"type": "string"},
                "summary_text": {"type": "string", "description": "Executive overview paragraph."},
                "decisions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}, **_CITATION_ITEM_PROPS},
                        "required": ["text"],
                    },
                },
                "topics": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "details": {"type": "string"},
                            **_CITATION_ITEM_PROPS,
                        },
                    },
                },
                "action_items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "owner": {"type": "string"},
                            "task": {"type": "string"},
                            "due": {"type": "string"},
                            **_CITATION_ITEM_PROPS,
                        },
                        "required": ["task"],
                    },
                },
                "speaker_overrides": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                },
                "term_replacements": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                },
            },
            "required": ["recording_id"],
            "additionalProperties": False,
        },
    ),
]

_TOOL_BY_NAME: dict[str, tuple[str, mcp_types.Tool]] = {
    tool.name: (scope, tool) for scope, tool in _SCOPED_TOOLS
}


def _parse_uuid(raw: Any, field_name: str = "recording_id") -> uuid.UUID:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(
            f"{field_name} must be a non-empty UUID string. "
            "Call list_recordings to find valid recording UUIDs."
        )
    try:
        return uuid.UUID(raw.strip())
    except ValueError:
        raise ValueError(
            f"Invalid UUID for {field_name}: {raw!r}. "
            "Call list_recordings to find valid recording UUIDs."
        ) from None


def _parse_int(raw: Any, default: int, field_name: str) -> int:
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ValueError(f"{field_name} must be an integer (got {type(raw).__name__}).")
    return raw


def _parse_float(raw: Any, field_name: str) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"{field_name} must be a number (got {type(raw).__name__}).")
    return float(raw)


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
        raise LookupError(
            f"Recording {recording_id} not found or not accessible. "
            "Call list_recordings first to inspect accessible recording UUIDs."
        )
    return rec


def _load_verified_keyframe(
    db: Session,
    rec: Recording,
    kf_id: uuid.UUID,
) -> tuple[RecordingKeyframe, bytes]:
    kf = db.get(RecordingKeyframe, kf_id)
    if (
        kf is None
        or kf.recording_id != rec.id
        or kf.deleted_at is not None
        or not kf.object_key
        or is_keyframe_opted_out(db, rec, kf)
    ):
        raise LookupError(
            f"Keyframe {kf_id} not found or opted out. "
            f"Call get_recording(recording_id='{rec.id}') to list available keyframe IDs."
        )
    try:
        png_bytes = get_storage().read(kf.object_key)
    except (ClientError, ObjectConflict):
        raise LookupError(
            f"Keyframe {kf_id} object unavailable in storage."
        ) from None
    if hashlib.sha256(png_bytes).hexdigest() != kf.sha256:
        raise LookupError("Invalid keyframe object integrity.")
    return kf, png_bytes


def _tool_result(
    text_body: str,
    *,
    extra_content: list[mcp_types.ContentBlock] | None = None,
) -> mcp_types.CallToolResult:
    blocks: list[mcp_types.ContentBlock] = [mcp_types.TextContent(type="text", text=text_body)]
    if extra_content:
        blocks.extend(extra_content)
    return mcp_types.CallToolResult(content=blocks, isError=False)


def _tool_error(message: str) -> mcp_types.CallToolResult:
    return mcp_types.CallToolResult(
        content=[mcp_types.TextContent(type="text", text=f"Error: {message}")],
        isError=True,
    )


def _format_citation_tag(item: dict[str, Any]) -> str:
    ts = str(item.get("timestamp") or "").strip()
    off = item.get("offset_seconds")
    if ts and isinstance(off, (int, float)):
        return f" [{ts} / +{int(round(float(off)))}s]"
    if ts:
        return f" [{ts}]"
    if isinstance(off, (int, float)):
        return f" [+{int(round(float(off)))}s]"
    return ""


def _human_status_label(rec: Recording) -> str:
    if rec.participation == "scheduled":
        return "upcoming"
    if rec.processing == "completed":
        return "completed"
    if rec.processing == "failed" or (
        rec.participation == "ended"
        and rec.participation_reason not in (None, "normal", "room_empty", "cancelled")
    ):
        return f"failed ({rec.processing_error or rec.participation_reason})"
    if rec.participation == "ended" and rec.participation_reason == "cancelled":
        return "cancelled"
    return f"active ({rec.participation}/{rec.processing})"


def _clean_decisions_list(
    raw_list: Any,
    *,
    origin_utc: str | None,
    segments: list[dict[str, Any]],
    keyframes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(raw_list, list):
        raise ValueError("decisions must be an array of {text, timestamp?, offset_seconds?}.")
    out: list[dict[str, Any]] = []
    for d in raw_list:
        if not isinstance(d, dict):
            raise ValueError("each decision must be an object with a 'text' string.")
        d_txt = " ".join(str(d.get("text") or "").split())
        if not d_txt:
            continue
        d_item: dict[str, Any] = {"text": d_txt}
        raw_ts = d.get("timestamp")
        d_ts, d_off = resolve_citation_timestamp(
            raw_ts,
            d.get("offset_seconds") if not str(raw_ts or "").strip() else None,
            origin_utc=origin_utc,
            segments=segments,
            keyframes=keyframes,
        )
        if d_ts and d_off is not None:
            d_item["timestamp"] = d_ts
            d_item["offset_seconds"] = d_off
        out.append(d_item)
    return out


def _clean_topics_list(
    raw_list: Any,
    *,
    origin_utc: str | None,
    segments: list[dict[str, Any]],
    keyframes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(raw_list, list):
        raise ValueError("topics must be an array of {title, details, timestamp?}.")
    out: list[dict[str, Any]] = []
    for t in raw_list:
        if not isinstance(t, dict):
            raise ValueError("each topic must be an object.")
        t_title = " ".join(str(t.get("title") or "").split())
        t_details = " ".join(str(t.get("details") or "").split())
        if not (t_title or t_details):
            continue
        t_item: dict[str, Any] = {"title": t_title, "details": t_details}
        raw_ts = t.get("timestamp")
        t_ts, t_off = resolve_citation_timestamp(
            raw_ts,
            t.get("offset_seconds") if not str(raw_ts or "").strip() else None,
            origin_utc=origin_utc,
            segments=segments,
            keyframes=keyframes,
        )
        if t_ts and t_off is not None:
            t_item["timestamp"] = t_ts
            t_item["offset_seconds"] = t_off
        out.append(t_item)
    return out


def _clean_actions_list(
    raw_list: Any,
    *,
    origin_utc: str | None,
    segments: list[dict[str, Any]],
    keyframes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(raw_list, list):
        raise ValueError("action_items must be an array of {owner?, task, due?, timestamp?}.")
    out: list[dict[str, Any]] = []
    for a in raw_list:
        if not isinstance(a, dict):
            raise ValueError("each action item must be an object with a 'task' string.")
        task = " ".join(str(a.get("task") or "").split())
        if not task:
            continue
        owner = " ".join(str(a.get("owner") or "").split()) or "Team"
        a_item: dict[str, Any] = {"owner": owner, "task": task}
        due = " ".join(str(a.get("due") or "").split())
        if due:
            a_item["due"] = due
        raw_ts = a.get("timestamp")
        a_ts, a_off = resolve_citation_timestamp(
            raw_ts,
            a.get("offset_seconds") if not str(raw_ts or "").strip() else None,
            origin_utc=origin_utc,
            segments=segments,
            keyframes=keyframes,
        )
        if a_ts and a_off is not None:
            a_item["timestamp"] = a_ts
            a_item["offset_seconds"] = a_off
        out.append(a_item)
    return out


def _merge_mcp_summary_fields(
    existing_raw: Any,
    arguments: dict[str, Any],
    *,
    origin_utc: str | None,
    segments: list[dict[str, Any]],
    keyframes: list[dict[str, Any]],
) -> tuple[bool, dict[str, Any] | None]:
    nested = arguments.get("summary")
    if nested is not None and not isinstance(nested, dict):
        raise ValueError(
            "summary must be an object (or pass flat summary_text, decisions, topics, "
            "action_items fields)."
        )
    nested_dict: dict[str, Any] = nested if isinstance(nested, dict) else {}

    has_summary_text = "summary_text" in arguments or "summary" in nested_dict
    has_decisions = "decisions" in arguments or "decisions" in nested_dict
    has_topics = "topics" in arguments or "topics" in nested_dict
    has_actions = "action_items" in arguments or "action_items" in nested_dict

    if not (has_summary_text or has_decisions or has_topics or has_actions):
        return False, None

    cur = dict(existing_raw) if isinstance(existing_raw, dict) else {}
    summary_text = str(cur.get("summary") or "").strip()
    decisions = list(cur.get("decisions") or [])
    topics = list(cur.get("topics") or [])
    action_items = list(cur.get("action_items") or [])

    if has_summary_text:
        raw_st = (
            arguments["summary_text"]
            if "summary_text" in arguments
            else nested_dict.get("summary")
        )
        summary_text = str(raw_st or "").strip()
    if has_decisions:
        raw_dec = (
            arguments["decisions"] if "decisions" in arguments else nested_dict.get("decisions")
        )
        decisions = _clean_decisions_list(
            raw_dec, origin_utc=origin_utc, segments=segments, keyframes=keyframes
        )
    if has_topics:
        raw_top = arguments["topics"] if "topics" in arguments else nested_dict.get("topics")
        topics = _clean_topics_list(
            raw_top, origin_utc=origin_utc, segments=segments, keyframes=keyframes
        )
    if has_actions:
        raw_act = (
            arguments["action_items"]
            if "action_items" in arguments
            else nested_dict.get("action_items")
        )
        action_items = _clean_actions_list(
            raw_act, origin_utc=origin_utc, segments=segments, keyframes=keyframes
        )

    if not (summary_text or decisions or topics or action_items):
        return True, None
    merged: dict[str, Any] = {
        "summary": summary_text,
        "decisions": decisions,
        "topics": topics,
        "action_items": action_items,
        "generated_at": datetime.now(UTC).isoformat(),
    }
    return True, merged


def _execute_tool_sync(
    scope: _McpCallScope,
    name: str,
    arguments: dict[str, Any],
) -> mcp_types.CallToolResult:
    origin = public_origin(scope.request)
    db = scope.db
    principal = scope.auth.principal

    if name == "list_recordings":
        if arguments.get("query") is not None and str(arguments.get("query")).strip():
            return _tool_error(
                "list_recordings no longer accepts 'query'; use search_protocols(query=...) "
                "instead."
            )
        limit = max(1, min(50, _parse_int(arguments.get("limit"), 20, "limit")))
        provider = str(arguments["provider"]) if arguments.get("provider") else None
        status_filter = str(arguments.get("status") or "").strip().lower() or None
        since_dt = parse_date_bound(arguments.get("since"), "since", is_upper=False)
        until_dt = parse_date_bound(arguments.get("until"), "until", is_upper=True)

        base_stmt = select(Recording).where(Recording.metadata_deleted_at.is_(None))
        if since_dt is not None:
            base_stmt = base_stmt.where(Recording.ends_at >= since_dt)
        if until_dt is not None:
            base_stmt = base_stmt.where(Recording.starts_at <= until_dt)
        if status_filter == "upcoming":
            base_stmt = base_stmt.where(Recording.participation == "scheduled")
        elif status_filter == "active":
            base_stmt = base_stmt.where(
                or_(
                    ~Recording.participation.in_(("scheduled", "ended")),
                    Recording.processing == "processing",
                )
            )
        elif status_filter == "completed":
            base_stmt = base_stmt.where(Recording.processing == "completed")
        elif status_filter == "failed":
            base_stmt = base_stmt.where(
                or_(
                    Recording.processing == "failed",
                    and_(
                        Recording.participation == "ended",
                        Recording.processing != "completed",
                        Recording.participation_reason != "cancelled",
                    ),
                )
            )
        elif status_filter is not None:
            raise ValueError(
                f"Invalid status {status_filter!r}; expected upcoming, active, completed, failed."
            )

        stmt, empty_for_principal = apply_recordings_search_filters(
            base_stmt,
            principal=principal,
            provider=provider,
            q=None,
        )
        if empty_for_principal:
            return _tool_result("No recordings found.")

        rows = db.scalars(
            stmt.order_by(desc(Recording.starts_at), desc(Recording.id)).limit(limit)
        ).all()
        if not rows:
            return _tool_result("No matching recordings found.")

        lines = [f"Found {len(rows)} recording(s):"]
        for rec in rows:
            title = rec.title or f"{rec.provider} meeting"
            lines.append(
                f"- **{title}** (`{rec.id}`) · {rec.provider} · "
                f"{rec.starts_at.strftime('%Y-%m-%d %H:%M UTC')} · {_human_status_label(rec)}"
            )
        return _tool_result("\n".join(lines))

    if name == "search_protocols":
        raw_query = arguments.get("query")
        query_str = str(raw_query or "").strip() if isinstance(raw_query, str) else ""
        if not query_str:
            return _tool_error("query must be a non-empty string.")
        rec_id_arg = (
            _parse_uuid(arguments["recording_id"]) if arguments.get("recording_id") else None
        )
        speaker_arg = str(arguments.get("speaker") or "").strip() or None
        kind_arg = str(arguments.get("kind") or "all").strip().lower() or "all"
        provider_arg = str(arguments.get("provider") or "").strip().lower() or None
        limit_arg = max(1, min(30, _parse_int(arguments.get("limit"), 10, "limit")))

        res = search_protocol_chunks(
            db,
            principal,
            query=query_str,
            recording_id=rec_id_arg,
            speaker=speaker_arg,
            kind=kind_arg,
            since=arguments.get("since"),
            until=arguments.get("until"),
            provider=provider_arg,
            limit=limit_arg,
        )
        notices: list[str] = []
        if res.scanned_capped:
            notices.append(
                "_Note: Vector scan capped at the 20,000 most recent chunks; older matches rely "
                "on full-text search._"
            )
        if res.lexical_only:
            notices.append(
                "_Note: Lexical search only (local ONNX embedding model unavailable)._"
            )
        if not res.hits:
            return _tool_result(
                "\n".join([*notices, "No matching protocol passages found."])
            )

        out_lines: list[str] = [*notices]
        for rank_idx, hit in enumerate(res.hits, start=1):
            date_str = hit.recording_starts_at.strftime("%Y-%m-%d")
            cite = _format_citation_tag(
                {"timestamp": hit.wall_clock, "offset_seconds": hit.start_seconds}
            ).strip()
            cite_part = f" · {cite}" if cite else ""
            kf_suffix = (
                f" (keyframe_id=`{hit.keyframe_id}`)" if hit.keyframe_id is not None else ""
            )
            speaker_prefix = (
                f"**{hit.speaker_label}**: "
                if (hit.chunk_kind == "slide" and hit.speaker_label)
                else ""
            )
            header = (
                f"{rank_idx}. **{hit.recording_title}** (`{hit.recording_id}`, {date_str}) · "
                f"`{hit.chunk_kind}`{cite_part}{kf_suffix}"
            )
            if "\n" in hit.content:
                indented = "\n".join(f"   {ln}" for ln in hit.content.splitlines())
                out_lines.append(f"{header}\n{indented}")
            else:
                out_lines.append(f"{header} {speaker_prefix}{hit.content}")
        return _tool_result("\n".join(out_lines))

    if name == "get_recording":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id)
        title = rec.title or f"{rec.provider} meeting"
        lang = effective_recording_language(rec, get_settings())
        lines = [
            f"# {title}",
            f"- ID: `{rec.id}`",
            f"- Provider: `{rec.provider}` · Language: `{lang}`",
            f"- Scheduled: {rec.starts_at.strftime('%Y-%m-%d %H:%M')}–"
            f"{rec.ends_at.strftime('%H:%M UTC')}",
            f"- Status: {_human_status_label(rec)}",
            f"- UI: {origin}/ui#view=meetings&id={rec.id}",
        ]
        if rec.transcript_deleted_at is not None:
            lines.append("\n_Transcript retention window has expired._")
            return _tool_result("\n".join(lines))

        exp = export_data(db, rec)
        segs: list[dict[str, Any]] = list(exp.get("segments") or [])
        keyframes: list[dict[str, Any]] = list(exp.get("keyframes") or [])
        pause_windows: list[dict[str, Any]] = list(exp.get("pause_windows") or [])
        speakers = sorted(
            {str(s.get("speaker_label") or s.get("speaker_name") or "Unknown") for s in segs}
        )
        lines.append(
            f"- Segments: {len(segs)} · Keyframes: {len(keyframes)} · "
            f"Pause windows: {len(pause_windows)}"
        )
        if speakers:
            lines.append(f"- Speakers ({len(speakers)}): {', '.join(speakers)}")

        summary = exp.get("summary")
        if isinstance(summary, dict):
            if summary.get("summary"):
                lines.extend(["", "## Summary", str(summary["summary"])])
            decisions = summary.get("decisions") or []
            if decisions:
                lines.extend(["", "## Decisions"])
                for d in decisions:
                    lines.append(f"- ✓ {d['text']}{_format_citation_tag(d)}")
            topics = summary.get("topics") or []
            if topics:
                lines.extend(["", "## Topics"])
                for t in topics:
                    t_title = t.get("title") or ""
                    t_det = t.get("details") or ""
                    body = (
                        f"**{t_title}**: {t_det}"
                        if t_title and t_det
                        else (f"**{t_title}**" if t_title else t_det)
                    )
                    lines.append(f"- {body}{_format_citation_tag(t)}")
            actions = summary.get("action_items") or []
            if actions:
                lines.extend(["", "## Action Items"])
                for a in actions:
                    due = f" _(due: {a['due']})_" if a.get("due") else ""
                    lines.append(
                        f"- [ ] **{a.get('owner') or 'Team'}**: {a['task']}"
                        f"{due}{_format_citation_tag(a)}"
                    )

        notes = str(exp.get("notes") or "").strip()
        if notes:
            lines.extend(["", "## Notes", notes])

        if pause_windows:
            lines.extend(["", "## Off-the-Record Pause Windows"])
            for pw in pause_windows:
                s_ts = short_timestamp(float(pw.get("offset_seconds") or 0.0))
                end_off = pw.get("end_offset_seconds")
                e_ts = short_timestamp(float(end_off)) if end_off is not None else "ongoing"
                by = f" ({pw.get('by')})" if pw.get("by") else ""
                lines.append(f"- [{s_ts}–{e_ts}] Off-the-Record{by}")

        if keyframes:
            lines.extend(["", "## Screen-Share Keyframes"])
            for kf in keyframes:
                off = int(round(float(kf.get("offset_seconds") or 0.0)))
                ts = kf.get("wall_clock") or short_timestamp(off)
                uri = f"wortlaut://recordings/{rec.id}/keyframes/{kf['id']}.png"
                vc = kf.get("visual_context")
                vc_summary = (
                    f" — {vc['summary']}"
                    if isinstance(vc, dict) and vc.get("summary")
                    else ""
                )
                lines.append(
                    f"- [{ts} / +{off}s] **{kf.get('presenter') or 'Screen'}** "
                    f"(keyframe_id=`{kf['id']}`, `{uri}`){vc_summary}"
                )

        return _tool_result("\n".join(lines))

    if name == "get_transcript":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        rec = _get_accessible_recording(db, principal, rec_id)
        if rec.transcript_deleted_at is not None:
            return _tool_error("Transcript retention window has expired for this recording.")
        exp = export_data(db, rec)
        origin_utc = exp.get("time_origin_utc")
        all_segments: list[dict[str, Any]] = list(exp.get("segments") or [])
        all_keyframes: list[dict[str, Any]] = list(exp.get("keyframes") or [])
        all_pauses: list[dict[str, Any]] = list(exp.get("pause_windows") or [])

        speaker_filter = str(arguments.get("speaker") or "").strip().lower()
        query_filter = str(arguments.get("query") or "").strip().lower()
        start_sec = _parse_float(arguments.get("start_seconds"), "start_seconds")
        end_sec = _parse_float(arguments.get("end_seconds"), "end_seconds")
        offset = max(0, _parse_int(arguments.get("offset"), 0, "offset"))
        limit = max(1, min(250, _parse_int(arguments.get("limit"), 80, "limit")))

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
            vc_text = ""
            if isinstance(kf.get("visual_context"), dict):
                vc_text = (
                    f"{kf['visual_context'].get('summary') or ''} "
                    f"{' '.join(kf['visual_context'].get('terms') or [])}"
                ).lower()
            if speaker_filter and speaker_filter not in pres and speaker_filter not in pid:
                continue
            if query_filter and query_filter not in pres and query_filter not in vc_text:
                continue
            if start_sec is not None and kf_offset < float(start_sec):
                continue
            if end_sec is not None and kf_offset > float(end_sec):
                continue
            out_keyframes.append(kf)

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
        next_hint = (
            f" · next offset={offset + len(page)}"
            if (offset + len(page)) < total_matching
            else ""
        )
        md_lines = [
            f"# {rec.title or rec.provider} ({rec.starts_at.strftime('%Y-%m-%d %H:%M UTC')})",
            f"Showing {len(page)} of {total_matching} segment(s) (offset={offset}{next_hint}):\n",
        ]
        if total_matching == 0 and speaker_filter and all_segments:
            known_speakers = sorted(
                {
                    str(s.get("speaker_label") or s.get("speaker_name") or "Unknown")
                    for s in all_segments
                }
            )
            md_lines.append(
                f"No segments matched speaker={arguments.get('speaker')!r}. "
                f"Available speakers: {', '.join(known_speakers)}."
            )
        for seg in page:
            s_start = float(seg.get("start") or 0.0)
            speaker_label = str(
                seg.get("speaker_label")
                or seg.get("speaker_name")
                or ("Unbound Speaker" if seg.get("attribution_unknown") else "Speaker")
            )
            clock_label = (
                wall_clock_time_de(origin_utc, s_start) if origin_utc else short_timestamp(s_start)
            )
            md_lines.append(
                f"[{clock_label} / +{int(round(s_start))}s] **{speaker_label}**: "
                f"{seg.get('text') or ''}"
            )

        if out_pauses:
            md_lines.append("\nOff-the-record pause windows:")
            for pw in out_pauses:
                s_ts = short_timestamp(float(pw.get("offset_seconds") or 0.0))
                end_off = pw.get("end_offset_seconds")
                e_ts = short_timestamp(float(end_off)) if end_off is not None else "ongoing"
                by = f" ({pw.get('by')})" if pw.get("by") else ""
                md_lines.append(f"- [{s_ts}–{e_ts}] **OFF THE RECORD{by}**")

        if out_keyframes:
            md_lines.append("\nScreen-share keyframes:")
            for kf in out_keyframes:
                off = int(round(float(kf.get("offset_seconds") or 0.0)))
                ts = kf.get("wall_clock") or short_timestamp(off)
                uri = f"wortlaut://recordings/{rec.id}/keyframes/{kf['id']}.png"
                vc = kf.get("visual_context")
                vc_summary = (
                    f" — {vc['summary']}"
                    if isinstance(vc, dict) and vc.get("summary")
                    else ""
                )
                md_lines.append(
                    f"- [{ts} / +{off}s] **{kf.get('presenter') or 'Screen'}** "
                    f"(keyframe_id=`{kf['id']}`, `{uri}`){vc_summary}"
                )

        return _tool_result("\n".join(md_lines))

    if name == "get_keyframe":
        rec_id = _parse_uuid(arguments.get("recording_id"), "recording_id")
        kf_id = _parse_uuid(arguments.get("keyframe_id"), "keyframe_id")
        rec = _get_accessible_recording(db, principal, rec_id)
        if rec.transcript_deleted_at is not None:
            return _tool_error("Transcript retention window has expired for this recording.")
        kf, png_bytes = _load_verified_keyframe(db, rec, kf_id)
        exp = export_data(db, rec)
        kf_meta = next(
            (item for item in (exp.get("keyframes") or []) if item.get("id") == str(kf.id)),
            None,
        )
        off = int(round(float((kf_meta or {}).get("offset_seconds") or 0.0)))
        ts = (kf_meta or {}).get("wall_clock") or short_timestamp(off)
        presenter = (kf_meta or {}).get("presenter") or kf.participant_name or "Screen"
        caption_lines = [
            f"Keyframe `{kf.id}` · [{ts} / +{off}s] · Presenter: **{presenter}** "
            f"({kf.width}×{kf.height})"
        ]
        vc = (kf_meta or {}).get("visual_context")
        if isinstance(vc, dict):
            if vc.get("summary"):
                caption_lines.append(f"Slide context: {vc['summary']}")
            if vc.get("terms"):
                caption_lines.append(f"Visible terms: {', '.join(str(t) for t in vc['terms'])}")
        b64_png = base64.b64encode(png_bytes).decode("ascii")
        return _tool_result(
            "\n".join(caption_lines),
            extra_content=[
                mcp_types.ImageContent(type="image", data=b64_png, mimeType="image/png")
            ],
        )

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
                return _tool_error(
                    "starts_at must be a valid ISO-8601 datetime with timezone "
                    "(e.g. '2026-11-20T14:00:00+01:00' or 'Z'); omit starts_at to join now."
                )
            if starts_at.tzinfo is None:
                return _tool_error(
                    "starts_at requires an explicit timezone offset (e.g. 'Z' or '+01:00'); "
                    "omit starts_at to join immediately."
                )
            starts_at = starts_at.astimezone(UTC)
        else:
            starts_at = now

        duration_min = max(
            5, min(240, _parse_int(arguments.get("duration_minutes"), 60, "duration_minutes"))
        )
        ends_at = starts_at + timedelta(minutes=duration_min)
        title = " ".join(str(arguments.get("title") or "").split())[:200] or None
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

        return _tool_result(
            f"Scheduled {rec.provider} recording `{rec.id}` "
            f"({rec.starts_at.isoformat()} -> {rec.ends_at.isoformat()}) · "
            f"{origin}/ui#view=meetings&id={rec.id}"
        )

    if name == "cancel_recording":
        rec_id = _parse_uuid(arguments.get("recording_id"))
        _get_accessible_recording(db, principal, rec_id, for_update=False)
        rec = cancel_recording_and_unlink_calendar(db, rec_id, datetime.now(UTC))
        if rec is None:
            return _tool_error(f"Recording {rec_id} not found.")
        db.commit()
        return _tool_result(
            f"Cancelled recording `{rec.id}` (participation=`{rec.participation}`)."
        )

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
            exp = export_data(db, rec)
            touched_summary, merged_summary = _merge_mcp_summary_fields(
                meta.get("summary"),
                arguments,
                origin_utc=exp.get("time_origin_utc"),
                segments=exp.get("segments") or [],
                keyframes=exp.get("keyframes") or [],
            )
            if touched_summary:
                if merged_summary is not None:
                    meta["summary"] = merged_summary
                else:
                    meta.pop("summary", None)
        except ValueError as exc:
            return _tool_error(str(exc))
        invalidate_recording_rag_index(meta)
        rec.protocol_meta = meta
        db.commit()
        return _tool_result(
            f"Updated protocol `{rec.id}` "
            f"(title={rec.title!r}, language={effective_recording_language(rec, get_settings())})."
        )

    raise McpError(
        mcp_types.ErrorData(code=mcp_types.INVALID_PARAMS, message=f"Unknown tool: {name}")
    )


@mcp_app.list_tools()
async def _sdk_list_tools() -> list[mcp_types.Tool]:
    scope = _ACTIVE_CALL_SCOPE.get()
    open_world_search = get_settings().openai_chat_configured()
    tools: list[mcp_types.Tool] = []
    for req_scope, tool in _SCOPED_TOOLS:
        if req_scope not in scope.auth.scopes:
            continue
        if tool.name == "search_protocols" and tool.annotations is not None:
            tool = tool.model_copy(
                update={
                    "annotations": tool.annotations.model_copy(
                        update={"openWorldHint": open_world_search}
                    )
                }
            )
        tools.append(tool)
    return tools


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
            description=f"Markdown protocol ({r.provider}, {r.starts_at.strftime('%Y-%m-%d')})",
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
            uriTemplate="wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png",
            name="Screen-Share Slide Keyframe (PNG)",
            description="Static PNG snapshot captured from an active screen share.",
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
    if subpath != "protocol.md" and not is_keyframe_uri:
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
            kf_id = _parse_uuid(raw_kf_id, "keyframe_id")
            _, png_bytes = _load_verified_keyframe(scope.db, rec, kf_id)
        except (ValueError, LookupError) as exc:
            raise McpError(mcp_types.ErrorData(code=-32002, message=str(exc))) from None
        return [ReadResourceContents(content=png_bytes, mime_type="image/png")]
    rendered, mime = render_export(export_data(scope.db, rec), "md")
    text_body = rendered.decode("utf-8") if isinstance(rendered, bytes) else str(rendered)
    return [ReadResourceContents(content=text_body, mime_type=mime.split(";", 1)[0])]


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
            ),
            serverInfo=mcp_types.Implementation(
                name=get_settings().assistant_name,
                version="0.1.0",
            ),
            instructions=(
                "Speaker-isolated meeting protocols (Meet, Teams, Webex, Zoom). "
                "Use search_protocols for keyword, speaker, or conceptual search across "
                "completed protocols, list_recordings for chronological/status/provider "
                "browsing, get_recording for summary/decisions/tasks, get_transcript for "
                "verbatim quotes, and get_keyframe to view shared slides as PNG images."
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
