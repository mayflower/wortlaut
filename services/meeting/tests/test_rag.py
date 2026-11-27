"""Unit and real PostgreSQL 17 integration tests for local hybrid RAG protocol search."""

from __future__ import annotations

import json
import struct
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioStream,
    GlossaryEntry,
    ProtocolChunk,
    Recording,
    RecordingKeyframe,
    TranscriptSegment,
)
from wortlaut.oidc import Principal
from wortlaut.settings import get_settings

API = {"Authorization": "Bearer fixture-api-token"}


# ---------------------------------------------------------------------------
# Pure-Python minimal ONNX ModelProto wire encoder (zero `onnx` package dep)
# ---------------------------------------------------------------------------


def _pb_varint(val: int) -> bytes:
    if val < 0:
        val += 1 << 64
    out = bytearray()
    while True:
        byte = val & 0x7F
        val >>= 7
        if val:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            break
    return bytes(out)


def _pb_tag(field_num: int, wire_type: int) -> bytes:
    return _pb_varint((field_num << 3) | wire_type)


def _pb_int(field_num: int, val: int) -> bytes:
    return _pb_tag(field_num, 0) + _pb_varint(val)


def _pb_bytes(field_num: int, data: bytes) -> bytes:
    return _pb_tag(field_num, 2) + _pb_varint(len(data)) + data


def _pb_str(field_num: int, text: str) -> bytes:
    return _pb_bytes(field_num, text.encode("utf-8"))


def _onnx_value_info(name: str, elem_type: int, dims: list[int | str]) -> bytes:
    shape_bytes = b""
    for d in dims:
        dim_msg = _pb_int(1, d) if isinstance(d, int) else _pb_str(2, d)
        shape_bytes += _pb_bytes(1, dim_msg)
    tensor_type = _pb_int(1, elem_type) + _pb_bytes(2, shape_bytes)
    type_proto = _pb_bytes(1, tensor_type)
    return _pb_str(1, name) + _pb_bytes(2, type_proto)


def _onnx_tensor_proto(name: str, elem_type: int, dims: list[int], raw_data: bytes) -> bytes:
    msg = b""
    for d in dims:
        msg += _pb_int(1, d)
    msg += _pb_int(2, elem_type)
    msg += _pb_str(8, name)
    msg += _pb_bytes(9, raw_data)
    return msg


def _onnx_attr_int(name: str, val: int) -> bytes:
    # AttributeProto: name=1, i=3, type=20 (INT=2)
    return _pb_str(1, name) + _pb_int(3, val) + _pb_int(20, 2)


def _onnx_node(
    op_type: str,
    inputs: list[str],
    outputs: list[str],
    attrs: list[bytes] | None = None,
) -> bytes:
    msg = b""
    for inp in inputs:
        msg += _pb_str(1, inp)
    for out in outputs:
        msg += _pb_str(2, out)
    msg += _pb_str(4, op_type)
    for a in attrs or []:
        msg += _pb_bytes(5, a)
    return msg


def _write_synthetic_e5_onnx_fixture(model_dir: Path) -> None:
    """Create minimal `tokenizer.json` + 3-input `(B, T, 384)` ONNX model in `model_dir`."""
    model_dir.mkdir(parents=True, exist_ok=True)
    vocab = {
        "<unk>": 0,
        "<pad>": 1,
        "query:": 2,
        "passage:": 3,
        "feature": 4,
        "flags": 5,
        "rollout": 6,
        "postgres": 7,
        "database": 8,
    }
    tok_json = {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": [
            {
                "id": 0,
                "content": "<unk>",
                "single_word": False,
                "lstrip": False,
                "rstrip": False,
                "normalized": False,
                "special": True,
            },
            {
                "id": 1,
                "content": "<pad>",
                "single_word": False,
                "lstrip": False,
                "rstrip": False,
                "normalized": False,
                "special": True,
            },
        ],
        "normalizer": {"type": "Lowercase"},
        "pre_tokenizer": {"type": "WhitespaceSplit"},
        "post_processor": None,
        "decoder": None,
        "model": {"type": "WordLevel", "vocab": vocab, "unk_token": "<unk>"},
    }
    (model_dir / "tokenizer.json").write_text(json.dumps(tok_json), encoding="utf-8")

    # Element types: FLOAT=1, INT64=7
    axis_raw = struct.pack("<q", 2)
    basis = np.linspace(0.5, 2.5, 384, dtype=np.float32)
    basis_raw = basis.tobytes()

    nodes = [
        _onnx_node("Cast", ["input_ids"], ["f_ids"], [_onnx_attr_int("to", 1)]),
        _onnx_node("Cast", ["attention_mask"], ["f_mask"], [_onnx_attr_int("to", 1)]),
        _onnx_node("Cast", ["token_type_ids"], ["f_tti"], [_onnx_attr_int("to", 1)]),
        _onnx_node("Add", ["f_ids", "f_tti"], ["f_sum"]),
        _onnx_node("Mul", ["f_sum", "f_mask"], ["f_masked"]),
        _onnx_node("Unsqueeze", ["f_masked", "axis_const"], ["f_3d"]),
        _onnx_node("Add", ["f_3d", "basis_const"], ["last_hidden_state"]),
    ]
    inits = [
        _onnx_tensor_proto("axis_const", 7, [1], axis_raw),
        _onnx_tensor_proto("basis_const", 1, [1, 1, 384], basis_raw),
    ]
    inputs = [
        _onnx_value_info("input_ids", 7, ["B", "T"]),
        _onnx_value_info("attention_mask", 7, ["B", "T"]),
        _onnx_value_info("token_type_ids", 7, ["B", "T"]),
    ]
    outputs = [_onnx_value_info("last_hidden_state", 1, ["B", "T", 384])]

    graph = b""
    for n in nodes:
        graph += _pb_bytes(1, n)
    graph += _pb_str(2, "synthetic_e5")
    for init in inits:
        graph += _pb_bytes(5, init)
    for inp in inputs:
        graph += _pb_bytes(11, inp)
    for out in outputs:
        graph += _pb_bytes(12, out)

    opset = _pb_int(2, 13)
    model_proto = _pb_int(1, 8) + _pb_bytes(7, graph) + _pb_bytes(8, opset)
    (model_dir / "model_quantized.onnx").write_bytes(model_proto)


