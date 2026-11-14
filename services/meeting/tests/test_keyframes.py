import base64
import hashlib
import json
import struct
import time
import uuid
import zlib
from datetime import UTC, datetime, timedelta

from botocore.exceptions import ClientError
from sqlalchemy import select
from sqlalchemy.orm import Session


def _make_png(
    width: int = 320, height: int = 180, rgb: tuple[int, int, int] = (32, 96, 192)
) -> bytes:
    def _chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + bytes(rgb) * width
    raw = row * height
    idat = zlib.compress(raw, level=6)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", idat)
        + _chunk(b"IEND", b"")
    )


def _encode_meta_header(meta: dict) -> str:
    raw = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _s3_exists(storage, key: str) -> bool:
    try:
        storage.client.head_object(Bucket=storage.bucket, Key=key)
        return True
    except ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code") or "") in ("404", "NoSuchKey"):
            return False
        raise


def _create_claimed_attempt(
    client,
    operator_headers: dict[str, str],
    *,
    title: str = "Architektur Sync",
    worker_id: str = "worker-kf-1",
    starts_offset_min: int = -5,
    ends_offset_min: int = 55,
) -> tuple[uuid.UUID, uuid.UUID, str]:
    now = datetime.now(UTC)
    rec_resp = client.post(
        "/v1/recordings",
        headers={**operator_headers, "Idempotency-Key": f"kf-{uuid.uuid4()}"},
        json={
            "meeting_url": "https://meet.google.com/key-fram-one",
            "starts_at": (now + timedelta(minutes=starts_offset_min)).isoformat(),
            "ends_at": (now + timedelta(minutes=ends_offset_min)).isoformat(),
            "title": title,
        },
    )
    assert rec_resp.status_code == 200
    rec_id = uuid.UUID(rec_resp.json()["id"])

    att_resp = client.post(
        f"/v1/recordings/{rec_id}/attempts",
        headers=operator_headers,
    )
    assert att_resp.status_code == 200
    att_id = uuid.UUID(att_resp.json()["attempt_id"])
    cred = att_resp.json()["bootstrap_credential"]

    claim_resp = client.post(
        f"/v1/attempts/{att_id}/claim",
        headers={"Authorization": f"Bearer {cred}"},
        json={"worker_id": worker_id},
    )
    assert claim_resp.status_code == 200
    return rec_id, att_id, cred


def test_privacy_chat_intro_and_bootstrap_keyframe_toggle(client, storage, monkeypatch):
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    monkeypatch.setenv("WORTLAUT_ENABLE_KEYFRAMES", "true")
    get_settings.cache_clear()

    op_headers = {"Authorization": "Bearer fixture-api-token"}
    _, att_id, cred = _create_claimed_attempt(client, op_headers)

    boot = client.get(
        f"/v1/attempts/{att_id}/bootstrap",
        headers={"Authorization": f"Bearer {cred}", "X-Worker-ID": "worker-kf-1"},
    )
    assert boot.status_code == 200
    boot_json = boot.json()
    assert boot_json["enable_keyframes"] is True
    assert "Standbilder" in boot_json["chat_intro"]

    priv_de = client.get("/privacy").text
    assert "Standbilder (Keyframes)" in priv_de
    assert "niemals Teilnehmer-Kamerabilder" in priv_de

    priv_en = client.get("/privacy?lang=en").text
    assert "settled static snapshots (keyframes)" in priv_en
    assert "Participant camera feeds and continuous video are never recorded" in priv_en

    ui_html = client.get("/ui").text
    assert '"enable_keyframes": true' in ui_html

    monkeypatch.setenv("WORTLAUT_ENABLE_KEYFRAMES", "false")
    get_settings.cache_clear()

    priv_disabled = client.get("/privacy").text
    assert "weder Kamerabilder noch Bildschirminhalte" in priv_disabled
    priv_disabled_en = client.get("/privacy?lang=en").text
    assert "Neither camera video nor screen shares are recorded" in priv_disabled_en


