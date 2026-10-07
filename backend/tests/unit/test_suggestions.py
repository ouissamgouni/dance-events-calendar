"""Unit tests for the event suggestion feature."""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch, AsyncMock

from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.api.deps import (
    require_admin,
    get_client_ip,
    create_session_token,
    get_current_user_optional,
)
from backend.db.database import get_session
from backend.db.models import (
    BlockedEvent,
    CachedEvent,
    CalendarSetting,
    EventSuggestion,
    User,
    UserEventAttendance,
)


def _fake_admin():
    return {"email": "admin@example.com", "name": "Admin"}


def _mock_session_with_suggestions(*suggestions):
    """Create a mock session that supports get/add/commit/refresh/exec for suggestions."""
    session = MagicMock(spec=Session)
    store = {s.id: s for s in suggestions}

    def mock_get(model, pk):
        if model is EventSuggestion:
            return store.get(pk)
        if model is CalendarSetting:
            return CalendarSetting(calendar_id=str(pk), name="Test Cal", enabled=True)
        return None

    def mock_add(obj):
        if isinstance(obj, EventSuggestion):
            store[obj.id] = obj
        pass

    def mock_refresh(obj):
        pass

    def mock_commit():
        pass

    def mock_exec(stmt):
        result = MagicMock()
        # Only answer with suggestions when the statement actually selects
        # them — the routes also query CachedEvent/EventSeriesMember.
        try:
            entity = stmt.column_descriptions[0]["entity"]
        except Exception:
            entity = None
        result.all.return_value = (
            list(store.values()) if entity is EventSuggestion else []
        )
        result.first.return_value = None
        return result

    session.get = mock_get
    session.add = mock_add
    session.commit = mock_commit
    session.refresh = mock_refresh
    session.exec = mock_exec
    return session


def _make_suggestion(**overrides) -> EventSuggestion:
    from uuid import uuid4

    defaults = dict(
        id=uuid4(),
        title="Test Salsa Night",
        description="A fun event",
        location="Berlin",
        start=datetime(2026, 6, 15, 20, 0),
        end=datetime(2026, 6, 15, 23, 0),
        all_day=False,
        status="pending",
        submitter_name="John",
        submitter_email="john@example.com",
    )
    defaults.update(overrides)
    return EventSuggestion(**defaults)