def _seed_completed_recording(
    db: Session,
    *,
    owner_email: str,
    title: str | None = "Architektur Review",
    provider: str = "google_meet",
    starts_at: datetime | None = None,
    segments: list[dict] | None = None,
    protocol_meta: dict | None = None,
    keyframes: list[dict] | None = None,
    pause_windows: list[dict] | None = None,
) -> uuid.UUID:
    now = starts_at or datetime(2026, 11, 18, 10, 0, 0, tzinfo=UTC)
    rec_id = uuid.uuid4()
    att_id = uuid.uuid4()
    stream_pk = uuid.uuid4()
    stream_ext = uuid.uuid4()
    epoch = uuid.uuid4()
    origin_iso = now.isoformat()

    rec = Recording(
        id=rec_id,
        idempotency_key=f"rag-{rec_id}",
        request_digest=rec_id.hex,
        meeting_url=f"https://meet.google.com/{rec_id.hex[:10]}",
        provider=provider,
        title=title,
        owner_sub=f"sub-{owner_email}",
        owner_email=owner_email,
        starts_at=now,
        ends_at=now + timedelta(minutes=45),
        participation="ended",
        processing="completed",
        audio_closed_at=now + timedelta(minutes=45),
        processing_finished_at=now + timedelta(minutes=46),
        protocol_meta=dict(protocol_meta or {}),
    )
    diag = {}
    if pause_windows:
        diag["participant_sources"] = {"pause_windows": pause_windows}
    att = Attempt(
        id=att_id,
        recording_id=rec_id,
        credential_hash=rec_id.hex,
        credential_expires_at=now + timedelta(hours=2),
        worker_id="worker-rag",
        ended_at=now + timedelta(minutes=45),
        process_ended_at=now + timedelta(minutes=45),
        end_reason="normal",
        diagnostics=diag,
    )
    db.add(rec)
    db.flush()
    db.add(att)
    db.flush()

    if segments:
        stream = AudioStream(
            id=stream_pk,
            attempt_id=att_id,
            stream_id=stream_ext,
            epoch=epoch,
            contract={
                "session_utc_origin": origin_iso,
                "monotonic_origin_ms": 0,
                "session_monotonic_origin_ms": 0,
                "provider_source_id": "rtc:1",
                "participant_id": "p-1",
                "participant_name": segments[0].get("speaker", "Alice"),
                "source_kind": "speaker",
                "attribution_unknown": False,
            },
            scan_complete=True,
        )
        db.add(stream)
        db.flush()
        for idx, seg in enumerate(segments):
            job_id = f"rag-job-{rec_id.hex[:12]}-{idx}"
            s_start = float(seg.get("start", idx * 5.0))
            s_end = float(seg.get("end", s_start + 3.0))
            spk = str(seg.get("speaker") or "Alice")
            pid = str(seg.get("participant_id") or f"pid-{spk.lower()}")
            db.add(
                AsrJob(
                    id=job_id,
                    stream_id=stream_pk,
                    start_sample=int(s_start * 16000),
                    end_sample=int(s_end * 16000),
                    core_start=int(s_start * 16000),
                    core_end=int(s_end * 16000),
                    binding={"participant_id": pid, "participant_name": spk},
                    status="completed",
                )
            )
            db.flush()
            db.add(
                TranscriptSegment(
                    id=job_id,
                    result={
                        "id": job_id,
                        "stream_id": str(stream_ext),
                        "epoch": str(epoch),
                        "session_utc_origin": origin_iso,
                        "source_kind": "speaker",
                        "provider_source_id": f"rtc:{pid}",
                        "participant_id": pid,
                        "speaker_id": pid,
                        "participant_name": spk,
                        "attribution_unknown": False,
                        "start": s_start,
                        "end": s_end,
                        "confidence": 0.95,
                        "text": seg["text"],
                        "words": [],
                    },
                )
            )

    for idx, kf in enumerate(keyframes or []):
        kf_id = uuid.UUID(str(kf["id"])) if kf.get("id") else uuid.uuid4()
        off = float(kf.get("offset_seconds", 10.0))
        db.add(
            RecordingKeyframe(
                id=kf_id,
                recording_id=rec_id,
                attempt_id=att_id,
                sequence=idx + 1,
                provider_source_id="screen:1",
                participant_id=str(kf.get("participant_id") or "pid-screen"),
                participant_name=str(kf.get("presenter") or "Dr. Weber"),
                captured_at=now + timedelta(seconds=off),
                width=1280,
                height=720,
                byte_size=1024,
                sha256="a" * 64,
                object_key=f"recordings/{rec_id}/keyframes/{kf_id}.png",
            )
        )

    db.commit()
    return rec_id