def test_keyframe_ingest_validation_idempotency_cap_and_quota(
    client, database, storage, monkeypatch
):
    from wortlaut.settings import get_settings

    op_headers = {"Authorization": "Bearer fixture-api-token"}
    rec_id, att_id, cred = _create_claimed_attempt(client, op_headers)
    worker_headers = {
        "Authorization": f"Bearer {cred}",
        "X-Worker-ID": "worker-kf-1",
        "Content-Type": "image/png",
    }
    png_1 = _make_png(320, 180, (20, 80, 160))
    sha_1 = hashlib.sha256(png_1).hexdigest()
    t0 = datetime.now(UTC)

    base_meta = {
        "sequence": 0,
        "provider_source_id": "rtc:slides:1",
        "participant_id": "spaces/meet/devices/presenter-1",
        "participant_name": "Clara Presenter",
        "captured_at": t0.isoformat(),
        "width": 320,
        "height": 180,
        "sha256": sha_1,
    }

    # Disabled toggle rejects with 409 keyframes_disabled
    monkeypatch.setenv("WORTLAUT_ENABLE_KEYFRAMES", "false")
    get_settings.cache_clear()
    res_dis = client.post(
        f"/v1/attempts/{att_id}/keyframes",
        headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(base_meta)},
        content=png_1,
    )
    assert res_dis.status_code == 409
    assert res_dis.json()["detail"] == "keyframes_disabled"

    monkeypatch.setenv("WORTLAUT_ENABLE_KEYFRAMES", "true")
    get_settings.cache_clear()

    # Wrong worker ID rejected with 409
    assert (
        client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={
                **worker_headers,
                "X-Worker-ID": "other-worker",
                "X-Wortlaut-Keyframe": _encode_meta_header(base_meta),
            },
            content=png_1,
        ).status_code
        == 409
    )

    # Non-PNG bytes rejected with 400
    bad_bytes = b"not-a-png-file-at-all" * 4
    bad_meta = {**base_meta, "sha256": hashlib.sha256(bad_bytes).hexdigest()}
    assert (
        client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(bad_meta)},
            content=bad_bytes,
        ).status_code
        == 400
    )

    # Mismatched IHDR dimensions rejected with 400
    wrong_dim_meta = {**base_meta, "width": 640}
    assert (
        client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(wrong_dim_meta)},
            content=png_1,
        ).status_code
        == 400
    )

    # Mismatched SHA-256 rejected with 400
    wrong_sha_meta = {**base_meta, "sha256": "0" * 64}
    assert (
        client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(wrong_sha_meta)},
            content=png_1,
        ).status_code
        == 400
    )

    # Valid upload -> 201 Created + S3 WORTLAUT1 object + Prometheus metrics
    ok = client.post(
        f"/v1/attempts/{att_id}/keyframes",
        headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(base_meta)},
        content=png_1,
    )
    assert ok.status_code == 201
    assert ok.json()["duplicate"] is False
    s3_key_0 = f"keyframes/{rec_id}/{att_id}/0000.png"
    assert _s3_exists(storage, s3_key_0)
    assert storage.read(s3_key_0) == png_1

    metrics_txt = client.get("/metrics", headers=op_headers).text
    assert "wortlaut_stored_keyframes 1" in metrics_txt

    # Idempotent retry of same sequence + sha256 -> 200 duplicate=True
    retry = client.post(
        f"/v1/attempts/{att_id}/keyframes",
        headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(base_meta)},
        content=png_1,
    )
    assert retry.status_code == 200
    assert retry.json()["duplicate"] is True
    assert retry.json()["id"] == ok.json()["id"]

    # Same sequence with different PNG -> 409 keyframe_sequence_conflict
    png_other = _make_png(320, 180, (200, 30, 30))
    conflict_meta = {**base_meta, "sha256": hashlib.sha256(png_other).hexdigest()}
    conflict_res = client.post(
        f"/v1/attempts/{att_id}/keyframes",
        headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(conflict_meta)},
        content=png_other,
    )
    assert conflict_res.status_code == 409
    assert conflict_res.json()["detail"] == "keyframe_sequence_conflict"

    # Storage capacity quota -> 507 storage_capacity_reached
    monkeypatch.setenv("WORTLAUT_MAX_STORED_AUDIO_BYTES", "100")
    get_settings.cache_clear()
    seq1_meta = {
        **base_meta,
        "sequence": 1,
        "captured_at": (t0 + timedelta(seconds=10)).isoformat(),
        "sha256": hashlib.sha256(png_other).hexdigest(),
    }
    quota_res = client.post(
        f"/v1/attempts/{att_id}/keyframes",
        headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(seq1_meta)},
        content=png_other,
    )
    assert quota_res.status_code == 507
    assert quota_res.json()["detail"] == "storage_capacity_reached"

    monkeypatch.setenv("WORTLAUT_MAX_STORED_AUDIO_BYTES", str(8 * 1024**3))
    get_settings.cache_clear()

    # Fill up to 60 keyframes total (1..59), then verify 61st returns 409 keyframe_limit_reached
    for seq in range(1, 60):
        frame_bytes = _make_png(64, 36, (seq * 3 % 255, 100, 150))
        m = {
            **base_meta,
            "sequence": seq,
            "width": 64,
            "height": 36,
            "captured_at": (t0 + timedelta(seconds=seq * 6)).isoformat(),
            "sha256": hashlib.sha256(frame_bytes).hexdigest(),
        }
        r = client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(m)},
            content=frame_bytes,
        )
        assert r.status_code == 201

    frame_60 = _make_png(64, 36, (250, 250, 10))
    m_60 = {
        **base_meta,
        "sequence": 60,
        "width": 64,
        "height": 36,
        "captured_at": (t0 + timedelta(seconds=400)).isoformat(),
        "sha256": hashlib.sha256(frame_60).hexdigest(),
    }
    cap_res = client.post(
        f"/v1/attempts/{att_id}/keyframes",
        headers={**worker_headers, "X-Wortlaut-Keyframe": _encode_meta_header(m_60)},
        content=frame_60,
    )
    assert cap_res.status_code == 409
    assert cap_res.json()["detail"] == "keyframe_limit_reached"


