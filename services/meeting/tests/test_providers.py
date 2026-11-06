"""Provider identity through real migrations, API and calendar occurrences."""

import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_calendar import configure, imported, mail
from test_recordings import API, create, prepare, request_body
from test_recurrence import NOW

from wortlaut.exports import export_data, render_export
from wortlaut.models import Recording
from wortlaut.recurrence import recurrence_pass
from wortlaut.settings import get_settings
from wortlaut.validation import normalize_meeting_url

MEET = "https://meet.google.com/abc-defg-hij"


@pytest.fixture(autouse=True)
def settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_existing_webex_migration_preserves_idempotency(client, database):
    body = request_body()
    identifier = create(client, body=body)
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    # Downgrade only this isolated test schema, preserving a legacy recording.
    command.downgrade(config, "0012")
    command.upgrade(config, "head")
    assert create(client, body=body) == identifier
    assert create(client, body={**body, "provider": "webex"}) == identifier
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identifier))
        assert recording.provider == "webex"
        assert recording.meeting_url == body["meeting_url"]
        assert recording.active_attempt_id is None
        # Database enforcement also protects non-API writers.
        with pytest.raises(IntegrityError):
            db.execute(text("UPDATE recordings SET provider='invalid'"))
        db.rollback()


def test_meet_url_variants_have_one_identity_and_provider_must_match(client, database):
    body = {**request_body(), "meeting_url": MEET + "?authuser=1&utm_source=calendar#join"}
    identifier = create(client, body=body)
    assert create(client, body={**body, "meeting_url": MEET + "/", "provider": "google_meet"}) == (
        identifier
    )
    wrong = {**body, "provider": "webex"}
    assert (
        client.post(
            "/v1/recordings", json=wrong, headers={**API, "Idempotency-Key": "mismatch"}
        ).status_code
        == 422
    )
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(identifier))
        assert (recording.provider, recording.meeting_url) == ("google_meet", MEET)
        data = export_data(db, recording)
        assert data["provider"] == "google_meet"
        for format in ("txt", "vtt", "json"):
            assert "google_meet" in render_export(data, format)[0]