# ---------------------------------------------------------------------------
# 1. Real tokenizers + ONNX Runtime + float16 round-trip + lexical-only fallback
# ---------------------------------------------------------------------------


def test_real_onnx_tokenizer_pooling_float16_and_lexical_fallback(tmp_path, monkeypatch):
    from wortlaut import rag

    rag._reset_embedder_for_tests()

    # Missing model directory -> lexical-only mode with no network call
    missing_dir = tmp_path / "does-not-exist"
    monkeypatch.setenv("WORTLAUT_EMBEDDING_MODEL_DIR", str(missing_dir))
    get_settings.cache_clear()
    assert rag.embedder_is_available() is False
    assert rag.active_embedding_model_id() == rag.LEXICAL_ONLY_MODEL_ID
    empty_vecs = rag.embed_texts([], prefix="query: ")
    assert empty_vecs.shape == (0, rag.EMBEDDING_DIM)
    lex_vecs = rag.embed_texts(["feature flags"], prefix="query: ")
    assert lex_vecs.shape == (1, 0)

    # Real tokenizers.Tokenizer + onnxruntime.InferenceSession with synthetic 3-input ONNX graph
    model_dir = tmp_path / "synth-e5"
    _write_synthetic_e5_onnx_fixture(model_dir)
    monkeypatch.setenv("WORTLAUT_EMBEDDING_MODEL_DIR", str(model_dir))
    get_settings.cache_clear()
    rag._reset_embedder_for_tests()

    assert rag.embedder_is_available() is True
    assert rag.active_embedding_model_id() == rag.EMBEDDING_MODEL_ID
    assert rag.embed_texts([], prefix="passage: ").shape == (0, rag.EMBEDDING_DIM)

    vecs = rag.embed_texts(["feature flags", "postgres database rollout"], prefix="passage: ")
    assert vecs.shape == (2, rag.EMBEDDING_DIM)
    assert vecs.dtype == np.float32
    norms = np.linalg.norm(vecs, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)

    # float16 `<f2` serialization halves storage (768 bytes) with < 1e-3 cosine drift
    blob0 = rag.pack_float16_embedding(vecs[0])
    blob1 = rag.pack_float16_embedding(vecs[1])
    assert len(blob0) == rag.EMBEDDING_DIM * 2 == 768
    unpacked = rag.unpack_float16_embeddings([blob0, blob1])
    assert unpacked.shape == (2, rag.EMBEDDING_DIM)
    assert float(unpacked[0] @ vecs[0]) > 0.999
    assert abs(float(unpacked[0] @ unpacked[1]) - float(vecs[0] @ vecs[1])) < 1e-3


# ---------------------------------------------------------------------------
# 2. Multi-config GIN tsvector + punctuation-safe OR-disjunction & RRF fusion
# ---------------------------------------------------------------------------


