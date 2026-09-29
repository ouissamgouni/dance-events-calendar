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
            "rooms": [
                {
                    "id": 2,
                    "venue_id": 1,
                    "name": "Grand Hall",
                    "color": "amber",
                    "sort_order": 0,
                }
            ],
            "levels": [{"id": 3, "label": "Open"}],
            "activity_types": [{"id": 4, "name": "Workshop", "color": "blue"}],
            "contributors": [
                {
                    "id": 5,
                    "external_id": "alexis-ruiz",
                    "display_name": "Alexis Ruiz",
                },
                {
                    "id": 6,
                    "external_id": "angelo-rito",
                    "display_name": "Angelo Rito",
                },
                {
                    "id": 7,
                    "external_id": "terry-salsalianza",
                    "display_name": "Terry Salsalianza",
                },
            ],
            "sessions": [
                {
                    "id": "session-1",
                    "title": "=Musicality",
                    "instructors": None,
                    "contributors": [
                        {"contributor_id": 5, "role": "instructor", "position": 0},
                        {"contributor_id": 6, "role": "instructor", "position": 1},
                        {"contributor_id": 7, "role": "instructor", "position": 2},
                    ],
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


def test_projection_exposes_schedule_metadata_and_combines_filters():
    publication = _publication()
    excluded = dict(publication.snapshot["sessions"][0])
    excluded.update(
        {
            "id": "session-2",
            "instructors": "Other Teacher",
            "level_id": None,
            "activity_type_id": None,
        }
    )
    publication.snapshot["sessions"].append(excluded)

    projection = build_program_projection(
        _event(),
        publication,
        instructor="alexis",
        level_ids=[3],
        activity_type_ids=[4],
    )

    assert [row["id"] for row in projection["sessions"]] == ["session-1"]
    assert projection["rooms"][0]["color"] == "amber"
    assert projection["activity_types"][0]["color"] == "blue"
    assert (
        projection["sessions"][0]
        | {
            "venue_id": 1,
            "room_id": 2,
            "level_id": 3,
            "activity_type_id": 4,
            "is_cancelled": False,
        }
        == projection["sessions"][0]
    )


def test_projection_filters_by_exact_contributor_id():
    publication = _publication()
    excluded = dict(publication.snapshot["sessions"][0])
    excluded.update(
        {
            "id": "session-2",
            "instructors": "Jemís Guest",
            "contributors": [],
        }
    )
    publication.snapshot["sessions"].append(excluded)

    projection = build_program_projection(_event(), publication, contributor_ids=[5])

    assert [row["id"] for row in projection["sessions"]] == ["session-1"]
    assert projection["sessions"][0]["contributors"][0]["display_name"] == "Alexis Ruiz"
    assert projection["sessions"][0]["instructors"] == (
        "Alexis Ruiz, Angelo Rito, Terry Salsalianza"
    )


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
    assert "Contributors: Alexis Ruiz\\, Angelo Rito\\, Terry Salsalianza" in content
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
    assert rows[0][7] == "Contributors"
    assert rows[1][6] == "'=Musicality"
    assert rows[1][7] == "Alexis Ruiz, Angelo Rito, Terry Salsalianza"
    assert rows[1][10:13] == ["Palace", "Grand Hall", "Old Town"]
