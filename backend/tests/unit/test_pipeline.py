"""Unit tests for the enrichment pipeline."""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch

from backend.db.models import CachedEvent
from backend.services.pipeline.base import (
    EnrichmentPipeline,
    EnrichmentStage,
    StageResult,
)


class _SuccessStage(EnrichmentStage):
    @property
    def name(self):
        return "success_stage"

    def should_process(self, event):
        return True

    def process(self, event):
        return True


class _FailStage(EnrichmentStage):
    @property
    def name(self):
        return "fail_stage"

    def should_process(self, event):
        return True

    def process(self, event):
        return False


class _SkipStage(EnrichmentStage):
    @property
    def name(self):
        return "skip_stage"

    def should_process(self, event):
        return False

    def process(self, event):
        return True


class _ErrorStage(EnrichmentStage):
    @property
    def name(self):
        return "error_stage"

    def should_process(self, event):
        return True

    def process(self, event):
        raise RuntimeError("boom")


def _make_event(
    event_id="evt-1", start_offset_days=10, location="Paris", description=None
):
    from datetime import timedelta

    base = datetime(2026, 5, 15, 20, 0)
    start = base + timedelta(days=start_offset_days)
    end = start + timedelta(hours=3)
    return CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title="Test",
        location=location,
        description=description,
        start=start,
        end=end,
    )


@pytest.mark.unit
class TestEnrichmentPipeline:
    def test_stages_run_in_order(self):
        """All stages run and results are tracked."""
        pipeline = EnrichmentPipeline([_SuccessStage(), _FailStage(), _SkipStage()])
        event = _make_event()

        session = MagicMock()
        session.exec.return_value.all.return_value = [event]

        progress = pipeline.run(session, ["evt-1"])

        assert progress.stages["success_stage"].processed == 1
        assert progress.stages["fail_stage"].failed == 1
        assert progress.stages["skip_stage"].skipped == 1

    def test_error_in_stage_is_caught(self):
        """A stage raising an exception records a failure, doesn't crash pipeline."""
        pipeline = EnrichmentPipeline([_ErrorStage(), _SuccessStage()])
        event = _make_event()

        session = MagicMock()
        session.exec.return_value.all.return_value = [event]

        progress = pipeline.run(session, ["evt-1"])

        assert progress.stages["error_stage"].failed == 1
        assert progress.stages["success_stage"].processed == 1

    def test_future_first_ordering(self):
        """Events are processed future-first (descending start)."""
        e1 = _make_event("evt-near", start_offset_days=1)
        e2 = _make_event("evt-far", start_offset_days=20)

        order = []

        class _TrackStage(EnrichmentStage):
            @property
            def name(self):
                return "track"

            def should_process(self, event):
                return True

            def process(self, event):
                order.append(event.event_id)
                return True

        pipeline = EnrichmentPipeline([_TrackStage()])

        session = MagicMock()
        # Simulate DB returning events in descending start order
        session.exec.return_value.all.return_value = [e2, e1]

        pipeline.run(session, ["evt-near", "evt-far"])

        assert order == ["evt-far", "evt-near"]

    def test_skip_past_events(self):
        """Events before since_date are excluded."""
        past = _make_event("evt-past", start_offset_days=-30)
        future = _make_event("evt-future", start_offset_days=10)

        pipeline = EnrichmentPipeline([_SuccessStage()])

        session = MagicMock()
        session.exec.return_value.all.return_value = [future, past]

        # since_date after the past event's start but before the future event's
        since = datetime(2026, 5, 1)
        progress = pipeline.run(session, ["evt-past", "evt-future"], since_date=since)

        assert progress.stages["success_stage"].processed == 1

    def test_commit_per_event(self):
        """Session.commit is called for each event processed."""
        e1 = _make_event("evt-1")
        e2 = _make_event("evt-2", start_offset_days=5)

        pipeline = EnrichmentPipeline([_SuccessStage()])

        session = MagicMock()
        session.exec.return_value.all.return_value = [e1, e2]

        pipeline.run(session, ["evt-1", "evt-2"])

        # Each event gets commit after each stage
        assert session.commit.call_count == 2

    def test_progress_to_dict(self):
        """PipelineProgress.to_dict returns serializable dict."""
        pipeline = EnrichmentPipeline([_SuccessStage(), _SkipStage()])
        event = _make_event()

        session = MagicMock()
        session.exec.return_value.all.return_value = [event]

        progress = pipeline.run(session, ["evt-1"])
        d = progress.to_dict()

        assert d["success_stage"]["processed"] == 1
        assert d["skip_stage"]["skipped"] == 1

    def test_empty_event_ids(self):
        """Pipeline with no event IDs does nothing."""
        pipeline = EnrichmentPipeline([_SuccessStage()])

        session = MagicMock()
        session.exec.return_value.all.return_value = []

        progress = pipeline.run(session, [])
        assert progress.stages["success_stage"].processed == 0