def test_hybrid_tsvector_punctuation_rrf_noise_floor_diversity_and_scan_cap(database, monkeypatch):
    from wortlaut import rag

    alice = Principal(kind="user", sub="sub-alice@example.org", email="alice@example.org")
    bob = Principal(kind="user", sub="sub-bob@example.org", email="bob@example.org")
    nobody = Principal(kind="user", sub=None, email=None)

    with Session(database) as db:
        rec_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="S/4HANA & PROJ-270 Migration",
            segments=[
                {
                    "speaker": "Dr. Weber",
                    "start": 0.0,
                    "end": 4.0,
                    "text": (
                        "Im Projekt Phoenix ersetzen wir Ragas fuer Ticket PROJ-270 "
                        "ohne Re-Deploy auf S/4HANA."
                    ),
                },
                {
                    "speaker": "Clara",
                    "start": 80.0,
                    "end": 85.0,
                    "text": "Zweite eigenstaendige Diskussion ueber Kostenplanung Q4.",
                },
            ],
            protocol_meta={
                "summary": {
                    "summary": "Ueberblick zur Migration.",
                    "decisions": [
                        {
                            "text": "Feature-Schalter werden ohne Neustart umgeschaltet.",
                            "timestamp": "11:00:05",
                            "offset_seconds": 5.0,
                        }
                    ],
                    "topics": [
                        {
                            "title": "Rollout-Strategie",
                            "details": "Schrittweise Freigabe pro Mandant.",
                        }
                    ],
                    "action_items": [
                        {
                            "owner": "Clara",
                            "task": "Ticket PROJ-270 abschliessen",
                            "due": "Freitag",
                        }
                    ],
                },
                "notes": "# Architektur\n\nS/4HANA Konnektor pruefen.",
            },
        )
        # Bob's private recording with identical keywords must never leak to Alice
        _seed_completed_recording(
            db,
            owner_email="bob@example.org",
            title="Bobs PROJ-270 Geheimnis",
            segments=[{"speaker": "Bob", "start": 0.0, "end": 3.0, "text": "PROJ-270 geheim."}],
        )

    assert rag.rag_index_batch(database) == 2
    assert rag.rag_index_pass(database) is False

    # Punctuated IDs (`PROJ-270`, `S/4HANA`) + partial-match query work without tsquery errors
    with Session(database) as db:
        res_id = rag.search_protocol_chunks(
            db,
            alice,
            query="PROJ-270 Rollout ohne Neustart S/4HANA",
            limit=10,
        )
        assert res_id.hits
        assert all(h.recording_id == rec_id for h in res_id.hits)
        assert any("PROJ-270" in h.content for h in res_id.hits)

        # `empty_for_principal` RBAC guard returns empty instead of scanning all tenants
        res_empty = rag.search_protocol_chunks(db, nobody, query="PROJ-270")
        assert res_empty.hits == []

        # Bob only sees his own recording
        res_bob = rag.search_protocol_chunks(db, bob, query="PROJ-270")
        assert len(res_bob.hits) == 1
        assert res_bob.hits[0].recording_id != rec_id

        # `kind="topic"` filters strictly to topic chunks
        res_topic = rag.search_protocol_chunks(db, alice, query="Rollout", kind="topic", limit=5)
        assert len(res_topic.hits) == 1
        assert res_topic.hits[0].chunk_kind == "topic"

    # Semantic-only paraphrase hit (zero lexical overlap) + 0.65 vector noise floor
    basis_a = np.zeros(rag.EMBEDDING_DIM, dtype=np.float32)
    basis_a[0] = 1.0
    basis_b = np.zeros(rag.EMBEDDING_DIM, dtype=np.float32)
    basis_b[1] = 1.0

    def semantic_override(texts: list[str], prefix: str) -> np.ndarray:
        out = []
        for t in texts:
            low = t.lower()
            if "ohne neustart" in low or "zero downtime toggle" in low:
                out.append(basis_a)
            elif "completely unrelated quantum bananas" in low:
                # Cosine 0.0 against basis_a and basis_b -> rejected by 0.65 floor
                v = np.zeros(rag.EMBEDDING_DIM, dtype=np.float32)
                v[2] = 1.0
                out.append(v)
            else:
                out.append(basis_b)
        return np.vstack(out)

    rag.set_embedder_override_for_tests(semantic_override)
    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        meta = dict(rec.protocol_meta or {})
        rag.invalidate_recording_rag_index(meta)
        rec.protocol_meta = meta
        db.commit()
    assert rag.rag_index_batch(database) == 1

    with Session(database) as db:
        sem_hit = rag.search_protocol_chunks(db, alice, query="zero downtime toggle", limit=5)
        assert len(sem_hit.hits) == 1
        assert sem_hit.hits[0].chunk_kind == "decision"
        assert "ohne Neustart" in sem_hit.hits[0].content

        noise = rag.search_protocol_chunks(
            db, alice, query="completely unrelated quantum bananas", limit=5
        )
        assert noise.hits == []

    # Per-recording diversity cap (<= 3 per recording when recording_id omitted) + scanned_capped
    with Session(database) as db:
        rec_b = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Zweites PROJ-270 Meeting",
            segments=[
                {
                    "speaker": "Alice",
                    "start": 0.0,
                    "end": 3.0,
                    "text": "Zweiter Hinweis zu PROJ-270 Migration.",
                }
            ],
        )
    assert rag.rag_index_batch(database) == 1

    monkeypatch.setattr(rag, "MAX_VECTOR_SCAN_CHUNKS", 3)
    with Session(database) as db:
        capped = rag.search_protocol_chunks(db, alice, query="PROJ-270 Migration", limit=4)
        assert capped.scanned_capped is True
        counts: dict[uuid.UUID, int] = {}
        for h in capped.hits:
            counts[h.recording_id] = counts.get(h.recording_id, 0) + 1
        assert len(capped.hits) == 4
        assert len(counts) == 2
        assert max(counts.values()) <= 3
        assert rec_b in counts

        # Escaped SQL LIKE wildcards in speaker filter do not act as catch-all wildcards
        wildcard_spk = rag.search_protocol_chunks(db, alice, query="PROJ-270", speaker="%", limit=5)
        assert wildcard_spk.hits == []

    # Lexical-only mode must not report scanned_capped=True (no vector scan performed)
    rag._reset_embedder_for_tests()
    monkeypatch.setenv("WORTLAUT_EMBEDDING_MODEL_DIR", "/nonexistent/model/dir")
    get_settings.cache_clear()
    with Session(database) as db:
        lex_only = rag.search_protocol_chunks(db, alice, query="PROJ-270", limit=5)
        assert lex_only.lexical_only is True
        assert lex_only.scanned_capped is False
        assert lex_only.hits


# ---------------------------------------------------------------------------
# 3. Tenant-isolated local glossary + bounded OpenAI query-only expansion
# ---------------------------------------------------------------------------


