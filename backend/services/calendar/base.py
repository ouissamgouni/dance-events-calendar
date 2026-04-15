from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass
class CalendarInfo:
    calendar_id: str
    name: str


@dataclass
class CalendarEvent:
    event_id: str
    calendar_id: str
    title: str
    description: Optional[str]
    location: Optional[str]
    start: datetime
    end: datetime
    all_day: bool = False


@dataclass
class SyncResult:
    events: list[CalendarEvent]
    deleted_event_ids: list[str]
    next_sync_token: Optional[str]


class BaseCalendarService(ABC):
    @abstractmethod
    def list_calendars(self) -> list[CalendarInfo]: ...

    @abstractmethod
    def get_calendar_info(self, calendar_id: str) -> Optional[CalendarInfo]:
        """Verify access to a calendar and return its info, or None if not accessible."""
        ...

    @abstractmethod
    def get_events(
        self,
        calendar_id: str,
        sync_token: Optional[str] = None,
        time_min: Optional[datetime] = None,
    ) -> SyncResult: ...

    @abstractmethod
    def create_event(
        self,
        calendar_id: str,
        title: str,
        description: Optional[str],
        location: Optional[str],
        start: datetime,
        end: datetime,
        all_day: bool = False,
    ) -> str:
        """Create an event and return its ID."""
        ...