@pytest.mark.unit
class TestGeocodingStage:
    @patch(
        "backend.services.pipeline.stages.geocoding.geocode_location",
        return_value=(48.86, 2.35),
    )
    def test_geocodes_event_with_location(self, mock_geo):
        from backend.services.pipeline.stages.geocoding import GeocodingStage

        stage = GeocodingStage()
        event = _make_event(location="Paris")

        assert stage.should_process(event) is True
        assert stage.process(event) is True
        assert event.latitude == 48.86
        assert event.longitude == 2.35

    @patch(
        "backend.services.pipeline.stages.geocoding.geocode_location", return_value=None
    )
    def test_returns_false_on_geocode_failure(self, mock_geo):
        from backend.services.pipeline.stages.geocoding import GeocodingStage

        stage = GeocodingStage()
        event = _make_event(location="Unknown Place XYZ")

        assert stage.process(event) is False

    def test_skips_event_without_location(self):
        from backend.services.pipeline.stages.geocoding import GeocodingStage

        stage = GeocodingStage()
        event = _make_event(location=None)

        assert stage.should_process(event) is False

    def test_skips_already_geocoded(self):
        from backend.services.pipeline.stages.geocoding import GeocodingStage

        stage = GeocodingStage()
        event = _make_event(location="Paris")
        event.latitude = 48.86
        event.longitude = 2.35

        assert stage.should_process(event) is False


@pytest.mark.unit
class TestPriceExtractionStage:
    def test_extracts_price(self):
        from backend.services.pipeline.stages.price_extraction import (
            PriceExtractionStage,
        )

        stage = PriceExtractionStage()
        event = _make_event(description="Entry: €10-15")

        assert stage.should_process(event) is True
        assert stage.process(event) is True
        assert event.price_min == 10.0
        assert event.price_max == 15.0
        assert event.price_currency == "EUR"

    def test_skips_no_description(self):
        from backend.services.pipeline.stages.price_extraction import (
            PriceExtractionStage,
        )

        stage = PriceExtractionStage()
        event = _make_event(description=None)

        assert stage.should_process(event) is False


@pytest.mark.unit
class TestLinkExtractionStage:
    def test_extracts_links(self):
        from backend.services.pipeline.stages.link_extraction import LinkExtractionStage

        stage = LinkExtractionStage()
        event = _make_event(
            description="Visit https://example.com and https://other.org for more info"
        )

        assert stage.should_process(event) is True
        assert stage.process(event) is True
        assert len(event.links) == 2
        assert event.links[0]["url"] == "https://example.com"
        assert event.links[1]["url"] == "https://other.org"

    def test_deduplicates_links(self):
        from backend.services.pipeline.stages.link_extraction import LinkExtractionStage

        stage = LinkExtractionStage()
        event = _make_event(
            description="https://example.com and https://example.com again"
        )

        stage.process(event)
        assert len(event.links) == 1

    def test_skips_no_description(self):
        from backend.services.pipeline.stages.link_extraction import LinkExtractionStage

        stage = LinkExtractionStage()
        event = _make_event(description=None)

        assert stage.should_process(event) is False

    def test_returns_false_when_no_urls(self):
        from backend.services.pipeline.stages.link_extraction import LinkExtractionStage

        stage = LinkExtractionStage()
        event = _make_event(description="No links here at all")

        assert stage.process(event) is False