def test_glossary_tenancy_and_openai_query_expansion_guards(database, monkeypatch):
    from wortlaut import llm as llm_module
    from wortlaut import rag
    from wortlaut.glossary import (
        expand_query_with_local_glossary,
        resolve_principal_search_glossary,
    )

    alice = Principal(kind="user", sub="sub-alice", email="alice@example.org")
    with Session(database) as db:
        db.add_all(
            [
                GlossaryEntry(
                    owner_email="",
                    term_key="acmestack",
                    term="AcmeStack",
                    aliases=["MyAcme"],
                    disabled=False,
                ),
                GlossaryEntry(
                    owner_email="alice@example.org",
                    term_key="projekt phoenix",
                    term="Projekt Phoenix",
                    aliases=["Phönix"],
                    disabled=False,
                ),
                GlossaryEntry(
                    owner_email="bob@example.org",
                    term_key="secret_bob",
                    term="SecretBobProject",
                    aliases=["BobAlias"],
                    disabled=False,
                ),
                GlossaryEntry(
                    owner_email="alice@example.org",
                    term_key="disabled_term",
                    term="DisabledTerm",
                    aliases=["DisAlias"],
                    disabled=True,
                ),
            ]
        )
        _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Plattform Sync",
            segments=[
                {
                    "speaker": "Alice",
                    "start": 0.0,
                    "end": 4.0,
                    "text": "AcmeStack und Projekt Phoenix sind produktiv mit Geheimtext XYZ999.",
                }
            ],
        )
        db.commit()

    assert rag.rag_index_batch(database) == 1

    with Session(database) as db:
        terms, alias_map = resolve_principal_search_glossary(db, alice)
        assert "AcmeStack" in terms
        assert "Projekt Phoenix" in terms
        assert "SecretBobProject" not in terms
        assert "DisabledTerm" not in terms
        local_exp = expand_query_with_local_glossary("Status zu MyAcme", terms, alias_map)
        assert "AcmeStack" in local_exp

    # External OpenAI query-only expansion: verifies zero transcript egress, follow_redirects=False,
    # reasoning-model max_completion_tokens, DB transaction closed before HTTP, and 503 fallback.
    monkeypatch.setenv("WORTLAUT_OPENAI_BASE_URL", "https://openai.example.test/v1")
    monkeypatch.setenv("WORTLAUT_OPENAI_API_KEY", "sk-test-secret")
    monkeypatch.setenv("WORTLAUT_OPENAI_MODEL", "o4-mini")
    get_settings.cache_clear()

    seen_calls: list[dict] = []

    def fake_openai_post(url, **kwargs):
        seen_calls.append({"url": url, **kwargs})
        assert kwargs.get("follow_redirects") is False
        body_json = kwargs["json"]
        assert "max_completion_tokens" in body_json
        assert "temperature" not in body_json
        payload_str = json.dumps(body_json)
        assert "JSON" in payload_str
        assert "Geheimtext" not in payload_str
        assert "XYZ999" not in payload_str
        assert "SecretBobProject" not in payload_str

        class Resp:
            status_code = 200
            text = ""

            def json(self):
                return {
                    "choices": [
                        {"message": {"content": '{"terms": ["Projekt Phoenix", "AcmeStack"]}'}}
                    ]
                }

        return Resp()

    monkeypatch.setattr(llm_module.httpx, "post", fake_openai_post)
    with Session(database) as db:
        res = rag.search_protocol_chunks(db, alice, query="MyAcme Status")
        assert len(seen_calls) == 1
        assert seen_calls[0]["url"] == "https://openai.example.test/v1/chat/completions"
        assert res.hits

    # HTTP 503 / timeout degrades to local hybrid RRF without raising
    def failing_post(url, **kwargs):
        raise httpx.TimeoutException("upstream timeout")

    monkeypatch.setattr(llm_module.httpx, "post", failing_post)
    with Session(database) as db:
        res_fallback = rag.search_protocol_chunks(db, alice, query="MyAcme")
        assert res_fallback.hits

    # Saturated concurrency semaphore skips outbound HTTP cleanly
    acquired = [llm_module._EXPANSION_SEMAPHORE.acquire(blocking=False) for _ in range(4)]
    try:
        assert all(acquired)
        assert llm_module.expand_search_query("MyAcme", ["AcmeStack"]) == []
    finally:
        for _ in acquired:
            llm_module._EXPANSION_SEMAPHORE.release()

    # Explicit opt-out WORTLAUT_ENABLE_RAG_QUERY_EXPANSION=false skips outbound HTTP
    monkeypatch.setenv("WORTLAUT_ENABLE_RAG_QUERY_EXPANSION", "false")
    get_settings.cache_clear()
    called_when_disabled = []

    def fail_if_called(url, **kwargs):
        called_when_disabled.append(url)
        raise AssertionError("expand_search_query must not call OpenAI when opted out")

    monkeypatch.setattr(llm_module.httpx, "post", fail_if_called)
    assert llm_module.expand_search_query("MyAcme", ["AcmeStack"]) == []
    assert called_when_disabled == []
    monkeypatch.setenv("WORTLAUT_ENABLE_RAG_QUERY_EXPANSION", "true")
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# 4. WORTLAUT_ENABLE_LLM_SUMMARY privacy gate + dynamic /privacy disclosure
# ---------------------------------------------------------------------------


