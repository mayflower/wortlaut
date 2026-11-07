"""OpenTelemetry OTLP/HTTP trace export and structured Loki telemetry for the Grafana stack."""

import json
import logging
import secrets
import time
import uuid
from typing import Any

import httpx

from wortlaut.settings import get_settings

logger = logging.getLogger("wortlaut.telemetry")


def _otel_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [_otel_value(item) for item in value]}}
    return {"stringValue": str(value)}


def _otel_attributes(attributes: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"key": key, "value": _otel_value(val)}
        for key, val in attributes.items()
        if val is not None
    ]


def build_otlp_trace_payload(
    *,
    trace_id: str,
    span_id: str,
    name: str,
    attributes: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
    start_ns: int | None = None,
    end_ns: int | None = None,
    status_error: bool = False,
) -> dict[str, Any]:
    settings = get_settings()
    now_ns = time.time_ns()
    start = start_ns or (now_ns - 1_000_000)
    end = end_ns or now_ns
    span_events = [
        {
            "timeUnixNano": str(end),
            "name": event["name"],
            "attributes": _otel_attributes(event.get("attributes", {})),
        }
        for event in (events or [])
    ]
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": _otel_attributes(
                        {
                            "service.name": "wortlaut-meeting",
                            "service.version": "0.1.0",
                            "deployment.environment": settings.namespace,
                        }
                    )
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "wortlaut.telemetry", "version": "0.1.0"},
                        "spans": [
                            {
                                "traceId": trace_id,
                                "spanId": span_id,
                                "name": name,
                                "kind": 1,
                                "startTimeUnixNano": str(start),
                                "endTimeUnixNano": str(end),
                                "attributes": _otel_attributes(attributes),
                                "events": span_events,
                                "status": {"code": 2 if status_error else 1},
                            }
                        ],
                    }
                ],
            }
        ]
    }


def emit_span(
    *,
    recording_id: uuid.UUID,
    name: str,
    attributes: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
    status_error: bool = False,
) -> dict[str, Any]:
    trace_id = recording_id.hex
    span_id = secrets.token_hex(8)
    log_record = {
        "event": name,
        "trace_id": trace_id,
        "span_id": span_id,
        **{k: v for k, v in attributes.items() if v is not None},
        **({"events": events} if events else {}),
    }
    logger.info(json.dumps(log_record, sort_keys=True))
    payload = build_otlp_trace_payload(
        trace_id=trace_id,
        span_id=span_id,
        name=name,
        attributes=attributes,
        events=events,
        status_error=status_error,
    )
    endpoint = get_settings().otlp_endpoint
    if endpoint:
        try:
            httpx.post(
                endpoint,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=2.0,
            )
        except Exception:
            logger.debug("otlp_export_failed", exc_info=False)
    return payload


