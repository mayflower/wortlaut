from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_calendar import configure, imported, mail

from wortlaut.models import CalendarEntry, Recording
from wortlaut.recurrence import recurrence_pass

NOW = datetime(2026, 10, 23, tzinfo=UTC)


@pytest.mark.parametrize("method", ["REQUEST", "CANCEL"])
def test_newer_master_supersedes_same_sequence_older_exception(
    client, database, monkeypatch, method
):
    configure(monkeypatch)
    imported(client, mail(extra="RRULE:FREQ=DAILY;COUNT=3\r\n"))
    recurrence_pass(database, NOW)
    before = occurrences(database)
    imported(
        client,
        mail(
            sequence=1,
            stamp="20261006T120000Z",
            method=method,
            starts="DTSTART;TZID=Europe/Berlin:20261025T120000",
            ends="DTEND;TZID=Europe/Berlin:20261025T123000",
            extra="RECURRENCE-ID;TZID=Europe/Berlin:20261025T100000\r\n",
        ),
    )
    recurrence_pass(database, NOW)
    imported(
        client,
        mail(
            sequence=1,
            stamp="20261007T120000Z",
            extra="RRULE:FREQ=DAILY;COUNT=3\r\n",
            link="https://other.webex.com/meet/new-master",
        ),
    )
    recurrence_pass(database, NOW)
    with Session(database) as db:
        occurrence = db.get(Recording, before[1][0])
        assert occurrence.recurrence_key == "2026-10-25T09:00:00+00:00"
        assert occurrence.starts_at == datetime(2026, 10, 25, 9, tzinfo=UTC)
        assert occurrence.meeting_url == "https://other.webex.com/meet/new-master"
        assert occurrence.participation == "scheduled"
        assert occurrence.cancelled_at is None
        assert not occurrence.calendar_conflict


def occurrences(database):
    with Session(database) as db:
        return [
            (r.id, r.recurrence_key, r.starts_at, r.participation, r.calendar_conflict)
            for r in db.scalars(select(Recording).order_by(Recording.recurrence_key))
        ]


def test_dst_exdate_rdate_and_repeated_planning_preserve_original_identity(
    client, database, monkeypatch
):
    configure(monkeypatch)
    imported(
        client,
        mail(
            extra=(
                "RRULE:FREQ=DAILY;COUNT=4\r\n"
                "EXDATE;TZID=Europe/Berlin:20261025T100000\r\n"
                "RDATE;TZID=Europe/Berlin:20261029T100000\r\n"
            )
        ),
    )
    recurrence_pass(database, NOW)
    first = occurrences(database)
    assert [(r[1], r[2].isoformat()) for r in first] == [
        ("2026-10-24T08:00:00+00:00", "2026-10-24T08:00:00+00:00"),
        ("2026-10-26T09:00:00+00:00", "2026-10-26T09:00:00+00:00"),
        ("2026-10-27T09:00:00+00:00", "2026-10-27T09:00:00+00:00"),
        ("2026-10-29T09:00:00+00:00", "2026-10-29T09:00:00+00:00"),
    ]
    database.dispose()
    recurrence_pass(database, NOW)
    assert occurrences(database) == first


def test_moved_occurrence_and_single_series_cancellation(client, database, monkeypatch):
    configure(monkeypatch)
    imported(client, mail(extra="RRULE:FREQ=DAILY;COUNT=3\r\n"))
    recurrence_pass(database, NOW)
    first = occurrences(database)
    imported(
        client,
        mail(
            sequence=1,
            starts="DTSTART;TZID=Europe/Berlin:20261025T120000",
            ends="DTEND;TZID=Europe/Berlin:20261025T123000",
            extra="RECURRENCE-ID;TZID=Europe/Berlin:20261025T100000\r\n",
        ),
    )
    recurrence_pass(database, NOW)
    moved = occurrences(database)
    assert [r[0] for r in moved] == [r[0] for r in first]
    assert moved[1][1] == "2026-10-25T09:00:00+00:00"
    assert moved[1][2] == datetime(2026, 10, 25, 11, tzinfo=UTC)
    imported(
        client,
        mail(
            sequence=2,
            method="CANCEL",
            extra="RECURRENCE-ID;TZID=Europe/Berlin:20261025T100000\r\n",
        ),
    )
    recurrence_pass(database, NOW)
    assert [r[3] for r in occurrences(database)] == ["scheduled", "ended", "scheduled"]
    imported(client, mail(sequence=3, method="CANCEL"))
    recurrence_pass(database, NOW)
    assert all(r[3] == "ended" for r in occurrences(database))


def test_series_update_preserves_rows_and_does_not_rewrite_historical_attempt(
    client, database, monkeypatch
):
    configure(monkeypatch)
    imported(client, mail(extra="RRULE:FREQ=DAILY;COUNT=2\r\n"))
    recurrence_pass(database, NOW)
    before = occurrences(database)
    # A historical completed occurrence is immutable even when the series URL changes.
    with Session(database) as db:
        recording = db.get(Recording, before[0][0])
        recording.participation = "ended"
        db.commit()
    imported(
        client,
        mail(
            sequence=1,
            extra="RRULE:FREQ=DAILY;COUNT=3\r\n",
            link="https://other.webex.com/meet/updated",
        ),
    )
    recurrence_pass(database, NOW)
    with Session(database) as db:
        records = db.scalars(select(Recording).order_by(Recording.recurrence_key)).all()
        assert len(records) == 3
        assert records[0].id == before[0][0]
        assert records[0].meeting_url == "https://example.webex.com/meet/calendar"
        assert records[1].id == before[1][0]
        assert records[1].meeting_url == "https://other.webex.com/meet/updated"


def test_thisandfuture_is_explicitly_unsupported_and_cannot_start_wrong_dates(
    client, database, monkeypatch
):
    configure(monkeypatch)
    imported(client, mail(extra="RRULE:FREQ=DAILY;COUNT=3\r\n"))
    recurrence_pass(database, NOW)
    imported(
        client,
        mail(
            sequence=1,
            extra="RECURRENCE-ID;TZID=Europe/Berlin;RANGE=THISANDFUTURE:20261025T100000\r\n",
        ),
    )
    assert all(r[4] for r in occurrences(database))  # Block before the next planner pass.
    recurrence_pass(database, NOW)
    assert all(r[4] for r in occurrences(database))
    with Session(database) as db:
        parent = db.scalar(select(CalendarEntry).where(CalendarEntry.recurrence_key == ""))
        assert (parent.status, parent.reason) == ("unsupported", "thisandfuture_unsupported")


def test_master_anchor_change_cannot_replace_original_occurrence_identities(
    client, database, monkeypatch
):
    configure(monkeypatch)
    imported(client, mail(extra="RRULE:FREQ=DAILY;COUNT=3\r\n"))
    recurrence_pass(database, NOW)
    original = occurrences(database)
    for sequence, extra in [(1, "RRULE:FREQ=DAILY;COUNT=3\r\n"), (2, "")]:
        result = imported(
            client,
            mail(
                sequence=sequence,
                starts="DTSTART;TZID=Europe/Berlin:20261024T110000",
                ends="DTEND;TZID=Europe/Berlin:20261024T113000",
                extra=extra,
            ),
        )
        assert result["reason"] == "series_anchor_change_unsupported"
        recurrence_pass(database, NOW)
        current = occurrences(database)
        assert [r[:4] for r in current] == [r[:4] for r in original]
        assert all(r[4] for r in current)
    imported(client, mail(sequence=3, extra="RRULE:FREQ=DAILY;COUNT=3\r\n"))
    recurrence_pass(database, NOW)
    assert occurrences(database) == original