def test_openai_summary_privacy_gate_and_dynamic_privacy_page(client, database, monkeypatch):
    from wortlaut import llm as llm_module

    # State 1: default local-only privacy notice
    de1 = client.get("/privacy?lang=de").text
    en1 = client.get("/privacy?lang=en").text
    assert "100 % Self-Hosted" in de1
    assert "100% Self-Hosted" in en1
    assert "nein" not in de1.lower()

    # State 2: WORTLAUT_OPENAI_BASE_URL set, WORTLAUT_ENABLE_LLM_SUMMARY=false
    monkeypatch.setenv("WORTLAUT_OPENAI_BASE_URL", "https://openai.example.test/v1")
    monkeypatch.setenv("WORTLAUT_OPENAI_API_KEY", "")
    monkeypatch.setenv("WORTLAUT_OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("WORTLAUT_ENABLE_LLM_SUMMARY", "false")
    get_settings.cache_clear()

    with Session(database) as db:
        rec_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Privacy Gate Call",
            segments=[{"speaker": "Alice", "start": 0.0, "end": 4.0, "text": "Hallo Team."}],
        )

    # Summary endpoint and internal helpers stay blocked when WORTLAUT_ENABLE_LLM_SUMMARY=false
    blocked = client.post(f"/v1/recordings/{rec_id}/summary", headers=API)
    assert blocked.status_code == 503
    from wortlaut.exports import extract_keyframe_visual_context, generate_protocol_summary

    assert extract_keyframe_visual_context(b"\x89PNG\r\n\x1a\nfake") is None
    with Session(database) as db:
        try:
            generate_protocol_summary(db, rec_id)
        except RuntimeError as exc:
            assert str(exc) == "llm_summary_disabled"
        else:
            raise AssertionError("generate_protocol_summary must fail closed when disabled")

    de2 = client.get("/privacy?lang=de").text
    en2 = client.get("/privacy?lang=en").text
    assert "Externe Suchbegriff-Erweiterung" in de2
    assert "Query-Only Search AI" in en2
    assert "100 % Self-Hosted" not in de2
    assert "nein" not in de2.lower()

    # State 2b: opting out of query expansion restores 100% self-hosted notice + Parakeet label
    monkeypatch.setenv("WORTLAUT_ENABLE_RAG_QUERY_EXPANSION", "false")
    monkeypatch.setenv("WORTLAUT_ASR_BACKEND", "parakeet")
    get_settings.cache_clear()
    de2b = client.get("/privacy?lang=de").text
    en2b = client.get("/privacy?lang=en").text
    assert "100 % Self-Hosted" in de2b
    assert "Parakeet TDT v3 ONNX" in de2b
    assert "Parakeet TDT v3 ONNX" in en2b
    assert "Qwen3-ASR" not in de2b
    assert "Qwen3-ASR" not in en2b
    monkeypatch.setenv("WORTLAUT_ENABLE_RAG_QUERY_EXPANSION", "true")
    monkeypatch.setenv("WORTLAUT_ASR_BACKEND", "")
    get_settings.cache_clear()

    # State 3: WORTLAUT_ENABLE_LLM_SUMMARY=true activates OpenAI summary + transparent notice
    monkeypatch.setenv("WORTLAUT_ENABLE_LLM_SUMMARY", "true")
    get_settings.cache_clear()

    de3 = client.get("/privacy?lang=de").text
    en3 = client.get("/privacy?lang=en").text
    assert "Konfigurierter KI-Endpunkt aktiv" in de3
    assert "Configured External AI Endpoint" in en3
    assert "nein" not in de3.lower()

    # Empty SecretStr("") omits Authorization header on keyless OpenAI-compatible servers
    captured_headers: list[dict] = []

    def fake_summary_post(url, **kwargs):
        captured_headers.append(dict(kwargs.get("headers") or {}))

        class Resp:
            status_code = 200
            text = ""

            def json(self):
                return {
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "summary": "Kurze OpenAI Zusammenfassung.",
                                        "decisions": [{"text": "Freigegeben."}],
                                        "topics": [],
                                        "action_items": [],
                                    }
                                )
                            }
                        }
                    ]
                }

        return Resp()

    monkeypatch.setattr(llm_module.httpx, "post", fake_summary_post)
    ok_sum = client.post(f"/v1/recordings/{rec_id}/summary", headers=API)
    assert ok_sum.status_code == 200
    assert ok_sum.json()["summary"]["model"] == "gpt-4o-mini"
    assert "Authorization" not in captured_headers[0]


# ---------------------------------------------------------------------------
# 5. #pause exclusion/split boundary, slide chunking, & zero-chunk recordings
# ---------------------------------------------------------------------------


