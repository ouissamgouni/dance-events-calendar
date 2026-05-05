"""Shared fixtures for all unit tests."""

import os
import pytest


@pytest.fixture(autouse=True)
def set_session_secret(monkeypatch):
    """Ensure SESSION_SECRET is always set for unit tests."""
    monkeypatch.setenv("SESSION_SECRET", "test-secret-for-unit-tests-only-not-secure")