def record_worker_status_telemetry(recording, attempt, body) -> dict[str, Any]:
    receivers = body.receiver_sources or []
    participants = body.participant_sources
    data_channels = getattr(body, "data_channels", None) or []
    sdp = getattr(body, "sdp", None)
    bound_receivers = sum(1 for r in receivers if r.signaled_participant_id)
    bound_named_receivers = sum(
        1
        for r in receivers
        if r.signaled_participant_id and getattr(r, "participant_name", None)
    )
    named_participants = sum(
        1 for p in (participants.sources or []) if getattr(p, "participant_name", None)
    )
    dom_participants = getattr(participants, "dom_participants", None) or 0
    http_signaling_frames = sum(
        dc.text_frames + dc.binary_frames
        for dc in data_channels
        if dc.label.startswith("http:")
    )
    ws_signaling_frames = sum(
        dc.text_frames + dc.binary_frames
        for dc in data_channels
        if dc.label == "ws:signaling"
    )
    ssrc_total = sum(len(r.ssrc) for r in receivers)
    csrc_total = sum(len(r.csrc) for r in receivers)
    labels = sorted({dc.label for dc in data_channels if dc.label})
    json_keys = sorted({key for dc in data_channels for key in dc.json_keys})
    wire_formats = sorted({wf for dc in data_channels for wf in getattr(dc, "wire_formats", [])})
    protobuf_fields = sorted(
        {pf for dc in data_channels for pf in getattr(dc, "protobuf_fields", [])}
    )

    events: list[dict[str, Any]] = []
    for r in receivers[:32]:
        events.append(
            {
                "name": "webrtc.receiver",
                "attributes": {
                    "webrtc.provider_source_id": r.provider_source_id,
                    "webrtc.source_kind": r.source_kind,
                    "webrtc.capture_path": r.capture_path,
                    "webrtc.track_id": r.track_id or "",
                    "webrtc.csi": r.csi,
                    "webrtc.signaled_participant_id": r.signaled_participant_id or "",
                    "webrtc.has_participant_name": bool(getattr(r, "participant_name", None)),
                    "webrtc.ssrc_count": len(r.ssrc),
                    "webrtc.csrc_count": len(r.csrc),
                    "webrtc.encoded_transform_state": (
                        r.encoded_transform.state if r.encoded_transform else "none"
                    ),
                },
            }
        )
    for dc in data_channels[:32]:
        events.append(
            {
                "name": "webrtc.datachannel",
                "attributes": {
                    "webrtc.channel_label": dc.label,
                    "webrtc.ready_state": dc.ready_state,
                    "webrtc.text_frames": dc.text_frames,
                    "webrtc.binary_frames": dc.binary_frames,
                    "webrtc.json_frames": dc.json_frames,
                    "webrtc.json_keys": ",".join(dc.json_keys),
                    "webrtc.wire_formats": ",".join(getattr(dc, "wire_formats", [])),
                    "webrtc.protobuf_fields": ",".join(getattr(dc, "protobuf_fields", [])),
                },
            }
        )

    attributes = {
        "wortlaut.recording_id": str(recording.id),
        "wortlaut.attempt_id": str(attempt.id),
        "wortlaut.provider": recording.provider,
        "wortlaut.title": recording.title or "",
        "wortlaut.participation": body.participation,
        "wortlaut.reason": body.reason or "",
        "wortlaut.capability": body.capability,
        "wortlaut.streams": body.streams,
        "wortlaut.audio_samples": body.audio_samples,
        "wortlaut.active_audio_samples": getattr(body, "active_audio_samples", 0),
        "wortlaut.receiver_count": len(receivers),
        "wortlaut.bound_receiver_count": bound_receivers,
        "wortlaut.bound_named_receiver_count": bound_named_receivers,
        "wortlaut.rtp_ssrc_count": ssrc_total,
        "wortlaut.rtp_csrc_count": csrc_total,
        "wortlaut.participant_sources_available": participants.available,
        "wortlaut.participant_count": participants.total,
        "wortlaut.named_participant_count": named_participants,
        "wortlaut.dom_participant_count": dom_participants,
        "wortlaut.data_channel_count": len(data_channels),
        "wortlaut.http_signaling_frames": http_signaling_frames,
        "wortlaut.ws_signaling_frames": ws_signaling_frames,
        "wortlaut.data_channel_labels": ",".join(labels),
        "wortlaut.data_channel_json_keys": ",".join(json_keys),
        "wortlaut.data_channel_wire_formats": ",".join(wire_formats),
        "wortlaut.data_channel_protobuf_fields": ",".join(protobuf_fields),
        "wortlaut.sdp_descriptions": sdp.descriptions if sdp else 0,
        "wortlaut.sdp_ssrc_count": sdp.ssrc_count if sdp else 0,
        "wortlaut.sdp_cname_count": sdp.cname_count if sdp else 0,
        "wortlaut.sdp_msid_count": sdp.msid_count if sdp else 0,
    }
    is_error = bool(
        body.participation == "ended"
        and body.reason
        and body.reason not in ("normal", "scheduled_end", "deadline", "room_empty", "cancelled")
    )
    return emit_span(
        recording_id=recording.id,
        name="wortlaut.worker.status",
        attributes=attributes,
        events=events,
        status_error=is_error,
    )
