"""Persistent ASR & summary glossary management (team baseline + per-user vocabulary)."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.models import CalendarEntry, CalendarSyncedEvent, GlossaryEntry, Recording
from wortlaut.oidc import Principal
from wortlaut.settings import Settings, get_settings

GlossaryScope = Literal["global", "personal"]
GlossaryScopeInput = Literal["auto", "global", "personal"]

MAX_GLOSSARY_TERM_LEN = 80
MAX_ALIASES_PER_TERM = 12
MAX_ENTRIES_PER_SCOPE = 250

_ARROW_SPLIT_RE = re.compile(r"\s*(?:->|=>|→)\s*")
_ITEM_SPLIT_RE = re.compile(r"[,;\n]+")
_ALIAS_PIPE_SPLIT_RE = re.compile(r"[,;|\n]+")


def normalize_glossary_term(raw: str | None) -> str:
    return " ".join(str(raw or "").split())[:MAX_GLOSSARY_TERM_LEN]


def glossary_term_key(term: str) -> str:
    return normalize_glossary_term(term).lower()


def _is_valid_alias(candidate: str, canonical: str) -> bool:
    if len(candidate) < 2 or len(candidate) > MAX_GLOSSARY_TERM_LEN:
        return False
    if candidate == canonical:
        return False
    return any(ch.isalnum() for ch in candidate)


def normalize_glossary_aliases(
    raw_aliases: list[str] | str | None,
    canonical_term: str,
) -> list[str]:
    if raw_aliases is None:
        return []
    if isinstance(raw_aliases, str):
        parts = _ALIAS_PIPE_SPLIT_RE.split(raw_aliases)
    else:
        parts = []
        for item in raw_aliases:
            parts.extend(_ALIAS_PIPE_SPLIT_RE.split(str(item or "")))
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        clean = normalize_glossary_term(part)
        if not _is_valid_alias(clean, canonical_term):
            continue
        if clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
        if len(out) >= MAX_ALIASES_PER_TERM:
            break
    return out


def parse_bulk_glossary_input(raw_text: str) -> list[tuple[str, list[str]]]:
    """Parse single, comma/newline-separated, or `Mistack -> mAIstack` glossary entries."""
    by_key: dict[str, tuple[str, list[str]]] = {}
    for raw_line in (raw_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if _ARROW_SPLIT_RE.search(line):
            # Line contains explicit arrow mapping(s); split by semicolon only if multiple
            segments = [s.strip() for s in line.split(";") if s.strip()]
        else:
            segments = [s.strip() for s in _ITEM_SPLIT_RE.split(line) if s.strip()]
        for seg in segments:
            if _ARROW_SPLIT_RE.search(seg):
                lhs, rhs = _ARROW_SPLIT_RE.split(seg, maxsplit=1)
                term = normalize_glossary_term(rhs)
                if not term:
                    continue
                aliases = normalize_glossary_aliases(lhs, term)
            else:
                term = normalize_glossary_term(seg)
                if not term:
                    continue
                aliases = []
            tkey = glossary_term_key(term)
            if not tkey:
                continue
            if tkey in by_key:
                prev_term, prev_aliases = by_key[tkey]
                merged_aliases = normalize_glossary_aliases([*prev_aliases, *aliases], term)
                by_key[tkey] = (term or prev_term, merged_aliases)
            else:
                by_key[tkey] = (term, aliases)
    return list(by_key.values())


def resolve_glossary_scope_owner(
    principal: Principal,
    requested_scope: GlossaryScopeInput = "auto",
) -> tuple[GlossaryScope, str]:
    has_personal = bool(principal.kind == "user" and principal.email)
    if requested_scope == "auto":
        if principal.is_admin:
            return "global", ""
        if has_personal:
            return "personal", str(principal.email).strip().lower()
        raise HTTPException(403, "Keine Berechtigung zum Bearbeiten des Glossars.")
    if requested_scope == "global":
        if not principal.is_admin:
            raise HTTPException(
                403,
                "Nur Administratoren können das instanzweite Team-Glossar bearbeiten.",
            )
        return "global", ""
    if not has_personal:
        raise HTTPException(
            400,
            "Persönliches Glossar ist nur mit einer persönlichen Benutzeranmeldung verfügbar.",
        )
    return "personal", str(principal.email).strip().lower()


def _build_global_entries(
    db: Session, settings=None
) -> tuple[list[dict[str, Any]], list[str]]:
    settings = settings or get_settings()
    env_terms: list[str] = list(settings.asr_glossary or [])
    env_by_key: dict[str, str] = {}
    for raw in env_terms:
        clean = normalize_glossary_term(raw)
        if clean:
            env_by_key.setdefault(glossary_term_key(clean), clean)

    db_rows = list(
        db.scalars(
            select(GlossaryEntry)
            .where(GlossaryEntry.owner_email == "")
            .order_by(GlossaryEntry.term_key.asc())
        ).all()
    )
    rows_by_key = {row.term_key: row for row in db_rows}

    entries: list[dict[str, Any]] = []
    suppressed_env_terms: list[str] = []
    seen_keys: set[str] = set()

    for row in db_rows:
        seen_keys.add(row.term_key)
        if row.disabled:
            if row.term_key in env_by_key:
                suppressed_env_terms.append(env_by_key[row.term_key])
            continue
        aliases = normalize_glossary_aliases(
            row.aliases if isinstance(row.aliases, list) else [],
            row.term,
        )
        is_unchanged_env = (
            row.term_key in env_by_key
            and row.term == env_by_key[row.term_key]
            and not aliases
        )
        entries.append(
            {
                "term_key": row.term_key,
                "term": row.term,
                "aliases": aliases,
                "source": "env" if is_unchanged_env else "custom",
                "updated_at": row.updated_at.astimezone(UTC).isoformat()
                if row.updated_at
                else None,
            }
        )

    for tkey, env_term in env_by_key.items():
        if tkey in seen_keys or tkey in rows_by_key:
            continue
        entries.append(
            {
                "term_key": tkey,
                "term": env_term,
                "aliases": [],
                "source": "env",
                "updated_at": None,
            }
        )

    entries.sort(key=lambda item: (str(item["term"]).lower(), str(item["term_key"])))
    suppressed_env_terms.sort(key=lambda val: val.lower())
    return entries, suppressed_env_terms


def _build_personal_entries(db: Session, user_email: str) -> list[dict[str, Any]]:
    clean_email = user_email.strip().lower()
    if not clean_email:
        return []
    rows = list(
        db.scalars(
            select(GlossaryEntry)
            .where(
                GlossaryEntry.owner_email == clean_email,
                GlossaryEntry.disabled.is_(False),
            )
            .order_by(GlossaryEntry.term_key.asc())
        ).all()
    )
    entries = [
        {
            "term_key": row.term_key,
            "term": row.term,
            "aliases": normalize_glossary_aliases(
                row.aliases if isinstance(row.aliases, list) else [],
                row.term,
            ),
            "source": "custom",
            "updated_at": row.updated_at.astimezone(UTC).isoformat()
            if row.updated_at
            else None,
        }
        for row in rows
    ]
    entries.sort(key=lambda item: (str(item["term"]).lower(), str(item["term_key"])))
    return entries


def get_glossary_overview(db: Session, principal: Principal, settings=None) -> dict[str, Any]:
    settings = settings or get_settings()
    can_edit_global = bool(principal.is_admin)
    has_personal = bool(principal.kind == "user" and principal.email)
    global_entries, suppressed_env_terms = _build_global_entries(db, settings)
    personal_entries = (
        _build_personal_entries(db, str(principal.email)) if has_personal else []
    )
    effective_keys = {e["term_key"] for e in global_entries} | {
        e["term_key"] for e in personal_entries
    }
    return {
        "can_edit_global": can_edit_global,
        "has_personal_scope": has_personal,
        "default_scope": "global" if can_edit_global else "personal",
        "global_entries": global_entries,
        "personal_entries": personal_entries,
        "suppressed_env_terms": suppressed_env_terms,
        "effective_count": len(effective_keys),
    }


def _env_term_keys(settings=None) -> set[str]:
    settings = settings or get_settings()
    return {
        glossary_term_key(raw)
        for raw in (settings.asr_glossary or [])
        if glossary_term_key(raw)
    }


def _delete_or_suppress_key(
    db: Session,
    owner_email: str,
    term_key: str,
    env_keys: set[str],
    now: datetime,
) -> bool:
    clean_key = glossary_term_key(term_key)
    if not clean_key:
        return False
    existing = db.scalar(
        select(GlossaryEntry)
        .where(
            GlossaryEntry.owner_email == owner_email,
            GlossaryEntry.term_key == clean_key,
        )
        .with_for_update()
    )
    if owner_email == "" and clean_key in env_keys:
        if existing is None:
            db.add(
                GlossaryEntry(
                    owner_email="",
                    term_key=clean_key,
                    term=clean_key,
                    aliases=[],
                    disabled=True,
                    created_at=now,
                    updated_at=now,
                )
            )
            return True
        if not existing.disabled:
            existing.disabled = True
            existing.aliases = []
            existing.updated_at = now
            return True
        return False
    if existing is not None:
        db.delete(existing)
        return True
    return False


def upsert_glossary_entries(
    db: Session,
    principal: Principal,
    *,
    scope: GlossaryScopeInput = "auto",
    term: str | None = None,
    aliases: list[str] | str | None = None,
    raw_text: str | None = None,
    replace_aliases: bool = False,
    previous_term_key: str | None = None,
    settings=None,
) -> dict[str, Any]:
    settings = settings or get_settings()
    resolved_scope, owner_email = resolve_glossary_scope_owner(principal, scope)
    items: list[tuple[str, list[str]]] = []
    if term is not None and normalize_glossary_term(term):
        clean_term = normalize_glossary_term(term)
        items.append((clean_term, normalize_glossary_aliases(aliases, clean_term)))
    if raw_text is not None and raw_text.strip():
        parsed = parse_bulk_glossary_input(raw_text)
        extra_aliases = aliases if (term is None or not normalize_glossary_term(term)) else None
        if extra_aliases and len(parsed) == 1:
            p_term, p_aliases = parsed[0]
            merged = normalize_glossary_aliases([*p_aliases, *(
                [extra_aliases] if isinstance(extra_aliases, str) else list(extra_aliases)
            )], p_term)
            items.append((p_term, merged))
        else:
            items.extend(parsed)

    if not items:
        raise HTTPException(422, "Mindestens ein gültiger Fachbegriff ist erforderlich.")

    now = datetime.now(UTC)
    env_keys = _env_term_keys(settings)

    if previous_term_key:
        prev_clean = glossary_term_key(previous_term_key)
        new_keys = {glossary_term_key(t) for t, _ in items}
        if prev_clean and prev_clean not in new_keys:
            _delete_or_suppress_key(db, owner_email, prev_clean, env_keys, now)
            db.flush()

    existing_rows = {
        row.term_key: row
        for row in db.scalars(
            select(GlossaryEntry)
            .where(GlossaryEntry.owner_email == owner_email)
            .with_for_update()
        ).all()
    }
    active_keys: set[str] = {
        k for k, row in existing_rows.items() if not row.disabled
    }
    if owner_email == "":
        for ek in env_keys:
            if ek not in existing_rows:
                active_keys.add(ek)

    for item_term, item_aliases in items:
        tkey = glossary_term_key(item_term)
        if not tkey:
            continue
        if tkey not in active_keys and len(active_keys) >= MAX_ENTRIES_PER_SCOPE:
            raise HTTPException(
                422,
                f"Maximale Anzahl von {MAX_ENTRIES_PER_SCOPE} Glossareinträgen erreicht.",
            )
        active_keys.add(tkey)
        row = existing_rows.get(tkey)
        if row is None:
            row = GlossaryEntry(
                owner_email=owner_email,
                term_key=tkey,
                term=item_term,
                aliases=item_aliases,
                disabled=False,
                created_at=now,
                updated_at=now,
            )
            db.add(row)
            existing_rows[tkey] = row
        else:
            was_disabled = bool(row.disabled)
            row.term = item_term
            if replace_aliases or was_disabled:
                row.aliases = item_aliases
            elif item_aliases:
                prev_list = row.aliases if isinstance(row.aliases, list) else []
                row.aliases = normalize_glossary_aliases(
                    [*prev_list, *item_aliases],
                    item_term,
                )
            row.disabled = False
            row.updated_at = now

    db.commit()
    return {
        "scope": resolved_scope,
        **get_glossary_overview(db, principal, settings),
    }


def delete_glossary_entry(
    db: Session,
    principal: Principal,
    *,
    term_key: str,
    scope: GlossaryScopeInput = "auto",
    settings=None,
) -> dict[str, Any]:
    settings = settings or get_settings()
    resolved_scope, owner_email = resolve_glossary_scope_owner(principal, scope)
    now = datetime.now(UTC)
    removed = _delete_or_suppress_key(
        db, owner_email, term_key, _env_term_keys(settings), now
    )
    if not removed:
        raise HTTPException(404, "Glossareintrag nicht gefunden.")
    db.commit()
    return {
        "deleted": True,
        "scope": resolved_scope,
        **get_glossary_overview(db, principal, settings),
    }


def _recording_owner_email(db: Session, recording: Recording | None) -> str:
    if recording is None:
        return ""
    if recording.owner_email and recording.owner_email.strip():
        return recording.owner_email.strip().lower()
    if recording.calendar_entry_id:
        entry = db.get(CalendarEntry, recording.calendar_entry_id)
        if entry and entry.organizer and entry.organizer.strip():
            return entry.organizer.strip().lower()
    if recording.id is not None:
        synced = db.scalar(
            select(CalendarSyncedEvent)
            .where(CalendarSyncedEvent.recording_id == recording.id)
            .limit(1)
        )
        if synced:
            cand = synced.owner_email or synced.organizer_email
            if cand and cand.strip():
                return cand.strip().lower()
    return ""


def _resolve_glossary_for_owner(
    db: Session,
    owner_email: str,
    settings: Settings | None = None,
) -> tuple[list[str], dict[str, str]]:
    """Resolve active global + personal glossary terms and alias replacements for one owner."""
    settings = settings or get_settings()
    clean_owner = (owner_email or "").strip().lower()
    owners = [""] if not clean_owner else ["", clean_owner]
    rows = list(
        db.scalars(
            select(GlossaryEntry)
            .where(GlossaryEntry.owner_email.in_(owners))
            .order_by(GlossaryEntry.updated_at.desc(), GlossaryEntry.term_key.asc())
        ).all()
    )

    global_rows: dict[str, GlossaryEntry] = {}
    personal_rows: list[GlossaryEntry] = []
    for row in rows:
        if row.owner_email == "":
            global_rows[row.term_key] = row
        elif not row.disabled:
            personal_rows.append(row)

    ordered_terms: list[str] = []
    seen_keys: set[str] = set()

    def _add_term(raw_t: str) -> None:
        clean = normalize_glossary_term(raw_t)
        tkey = glossary_term_key(clean)
        if clean and tkey and tkey not in seen_keys:
            seen_keys.add(tkey)
            ordered_terms.append(clean)

    # 1. Personal glossary terms (highest priority for user's own meetings)
    for row in personal_rows:
        _add_term(row.term)

    # 2. Active global DB glossary terms (most recently updated first)
    for row in rows:
        if row.owner_email == "" and not row.disabled:
            _add_term(row.term)

    # 3. Remaining WORTLAUT_ASR_GLOSSARY baseline terms (unless overridden/disabled in DB)
    for raw_env in settings.asr_glossary or []:
        clean_env = normalize_glossary_term(raw_env)
        ekey = glossary_term_key(clean_env)
        if ekey and ekey not in global_rows:
            _add_term(clean_env)

    # Build alias -> canonical term replacements (personal overrides global)
    alias_replacements: dict[str, str] = {}
    for row in reversed(rows):
        if row.owner_email != "" or row.disabled:
            continue
        for al in normalize_glossary_aliases(
            row.aliases if isinstance(row.aliases, list) else [],
            row.term,
        ):
            alias_replacements[al] = row.term

    for row in reversed(personal_rows):
        for al in normalize_glossary_aliases(
            row.aliases if isinstance(row.aliases, list) else [],
            row.term,
        ):
            alias_replacements[al] = row.term

    return ordered_terms, alias_replacements


def resolve_recording_glossary(
    db: Session,
    recording: Recording | None,
    settings=None,
) -> tuple[list[str], dict[str, str]]:
    """Return `(ordered_terms, alias_replacements)` for ASR context & protocol export."""
    return _resolve_glossary_for_owner(db, _recording_owner_email(db, recording), settings)


def resolve_principal_search_glossary(
    db: Session,
    principal: Principal,
    settings: Settings | None = None,
) -> tuple[list[str], dict[str, str]]:
    """Return `(ordered_terms, alias_to_canonical)` visible to `principal` for search."""
    return _resolve_glossary_for_owner(db, principal.email or "", settings)


def _phrase_in_query(query_lower: str, phrase_lower: str) -> bool:
    if not phrase_lower:
        return False
    pattern = rf"(?<![0-9a-zäöüß]){re.escape(phrase_lower)}(?![0-9a-zäöüß])"
    return bool(re.search(pattern, query_lower))


def expand_query_with_local_glossary(
    query: str,
    ordered_terms: list[str],
    alias_to_canonical: dict[str, str],
    *,
    max_terms: int = 8,
) -> list[str]:
    """Expand matching glossary aliases/canonical terms in memory without network I/O."""
    q_clean = " ".join((query or "").split())
    if not q_clean or max_terms <= 0:
        return []
    q_lower = q_clean.lower()

    canonical_to_aliases: dict[str, list[str]] = {}
    for alias, canonical in alias_to_canonical.items():
        canonical_to_aliases.setdefault(canonical.lower(), []).append(alias)

    expanded: list[str] = []
    seen: set[str] = {q_lower}

    def _emit(term: str) -> None:
        clean = normalize_glossary_term(term)
        low = clean.lower()
        if len(clean) >= 2 and low not in seen and len(expanded) < max_terms:
            seen.add(low)
            expanded.append(clean)

    for alias, canonical in alias_to_canonical.items():
        if _phrase_in_query(q_lower, alias.lower()):
            _emit(canonical)
            if len(expanded) >= max_terms:
                return expanded

    for canonical in ordered_terms:
        c_low = canonical.lower()
        if _phrase_in_query(q_lower, c_low):
            for alias in canonical_to_aliases.get(c_low, ()):
                _emit(alias)
                if len(expanded) >= max_terms:
                    return expanded

    return expanded
