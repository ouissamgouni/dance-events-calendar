"""Pure-function tests for handle validation in ``backend.api.routes.auth``.

These cover ``_validate_handle`` and ``_handle_in_use`` only — the route-level
422/409 surface (display_name/handle PATCH) is exercised separately in the
auth route tests so unit tests here stay fast and DB-light.
"""

import uuid

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.routes.auth import (
    _RESERVED_HANDLES,
    _handle_in_use,
    _normalize_handle,
    _validate_handle,
)
from backend.db.models import User


def test_normalize_handle_strips_and_lowercases():
    assert _normalize_handle("  Alice  ") == "alice"
    assert _normalize_handle("BOB_42") == "bob_42"


class TestValidateHandle:
    def test_blank(self):
        normalized, reason = _validate_handle("")
        assert normalized is None
        assert reason and "required" in reason.lower()

    def test_whitespace_only(self):
        normalized, reason = _validate_handle("   ")
        assert normalized is None
        assert reason and "required" in reason.lower()

    def test_too_short(self):
        # Pattern requires 3-24 chars after the leading letter.
        normalized, reason = _validate_handle("ab")
        assert normalized is None
        assert reason is not None

    def test_too_long(self):
        normalized, reason = _validate_handle("a" + "b" * 24)
        assert normalized is None
        assert reason is not None

    def test_starts_with_digit_rejected(self):
        normalized, reason = _validate_handle("1abc")
        assert normalized is None
        assert reason is not None

    def test_starts_with_underscore_rejected(self):
        normalized, reason = _validate_handle("_abc")
        assert normalized is None
        assert reason is not None

    def test_special_chars_rejected(self):
        for bad in ("ali-ce", "ali.ce", "ali ce", "ali!", "ali@b", "ali/ce"):
            normalized, reason = _validate_handle(bad)
            assert normalized is None, f"expected reject for {bad!r}"
            assert reason is not None

    def test_uppercase_is_normalized(self):
        # Validation lowercases before pattern-matching, so mixed case is fine.
        normalized, reason = _validate_handle("Alice42")
        assert normalized == "alice42"
        assert reason is None

    def test_valid_simple(self):
        normalized, reason = _validate_handle("alice")
        assert normalized == "alice"
        assert reason is None

    def test_valid_with_digits_and_underscore(self):
        normalized, reason = _validate_handle("dj_salsa_99")
        assert normalized == "dj_salsa_99"
        assert reason is None

    def test_reserved_rejected(self):
        # Spot-check a few reserved handles.
        for reserved in ("admin", "support", "api", "events", "movida"):
            assert reserved in _RESERVED_HANDLES
            normalized, reason = _validate_handle(reserved)
            assert normalized is None, f"{reserved!r} should be reserved"
            assert reason and "reserved" in reason.lower()


class TestHandleInUse:
    def _engine(self):
        eng = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(eng)
        return eng

    def test_returns_false_when_no_users(self):
        with Session(self._engine()) as s:
            assert _handle_in_use(s, "alice", exclude_user_id=None) is False

    def test_detects_existing_handle(self):
        with Session(self._engine()) as s:
            u = User(email="a@example.com", handle="alice")
            s.add(u)
            s.commit()
            assert _handle_in_use(s, "alice", exclude_user_id=None) is True

    def test_case_insensitive_match(self):
        with Session(self._engine()) as s:
            s.add(User(email="a@example.com", handle="Alice"))
            s.commit()
            # Validation always lowercases before this check, so the input is
            # lowercase but the stored value may have been written in any case
            # by older code paths. ``func.lower(User.handle)`` handles that.
            assert _handle_in_use(s, "alice", exclude_user_id=None) is True

    def test_excludes_own_user_id(self):
        with Session(self._engine()) as s:
            u = User(email="a@example.com", handle="alice")
            s.add(u)
            s.commit()
            s.refresh(u)
            # Owner re-saving the same handle should not register as a clash.
            assert _handle_in_use(s, "alice", exclude_user_id=u.id) is False
            # But other users should.
            assert _handle_in_use(s, "alice", exclude_user_id=uuid.uuid4()) is True