def test_pause_exclusion_slide_chunking_and_empty_completed_recordings(database):
    from wortlaut import rag

    alice = Principal(kind="user", sub="sub-alice@example.org", email="alice@example.org")
    t0 = datetime(2026, 11, 18, 10, 0, 0, tzinfo=UTC)
    kf_visible = uuid.uuid4()
    kf_paused = uuid.uuid4()

    with Session(database) as db:
        # Newer empty completed recording (e.g., lobby_timeout) must NOT starve older recordings
        empty_rec_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title=None,
            starts_at=t0 + timedelta(hours=2),
            segments=[],
        )
        main_rec_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Off-the-Record Test",
            starts_at=t0,
            pause_windows=[
                {
                    "started_at": (t0 + timedelta(seconds=10)).isoformat(),
                    "ended_at": (t0 + timedelta(seconds=20)).isoformat(),
                    "by": "Alice",
                }
            ],
            segments=[
                {
                    "speaker": "Alice",
                    "start": 2.0,
                    "end": 5.0,
                    "text": "Vor der Pause oeffentlich.",
                },
                {
                    "speaker": "Alice",
                    "start": 12.0,
                    "end": 16.0,
                    "text": "GEHEIM IM PAUSE FENSTER.",
                },
                {
                    "speaker": "Alice",
                    "start": 22.0,
                    "end": 26.0,
                    "text": "Nach der Pause oeffentlich.",
                },
            ],
            keyframes=[
                {"id": kf_visible, "offset_seconds": 4.0, "presenter": "Dr. Weber"},
                {"id": kf_paused, "offset_seconds": 15.0, "presenter": "Dr. Weber"},
            ],
            protocol_meta={
                "summary": {
                    "summary": "",
                    "decisions": [
                        {
                            "text": "Geheimer Beschluss im Pause-Fenster",
                            "timestamp": "11:00:15",
                            "offset_seconds": 15.0,
                        }
                    ],
                    "topics": [],
                    "action_items": [],
                },
                "keyframe_context": {
                    str(kf_visible): {
                        "view": "Architektur-Diagramm",
                        "items": ["PROJ-270: DeepEval"],
                        "terms": ["DeepEval"],
                    },
                    str(kf_paused): {
                        "view": "Geheime Gehaltsliste",
                        "items": ["SALARY-SECRET"],
                        "terms": ["SALARY-SECRET"],
                    },
                },
            },
        )

    assert rag.rag_index_batch(database) == 2
    # Second tick does zero work because empty_rec_id was marked indexed
    assert rag.rag_index_batch(database) == 0

    with Session(database) as db:
        empty_rec = db.get(Recording, empty_rec_id)
        assert empty_rec.protocol_meta["rag_indexed_model"] == rag.EMBEDDING_MODEL_ID
        rows = list(
            db.scalars(
                select(ProtocolChunk)
                .where(ProtocolChunk.recording_id == main_rec_id)
                .order_by(ProtocolChunk.chunk_index.asc())
            ).all()
        )
        all_text = "\n".join(r.content for r in rows)
        assert "GEHEIM IM PAUSE FENSTER" not in all_text
        assert "Geheimer Beschluss im Pause-Fenster" not in all_text
        assert "SALARY-SECRET" not in all_text

        slide_rows = [r for r in rows if r.chunk_kind == "slide"]
        assert len(slide_rows) == 1
        assert slide_rows[0].keyframe_id == kf_visible
        assert "DeepEval" in slide_rows[0].content

        # Pre-pause and post-pause turns stay in separate transcript chunks (no cross-pause merge)
        tx_rows = [r for r in rows if r.chunk_kind == "transcript"]
        assert len(tx_rows) == 2
        assert "Vor der Pause" in tx_rows[0].content
        assert "Nach der Pause" not in tx_rows[0].content
        assert "Nach der Pause" in tx_rows[1].content
        assert "Vor der Pause" not in tx_rows[1].content

        res_slide = rag.search_protocol_chunks(db, alice, query="DeepEval", kind="slide")
        assert len(res_slide.hits) == 1
        assert res_slide.hits[0].keyframe_id == kf_visible


# ---------------------------------------------------------------------------
# 6. Synchronous opt-out, keyframe delete, rejoin, retention, & PATCH refresh
# ---------------------------------------------------------------------------


