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
    recording = imported(
        client,
        mail(
            starts="DTSTART;TZID=Europe/Berlin:20991024T100000",
            ends="DTEND;TZID=Europe/Berlin:20991024T103000",
        ),
    )["recording_id"]
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
            starts="DTSTART;TZID=Europe/Berlin:20991024T110000",
            ends="DTEND;TZID=Europe/Berlin:20991024T113000",
        ),
    )
    assert result["reason"] == "active_change_conflict"
    state = client.get(f"/v1/recordings/{recording}", headers=API).json()
    assert state["starts_at"].startswith("2099-10-24T08:00:00")
    assert state["active_attempt_id"] == attempt
    assert imported(
        client,
        mail(
            sequence=2,
            method="CANCEL",
            starts="DTSTART;TZID=Europe/Berlin:20991024T110000",
            ends="DTEND;TZID=Europe/Berlin:20991024T113000",
        ),
    )["status"] == "cancelled"
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


def test_multiple_meeting_targets_in_ics_or_fallback_are_conflicts(client, database, monkeypatch):
    configure(monkeypatch)
    ambiguous = mail(extra="LOCATION:https://other.webex.com/meet/other\r\n")
    assert imported(client, ambiguous)["reason"] == "meeting_link_ambiguous"
    message = BytesParser(policy=policy.default).parsebytes(mail(link=""))
    message.get_body(preferencelist=("plain",)).set_content(
        "https://example.webex.com/meet/one https://example.webex.com/meet/two"
    )
    assert imported(client, message.as_bytes())["status"] == "conflict"
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
        with pytest.raises(ValueError, match="meeting_link_missing"):
            meeting_link({}, link)


def test_dkim_invitation_authentication(client, database, signed_invite):
    valid = signed_invite()
    rejected = [
        mail(sender="owner@mayflower.de", organizer="owner@mayflower.de"),
        signed_invite(domain=b"attacker.example"),
        signed_invite(length=True),
        signed_invite(headers=[b"from"]),
        valid.replace(b"example.webex.com", b"attacker.webex.com"),
        valid.replace(b"From: owner@mayflower.de", b"From: other@mayflower.de"),
        b"From: other@mayflower.de\r\n" + valid,
        b"Content-Type: text/calendar\r\n" + valid,
        signed_invite(raw=mail(sender="owner@mayflower.de.attacker.org")),
        signed_invite(raw=mail(sender="owner@mayflower.de", organizer="other@mayflower.de")),
        b"DKIM-Signature: broken\r\n" + mail(sender="owner@mayflower.de"),
    ]
    for raw in rejected:
        assert imported(client, raw)["status"] == "rejected"
    with Session(database) as db:
        assert db.scalar(select(Recording)) is None
    result = imported(client, valid)
    assert result["status"] == "accepted"
    assert imported(client, valid)["recording_id"] == result["recording_id"]
    # A bogus Authentication-Results header neither grants nor removes authority.
    assert imported(client, b"Authentication-Results: forged; dkim=pass\r\n" + valid)[
        "recording_id"
    ] == result["recording_id"]
    # Explicit organizer_permissions allow a trusted sender to forward external invitations.
    settings = get_settings()
    settings.organizer_permissions = {"owner@mayflower.de": ["*"]}
    try:
        forwarded = signed_invite(raw=mail(
            uid="forwarded-ext", sender="owner@mayflower.de", organizer="customer@external.org"
        ))
        assert imported(client, forwarded)["status"] == "accepted"
    finally:
        settings.organizer_permissions = {}


def test_dkim_dns_outage_does_not_consume_invitation(database, monkeypatch, signed_invite):
    import dns.exception

    from wortlaut import calendar as intake

    raw = signed_invite()

    def unavailable(*args, **kwargs):
        raise dns.exception.Timeout

    monkeypatch.setattr(intake, "dkim_dns", unavailable)
    with Session(database) as db:
        with pytest.raises(dns.exception.Timeout):
            consume_imap_message(db, 1, 1, raw)
        db.rollback()
    with Session(database) as db:
        assert db.scalar(select(MailImport)) is None
        assert db.scalar(select(MailCursor)) is None


