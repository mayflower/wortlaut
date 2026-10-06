import uuid
from datetime import UTC, datetime
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_recordings import API, prepare

from wortlaut.calendar import consume_imap_message, meeting_link
from wortlaut.models import CalendarEntry, MailCursor, MailImport, Recording
from wortlaut.settings import get_settings


def mail(
    sequence=0,
    stamp="20261006T110000Z",
    extra="",
    method="REQUEST",
    sender="owner@example.org",
    organizer="owner@example.org",
    link="https://example.webex.com/meet/calendar",
    uid="single-fixture",
    starts="DTSTART;TZID=Europe/Berlin:20261024T100000",
    ends="DTEND;TZID=Europe/Berlin:20261024T103000",
):
    event = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//wortlaut fixture//EN\r\n"
        f"METHOD:{method}\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSEQUENCE:{sequence}\r\n"
        f"DTSTAMP:{stamp}\r\nORGANIZER:mailto:{organizer}\r\n"
        f"{starts}\r\n{ends}\r\n"
        f"URL:{link}\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    message = EmailMessage()
    message["From"] = sender
    message["To"] = "bot@example.org"
    message["X-Wortlaut-Authenticated-Sender"] = sender
    message.set_content("Einladung")
    message.add_attachment(event, subtype="calendar", params={"method": method})
    return message.as_bytes()


def configure(monkeypatch):
    monkeypatch.setenv("WORTLAUT_TRUSTED_SENDER_HEADER", "X-Wortlaut-Authenticated-Sender")
    monkeypatch.setenv(
        "WORTLAUT_ORGANIZER_PERMISSIONS", '{"owner@example.org":["owner@example.org"]}'
    )
    get_settings.cache_clear()


def imported(client, raw):
    response = client.post("/v1/calendar/messages", headers=API, content=raw)
    assert response.status_code == 200
    return response.json()["events"][0]


def test_single_replay_versions_conflict_and_utc(client, database, monkeypatch):
    configure(monkeypatch)
    result = imported(client, mail())
    recording = result["recording_id"]
    assert result["status"] == "accepted"
    assert imported(client, mail())["recording_id"] == recording
    assert imported(client, mail(sequence=1))["recording_id"] == recording
    assert imported(client, mail())["import"] == "older_ignored"
    assert (
        client.get(f"/v1/recordings/{recording}", headers=API)
        .json()["starts_at"]
        .startswith("2026-10-24T08:00:00")
    )
    conflict = imported(client, mail(sequence=1, link="https://other.webex.com/meet/calendar"))
    assert conflict["status"] == "conflict"
    assert client.post(f"/v1/recordings/{recording}/attempts", headers=API).status_code == 409
    assert imported(client, mail(sequence=2))["status"] == "accepted"
    with Session(database) as db:
        assert len(db.scalars(select(Recording)).all()) == 1
        entry = db.scalar(select(CalendarEntry))
        assert "TZID=Europe/Berlin" in entry.original
        assert entry.dtstamp == datetime(2026, 10, 6, 11, tzinfo=UTC)
    listing = client.get("/v1/calendar", headers=API).json()
    assert listing["events"][0]["recording_id"] == recording


def test_active_changes_are_conflicts_and_cancel_uses_worker_stop(client, monkeypatch):
    configure(monkeypatch)
    recording = imported(client, mail())["recording_id"]
    attempt, credentials = prepare(client, recording)
    assert (
        client.post(
            f"/v1/attempts/{attempt}/claim",
            headers=credentials,
            json={"worker_id": "calendar-owner"},
        ).status_code
        == 200
    )
    result = imported(
        client,
        mail(
            sequence=1,
            starts="DTSTART;TZID=Europe/Berlin:20261024T110000",
            ends="DTEND;TZID=Europe/Berlin:20261024T113000",
        ),
    )
    assert result["reason"] == "active_change_conflict"
    state = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert state["starts_at"].startswith("2026-10-24T08:00:00")
    assert state["active_attempt_id"] == attempt
    assert imported(client, mail(sequence=2, method="CANCEL"))["status"] == "cancelled"
    response = client.post(
        f"/v1/attempts/{attempt}/status",
        headers={**credentials, "X-Worker-ID": "calendar-owner"},
        json={"participation": "joining"},
    )
    assert response.json()["stop_requested"]
    assert response.json()["stop_reason"] == "cancelled"