def test_rejoin_timeline_exports_access_controls_optout_retention_and_mcp(
    client, database, storage, monkeypatch
):
    from wortlaut.exports import export_reader_token
    from wortlaut.models import (
        AsrJob,
        Attempt,
        AudioChunk,
        AudioStream,
        McpOAuthClient,
        McpOAuthGrant,
        Recording,
        RecordingKeyframe,
        TranscriptSegment,
    )
    from wortlaut.oidc import issue_user_session_token
    from wortlaut.retention import retention_pass
    from wortlaut.settings import get_settings

    monkeypatch.setenv("WORTLAUT_OIDC_ISSUER", "https://id.example.org")
    monkeypatch.setenv("WORTLAUT_API_URL", "https://wortlaut.example.org")
    get_settings.cache_clear()

    alice_token, _ = issue_user_session_token(
        sub="sub-alice",
        email="alice@mayflower.de",
        name="Alice Meier",
        exp=int(time.time()) + 3600,
    )
    bob_token, _ = issue_user_session_token(
        sub="sub-bob",
        email="bob@mayflower.de",
        name="Bob Unrelated",
        exp=int(time.time()) + 3600,
    )
    alice_hdrs = {"Authorization": f"Bearer {alice_token}"}
    bob_hdrs = {"Authorization": f"Bearer {bob_token}"}
    op_hdrs = {"Authorization": "Bearer fixture-api-token"}

    t_origin = datetime.now(UTC) - timedelta(minutes=30)
    rec_resp = client.post(
        "/v1/recordings",
        headers={**alice_hdrs, "Idempotency-Key": f"kf-rejoin-{uuid.uuid4()}"},
        json={
            "meeting_url": "https://meet.google.com/ali-keyf-two",
            "starts_at": (t_origin - timedelta(minutes=2)).isoformat(),
            "ends_at": (t_origin + timedelta(minutes=45)).isoformat(),
            "title": "System-Architektur Review",
        },
    )
    assert rec_resp.status_code == 200
    rec_id = uuid.UUID(rec_resp.json()["id"])

    # Attempt 1: captures slide at t_origin + 12s, plus audio stream anchored at t_origin
    att1_resp = client.post(f"/v1/recordings/{rec_id}/attempts", headers=op_hdrs)
    att1_id = uuid.UUID(att1_resp.json()["attempt_id"])
    cred1 = att1_resp.json()["bootstrap_credential"]
    assert (
        client.post(
            f"/v1/attempts/{att1_id}/claim",
            headers={"Authorization": f"Bearer {cred1}"},
            json={"worker_id": "w-1"},
        ).status_code
        == 200
    )

    png_slide1 = _make_png(640, 360, (40, 120, 200))
    meta_slide1 = {
        "sequence": 0,
        "provider_source_id": "rtc:slides:a",
        "participant_id": "p-clara",
        "participant_name": "Clara Diagramm",
        "captured_at": (t_origin + timedelta(seconds=12)).isoformat(),
        "width": 640,
        "height": 360,
        "sha256": hashlib.sha256(png_slide1).hexdigest(),
    }
    up1 = client.post(
        f"/v1/attempts/{att1_id}/keyframes",
        headers={
            "Authorization": f"Bearer {cred1}",
            "X-Worker-ID": "w-1",
            "Content-Type": "image/png",
            "X-Wortlaut-Keyframe": _encode_meta_header(meta_slide1),
        },
        content=png_slide1,
    )
    assert up1.status_code == 201
    kf1_id = uuid.UUID(up1.json()["id"])

    # End attempt 1 and verify ended-status replay idempotency with keyframes telemetry
    end_body_1 = {
        "participation": "ended",
        "capability": "verified",
        "reason": "normal",
        "streams": 1,
        "audio_samples": 32000,
        "active_audio_samples": 32000,
        "drained": True,
        "keyframes": {
            "capability": "active",
            "active_share": False,
            "evaluated_ticks": 20,
            "emitted": 1,
            "uploaded": 1,
            "dropped_unverified": 0,
            "dropped_opted_out": 0,
            "dropped_queue_full": 0,
        },
    }
    assert (
        client.post(
            f"/v1/attempts/{att1_id}/status",
            headers={"Authorization": f"Bearer {cred1}", "X-Worker-ID": "w-1"},
            json=end_body_1,
        ).status_code
        == 200
    )
    # Replay of identical ended status succeeds idempotently
    assert (
        client.post(
            f"/v1/attempts/{att1_id}/status",
            headers={"Authorization": f"Bearer {cred1}", "X-Worker-ID": "w-1"},
            json=end_body_1,
        ).status_code
        == 200
    )

    # Rejoin recording -> Attempt 2 captures slide 2 from presenter p-dave at t_origin + 125.5s
    assert client.post(f"/v1/recordings/{rec_id}/rejoin", headers=alice_hdrs).status_code == 200
    att2_resp = client.post(f"/v1/recordings/{rec_id}/attempts", headers=op_hdrs)
    att2_id = uuid.UUID(att2_resp.json()["attempt_id"])
    cred2 = att2_resp.json()["bootstrap_credential"]
    assert (
        client.post(
            f"/v1/attempts/{att2_id}/claim",
            headers={"Authorization": f"Bearer {cred2}"},
            json={"worker_id": "w-2"},
        ).status_code
        == 200
    )

    png_slide2 = _make_png(800, 450, (90, 180, 90))
    meta_slide2 = {
        "sequence": 0,
        "provider_source_id": "rtc:slides:b",
        "participant_id": "p-dave",
        "participant_name": "Dave Folie",
        "captured_at": (t_origin + timedelta(seconds=125.5)).isoformat(),
        "width": 800,
        "height": 450,
        "sha256": hashlib.sha256(png_slide2).hexdigest(),
    }
    up2 = client.post(
        f"/v1/attempts/{att2_id}/keyframes",
        headers={
            "Authorization": f"Bearer {cred2}",
            "X-Worker-ID": "w-2",
            "Content-Type": "image/png",
            "X-Wortlaut-Keyframe": _encode_meta_header(meta_slide2),
        },
        content=png_slide2,
    )
    assert up2.status_code == 201
    kf2_id = uuid.UUID(up2.json()["id"])

    # Also upload slide 3 from p-eve (who will opt out via live status)
    png_slide3 = _make_png(640, 360, (180, 60, 60))
    meta_slide3 = {
        "sequence": 1,
        "provider_source_id": "rtc:slides:c",
        "participant_id": "p-eve",
        "participant_name": "Eve Optout",
        "captured_at": (t_origin + timedelta(seconds=140)).isoformat(),
        "width": 640,
        "height": 360,
        "sha256": hashlib.sha256(png_slide3).hexdigest(),
    }
    up3 = client.post(
        f"/v1/attempts/{att2_id}/keyframes",
        headers={
            "Authorization": f"Bearer {cred2}",
            "X-Worker-ID": "w-2",
            "Content-Type": "image/png",
            "X-Wortlaut-Keyframe": _encode_meta_header(meta_slide3),
        },
        content=png_slide3,
    )
    assert up3.status_code == 201
    kf3_id = uuid.UUID(up3.json()["id"])
    s3_key_3 = f"keyframes/{rec_id}/{att2_id}/0001.png"
    assert _s3_exists(storage, s3_key_3)

    # Simulate transient S3 failure during Eve's live opt-out, then verify retention_pass retries!
    orig_delete_object = storage.delete_object

    def _fail_once(key: str):
        raise RuntimeError("simulated_s3_503")

    monkeypatch.setattr(storage, "delete_object", _fail_once)
    opt_status = client.post(
        f"/v1/attempts/{att2_id}/status",
        headers={"Authorization": f"Bearer {cred2}", "X-Worker-ID": "w-2"},
        json={
            "participation": "capturing",
            "capability": "verified",
            "streams": 1,
            "participant_sources": {
                "available": True,
                "total": 3,
                "sources": [],
                "opted_out": ["Eve Optout"],
            },
        },
    )
    assert opt_status.status_code == 200
    monkeypatch.setattr(storage, "delete_object", orig_delete_object)

    # Eve's keyframe is immediately soft-deleted (404 on GET) while object_key awaits retry
    assert (
        client.get(
            f"/v1/recordings/{rec_id}/keyframes/{kf3_id}.png", headers=alice_hdrs
        ).status_code
        == 404
    )
    with Session(database) as db:
        kf3_row = db.get(RecordingKeyframe, kf3_id)
        assert kf3_row.deleted_at is not None
        assert kf3_row.participant_name is None
        assert kf3_row.object_key == s3_key_3

    # Future uploads from Eve are rejected with 409 presenter_opted_out
    meta_slide3_next = {
        **meta_slide3,
        "sequence": 2,
    }
    assert (
        client.post(
            f"/v1/attempts/{att2_id}/keyframes",
            headers={
                "Authorization": f"Bearer {cred2}",
                "X-Worker-ID": "w-2",
                "Content-Type": "image/png",
                "X-Wortlaut-Keyframe": _encode_meta_header(meta_slide3_next),
            },
            content=png_slide3,
        ).status_code
        == 409
    )

    # retention_pass retries S3 delete and clears object_key=""
    retention_pass(database)
    assert not _s3_exists(storage, s3_key_3)
    with Session(database) as db:
        kf3_row = db.get(RecordingKeyframe, kf3_id)
        assert kf3_row.object_key == ""

    # Seed audio stream + transcript segment anchored at t_origin and mark recording completed
    stream_row_id = uuid.uuid4()
    stream_ext_id = uuid.uuid4()
    stream_epoch = uuid.uuid4()
    job_id = str(uuid.uuid4())
    audio_key = f"audio/{rec_id}/{att1_id}/{stream_ext_id}/000000.pcm"
    pcm_bytes = b"\x08\x00" * 32000
    stream_contract = {
        "source_kind": "speaker",
        "provider_source_id": "rtc:audio:1",
        "participant_id": "p-clara",
        "signaled_participant_id": "p-clara",
        "participant_name": "Clara Diagramm",
        "speaker_id": "p-clara",
        "attribution_unknown": False,
        "attribution_status": "bound",
        "session_utc_origin": t_origin.isoformat(),
        "monotonic_origin_ms": 0,
        "session_monotonic_origin_ms": 0,
    }
    pcm_sha = storage.put(audio_key, pcm_bytes, stream_contract)

    mcp_access_tok = "wortlaut-mcp-at-kf-test-secret"
    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        att1 = db.get(Attempt, att1_id)
        att2 = db.get(Attempt, att2_id)
        att1.process_ended_at = datetime.now(UTC)
        att2.ended_at = datetime.now(UTC)
        att2.end_reason = "normal"
        att2.process_ended_at = datetime.now(UTC)
        rec.active_attempt_id = None
        rec.participation = "ended"
        rec.processing = "completed"
        rec.processing_finished_at = datetime.now(UTC)
        rec.export_reader_nonce = uuid.uuid4()
        db.add(
            AudioStream(
                id=stream_row_id,
                attempt_id=att1_id,
                stream_id=stream_ext_id,
                epoch=stream_epoch,
                final_sample=32000,
                last_sequence=0,
                scan_sample=32000,
                scan_complete=True,
                contract=stream_contract,
            )
        )
        db.flush()
        db.add(
            AudioChunk(
                id=f"{stream_row_id}:0",
                stream_id=stream_row_id,
                sequence=0,
                start_sample=0,
                sample_count=32000,
                checksum=pcm_sha,
                contract=stream_contract,
                object_key=audio_key,
                object_size=len(pcm_bytes),
            )
        )
        db.add(
            AsrJob(
                id=job_id,
                stream_id=stream_row_id,
                start_sample=16000,
                end_sample=32000,
                core_start=16000,
                core_end=32000,
                binding=stream_contract,
                status="completed",
            )
        )
        db.flush()
        db.add(
            TranscriptSegment(
                id=job_id,
                result={
                    "id": job_id,
                    "stream_id": str(stream_ext_id),
                    "epoch": str(stream_epoch),
                    "session_utc_origin": t_origin.isoformat(),
                    "source_kind": "speaker",
                    "provider_source_id": "rtc:audio:1",
                    "participant_id": "p-clara",
                    "start": 20.0,
                    "end": 22.0,
                    "confidence": 0.95,
                    "text": "Hier auf der Folie sehen wir den neuen Ingress-Pfad.",
                    "participant_name": "Clara Diagramm",
                    "speaker_id": "p-clara",
                    "attribution_unknown": False,
                    "words": [],
                },
            )
        )
        db.add(
            McpOAuthClient(
                client_id="mcp-kf-client",
                client_name="Keyframe MCP Test",
                redirect_uris=["http://127.0.0.1:9999/cb"],
                token_endpoint_auth_method="none",
            )
        )
        db.flush()
        db.add(
            McpOAuthGrant(
                client_id="mcp-kf-client",
                client_name="Keyframe MCP Test",
                owner_sub="sub-alice",
                owner_email="alice@mayflower.de",
                owner_name="Alice Meier",
                is_operator=False,
                scopes=["mcp:read"],
                access_token_hash=hashlib.sha256(mcp_access_tok.encode()).hexdigest(),
                access_expires_at=datetime.now(UTC) + timedelta(hours=1),
                refresh_token_hash=hashlib.sha256(b"unused-refresh-kf").hexdigest(),
                refresh_expires_at=datetime.now(UTC) + timedelta(days=1),
            )
        )
        db.commit()
        share_token = export_reader_token(rec)
        assert share_token is not None

    # Override speaker name via PATCH -> verify 3-key presenter resolution & multi-attempt offsets
    patch_res = client.patch(
        f"/v1/recordings/{rec_id}",
        headers=alice_hdrs,
        json={"speaker_overrides": {"p-clara": "Dr. Clara Diagramm"}},
    )
    assert patch_res.status_code == 200
    tx = patch_res.json()
    assert [kf["id"] for kf in tx["keyframes"]] == [str(kf1_id), str(kf2_id)]
    assert tx["keyframes"][0]["offset_seconds"] == 12.0
    assert tx["keyframes"][0]["presenter"] == "Dr. Clara Diagramm"
    assert tx["keyframes"][1]["offset_seconds"] == 125.5
    assert tx["keyframes"][1]["presenter"] == "Dave Folie"

    # Markdown export contains credential-free chronological slide link markers and zero ?token=
    md_export = client.get(f"/v1/recordings/{rec_id}/exports/md", headers=alice_hdrs)
    assert md_export.status_code == 200
    md_text = md_export.text
    assert (
        f"> **[00:12] Screen share (Dr. Clara Diagramm):** "
        f"[https://wortlaut.example.org/ui#view=meetings&id={rec_id}]"
    ) in md_text
    assert "token=" not in md_text
    assert "![Screen" not in md_text
    assert md_text.index("[00:12] Screen share") < md_text.index("Ingress-Pfad")
    assert md_text.index("Ingress-Pfad") < md_text.index("[02:05] Screen share (Dave Folie)")

    # Auth matrix on GET /v1/recordings/{id}/keyframes/{kf_id}.png
    img_url_1 = f"/v1/recordings/{rec_id}/keyframes/{kf1_id}.png"
    # ?token= query parameter without Authorization header MUST return 401
    assert client.get(f"{img_url_1}?token={share_token}").status_code == 401
    assert client.get(f"{img_url_1}?token=fixture-api-token").status_code == 401
    # Unrelated user Bob gets 404
    assert client.get(img_url_1, headers=bob_hdrs).status_code == 404

    mcp_hdrs = {"Authorization": f"Bearer {mcp_access_tok}"}
    for hdrs in (op_hdrs, alice_hdrs, {"Authorization": f"Bearer {share_token}"}, mcp_hdrs):
        img_res = client.get(img_url_1, headers=hdrs)
        assert img_res.status_code == 200
        assert img_res.headers["content-type"] == "image/png"
        assert img_res.headers["cache-control"] == "private, max-age=3600"
        assert img_res.headers["content-security-policy"] == "default-src 'none'"
        assert img_res.content == png_slide1

    # MCP tools & resource template verification
    def _mcp_rpc(hdrs: dict[str, str], method: str, params: dict | None = None):
        return client.post(
            "/mcp",
            headers=hdrs,
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        ).json()

    # resources/list stays O(1) without per-keyframe fan-out; templates include keyframe PNG
    res_list = _mcp_rpc(mcp_hdrs, "resources/list")["result"]["resources"]
    assert all(not r["uri"].endswith(".png") for r in res_list)
    tpl_uris = {
        t["uriTemplate"]
        for t in _mcp_rpc(mcp_hdrs, "resources/templates/list")["result"]["resourceTemplates"]
    }
    assert "wortlaut://recordings/{recording_id}/keyframes/{keyframe_id}.png" in tpl_uris

    mcp_rec = _mcp_rpc(
        mcp_hdrs,
        "tools/call",
        {"name": "get_recording", "arguments": {"recording_id": str(rec_id)}},
    )["result"]["structuredContent"]
    assert mcp_rec["transcript"]["keyframe_count"] == 2
    kf1_uri = f"wortlaut://recordings/{rec_id}/keyframes/{kf1_id}.png"
    assert mcp_rec["keyframes"][0]["resource_uri"] == kf1_uri

    mcp_tx_filtered = _mcp_rpc(
        mcp_hdrs,
        "tools/call",
        {
            "name": "get_transcript",
            "arguments": {
                "recording_id": str(rec_id),
                "speaker": "Dave",
                "start_seconds": 100.0,
                "end_seconds": 130.0,
            },
        },
    )["result"]["structuredContent"]
    assert [k["id"] for k in mcp_tx_filtered["keyframes"]] == [str(kf2_id)]

    blob_read = _mcp_rpc(mcp_hdrs, "resources/read", {"uri": kf1_uri})["result"]["contents"][0]
    assert blob_read["mimeType"] == "image/png"
    assert base64.b64decode(blob_read["blob"]) == png_slide1

    # DELETE /v1/recordings/{id}/keyframes/{kf_id} authorization & S3 cleanup
    del_url_2 = f"/v1/recordings/{rec_id}/keyframes/{kf2_id}"
    assert (
        client.delete(del_url_2, headers={"Authorization": f"Bearer {share_token}"}).status_code
        == 401
    )
    assert client.delete(del_url_2, headers=bob_hdrs).status_code == 404
    assert client.delete(del_url_2, headers=alice_hdrs).status_code == 204
    assert not _s3_exists(storage, f"keyframes/{rec_id}/{att2_id}/0000.png")
    assert client.get(f"{del_url_2}.png", headers=alice_hdrs).status_code == 404
    assert _mcp_rpc(
        mcp_hdrs,
        "resources/read",
        {"uri": f"wortlaut://recordings/{rec_id}/keyframes/{kf2_id}.png"},
    )["error"]["code"] == -32002

    # 24-hour audio retention deletes audio/{rec_id}/ while preserving keyframes/{rec_id}/!
    s3_key_1 = f"keyframes/{rec_id}/{att1_id}/0000.png"
    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        rec.processing_finished_at = datetime.now(UTC) - timedelta(hours=26)
        db.commit()
    retention_pass(database)
    assert not _s3_exists(storage, audio_key)
    assert _s3_exists(storage, s3_key_1)
    assert client.get(img_url_1, headers=alice_hdrs).status_code == 200

    # 30-day transcript retention purges keyframes/{rec_id}/ in S3 and returns 410 Gone
    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        rec.processing_finished_at = datetime.now(UTC) - timedelta(days=31)
        db.commit()
    retention_pass(database)
    assert not _s3_exists(storage, s3_key_1)
    assert client.get(img_url_1, headers=op_hdrs).status_code == 410