def test_instant_invitations_plain_html_identity_and_replay(client, database, signed_invite):
    from datetime import timedelta
    from email.utils import format_datetime

    def notice(text=None, html=False, age=0, from_address="meetings-noreply@google.com",
               domain=b"google.com", headers=None, subject="Ad-hoc Projekt-Sync"):
        message = EmailMessage()
        message["From"] = from_address
        message["Subject"] = subject
        message["Date"] = format_datetime(datetime.now(UTC) - timedelta(hours=age))
        message["Message-ID"] = f"<{uuid.uuid4()}@notifications.google.com>"
        message.set_content(text or (
            "owner@mayflower.de lädt Sie zu einem gerade stattfindenden Videoanruf ein\n"
            "meet.google.com/abc-defg-hij"
        ), subtype="html" if html else "plain")
        return signed_invite(raw=message.as_bytes(), domain=domain, headers=headers or [
            b"from", b"content-type", b"mime-version", b"content-transfer-encoding",
            b"date", b"message-id",
        ])

    for raw in (
        notice(domain=b"attacker.org"),
        notice(age=3),
        notice(age=-1),
        notice(headers=[b"from", b"content-type", b"mime-version", b"content-transfer-encoding"]),
        notice("outsider@example.org lädt Sie zu einem gerade stattfindenden Videoanruf ein "
               "meet.google.com/abc-defg-hij"),
        notice("owner@mayflower.de lädt Sie zu einem gerade stattfindenden Videoanruf ein "
               "meet.google.com/abc-defg-hij meet.google.com/xyz-abcd-efg"),
        notice("meet.google.com/abc-defg-hij"),
        notice().replace(b"abc-defg-hij", b"xyz-abcd-efg"),
    ):
        assert imported(client, raw)["status"] == "rejected"
    with Session(database) as db:
        assert db.scalar(select(Recording)) is None
    raw = notice(age=0.25)
    received = datetime.now(UTC)
    result = imported(client, raw)
    assert result["status"] == "accepted"
    assert imported(client, raw)["recording_id"] == result["recording_id"]
    with Session(database) as db:
        recording = db.get(Recording, uuid.UUID(result["recording_id"]))
        assert recording.provider == "google_meet"
        assert recording.title == "Ad-hoc Projekt-Sync"
        assert recording.meeting_url == "https://meet.google.com/abc-defg-hij"
        assert recording.starts_at >= received
        assert timedelta(minutes=104) < recording.ends_at - recording.starts_at < timedelta(hours=2)
        assert db.get(CalendarEntry, recording.calendar_entry_id).organizer == "owner@mayflower.de"
    calendar_rows = client.get("/v1/calendar", headers=API).json()["events"]
    assert any(row.get("title") == "Ad-hoc Projekt-Sync" for row in calendar_rows)
    assert imported(client, notice(
        '<p>owner@mayflower.de is inviting you to an ongoing video call</p>'
        '<a href="https://meet.google.com/abc-defg-hij?hs=151">Join</a>', html=True,
    ))["status"] == "accepted"
    assert imported(client, notice(
        "Join https://meet.google.com/abc-defg-hij",
        from_address="owner@mayflower.de", domain=b"mayflower.de",
    ))["status"] == "accepted"
    teams_instant = imported(client, notice(
        "Join https://teams.microsoft.com/meet/123456789?p=fixture",
        from_address="owner@mayflower.de", domain=b"mayflower.de",
    ))
    assert (teams_instant["status"], teams_instant["provider"]) == ("accepted", "teams")
    webex_instant = imported(client, notice(
        "Join https://example.webex.com/meet/owner",
        from_address="owner@mayflower.de", domain=b"mayflower.de",
    ))
    assert (webex_instant["status"], webex_instant["provider"]) == ("accepted", "webex")