def test_only_gateway_authorized_organizer_and_webex_link_create_meetings(
    client, database, monkeypatch
):
    configure(monkeypatch)
    for raw in (
        mail(sender="attacker@example.org"),
        mail(organizer="someone@example.org"),
        mail(link="https://example.org/meet/forbidden"),
        mail().replace(b"X-Wortlaut-Authenticated-Sender:", b"Authentication-Results:"),
    ):
        assert imported(client, raw)["status"] == "rejected"
    with Session(database) as db:
        assert not db.scalars(select(Recording)).all()


def test_series_is_stored_without_single_meeting_and_floating_times_rejected(
    client, database, monkeypatch
):
    configure(monkeypatch)
    result = imported(client, mail(extra="RRULE:FREQ=DAILY;COUNT=3\r\n"))
    assert result["status"] == "not_expanded"
    assert result["recording_id"] is None
    floating = mail(uid="floating", starts="DTSTART:20261024T100000", ends="DTEND:20261024T103000")
    assert imported(client, floating)["status"] == "rejected"
    with Session(database) as db:
        assert not db.scalars(select(Recording)).all()


def test_uidvalidity_replay_and_committed_mail_progress(client, database, monkeypatch):
    configure(monkeypatch)
    with Session(database) as db:
        first = consume_imap_message(db, 100, 7, mail())
        db.commit()
    database.dispose()
    with Session(database) as db:
        assert consume_imap_message(db, 100, 7, mail()) == first
        db.commit()
        again = consume_imap_message(db, 200, 1, mail())
        db.commit()
        assert again[0]["recording_id"] == first[0]["recording_id"]
        cursor = db.get(MailCursor, "wortlaut")
        assert (cursor.uidvalidity, cursor.last_uid) == (200, 1)
        assert len(db.scalars(select(MailImport)).all()) == 2
        assert len(db.scalars(select(Recording)).all()) == 1
        assert db.get(Recording, uuid.UUID(first[0]["recording_id"])).calendar_entry_id


def test_ics_link_ignores_webex_help_footer_and_body_fallback_filters_non_meeting_links(
    client, database, monkeypatch
):
    configure(monkeypatch)
    message = BytesParser(policy=policy.default).parsebytes(mail())
    message.get_body(preferencelist=("plain",)).set_content(
        "Hilfe: https://help.webex.com/en-us/article/example\n"
        "Anderer Termin: https://other.webex.com/meet/other"
    )
    result = imported(client, message.as_bytes())
    assert result["status"] == "accepted"
    with Session(database) as db:
        assert db.get(Recording, uuid.UUID(result["recording_id"])).meeting_url == (
            "https://example.webex.com/meet/calendar"
        )

    message = BytesParser(policy=policy.default).parsebytes(mail(uid="body-fallback", link=""))
    message.get_body(preferencelist=("plain",)).set_content(
        "Hilfe: https://help.webex.com/en-us/article/example\n"
        "Termin: https://example.webex.com/example/j.php?MTID=fixture"
    )
    result = imported(client, message.as_bytes())
    assert result["status"] == "accepted"
    with Session(database) as db:
        assert db.get(Recording, uuid.UUID(result["recording_id"])).meeting_url == (
            "https://example.webex.com/example/j.php?MTID=fixture"
        )


def test_multiple_meeting_targets_in_ics_or_fallback_remain_rejected(client, database, monkeypatch):
    configure(monkeypatch)
    ambiguous = mail(extra="LOCATION:https://other.webex.com/meet/other\r\n")
    assert imported(client, ambiguous)["status"] == "rejected"
    message = BytesParser(policy=policy.default).parsebytes(mail(link=""))
    message.get_body(preferencelist=("plain",)).set_content(
        "https://example.webex.com/meet/one https://example.webex.com/meet/two"
    )
    assert imported(client, message.as_bytes())["status"] == "rejected"
    with Session(database) as db:
        assert not db.scalars(select(Recording)).all()


def test_meeting_link_formats_and_help_or_account_urls():
    for path in (
        "/meet/owner",
        "/m/fixture",
        "/join/owner",
        "/example/j.php?MTID=fixture",
        "/wbxmjs/joinservice/sites/example/meeting/download/fixture",
        "/webappng/sites/example/meeting/info/fixture",
    ):
        link = "https://example.webex.com" + path
        assert meeting_link({"URL": link}, "https://help.webex.com/en-us/article/example") == link
    for link in (
        "https://help.webex.com/en-us/article/example",
        "https://example.webex.com/webappng/sites/example/dashboard",
    ):
        with pytest.raises(ValueError, match="webex_link_missing_or_ambiguous"):
            meeting_link({}, link)
