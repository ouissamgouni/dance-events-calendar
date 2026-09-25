import csv
import io
from datetime import datetime

from backend.db.models import CachedEvent, SchedulePublication
from backend.services.program_exports import (
    build_program_projection,
    render_program_csv,
    render_program_ics,
)


def _publication() -> SchedulePublication:
    return SchedulePublication(
        schedule_id=1,
        version=3,
        published_at=datetime(2026, 10, 1, 12),
        snapshot={
            "event_id": "festival-2026",
            "timezone": "Europe/Prague",
            "day_start_hour": 6,
            "days": ["2026-10-16"],
            "venues": [
                {"id": 1, "name": "Palace", "address": "Old Town", "sort_order": 0}
            ],
            "rooms": [{"id": 2, "venue_id": 1, "name": "Grand Hall", "sort_order": 0}],
            "levels": [{"id": 3, "label": "Open"}],
            "activity_types": [{"id": 4, "name": "Workshop"}],
            "sessions": [
                {
                    "id": "session-1",
                    "title": "=Musicality",
                    "instructors": "Jemís & Dyanna",
                    "start": "2026-10-16T04:30:00Z",
                    "end": "2026-10-16T05:30:00Z",
                    "venue_id": 1,
                    "room_id": 2,
                    "level_id": 3,
                    "activity_type_id": 4,
                    "attendee_note": "Bring shoes",
                    "is_cancelled": False,
                }
            ],
        },
    )


def _event() -> CachedEvent:
    return CachedEvent(
        event_id="festival-2026",
        calendar_id="festivals",
        title="Festival",
        start=datetime(2026, 10, 16),
        end=datetime(2026, 10, 17),
    )


def test_projection_uses_program_day_boundary_and_rejects_unknown_day():
    publication = _publication()
    publication.snapshot["days"] = ["2026-10-15"]
    publication.snapshot["sessions"][0]["start"] = "2026-10-16T03:30:00Z"
    publication.snapshot["sessions"][0]["end"] = "2026-10-16T04:30:00Z"

    projection = build_program_projection(_event(), publication)

    assert projection["sessions"][0]["program_day"] == "2026-10-15"
    try:
        build_program_projection(_event(), publication, days=["2026-10-16"])
    except ValueError as exc:
        assert str(exc) == "Unknown program day: 2026-10-16"
    else:
        raise AssertionError("Unknown export day was accepted")


def test_program_ics_uses_stable_uid_sequence_and_cancellation():
    publication = _publication()
    removed = dict(publication.snapshot["sessions"][0])
    projection = build_program_projection(
        _event(), publication, selected_sessions=[(removed, "removed")]
    )

    content = render_program_ics(projection, my_plan=True)

    assert "UID:session-1@program.joinmovida.com\r\n" in content
    assert "SEQUENCE:3\r\n" in content
    assert "STATUS:CANCELLED\r\n" in content
    assert all(len(line.encode("utf-8")) <= 75 for line in content.split("\r\n"))


def test_empty_personal_selection_does_not_fall_back_to_full_program():
    projection = build_program_projection(
        _event(), _publication(), selected_sessions=[]
    )

    assert projection["sessions"] == []
    assert "BEGIN:VEVENT" not in render_program_ics(projection, my_plan=True)


def test_program_csv_is_utf8_and_neutralizes_formula_cells():
    content = render_program_csv(build_program_projection(_event(), _publication()))

    assert content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(content.decode("utf-8-sig"))))
    assert rows[1][6] == "'=Musicality"
    assert rows[1][10:13] == ["Palace", "Grand Hall", "Old Town"]