def test_oauth_calendar_to_asr_summary_mail_and_writeback_end_to_end(
    client, database, storage, monkeypatch
):
    """End-to-end integration over real PostgreSQL, S3, local HTTP APIs, and local SMTP:
    1) Google Calendar & Microsoft Graph OAuth2 sync schedules recordings,
    2) Real WebSocket PCM ingest -> segmentation -> ASR -> Ollama summary -> finalize_processing,
    3) Automatic protocol-link + summary PATCH write-back into Google & M365 events + SMTP mail,
    4) Negative cases: lobby_timeout and silent room_empty must NOT write empty protocol links to
       calendars, and capture_anomaly surfaces an explicit diagnostic warning in mail/exports.
    """
    import hashlib
    import json
    import socket
    import threading
    from datetime import timedelta
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from aiosmtpd.controller import Controller
    from test_ingest import authenticate, begin
    from test_mail import Receiver
    from test_processing import audio, send_pcm

    import wortlaut.calendar_oauth as cal_oauth
    from wortlaut.asr import finalize_processing, inference_pass
    from wortlaut.mail import smtp_pass
    from wortlaut.models import CalendarConnection, CalendarSyncedEvent
    from wortlaut.processing import segmentation_pass

    now = datetime.now(UTC).replace(microsecond=0)
    starts_iso = (now + timedelta(minutes=2)).isoformat()
    ends_iso = (now + timedelta(minutes=32)).isoformat()

    google_events = {
        "g-evt-active": {
            "id": "g-evt-active",
            "iCalUID": "ical-g-active@mayflower.de",
            "status": "confirmed",
            "summary": "Architektur-Sync Google",
            "description": "Agenda: Quartalsplanung",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "organizer": {"email": "owner@mayflower.de", "self": True},
            "attendees": [
                {"email": "owner@mayflower.de", "responseStatus": "accepted"},
                {"email": "alice@mayflower.de", "responseStatus": "accepted"},
            ],
            "start": {"dateTime": starts_iso},
            "end": {"dateTime": ends_iso},
        },
        "g-evt-lobby-timeout": {
            "id": "g-evt-lobby-timeout",
            "iCalUID": "ical-g-lobby@mayflower.de",
            "status": "confirmed",
            "summary": "Skills und Kollegen Negativfall",
            "description": "Nur bei echtem Transkript verlinken",
            "hangoutLink": "https://meet.google.com/qwj-xons-uxb",
            "organizer": {"email": "owner@mayflower.de", "self": True},
            "attendees": [
                {"email": "owner@mayflower.de", "responseStatus": "accepted"},
                {"email": "colleague@mayflower.de", "responseStatus": "accepted"},
            ],
            "start": {"dateTime": starts_iso},
            "end": {"dateTime": ends_iso},
        },
    }
    ms_events = {
        "ms-evt-active": {
            "id": "ms-evt-active",
            "iCalUId": "ical-ms-active@mayflower.de",
            "isCancelled": False,
            "isOrganizer": True,
            "subject": "Teams Sprint Review",
            "organizer": {"emailAddress": {"address": "owner@mayflower.de"}},
            "attendees": [
                {
                    "emailAddress": {"address": "bob@mayflower.de"},
                    "status": {"response": "accepted"},
                }
            ],
            "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/meet/987654321?p=secret"},
            "body": {"contentType": "HTML", "content": "<p>Sprint-Ziele</p>"},
            "start": {"dateTime": starts_iso, "timeZone": "UTC"},
            "end": {"dateTime": ends_iso, "timeZone": "UTC"},
        },
    }
    patches: list[tuple[str, str, dict]] = []

    class UpstreamHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def _json(self, code: int, payload: dict):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/google/events":
                return self._json(200, {"items": list(google_events.values())})
            if path.startswith("/google/events/"):
                eid = path.rsplit("/", 1)[-1]
                return self._json(200, google_events[eid])
            if path == "/ms/calendarView":
                return self._json(200, {"value": list(ms_events.values())})
            if path.startswith("/ms/events/"):
                eid = path.rsplit("/", 1)[-1]
                return self._json(200, ms_events[eid])
            self._json(404, {"error": "not_found"})

        def do_PATCH(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            path = self.path.split("?", 1)[0]
            if path.startswith("/google/events/"):
                eid = path.rsplit("/", 1)[-1]
                google_events[eid]["description"] = body["description"]
                patches.append(("google", eid, body))
                return self._json(200, google_events[eid])
            if path.startswith("/ms/events/"):
                eid = path.rsplit("/", 1)[-1]
                ms_events[eid]["body"] = body["body"]
                patches.append(("microsoft", eid, body))
                return self._json(200, ms_events[eid])
            self._json(404, {"error": "not_found"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length)
            if self.path == "/v1/transcribe":
                job_id = self.headers["X-Job-ID"]
                is_silent = all(b == 0 for b in raw_body)
                text = "" if is_silent else "Wir beschließen das Release für Freitag."
                words = [
                    {"word": w, "start": round(i * 0.12, 2), "end": round((i + 1) * 0.12, 2)}
                    for i, w in enumerate(text.split())
                ]
                return self._json(
                    200,
                    {
                        "job_id": job_id,
                        "pcm_sha256": hashlib.sha256(raw_body).hexdigest(),
                        "text": text,
                        "words": words,
                    },
                )
            if self.path == "/api/chat":
                summary_payload = {
                    "summary": "Das Team hat das Release verbindlich für Freitag beschlossen.",
                    "topics": [{"title": "Release-Planung", "details": "Go-Live am Freitag."}],
                    "action_items": [{"owner": "Alice", "task": "Deployment vorbereiten"}],
                }
                return self._json(
                    200, {"message": {"content": json.dumps(summary_payload)}}
                )
            self._json(404, {"error": "not_found"})

    http_server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
    http_port = http_server.server_address[1]
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        smtp_port = reserve.getsockname()[1]
    smtp_receiver = Receiver()
    smtp_server = Controller(smtp_receiver, hostname="127.0.0.1", port=smtp_port)
    smtp_server.start()

    base = f"http://127.0.0.1:{http_port}"
    monkeypatch.setattr(cal_oauth, "GOOGLE_CALENDAR_EVENTS_URL", f"{base}/google/events")
    monkeypatch.setattr(cal_oauth, "MICROSOFT_CALENDAR_VIEW_URL", f"{base}/ms/calendarView")
    monkeypatch.setattr(cal_oauth, "MICROSOFT_EVENTS_URL", f"{base}/ms/events")
    monkeypatch.setenv("WORTLAUT_ENABLE_GOOGLE_MEET", "true")
    monkeypatch.setenv("WORTLAUT_ENABLE_TEAMS", "true")
    monkeypatch.setenv("WORTLAUT_API_URL", "https://wortlaut.data.mayflower.tech")
    monkeypatch.setenv("WORTLAUT_ASR_URL", base)
    monkeypatch.setenv("WORTLAUT_ASR_TOKEN", "fixture-asr-token")
    monkeypatch.setenv("WORTLAUT_ENABLE_LLM_SUMMARY", "true")
    monkeypatch.setenv("WORTLAUT_OLLAMA_URL", base)
    monkeypatch.setenv("WORTLAUT_SMTP_HOST", "127.0.0.1")
    monkeypatch.setenv("WORTLAUT_SMTP_PORT", str(smtp_port))
    monkeypatch.setenv("WORTLAUT_SMTP_TLS", "none")
    monkeypatch.setenv("WORTLAUT_SMTP_FROM", "wortlaut@mayflower.de")
    monkeypatch.setenv("WORTLAUT_RESULT_RECIPIENTS", '{"default":["owner@mayflower.de"]}')
    get_settings.cache_clear()

    try:
        with Session(database) as db:
            g_conn = CalendarConnection(
                owner_sub="sub-owner",
                owner_email="owner@mayflower.de",
                provider="google",
                account_email="owner@mayflower.de",
                encrypted_access_token=cal_oauth.encrypt_secret("google-token"),
                encrypted_refresh_token=cal_oauth.encrypt_secret("google-refresh"),
                token_expires_at=now + timedelta(hours=1),
            )
            ms_conn = CalendarConnection(
                owner_sub="sub-owner",
                owner_email="owner@mayflower.de",
                provider="microsoft",
                account_email="owner@mayflower.de",
                encrypted_access_token=cal_oauth.encrypt_secret("ms-token"),
                encrypted_refresh_token=cal_oauth.encrypt_secret("ms-refresh"),
                token_expires_at=now + timedelta(hours=1),
            )
            db.add_all([g_conn, ms_conn])
            db.commit()
            cal_oauth.sync_connection(db, g_conn, now=now)
            cal_oauth.sync_connection(db, ms_conn, now=now)
            db.commit()

            synced = {
                e.external_event_id: e
                for e in db.scalars(select(CalendarSyncedEvent)).all()
            }
            assert set(synced) == {"g-evt-active", "g-evt-lobby-timeout", "ms-evt-active"}
            g_rec_id = synced["g-evt-active"].recording_id
            lobby_rec_id = synced["g-evt-lobby-timeout"].recording_id
            ms_rec_id = synced["ms-evt-active"].recording_id
            assert g_rec_id and lobby_rec_id and ms_rec_id

        speech_pcm = audio("german-a.wav")
        sample_count = len(speech_pcm) // 2

        # Complete both active Google Meet & Teams recordings with real speech + ASR + summary
        for rec_id, prov in ((g_rec_id, "google_meet"), (ms_rec_id, "teams")):
            with Session(database) as db:
                rec = db.get(Recording, rec_id)
                rec.starts_at = now - timedelta(minutes=1)
                db.commit()
            attempt_id, headers = prepare(client, str(rec_id))
            assert (
                client.post(
                    f"/v1/attempts/{attempt_id}/claim",
                    headers=headers,
                    json={"worker_id": "fixture-worker"},
                ).status_code
                == 200
            )
            credential = headers["Authorization"][7:]
            stream_id = str(uuid.uuid4())
            epoch = str(uuid.uuid4())
            ident = {
                "meeting_id": str(rec_id),
                "attempt_id": attempt_id,
                "stream_id": stream_id,
                "epoch": epoch,
                "source_kind": "speaker",
                "provider_source_id": f"{prov}:{rec_id}:receiver:1",
                "speaker_id": "alice-session",
                "participant_id": "alice-session",
                "participant_name": "Alice Example",
                "attribution_unknown": False,
                "sample_rate": 16000,
                "channels": 1,
                "encoding": "pcm_s16le",
                "monotonic_origin_ms": 1200,
                "session_monotonic_origin_ms": 1000,
                "session_utc_origin": "2026-10-06T09:00:00Z",
            }
            with client.websocket_connect(f"/v1/attempts/{attempt_id}/audio") as ws:
                authenticate(ws, credential)
                ws.send_json(begin(ident))
                assert ws.receive_json()["type"] == "ack"
                send_pcm(ws, ident, speech_pcm, 0, 0)
                ws.send_json(
                    {
                        "type": "end",
                        "id": begin(ident)["id"] + "/end",
                        "stream_id": stream_id,
                        "epoch": epoch,
                        "final_sample": sample_count,
                        "last_sequence": 0,
                    }
                )
                assert ws.receive_json()["type"] == "ack"
            res = client.post(
                f"/v1/attempts/{attempt_id}/status",
                headers={**headers, "X-Worker-ID": "fixture-worker"},
                json={"participation": "ended", "reason": "normal", "drained": True},
            )
            assert res.status_code == 200

        # Negative case: silent chunk + 10 signaled participants + room_empty -> capture_anomaly,
        # and NO empty protocol link written into calendar event g-evt-lobby-timeout!
        with Session(database) as db:
            lrec = db.get(Recording, lobby_rec_id)
            lrec.starts_at = now - timedelta(minutes=1)
            db.commit()
        l_attempt, l_headers = prepare(client, str(lobby_rec_id))
        assert (
            client.post(
                f"/v1/attempts/{l_attempt}/claim",
                headers=l_headers,
                json={"worker_id": "fixture-worker"},
            ).status_code
            == 200
        )
        l_cred = l_headers["Authorization"][7:]
        l_stream = str(uuid.uuid4())
        l_epoch = str(uuid.uuid4())
        l_ident = {
            "meeting_id": str(lobby_rec_id),
            "attempt_id": l_attempt,
            "stream_id": l_stream,
            "epoch": l_epoch,
            "source_kind": "speaker",
            "provider_source_id": f"google_meet:{lobby_rec_id}:receiver:1",
            "speaker_id": None,
            "attribution_unknown": True,
            "sample_rate": 16000,
            "channels": 1,
            "encoding": "pcm_s16le",
            "monotonic_origin_ms": 1200,
            "session_monotonic_origin_ms": 1000,
            "session_utc_origin": "2026-10-06T09:00:00Z",
        }
        with client.websocket_connect(f"/v1/attempts/{l_attempt}/audio") as ws:
            authenticate(ws, l_cred)
            ws.send_json(begin(l_ident))
            assert ws.receive_json()["type"] == "ack"
            send_pcm(ws, l_ident, bytes(32000), 0, 0)
            ws.send_json(
                {
                    "type": "end",
                    "id": begin(l_ident)["id"] + "/end",
                    "stream_id": l_stream,
                    "epoch": l_epoch,
                    "final_sample": 16000,
                    "last_sequence": 0,
                }
            )
            assert ws.receive_json()["type"] == "ack"
        res_neg = client.post(
            f"/v1/attempts/{l_attempt}/status",
            headers={**l_headers, "X-Worker-ID": "fixture-worker"},
            json={
                "participation": "ended",
                "reason": "room_empty",
                "drained": True,
                "streams": 1,
                "audio_samples": 16000,
                "active_audio_samples": 0,
                "participant_sources": {
                    "available": True,
                    "total": 10,
                    "truncated": False,
                    "sources": [],
                },
            },
        )
        assert res_neg.status_code == 200

        for _ in range(5):
            segmentation_pass(database)
        for _ in range(10):
            inference_pass(database)
        for _ in range(5):
            finalize_processing(database)
        for _ in range(5):
            smtp_pass(database)

        # Verify ONLY the 2 real-speech events received calendar PATCH write-backs
        patched_ids = {(prov, eid) for prov, eid, _ in patches}
        assert patched_ids == {("google", "g-evt-active"), ("microsoft", "ms-evt-active")}
        from html import unescape

        token_prefix = "https://wortlaut.data.mayflower.tech/ui#view=meetings&id="
        g_desc = google_events["g-evt-active"]["description"]
        ms_body = unescape(ms_events["ms-evt-active"]["body"]["content"])
        assert token_prefix in g_desc and "token=wortlaut-read-" in g_desc
        assert "Release verbindlich für Freitag beschlossen" in g_desc
        assert token_prefix in ms_body and "token=wortlaut-read-" in ms_body
        assert (
            google_events["g-evt-lobby-timeout"]["description"]
            == "Nur bei echtem Transkript verlinken"
        )

        # Verify capture_anomaly flag & diagnostic warning in export + SMTP mail
        neg_export = client.get(f"/v1/recordings/{lobby_rec_id}/exports/json", headers=API).json()
        assert neg_export["quality"]["capture_anomaly"] is True

        assert len(smtp_receiver.messages) == 3
        subjects_and_bodies = [
            (str(m["Subject"]), m.get_body(preferencelist=("plain",)).get_content())
            for m in smtp_receiver.messages
        ]
        assert any(
            "Architektur-Sync Google" in subj and "Alice Example" in body and "Freitag" in body
            for subj, body in subjects_and_bodies
        )
        assert any(
            "Teams Sprint Review" in subj and "Alice Example" in body
            for subj, body in subjects_and_bodies
        )
        assert any(
            "Skills und Kollegen Negativfall" in subj and "mögliche Erfassungsstörung" in body
            for subj, body in subjects_and_bodies
        )
    finally:
        smtp_server.stop()
        http_server.shutdown()
        get_settings.cache_clear()