def test_recording_list_pages_parallel_providers_and_filters_chronological_period(client):
    shared = request_body()
    identifiers = []
    for number, provider in enumerate(["webex", "google_meet", "webex", "google_meet"]):
        starts = datetime.fromisoformat(shared["starts_at"]) + timedelta(minutes=number // 2)
        body = {
            **shared,
            "starts_at": starts.isoformat(),
            "meeting_url": MEET if provider == "google_meet" else shared["meeting_url"],
        }
        identifiers.append((starts, create(client, key=f"page-{number}", body=body), provider))
    expected = sorted(identifiers)
    assert client.get("/v1/recordings").status_code == 401
    first = client.get("/v1/recordings", headers=API, params={"limit": 2})
    assert first.status_code == 200
    data = first.json()
    assert [r["id"] for r in data["items"]] == [r[1] for r in expected[:2]]
    assert data["next_cursor"]
    second = client.get(
        "/v1/recordings", headers=API, params={"limit": 2, "cursor": data["next_cursor"]}
    ).json()
    assert [r["id"] for r in second["items"]] == [r[1] for r in expected[2:]]
    assert second["next_cursor"] is None
    for row in data["items"] + second["items"]:
        assert row["participation"] == "scheduled" and row["processing"] == "pending"
        assert row["quality"]["no_audio_received"] and row["quality"]["status"] == "pending"
        assert row["delivery"]["status"] == "not_configured"
    filtered = client.get(
        "/v1/recordings",
        headers=API,
        params={
            "provider": "google_meet",
            "starts_from": expected[2][0].isoformat(),
            "starts_before": (expected[2][0] + timedelta(minutes=1)).isoformat(),
        },
    ).json()
    assert {r["id"] for r in filtered["items"]} == {
        r[1] for r in identifiers if r[2] == "google_meet" and r[0] == expected[2][0]
    }
    for params, status in [
        ({"cursor": "invalid"}, 400),
        ({"limit": 101}, 422),
        ({"starts_from": "2026-10-07T10:00:00"}, 422),
    ]:
        assert client.get("/v1/recordings", headers=API, params=params).status_code == status


@pytest.mark.parametrize(
    "url",
    [
        "http://meet.google.com/abc-defg-hij",
        "https://meet.google.com.attacker.org/abc-defg-hij",
        "https://token@meet.google.com/abc-defg-hij",
        "https://meet.google.com:9000/abc-defg-hij",
        "https://meet.google.com/lookup/shortcut",
        "https://meet.google.com/abc-defg-hij/redirect",
        "https://meet.google.com/%61bc-defg-hij",
    ],
)
def test_meet_url_cannot_select_another_destination(url):
    with pytest.raises(ValueError):
        normalize_meeting_url(url)


def test_meet_bootstrap_uses_browser_configuration_without_webex(client, monkeypatch):
    from wortlaut import app as app_module

    def forbidden(*args):
        pytest.fail("Meet invoked Webex guest issuance")

    monkeypatch.setattr(app_module, "guest_token", forbidden)
    identifier = create(client, body={**request_body(), "meeting_url": MEET})
    attempt, credential = prepare(client, identifier)
    client.post(f"/v1/attempts/{attempt}/claim", headers=credential, json={"worker_id": "meet"})
    headers = {**credential, "X-Worker-ID": "meet"}
    response = client.get(f"/v1/attempts/{attempt}/bootstrap", headers=headers)
    assert response.status_code == 503
    assert response.json()["detail"] == "google_meet_not_configured"
    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    get_settings.cache_clear()
    response = client.get(f"/v1/attempts/{attempt}/bootstrap", headers=headers)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    result = response.json()
    assert result["provider"] == "google_meet"
    assert result["meeting_url"] == MEET
    assert result["meet"] == {"display_name": "wortlaut", "locale": "de-DE", "auth_mode": "guest"}
    assert "guest" not in result and "sdk_page_url" not in result
    monkeypatch.setenv("WORTLAUT_MEET_STORAGE_STATE_SECRET", "wortlaut-meet-browser")
    get_settings.cache_clear()
    assert (
        client.get(f"/v1/attempts/{attempt}/bootstrap", headers=headers).json()["meet"]["auth_mode"]
        == "account"
    )


def test_meet_ics_fields_conflict_blocks_old_occurrence_and_can_be_resolved(
    client, database, monkeypatch
):
    configure(monkeypatch)
    future = {
        "starts": "DTSTART;TZID=Europe/Berlin:20991024T100000",
        "ends": "DTEND;TZID=Europe/Berlin:20991024T103000",
    }
    event = imported(
        client,
        mail(
            **future,
            link=MEET + "?authuser=1",
            extra=(f"X-GOOGLE-CONFERENCE:{MEET}\r\nDESCRIPTION:{MEET}?utm_source=calendar\r\n"),
        ),
    )
    assert (event["status"], event["provider"]) == ("accepted", "google_meet")
    identifier = event["recording_id"]
    conflict = imported(
        client,
        mail(
            **future,
            sequence=1,
            link=MEET,
            extra=("LOCATION:https://example.webex.com/meet/other\r\n"),
        ),
    )
    assert (conflict["status"], conflict["reason"]) == ("conflict", "meeting_link_ambiguous")
    assert client.post(f"/v1/recordings/{identifier}/attempts", headers=API).status_code == 409
    resolved = imported(
        client, mail(**future, sequence=2, link="", extra=f"X-GOOGLE-CONFERENCE:{MEET}\r\n")
    )
    assert resolved["recording_id"] == identifier
    assert resolved["status"] == "accepted"
    attempt, _ = prepare(client, identifier)
    changed = imported(client, mail(**future, sequence=3))
    assert changed["reason"] == "active_change_conflict"
    state = client.get(f"/v1/recordings/{identifier}", headers=API).json()
    assert state["provider"] == "google_meet" and state["active_attempt_id"] == attempt
    with Session(database) as db:
        assert db.get(Recording, uuid.UUID(identifier)).meeting_url == MEET


def test_meet_series_update_and_cancel_preserve_provider_and_identity(
    client, database, monkeypatch
):
    configure(monkeypatch)
    imported(client, mail(link=MEET, extra="RRULE:FREQ=DAILY;COUNT=2\r\n"))
    recurrence_pass(database, NOW)
    with Session(database) as db:
        before = {r.recurrence_key: r.id for r in db.scalars(select(Recording))}
        assert len(before) == 2
    updated = "https://meet.google.com/xyz-abcd-efg"
    imported(client, mail(sequence=1, link=updated, extra="RRULE:FREQ=DAILY;COUNT=2\r\n"))
    recurrence_pass(database, NOW)
    with Session(database) as db:
        rows = db.scalars(select(Recording)).all()
        assert {r.recurrence_key: r.id for r in rows} == before
        assert all(r.provider == "google_meet" and r.meeting_url == updated for r in rows)
    imported(client, mail(sequence=2, method="CANCEL"))
    recurrence_pass(database, NOW)
    with Session(database) as db:
        assert all(r.participation == "ended" for r in db.scalars(select(Recording)))


def test_webex_browser_bootstrap_does_not_issue_sdk_credentials(client, monkeypatch):
    from wortlaut import app as app_module

    def forbidden(*args):
        pytest.fail("Browser guest invoked Webex guest issuance")

    monkeypatch.setattr(app_module, "guest_token", forbidden)
    monkeypatch.setenv("WORTLAUT_ENABLE_WEBEX_BROWSER", "true")
    get_settings.cache_clear()
    identifier = create(client)
    attempt, credential = prepare(client, identifier)
    client.post(f"/v1/attempts/{attempt}/claim", headers=credential, json={"worker_id": "webex"})
    response = client.get(
        f"/v1/attempts/{attempt}/bootstrap",
        headers={**credential, "X-Worker-ID": "webex"},
    )
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    result = response.json()
    assert result["provider"] == "webex"
    assert result["webex_browser"] == {"display_name": "wortlaut"}
    assert "guest" not in result and "sdk_page_url" not in result


@pytest.mark.parametrize("url", [
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7B%7D",
    "https://teams.microsoft.com/meet/123456789?p=fixture-passcode",
    "https://teams.live.com/meet/123456789?p=fixture-passcode",
    "https://teams.cloud.microsoft/meet/123456789?p=fixture-passcode",
])
def test_teams_preserves_invitation_identity(url):
    assert normalize_meeting_url(url + "#fragment") == ("teams", url)


@pytest.mark.parametrize("url", [
    "http://teams.microsoft.com/meet/123",
    "https://teams.microsoft.com.attacker.example/meet/123",
    "https://user@teams.microsoft.com/meet/123",
    "https://teams.microsoft.com:444/meet/123",
    "https://teams.microsoft.com/redirect?url=https://example.com",
    "https://teams.microsoft.com/meet/123/extra",
])
def test_teams_rejects_non_meeting_destinations(url):
    with pytest.raises(ValueError):
        normalize_meeting_url(url)


def test_teams_bootstrap_is_independent_and_preserves_passcode(client, database, monkeypatch):
    from wortlaut import app as app_module

    monkeypatch.setattr(app_module, "guest_token", lambda *args: pytest.fail("Webex invoked"))
    url = "https://teams.microsoft.com/meet/123456789?p=fixture-passcode"
    identifier = create(client, body={**request_body(), "meeting_url": url, "provider": "teams"})
    with Session(database) as db:
        assert db.get(Recording, uuid.UUID(identifier)).provider == "teams"
    attempt, credential = prepare(client, identifier)
    client.post(f"/v1/attempts/{attempt}/claim", headers=credential, json={"worker_id": "teams"})
    headers = {**credential, "X-Worker-ID": "teams"}
    response = client.get(f"/v1/attempts/{attempt}/bootstrap", headers=headers)
    assert response.status_code == 503
    assert response.json()["detail"] == "teams_not_configured"
    monkeypatch.setenv("WORTLAUT_ENABLE_TEAMS", "true")
    get_settings.cache_clear()
    response = client.get(f"/v1/attempts/{attempt}/bootstrap", headers=headers)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    data = response.json()
    assert data["provider"] == "teams"
    assert data["meeting_url"] == url
    assert data["teams"] == {"display_name": "wortlaut", "locale": "en-US"}
    assert "guest" not in data and "sdk_page_url" not in data and "meet" not in data
    status = client.post(f"/v1/attempts/{attempt}/status", headers=headers, json={
        "participation": "capturing", "capability": "unverified",
        "receiver_sources": [{
            "provider_source_id": f"teams:{identifier}:receiver:1",
            "source_kind": "unknown", "capture_path": "rtc_receiver",
            "track_id": "mainAudio", "signaled_participant_id": None,
        }],
    })
    assert status.status_code == 200


@pytest.mark.parametrize("url", [
    "https://teams.microsoft.com/meet/123456789?p=fixture",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7B%7D",
])
def test_teams_calendar_invite(client, monkeypatch, url):
    configure(monkeypatch)
    event = imported(client, mail(link=url))
    assert event["status"] == "accepted"
    assert event["provider"] == "teams"
