import logging
import os
import time
from datetime import datetime
from typing import Optional

from backend.services.calendar.base import (
    BaseCalendarService,
    CalendarEvent,
    CalendarInfo,
    SyncResult,
)

logger = logging.getLogger(__name__)


class GoogleCalendarService(BaseCalendarService):
    """Real Google Calendar API v3 client using service account credentials."""

    def __init__(self):
        self._service = None

    def _get_service(self):
        if self._service is not None:
            return self._service

        import json

        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        json_str = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
        if json_str:
            credentials = service_account.Credentials.from_service_account_info(
                json.loads(json_str),
                scopes=["https://www.googleapis.com/auth/calendar"],
            )
        else:
            creds_file = os.getenv(
                "GOOGLE_SERVICE_ACCOUNT_FILE", "credentials/service-account.json"
            )
            credentials = service_account.Credentials.from_service_account_file(
                creds_file,
                scopes=["https://www.googleapis.com/auth/calendar"],
            )
        self._service = build("calendar", "v3", credentials=credentials)
        return self._service

    def list_calendars(self) -> list[CalendarInfo]:
        service = self._get_service()
        result = service.calendarList().list().execute()
        return [
            CalendarInfo(
                calendar_id=item["id"],
                name=item.get("summary", item["id"]),
            )
            for item in result.get("items", [])
        ]

    def get_calendar_info(self, calendar_id: str) -> CalendarInfo | None:
        """Verify access to a shared calendar by calling calendars().get()."""
        service = self._get_service()
        try:
            cal = service.calendars().get(calendarId=calendar_id).execute()
            return CalendarInfo(
                calendar_id=cal["id"],
                name=cal.get("summary", cal["id"]),
            )
        except Exception as exc:
            logger.warning("Cannot access calendar %s: %s", calendar_id, exc)
            return None

    def get_events(
        self,
        calendar_id: str,
        sync_token: Optional[str] = None,
        time_min: Optional[datetime] = None,
    ) -> SyncResult:
        service = self._get_service()
        events = []
        deleted_ids = []
        page_token = None
        next_sync_token = None

        kwargs = {
            "calendarId": calendar_id,
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": 250,
        }

        if sync_token:
            kwargs["syncToken"] = sync_token
        elif time_min:
            kwargs["timeMin"] = time_min.isoformat() + "Z"

        retries = 0
        while True:
            if page_token:
                kwargs["pageToken"] = page_token

            try:
                result = service.events().list(**kwargs).execute()
            except Exception as e:
                error_str = str(e)
                # 410 Gone — sync token expired, need full re-sync
                if "410" in error_str and sync_token:
                    logger.warning(
                        "Sync token expired for calendar %s, doing full re-sync",
                        calendar_id,
                    )
                    return SyncResult(
                        events=[], deleted_event_ids=[], next_sync_token=None
                    )
                # 429 Too Many Requests — exponential backoff
                if "429" in error_str and retries < 5:
                    wait = 2**retries
                    logger.warning("Rate limited, backing off %ds", wait)
                    time.sleep(wait)
                    retries += 1
                    continue
                raise

            for item in result.get("items", []):
                if item.get("status") == "cancelled":
                    deleted_ids.append(item["id"])
                    continue

                start_data = item.get("start", {})
                end_data = item.get("end", {})
                all_day = "date" in start_data

                if all_day:
                    start = datetime.fromisoformat(start_data["date"])
                    end = datetime.fromisoformat(end_data["date"])
                else:
                    start = datetime.fromisoformat(
                        start_data["dateTime"].replace("Z", "+00:00")
                    )
                    end = datetime.fromisoformat(
                        end_data["dateTime"].replace("Z", "+00:00")
                    )

                events.append(
                    CalendarEvent(
                        event_id=item["id"],
                        calendar_id=calendar_id,
                        title=item.get("summary", ""),
                        description=item.get("description"),
                        location=item.get("location"),
                        start=start,
                        end=end,
                        all_day=all_day,
                    )
                )

            page_token = result.get("nextPageToken")
            next_sync_token = result.get("nextSyncToken")
            if not page_token:
                break

        return SyncResult(
            events=events,
            deleted_event_ids=deleted_ids,
            next_sync_token=next_sync_token,
        )

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
        service = self._get_service()
        body: dict = {
            "summary": title,
        }
        if description:
            body["description"] = description
        if location:
            body["location"] = location

        if all_day:
            body["start"] = {"date": start.strftime("%Y-%m-%d")}
            body["end"] = {"date": end.strftime("%Y-%m-%d")}
        else:
            body["start"] = {"dateTime": start.isoformat(), "timeZone": "UTC"}
            body["end"] = {"dateTime": end.isoformat(), "timeZone": "UTC"}

        result = service.events().insert(calendarId=calendar_id, body=body).execute()
        return result["id"]