def test_sync_purge_on_opt_out_keyframe_delete_rejoin_and_retention(client, database, storage):
    from wortlaut import rag
    from wortlaut.retention import retention_pass

    t0 = datetime.now(UTC) - timedelta(days=40)
    kf_id = uuid.uuid4()

    with Session(database) as db:
        rec_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Lifecycle Test",
            starts_at=t0,
            segments=[
                {
                    "speaker": "Alice",
                    "participant_id": "p-alice",
                    "start": 0.0,
                    "end": 3.0,
                    "text": "Alice bespricht den Release-Plan.",
                },
                {
                    "speaker": "Bob",
                    "participant_id": "p-bob",
                    "start": 80.0,
                    "end": 83.0,
                    "text": "Bob vertrauliche Aussage Omega.",
                },
            ],
            keyframes=[{"id": kf_id, "offset_seconds": 5.0, "presenter": "Alice"}],
            protocol_meta={
                "keyframe_context": {
                    str(kf_id): {
                        "view": "Slide Alpha",
                        "items": ["SLIDE-ALPHA-99"],
                        "terms": ["SlideAlpha"],
                    }
                }
            },
        )

    assert rag.rag_index_batch(database) == 1

    # 1. Keyframe DELETE removes slide chunk + keyframe_context synchronously
    del_kf = client.delete(f"/v1/recordings/{rec_id}/keyframes/{kf_id}", headers=API)
    assert del_kf.status_code == 204
    with Session(database) as db:
        kf_chunks = db.scalar(
            select(func.count(ProtocolChunk.id)).where(
                ProtocolChunk.recording_id == rec_id,
                ProtocolChunk.keyframe_id == kf_id,
            )
        )
        assert kf_chunks == 0
        rec = db.get(Recording, rec_id)
        assert str(kf_id) not in (rec.protocol_meta or {}).get("keyframe_context", {})
        assert "rag_indexed_model" not in (rec.protocol_meta or {})

    assert rag.rag_index_batch(database) == 1

    # 2. Single-speaker opt-out purges chunks synchronously; next batch re-indexes Alice only
    opt_res = client.patch(
        f"/v1/recordings/{rec_id}",
        headers=API,
        json={"opted_out_speakers": ["Bob"]},
    )
    assert opt_res.status_code == 200
    with Session(database) as db:
        assert (
            db.scalar(
                select(func.count(ProtocolChunk.id)).where(ProtocolChunk.recording_id == rec_id)
            )
            == 0
        )

    assert rag.rag_index_batch(database) == 1
    with Session(database) as db:
        remaining = list(
            db.scalars(select(ProtocolChunk).where(ProtocolChunk.recording_id == rec_id)).all()
        )
        assert remaining
        assert all("Omega" not in c.content for c in remaining)
        assert any("Release-Plan" in c.content for c in remaining)

    # 3. PATCH notes invalidates dirty marker without running ONNX in-lock; next batch refreshes
    patch_notes = client.patch(
        f"/v1/recordings/{rec_id}",
        headers=API,
        json={"notes": "Nachtrag: Freigabe durch Security-Team."},
    )
    assert patch_notes.status_code == 200
    assert rag.rag_index_batch(database) == 1
    with Session(database) as db:
        assert any(
            "Security-Team" in c.content
            for c in db.scalars(
                select(ProtocolChunk).where(ProtocolChunk.recording_id == rec_id)
            ).all()
        )

    # 4. 30-day retention pass deletes all protocol_chunks rows alongside expired transcript
    with Session(database) as db:
        rec = db.get(Recording, rec_id)
        rec.audio_deleted_at = datetime.now(UTC) - timedelta(days=39)
        db.commit()
    retention_pass(database)
    with Session(database) as db:
        assert (
            db.scalar(
                select(func.count(ProtocolChunk.id)).where(ProtocolChunk.recording_id == rec_id)
            )
            == 0
        )

    # 5. Rejoin purges pre-rejoin chunks synchronously
    with Session(database) as db:
        rec2_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Rejoin Meeting",
            starts_at=datetime.now(UTC) - timedelta(minutes=30),
            segments=[{"speaker": "Alice", "start": 0.0, "end": 3.0, "text": "Vor Rejoin."}],
        )
    assert rag.rag_index_batch(database) == 1
    rejoin_res = client.post(f"/v1/recordings/{rec2_id}/rejoin", headers=API)
    assert rejoin_res.status_code == 200
    with Session(database) as db:
        assert (
            db.scalar(
                select(func.count(ProtocolChunk.id)).where(ProtocolChunk.recording_id == rec2_id)
            )
            == 0
        )
        rec2 = db.get(Recording, rec2_id)
        assert "rag_indexed_model" not in (rec2.protocol_meta or {})


# ---------------------------------------------------------------------------
# 7. MCP openWorldHint dynamic model_copy (no global Tool mutation)
# ---------------------------------------------------------------------------


def test_mcp_search_protocols_open_world_hint_toggles_without_mutating_registry(
    client, monkeypatch
):
    from wortlaut import mcp_server

    def _list_tools():
        resp = client.post(
            "/mcp",
            headers=API,
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        assert resp.status_code == 200
        return {t["name"]: t for t in resp.json()["result"]["tools"]}

    monkeypatch.delenv("WORTLAUT_OPENAI_BASE_URL", raising=False)
    get_settings.cache_clear()
    tools_local = _list_tools()
    assert tools_local["search_protocols"]["annotations"]["openWorldHint"] is False

    monkeypatch.setenv("WORTLAUT_OPENAI_BASE_URL", "https://openai.example.test/v1")
    get_settings.cache_clear()
    tools_oai = _list_tools()
    assert tools_oai["search_protocols"]["annotations"]["openWorldHint"] is True

    # Global registry instance remains untouched (False)
    _, base_tool = mcp_server._TOOL_BY_NAME["search_protocols"]
    assert base_tool.annotations.openWorldHint is False

    # Empty query returns actionable tool error
    empty_q = client.post(
        "/mcp",
        headers=API,
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "search_protocols", "arguments": {"query": "   "}},
        },
    ).json()["result"]
    assert empty_q["isError"] is True
    assert "non-empty string" in empty_q["content"][0]["text"]


def test_rag_index_batch_isolates_poison_pill_recording(database, monkeypatch):
    from wortlaut import rag

    t0 = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)
    with Session(database) as db:
        bad_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Poison Pill Recording",
            starts_at=t0 + timedelta(minutes=10),
            segments=[{"speaker": "Alice", "start": 0.0, "end": 3.0, "text": "Fails export."}],
        )
        good_id = _seed_completed_recording(
            db,
            owner_email="alice@example.org",
            title="Healthy Recording",
            starts_at=t0,
            segments=[{"speaker": "Alice", "start": 0.0, "end": 3.0, "text": "Succeeds export."}],
        )

    real_export = rag.export_data

    def flaky_export(db_sess, rec):
        if rec.id == bad_id:
            raise RuntimeError("corrupt recording payload")
        return real_export(db_sess, rec)

    monkeypatch.setattr(rag, "export_data", flaky_export)
    assert rag.rag_index_batch(database) == 1

    with Session(database) as db:
        good_count = db.scalar(
            select(func.count(ProtocolChunk.id)).where(ProtocolChunk.recording_id == good_id)
        )
        bad_count = db.scalar(
            select(func.count(ProtocolChunk.id)).where(ProtocolChunk.recording_id == bad_id)
        )
        assert good_count == 1
        assert bad_count == 0
