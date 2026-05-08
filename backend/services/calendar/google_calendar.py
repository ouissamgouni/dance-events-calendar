import logging
import os
import socket
import time
from datetime import datetime, timezone
from typing import Optional

from backend.services.calendar.base import (
    BaseCalendarService,
    CalendarEvent,
    CalendarInfo,
    SyncResult,
)

logger = logging.getLogger(__name__)

# Default per-request socket timeout (seconds). Overridable via env.
_HTTP_TIMEOUT = float(os.getenv("GOOGLE_CALENDAR_HTTP_TIMEOUT", "60"))


class GoogleCalendarService(BaseCalendarService):
    """Real Google Calendar API v3 client using service account credentials."""

    def __init__(self):
        self._service = None

    def _get_service(self):
        if self._service is not None:
            return self._service

        import json

        import httplib2
        from google.oauth2 import service_account
        from google_auth_httplib2 import AuthorizedHttp
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
        # Use an httplib2 client with an explicit socket timeout so that a
        # stalled Google API request fails fast and is retried instead of
        # blocking the worker thread for the OS-default (often unbounded).
        authed_http = AuthorizedHttp(
            credentials, http=httplib2.Http(timeout=_HTTP_TIMEOUT)
        )
        self._service = build("calendar", "v3", http=authed_http, cache_discovery=False)
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
            "maxResults": 250,
        }

        if sync_token:
            # Google API: syncToken is incompatible with orderBy, q, timeMin,
            # timeMax, timeZone, updatedMin. Only set syncToken here.
            kwargs["syncToken"] = sync_token
        else:
            # Full fetch.
            # NOTE: We deliberately do NOT pass `timeMin` *or* `orderBy` here.
            # Per the Google Calendar API docs, `nextSyncToken` is ONLY
            # returned when the result set is unfiltered — i.e. NOT pruned by
            # `timeMin`, `timeMax`, `q`, `updatedMin`, *or* sorted by
            # `orderBy`. Specifying any of these silently disables incremental
            # sync (no token returned), so every subsequent run becomes
            # another full fetch. We sort/filter client-side below instead.
            pass

        retries = 0
        while True:
            if page_token:
                kwargs["pageToken"] = page_token

            try:
                result = service.events().list(**kwargs).execute()
            except socket.timeout:
                # Read timeout — retry with exponential backoff before giving up
                if retries < 3:
                    wait = 2**retries
                    logger.warning(
                        "Google Calendar request timed out for %s, retrying in %ds",
                        calendar_id,
                        wait,
                    )
                    time.sleep(wait)
                    retries += 1
                    continue
                logger.error(
                    "Google Calendar request timed out for %s after %d retries",
                    calendar_id,
                    retries,
                )
                raise
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
                # Generic transient I/O errors — retry a couple of times
                if (
                    "timed out" in error_str.lower()
                    or "connection reset" in error_str.lower()
                    or "eof occurred" in error_str.lower()
                ) and retries < 3:
                    wait = 2**retries
                    logger.warning(
                        "Transient error from Google Calendar (%s), retrying in %ds",
                        error_str,
                        wait,
                    )
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
                    # Normalize to naive UTC. The DB stores `start`/`end` as
                    # TIMESTAMP WITHOUT TIME ZONE, so values read back from
                    # the DB are tz-naive. Keeping incoming values tz-aware
                    # makes equality comparisons (`existing.start != event.start`)
                    # always True, which spuriously bumps `review_status` to
                    # "pending" on every re-sync of an unchanged event.
                    if start.tzinfo is not None:
                        start = start.astimezone(timezone.utc).replace(tzinfo=None)
                    if end.tzinfo is not None:
                        end = end.astimezone(timezone.utc).replace(tzinfo=None)

                # Client-side time_min filter on full fetches (we cannot push
                # this to the server without losing nextSyncToken — see note
                # above). On incremental fetches Google returns only changes,
                # so this filter would incorrectly hide updates to older
                # events; only apply it when there is no sync token.
                if time_min is not None and sync_token is None:
                    # Compare in UTC; treat naive datetimes as UTC.
                    cutoff = time_min if time_min.tzinfo else time_min
                    end_cmp = end if (all_day or end.tzinfo is None) else end
                    if cutoff.tzinfo is None and end_cmp.tzinfo is not None:
                        end_cmp = end_cmp.replace(tzinfo=None)
                    elif cutoff.tzinfo is not None and end_cmp.tzinfo is None:
                        cutoff = cutoff.replace(tzinfo=None)
                    if end_cmp < cutoff:
                        continue

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

        logger.info(
            "Google fetch %s: events=%d deleted=%d next_sync_token=%s (incremental=%s)",
            calendar_id,
            len(events),
            len(deleted_ids),
            (next_sync_token[:8] + "…") if next_sync_token else "None",
            bool(sync_token),
        )

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