@pytest.mark.unit
class TestSubmitSuggestion:
    def test_honeypot_silent_reject(self):
        """Filled honeypot field → 201 returned, but no DB write."""
        mock_session = MagicMock(spec=Session)
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[get_current_user_optional] = lambda: User(
            email="bot@example.com", provider="google", provider_subject="mock|bot"
        )

        client = TestClient(app)
        resp = client.post(
            "/api/suggestions",
            json={
                "title": "Bot Event",
                "start": "2026-06-15T20:00:00",
                "end": "2026-06-15T23:00:00",
                "website": "http://spam.com",  # honeypot filled
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert "under review" in data["message"]
        # Session.add should NOT have been called (no DB write)
        mock_session.add.assert_not_called()

        app.dependency_overrides.clear()

    def test_anonymous_visitors_cannot_add_events(self):
        mock_session = MagicMock(spec=Session)
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[get_current_user_optional] = lambda: None
        try:
            resp = TestClient(app).post(
                "/api/suggestions",
                json={
                    "title": "Salsa Tuesday",
                    "start": "2027-06-15T20:00:00",
                    "end": "2027-06-15T23:00:00",
                },
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 401
        mock_session.add.assert_not_called()

    def test_submit_signed_in_user_creates_live_event_and_going(self):
        mock_session = MagicMock(spec=Session)
        mock_session.refresh = MagicMock()
        mock_session.commit = MagicMock()

        added = []

        def capture_add(obj):
            added.append(obj)

        def mock_get(model, pk):
            if model is CalendarSetting and pk == "user-submissions":
                return None
            if model is CachedEvent:
                return None
            if model is User:
                return current_user
            return None

        def mock_exec(stmt):
            result = MagicMock()
            result.first.return_value = None
            result.all.return_value = []
            return result

        mock_session.add = capture_add
        mock_session.get = mock_get
        mock_session.exec = mock_exec

        current_user = User(
            email="alice@example.com",
            display_name="Alice",
            provider="google",
            provider_subject="mock|alice@example.com",
        )

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[get_current_user_optional] = lambda: current_user

        client = TestClient(app)
        resp = client.post(
            "/api/suggestions",
            json={
                "title": "Salsa Tuesday",
                "description": "Weekly salsa class",
                "location": "Studio A",
                "latitude": 52.52,
                "longitude": 13.405,
                "start": "2027-06-15T20:00:00",
                "end": "2027-06-15T23:00:00",
                "going": True,
                "going_audience": "friends",
                "submitter_name": "Alice",
                "submitter_email": "alice@example.com",
            },
        )

        assert resp.status_code == 201, resp.text
        assert any(isinstance(obj, EventSuggestion) for obj in added)
        assert any(
            isinstance(obj, CalendarSetting) and obj.calendar_id == "user-submissions"
            for obj in added
        )
        assert any(
            isinstance(obj, CachedEvent)
            and obj.review_status == "reviewed"
            and obj.visibility == "private"
            for obj in added
        )
        assert any(
            isinstance(obj, UserEventAttendance) and obj.share_audience == "friends"
            for obj in added
        )

        app.dependency_overrides.clear()

    @staticmethod
    def _signed_in_submit(payload):
        from backend.api.routes.suggestions import limiter

        limiter.reset()
        mock_session = MagicMock(spec=Session)
        added = []
        mock_session.add = added.append
        mock_session.get = lambda model, pk: None

        def mock_exec(stmt):
            result = MagicMock()
            result.first.return_value = None
            result.all.return_value = []
            return result

        mock_session.exec = mock_exec
        user = User(
            email="alice@example.com",
            provider="google",
            provider_subject="mock|alice@example.com",
        )
        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[get_current_user_optional] = lambda: user
        try:
            with patch("backend.api.routes.suggestions._notify_admin") as notify:
                resp = TestClient(app).post("/api/suggestions", json=payload)
        finally:
            app.dependency_overrides.clear()
        return resp, added, user, notify

    def test_kept_for_myself_creates_a_private_owned_event(self):
        resp, added, user, notify = self._signed_in_submit(
            {
                "title": "Salsa Tuesday",
                "start": "2027-06-15T20:00:00",
                "end": "2027-06-15T23:00:00",
                "share_publicly": False,
            }
        )

        assert resp.status_code == 201, resp.text
        suggestion = next(o for o in added if isinstance(o, EventSuggestion))
        assert suggestion.status == "private"
        events = [o for o in added if isinstance(o, CachedEvent)]
        assert events and all(e.visibility == "private" for e in events)
        assert all(e.owner_user_id == user.id for e in events)
        notify.assert_not_called()

    def test_past_event_can_be_kept_but_not_shared(self):
        past = {
            "title": "Last week",
            "start": "2020-06-15T20:00:00",
            "end": "2020-06-15T23:00:00",
        }

        shared, *_ = self._signed_in_submit({**past, "share_publicly": True})
        kept, *_ = self._signed_in_submit({**past, "share_publicly": False})

        assert shared.status_code == 422
        assert kept.status_code == 201, kept.text

    def test_submit_missing_title(self):
        """Missing title → 422 validation error."""
        app.dependency_overrides[get_session] = lambda: MagicMock(spec=Session)
        app.dependency_overrides[get_current_user_optional] = lambda: User(
            email="alice@example.com", provider="google", provider_subject="mock|alice"
        )
        try:
            client = TestClient(app)
            resp = client.post(
                "/api/suggestions",
                json={
                    "start": "2026-06-15T20:00:00",
                    "end": "2026-06-15T23:00:00",
                },
            )
            assert resp.status_code == 422
        finally:
            app.dependency_overrides.clear()


@pytest.mark.unit
class TestSuggestionOccurrences:
    def test_lists_every_date_approval_would_create(self):
        suggestion = _make_suggestion(recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4")
        mock_session = _mock_session_with_suggestions(suggestion)

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            resp = TestClient(app).get(
                f"/api/admin/suggestions/{suggestion.id}/occurrences"
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["total"] == 4
        assert [o["index"] for o in data["occurrences"]] == [0, 1, 2, 3]
        # Nothing is materialised yet, so no occurrence claims an event id.
        assert all(o["materialised"] is False for o in data["occurrences"])

    def test_single_date_suggestion_has_one_occurrence(self):
        suggestion = _make_suggestion()
        mock_session = _mock_session_with_suggestions(suggestion)

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            resp = TestClient(app).get(
                f"/api/admin/suggestions/{suggestion.id}/occurrences"
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 1


@pytest.mark.unit
class TestApproveSuggestion:
    def test_approve_creates_cached_event(self):
        """Approving a pending suggestion creates a CachedEvent and updates status."""
        suggestion = _make_suggestion()
        mock_session = _mock_session_with_suggestions(suggestion)

        # Track added objects
        added_objects = []
        original_add = mock_session.add

        def tracking_add(obj):
            added_objects.append(obj)
            original_add(obj)

        mock_session.add = tracking_add

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "approved"
        assert data["assigned_calendar_id"] == "cal-1"

        # A CachedEvent should have been added
        cached_events = [o for o in added_objects if isinstance(o, CachedEvent)]
        assert len(cached_events) == 1
        assert cached_events[0].title == suggestion.title

        app.dependency_overrides.clear()

    def test_approve_with_promo_code_creates_promo_queue_entry(self):
        """Approving a suggestion with a promo code queues it for admin review."""
        from uuid import uuid4
        from backend.db.models import EventPromoCode

        submitter_id = uuid4()
        suggestion = _make_suggestion(
            promo_code="SALSA10",
            promo_description="10% off drinks",
            promo_source_url="https://example.com/promo",
            submitter_user_id=submitter_id,
        )
        mock_session = _mock_session_with_suggestions(suggestion)

        added_objects = []
        original_add = mock_session.add

        def tracking_add(obj):
            added_objects.append(obj)
            original_add(obj)

        def mock_exec(stmt):
            result = MagicMock()
            result.all.return_value = []
            result.first.return_value = None
            return result

        mock_session.add = tracking_add
        mock_session.exec = mock_exec

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 200, resp.text
        promo_entries = [o for o in added_objects if isinstance(o, EventPromoCode)]
        assert len(promo_entries) == 1
        assert promo_entries[0].code == "SALSA10"
        assert promo_entries[0].description == "10% off drinks"
        assert promo_entries[0].source_url == "https://example.com/promo"
        assert promo_entries[0].submitter_user_id == submitter_id

        app.dependency_overrides.clear()

    def test_approve_without_signed_in_submitter_skips_promo_queue(self):
        """Anonymous submissions cannot own a promo code entry (NOT NULL FK)."""
        from backend.db.models import EventPromoCode

        suggestion = _make_suggestion(promo_code="ANONCODE", submitter_user_id=None)
        mock_session = _mock_session_with_suggestions(suggestion)

        added_objects = []
        original_add = mock_session.add

        def tracking_add(obj):
            added_objects.append(obj)
            original_add(obj)

        mock_session.add = tracking_add

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 200, resp.text
        promo_entries = [o for o in added_objects if isinstance(o, EventPromoCode)]
        assert len(promo_entries) == 0

        app.dependency_overrides.clear()

    def test_approve_existing_live_event_with_auto_save_saves_event(self):
        """Regression test: approving a suggestion that already created a live
        event, with auto_save on, hits the elif branch referencing
        UserSavedEvent — must not raise UnboundLocalError."""
        from uuid import uuid4
        from backend.db.models import UserSavedEvent

        submitter_id = uuid4()
        suggestion = _make_suggestion(
            created_event_id="suggestion-live-2",
            submitter_user_id=submitter_id,
            auto_save=True,
        )
        mock_session = _mock_session_with_suggestions(suggestion)

        actor = User(
            id=submitter_id,
            email="alice@example.com",
            display_name="Alice",
            provider="google",
            provider_subject="mock|alice@example.com",
        )

        added_objects = []
        original_add = mock_session.add
        original_get = mock_session.get

        def tracking_add(obj):
            added_objects.append(obj)
            original_add(obj)

        def mock_get(model, pk):
            if model is User and pk == submitter_id:
                return actor
            return original_get(model, pk)

        def mock_exec(stmt):
            result = MagicMock()
            result.all.return_value = []
            result.first.return_value = None
            return result

        mock_session.add = tracking_add
        mock_session.get = mock_get
        mock_session.exec = mock_exec

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 200, resp.text
        saved_events = [o for o in added_objects if isinstance(o, UserSavedEvent)]
        assert len(saved_events) == 1
        assert saved_events[0].user_id == submitter_id

        app.dependency_overrides.clear()

    def test_approve_already_approved(self):
        """Re-approving an already approved suggestion → 400."""
        suggestion = _make_suggestion(status="approved")
        mock_session = _mock_session_with_suggestions(suggestion)

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/approve",
            json={"calendar_id": "cal-1"},
        )

        assert resp.status_code == 400
        assert "already" in resp.json()["detail"].lower()

        app.dependency_overrides.clear()

    def test_approve_pictures_the_pending_preview(self):
        suggestion = _make_suggestion(
            created_event_id="suggestion-live-1", image_key="suggestions/u1/abc"
        )
        preview = CachedEvent(
            event_id="suggestion-live-1",
            calendar_id="user-submissions",
            title=suggestion.title,
            start=suggestion.start,
            end=suggestion.end,
            review_status="pending",
        )
        mock_session = _mock_session_with_suggestions(suggestion)
        base_get = mock_session.get
        mock_session.get = lambda model, pk: (
            preview
            if model is CachedEvent and pk == preview.event_id
            else base_get(model, pk)
        )

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            resp = TestClient(app).post(
                f"/api/admin/suggestions/{suggestion.id}/approve",
                json={"calendar_id": "cal-1"},
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        assert preview.image_key == "suggestions/u1/abc"


@pytest.mark.unit
class TestSuggestionImages:
    @pytest.fixture(autouse=True)
    def _public_base_url(self, monkeypatch):
        monkeypatch.setenv("OBJECT_STORAGE_PUBLIC_BASE_URL", "https://cdn.test")

    @staticmethod
    def _user():
        from uuid import uuid4

        return User(
            id=uuid4(),
            email="alice@example.com",
            provider="google",
            provider_subject="mock|alice@example.com",
        )

    def _submit(self, user, image_key):
        from backend.api.routes.suggestions import limiter

        limiter.reset()
        app.dependency_overrides[get_session] = lambda: MagicMock(spec=Session)
        app.dependency_overrides[get_current_user_optional] = lambda: user
        try:
            return TestClient(app).post(
                "/api/suggestions",
                json={
                    "title": "Salsa",
                    "start": "2026-06-15T20:00:00",
                    "end": "2026-06-15T23:00:00",
                    "image_key": image_key,
                },
            )
        finally:
            app.dependency_overrides.clear()

    def test_submit_rejects_another_users_image(self):
        resp = self._submit(self._user(), "suggestions/someone-else/abc")
        assert resp.status_code == 400

    def test_upload_requires_sign_in(self):
        app.dependency_overrides[get_current_user_optional] = lambda: None
        try:
            resp = TestClient(app).post(
                "/api/suggestions/images",
                files={"file": ("a.png", b"x", "image/png")},
            )
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 401

    def test_upload_stages_under_the_users_prefix(self):
        user = self._user()
        app.dependency_overrides[get_current_user_optional] = lambda: user
        try:
            with patch(
                "backend.services.event_images.store_event_image",
                side_effect=lambda _id, _data, _type, base_key: base_key,
            ):
                resp = TestClient(app).post(
                    "/api/suggestions/images",
                    files={"file": ("a.png", b"x", "image/png")},
                )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        key = resp.json()["image_key"]
        assert key.startswith(f"suggestions/{user.id}/")
        assert resp.json()["image_thumb_url"] == f"https://cdn.test/{key}/thumb.webp"


@pytest.mark.unit
class TestRefuseSuggestion:
    def test_decline_keeps_the_event_private_for_its_owner(self):
        suggestion = _make_suggestion(
            created_event_id="suggestion-live-1", image_key="suggestions/u1/abc"
        )
        live_event = CachedEvent(
            event_id="suggestion-live-1",
            calendar_id="user-submissions",
            title=suggestion.title,
            start=suggestion.start,
            end=suggestion.end,
            visibility="private",
        )
        mock_session = _mock_session_with_suggestions(suggestion)
        added = []
        base_add = mock_session.add

        def tracking_add(obj):
            added.append(obj)
            base_add(obj)

        mock_session.add = tracking_add

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            resp = TestClient(app).post(
                f"/api/admin/suggestions/{suggestion.id}/decline",
                json={"admin_notes": "Not a dance event"},
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        assert suggestion.status == "declined"
        assert suggestion.admin_notes == "Not a dance event"
        assert suggestion.reviewed_at is not None
        assert suggestion.image_key == "suggestions/u1/abc"
        assert live_event.is_hidden is False
        assert not any(isinstance(obj, BlockedEvent) for obj in added)

    def test_decline_only_applies_to_a_pending_request(self):
        suggestion = _make_suggestion(status="private")
        mock_session = _mock_session_with_suggestions(suggestion)

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            resp = TestClient(app).post(
                f"/api/admin/suggestions/{suggestion.id}/decline", json={}
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 400

    @pytest.mark.parametrize("status", ["pending", "private", "declined"])
    def test_block_hides_the_event_for_everyone(self, status):
        suggestion = _make_suggestion(
            status=status,
            created_event_id="suggestion-live-1",
            image_key="suggestions/u1/abc",
        )
        live_event = CachedEvent(
            event_id="suggestion-live-1",
            calendar_id="user-submissions",
            title=suggestion.title,
            start=suggestion.start,
            end=suggestion.end,
            all_day=False,
        )
        store = {suggestion.id: suggestion, live_event.event_id: live_event}
        mock_session = MagicMock(spec=Session)

        def mock_get(model, pk):
            if model is EventSuggestion:
                return store.get(pk)
            if model is CachedEvent:
                item = store.get(pk)
                return item if isinstance(item, CachedEvent) else None
            if model is BlockedEvent:
                item = store.get(pk)
                return item if isinstance(item, BlockedEvent) else None
            return None

        def mock_add(obj):
            store_key = getattr(obj, "id", None) or getattr(obj, "event_id", None)
            if store_key is not None:
                store[store_key] = obj

        mock_session.get = mock_get
        mock_session.add = mock_add
        mock_session.commit = MagicMock()
        mock_session.refresh = MagicMock()
        mock_session.exec = MagicMock()

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin
        try:
            resp = TestClient(app).post(
                f"/api/admin/suggestions/{suggestion.id}/block",
                json={"admin_notes": "Spam"},
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        assert suggestion.status == "blocked"
        assert suggestion.image_key is None
        assert live_event.is_hidden is True
        assert any(isinstance(obj, BlockedEvent) for obj in store.values())


@pytest.mark.unit
class TestSyncSuggestionToGoogle:
    def _setup(self, suggestion, live_event):
        store = {suggestion.id: suggestion}
        if live_event is not None:
            store[live_event.event_id] = live_event
        mock_session = MagicMock(spec=Session)

        def mock_get(model, pk):
            if model is EventSuggestion:
                return store.get(pk)
            if model is CachedEvent:
                item = store.get(pk)
                return item if isinstance(item, CachedEvent) else None
            return None

        mock_session.get = mock_get
        mock_session.add = MagicMock()
        mock_session.commit = MagicMock()
        mock_session.refresh = MagicMock()
        return mock_session

    def test_sync_uses_events_current_calendar(self):
        """Sync-back targets the event's live calendar, not the stale
        approval-time assigned_calendar_id (which may be a read-only source)."""
        suggestion = _make_suggestion(
            status="approved",
            synced_to_google=False,
            assigned_calendar_id="old-readonly@group.calendar.google.com",
            created_event_id="ev-1",
        )
        live_event = CachedEvent(
            event_id="ev-1",
            calendar_id="new-writable@group.calendar.google.com",
            title=suggestion.title,
            start=suggestion.start,
            end=suggestion.end,
            all_day=False,
        )
        mock_session = self._setup(suggestion, live_event)

        mock_service = MagicMock()
        mock_service.create_event.return_value = "goog-123"
        app.state.calendar_service = mock_service

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/sync-to-google",
        )

        assert resp.status_code == 200, resp.text
        called_calendar = mock_service.create_event.call_args.kwargs["calendar_id"]
        assert called_calendar == "new-writable@group.calendar.google.com"
        assert suggestion.synced_to_google is True
        assert suggestion.google_event_id == "goog-123"

        app.dependency_overrides.clear()

    def test_sync_read_only_calendar_returns_clear_error(self):
        """A 403 requiredAccessLevel from Google → 422 with an actionable
        message instead of a raw 502."""
        suggestion = _make_suggestion(
            status="approved",
            synced_to_google=False,
            assigned_calendar_id="readonly@group.calendar.google.com",
            created_event_id="ev-2",
        )
        live_event = CachedEvent(
            event_id="ev-2",
            calendar_id="readonly@group.calendar.google.com",
            title=suggestion.title,
            start=suggestion.start,
            end=suggestion.end,
            all_day=False,
        )
        mock_session = self._setup(suggestion, live_event)

        mock_service = MagicMock()
        mock_service.create_event.side_effect = Exception(
            "HttpError 403 requiredAccessLevel: You need to have writer access"
        )
        app.state.calendar_service = mock_service

        app.dependency_overrides[get_session] = lambda: mock_session
        app.dependency_overrides[require_admin] = _fake_admin

        client = TestClient(app)
        resp = client.post(
            f"/api/admin/suggestions/{suggestion.id}/sync-to-google",
        )

        assert resp.status_code == 422, resp.text
        assert "read access" in resp.json()["detail"].lower()
        assert suggestion.synced_to_google is False

        app.dependency_overrides.clear()


@pytest.mark.unit
class TestGetClientIp:
    def test_direct_no_proxy(self):
        """Without TRUSTED_PROXIES, returns request.client.host."""
        mock_request = MagicMock()
        mock_request.client.host = "203.0.113.50"
        mock_request.headers = {}

        with patch("backend.api.deps.get_trusted_proxies", return_value=[]):
            ip = get_client_ip(mock_request)

        assert ip == "203.0.113.50"

    def test_trusted_proxy_returns_forwarded(self):
        """With matching TRUSTED_PROXIES, returns X-Forwarded-For first IP."""
        mock_request = MagicMock()
        mock_request.client.host = "10.0.0.1"  # proxy IP
        mock_request.headers = {"x-forwarded-for": "203.0.113.50, 10.0.0.1"}

        with patch(
            "backend.api.deps.get_trusted_proxies",
            return_value=["10.0.0.0/8"],
        ):
            ip = get_client_ip(mock_request)

        assert ip == "203.0.113.50"

    def test_untrusted_proxy_ignores_header(self):
        """With non-matching proxy, ignores X-Forwarded-For."""
        mock_request = MagicMock()
        mock_request.client.host = "192.168.1.100"
        mock_request.headers = {"x-forwarded-for": "203.0.113.50"}

        with patch(
            "backend.api.deps.get_trusted_proxies",
            return_value=["10.0.0.0/8"],  # doesn't match 192.168.x
        ):
            ip = get_client_ip(mock_request)

        assert ip == "192.168.1.100"


@pytest.mark.unit
class TestPublicGeocodeEndpoint:
    def test_suggestion_geocode_returns_structured_city_and_country_kinds(self):
        with patch("geopy.geocoders.Nominatim") as MockNominatim:
            mock_geocoder = MagicMock()
            MockNominatim.return_value = mock_geocoder

            paris = MagicMock()
            paris.address = "Paris, Ile-de-France, France"
            paris.latitude = 48.8566
            paris.longitude = 2.3522
            paris.raw = {
                "name": "Paris",
                "class": "boundary",
                "type": "administrative",
                "addresstype": "city",
                "boundingbox": ["48.815", "48.902", "2.224", "2.470"],
                "address": {
                    "city": "Paris",
                    "state": "Ile-de-France",
                    "country": "France",
                },
            }
            france = MagicMock()
            france.address = "France"
            france.latitude = 46.6034
            france.longitude = 1.8883
            france.raw = {
                "name": "France",
                "class": "boundary",
                "type": "administrative",
                "addresstype": "country",
                "boundingbox": ["41.263", "51.269", "-5.453", "9.868"],
                "address": {"country": "France"},
            }
            europe = MagicMock()
            europe.address = "Europe"
            europe.latitude = 51.0
            europe.longitude = 10.0
            europe.raw = {
                "name": "Europe",
                "class": "place",
                "type": "continent",
                "addresstype": "continent",
                "boundingbox": ["34.5", "81.9", "-31.3", "69.1"],
                "address": {},
            }
            mock_geocoder.geocode.return_value = [paris, france, europe]

            response = TestClient(app).get("/api/suggestions/geocode?q=france")

            assert response.status_code == 200
            data = response.json()
            assert data[0]["name"] == "Paris"
            assert data[0]["context"] == "Ile-de-France, France"
            assert data[0]["place_kind"] == "city"
            assert data[0]["type_label"] == "City"
            assert data[0]["bounding_box"]["min_lat"] == 48.815
            assert data[1]["name"] == "France"
            assert data[1]["context"] is None
            assert data[1]["place_kind"] == "country"
            assert data[2]["name"] == "Europe"
            assert data[2]["place_kind"] == "continent"
            assert data[2]["type_label"] == "Continent"

    def test_suggestion_geocode_forwards_language_preference(self):
        """Public /api/suggestions/geocode should forward Accept-Language header to Nominatim."""
        with patch("geopy.geocoders.Nominatim") as MockNominatim:
            mock_geocoder = MagicMock()
            MockNominatim.return_value = mock_geocoder

            result = MagicMock()
            result.address = "Athina, Ellada"
            result.latitude = 37.9838
            result.longitude = 23.7275
            mock_geocoder.geocode.return_value = [result]

            client = TestClient(app)
            resp = client.get(
                "/api/suggestions/geocode?q=athens",
                headers={"Accept-Language": "el-GR,el;q=0.9"},
            )

            assert resp.status_code == 200
            data = resp.json()
            assert len(data) == 1
            assert data[0]["display_name"] == "Athina, Ellada"

            # Verify language preference was forwarded to geocode
            mock_geocoder.geocode.assert_called_once()
            call_kwargs = mock_geocoder.geocode.call_args[1]
            assert "language" in call_kwargs
            # Should have Greek with English fallback
            assert "el-GR" in call_kwargs["language"] or "el" in call_kwargs["language"]
            assert "en" in call_kwargs["language"]

    def test_suggestion_geocode_defaults_to_english_when_no_header(self):
        """Public geocode should default to English when Accept-Language is missing."""
        with patch("geopy.geocoders.Nominatim") as MockNominatim:
            mock_geocoder = MagicMock()
            MockNominatim.return_value = mock_geocoder

            result = MagicMock()
            result.address = "Paris, France"
            result.latitude = 48.86
            result.longitude = 2.35
            mock_geocoder.geocode.return_value = [result]

            client = TestClient(app)
            resp = client.get("/api/suggestions/geocode?q=paris")

            assert resp.status_code == 200

            # Verify default 'en' language was used
            mock_geocoder.geocode.assert_called_once()
            call_kwargs = mock_geocoder.geocode.call_args[1]
            assert call_kwargs["language"] == "en"