def test_patch_optout_and_delete_recording_purge_keyframes(client, database, storage):
    from wortlaut.models import Attempt, Recording, RecordingKeyframe

    op_hdrs = {"Authorization": "Bearer fixture-api-token"}
    rec_id, att_id, cred = _create_claimed_attempt(client, op_hdrs)
    t0 = datetime.now(UTC)

    png_a = _make_png(320, 180, (10, 20, 30))
    png_b = _make_png(320, 180, (40, 50, 60))
    for seq, (pid, pname, blob) in enumerate(
        [("p-opt", "Frank Opt", png_a), ("p-keep", "Grace Keep", png_b)]
    ):
        r = client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={
                "Authorization": f"Bearer {cred}",
                "X-Worker-ID": "worker-kf-1",
                "Content-Type": "image/png",
                "X-Wortlaut-Keyframe": _encode_meta_header(
                    {
                        "sequence": seq,
                        "provider_source_id": f"rtc:s:{seq}",
                        "participant_id": pid,
                        "participant_name": pname,
                        "captured_at": (t0 + timedelta(seconds=seq * 10)).isoformat(),
                        "width": 320,
                        "height": 180,
                        "sha256": hashlib.sha256(blob).hexdigest(),
                    }
                ),
            },
            content=blob,
        )
        assert r.status_code == 201

    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        att = db.get(Attempt, att_id)
        att.ended_at = datetime.now(UTC)
        att.end_reason = "normal"
        rec.active_attempt_id = None
        rec.participation = "ended"
        rec.processing = "completed"
        rec.processing_finished_at = datetime.now(UTC)
        db.commit()

    # PATCH opted_out_speakers purges Frank's S3 object while keeping Grace's
    patch_res = client.patch(
        f"/v1/recordings/{rec_id}",
        headers=op_hdrs,
        json={"opted_out_speakers": ["Frank Opt"]},
    )
    assert patch_res.status_code == 200
    assert [k["presenter"] for k in patch_res.json()["keyframes"]] == ["Grace Keep"]
    assert not _s3_exists(storage, f"keyframes/{rec_id}/{att_id}/0000.png")
    assert _s3_exists(storage, f"keyframes/{rec_id}/{att_id}/0001.png")

    # DELETE /v1/recordings/{id} purges remaining S3 keyframes and DB rows
    del_res = client.delete(f"/v1/recordings/{rec_id}", headers=op_hdrs)
    assert del_res.status_code == 200
    assert not _s3_exists(storage, f"keyframes/{rec_id}/{att_id}/0001.png")
    with Session(database) as db:
        remaining = db.scalars(
            select(RecordingKeyframe).where(RecordingKeyframe.recording_id == rec_id)
        ).all()
        assert remaining == []


def test_deferred_delete_resilience_and_silent_share_quality(
    client, database, storage, monkeypatch
):
    from botocore.exceptions import ClientError

    from wortlaut.models import Attempt, Recording, RecordingKeyframe
    from wortlaut.retention import retention_pass

    op_hdrs = {"Authorization": "Bearer fixture-api-token"}
    rec_id, att_id, cred = _create_claimed_attempt(client, op_hdrs)
    t0 = datetime.now(UTC)

    # Report active share with 2 roster participants and 0 active audio samples
    st_res = client.post(
        f"/v1/attempts/{att_id}/status",
        headers={"Authorization": f"Bearer {cred}", "X-Worker-ID": "worker-kf-1"},
        json={
            "participation": "capturing",
            "capability": "verified",
            "streams": 0,
            "audio_samples": 0,
            "active_audio_samples": 0,
            "participant_sources": {
                "available": True,
                "total": 2,
                "dom_participants": 2,
                "sources": [],
            },
            "keyframes": {
                "capability": "active",
                "active_share": True,
                "evaluated_ticks": 8,
                "emitted": 2,
                "uploaded": 2,
            },
        },
    )
    assert st_res.status_code == 200

    ids: list[str] = []
    for seq in (0, 1):
        blob = _make_png(320, 180, (20 + seq * 50, 80, 140))
        r = client.post(
            f"/v1/attempts/{att_id}/keyframes",
            headers={
                "Authorization": f"Bearer {cred}",
                "X-Worker-ID": "worker-kf-1",
                "Content-Type": "image/png",
                "X-Wortlaut-Keyframe": _encode_meta_header(
                    {
                        "sequence": seq,
                        "provider_source_id": "rtc:silent:1",
                        "participant_id": "p-silent",
                        "participant_name": "Hannah Silent",
                        "captured_at": (t0 + timedelta(seconds=seq * 12)).isoformat(),
                        "width": 320,
                        "height": 180,
                        "sha256": hashlib.sha256(blob).hexdigest(),
                    }
                ),
            },
            content=blob,
        )
        assert r.status_code == 201
        ids.append(r.json()["id"])

    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        att = db.get(Attempt, att_id)
        att.ended_at = datetime.now(UTC)
        att.end_reason = "normal"
        att.process_ended_at = datetime.now(UTC)
        rec.active_attempt_id = None
        rec.participation = "ended"
        rec.processing = "completed"
        rec.processing_finished_at = datetime.now(UTC)
        db.commit()

    exp_res = client.get(f"/v1/recordings/{rec_id}/exports/json", headers=op_hdrs)
    assert exp_res.status_code == 200
    exp_json = exp_res.json()
    assert exp_json["segments"] == []
    assert len(exp_json["keyframes"]) == 2
    assert exp_json["quality"]["capture_anomaly"] is False
    assert exp_json["attempts"][0]["keyframes"]["capability"] == "active"

    # Simulate S3 outage during DELETE /keyframes/{id} -> 204 tombstone + deferred S3 cleanup
    orig_delete = storage.delete_object
    s3_key_0 = f"keyframes/{rec_id}/{att_id}/0000.png"
    s3_key_1 = f"keyframes/{rec_id}/{att_id}/0001.png"

    def _fail_all_deletes(key: str):
        raise ClientError(
            {"Error": {"Code": "InternalError", "Message": "transient s3 outage"}},
            "DeleteObject",
        )

    monkeypatch.setattr(storage, "delete_object", _fail_all_deletes)
    del_0 = client.delete(f"/v1/recordings/{rec_id}/keyframes/{ids[0]}", headers=op_hdrs)
    del_1 = client.delete(f"/v1/recordings/{rec_id}/keyframes/{ids[1]}", headers=op_hdrs)
    get_0 = client.get(f"/v1/recordings/{rec_id}/keyframes/{ids[0]}.png", headers=op_hdrs)
    assert del_0.status_code == 204
    assert del_1.status_code == 204
    assert get_0.status_code == 404
    assert _s3_exists(storage, s3_key_0)
    assert _s3_exists(storage, s3_key_1)

    # Partial S3 failure on s3_key_0 -> retention_pass sweeps s3_key_1 without aborting
    def _fail_key_0_only(key: str):
        if key == s3_key_0:
            raise ClientError(
                {"Error": {"Code": "InternalError", "Message": "key 0 stuck"}},
                "DeleteObject",
            )
        return orig_delete(key)

    monkeypatch.setattr(storage, "delete_object", _fail_key_0_only)
    retention_pass(database)
    assert _s3_exists(storage, s3_key_0)
    assert not _s3_exists(storage, s3_key_1)

    # Restore S3 -> next retention_pass sweeps s3_key_0
    monkeypatch.setattr(storage, "delete_object", orig_delete)
    retention_pass(database)
    assert not _s3_exists(storage, s3_key_0)
    with Session(database) as db:
        rows = db.scalars(
            select(RecordingKeyframe).where(RecordingKeyframe.recording_id == rec_id)
        ).all()
        assert all(r.deleted_at is not None and r.object_key == "" for r in rows)
