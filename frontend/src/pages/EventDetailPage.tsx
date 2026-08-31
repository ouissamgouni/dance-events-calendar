import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { fetchEvent, updateEvent, fetchTagGroups } from '../api';
import { useAuth } from '../context/AuthContext';
import { trackView } from '../utils/tracking';
import { getDeviceId } from '../utils/deviceId';
import { useReferralAttribution } from '../hooks/useReferralAttribution';
import AdminEventDetailContent from '../components/AdminEventDetailContent';
import SuggestTagsButton from '../components/SuggestTagsButton';
import GoingButton from '../components/GoingButton';
import SaveEventButton from '../components/SaveEventButton';
import ShareButton from '../components/ShareButton';
import EventSummary, { type EventDetailTab } from '../components/EventSummary';
import EventDetailTabsBar from '../components/EventDetailTabsBar';
import EventSectionHeader from '../components/EventSectionHeader';
import EventActionDock from '../components/EventActionDock';
import AboutTab from '../components/event-tabs/AboutTab';
import LocationTab from '../components/event-tabs/LocationTab';
import PeopleTab from '../components/event-tabs/PeopleTab';
import ReviewsTab from '../components/event-tabs/ReviewsTab';
import DiscussionTab from '../components/event-tabs/DiscussionTab';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarEvent, TagGroup } from '../types';

export default function EventDetailPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);
    const { user, loading: authLoading } = useAuth();
    const { showRatings } = useFeatureFlags();

    // Edit mode — admin must explicitly activate inline editing
    const [editMode, setEditMode] = useState(false);

    // Suggest tags
    const [showSuggestTags, setShowSuggestTags] = useState(false);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);

    // Title inline editing
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleValue, setTitleValue] = useState('');
    const [savingTitle, setSavingTitle] = useState(false);
    const [reviewCount, setReviewCount] = useState(0);
    const titleCancelledRef = useRef(false);

    // Auto-open review modal when user clicks "Be the first to review" or arrives via the /review path.
    // A counter (not a boolean) so repeated requests to open the modal — e.g. clicking
    // "Be the first to review" again after closing it — reliably reopen it.
    const [reviewOpenToken, setReviewOpenToken] = useState(0);
    // Bumped whenever the current user's rating changes, so EventReviewsSection
    // reloads its aggregate + review list without a full remount.
    const [reviewsRefreshToken, setReviewsRefreshToken] = useState(0);
    // Bumped by the "Ask" action in the details actions bar to open the
    // message board's compose form (and scroll it into view).
    const [askComposeToken, setAskComposeToken] = useState(0);

    // Active detail tab. Initialised from `?tab=` on first render; kept in
    // sync with `#community`/`#messages` hashes below. `pendingAnchor` scrolls
    // to an in-tab anchor (e.g. `#series`/`#discounts`) once the tab renders.
    const initialTab = ((): EventDetailTab => {
        const t = searchParams.get('tab');
        if (t === 'about' || t === 'location' || t === 'people' || t === 'reviews' || t === 'discussion') return t;
        if (location.hash === '#community') return 'reviews';
        if (location.hash === '#messages') return 'discussion';
        return 'about';
    })();
    const [activeTab, setActiveTab] = useState<EventDetailTab>(initialTab);
    const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);

    // The page has two modes: `overview` shows the full EventSummary plus the
    // section entry-tabs; selecting a section switches to `section` mode, which
    // hides the overview behind a compact header and shows only that section.
    // Deep links (?tab=, #community/#messages, /review, /ask) open directly in
    // section mode.
    const deepLinkedToSection =
        searchParams.get('tab') !== null
        || location.hash === '#community'
        || location.hash === '#messages'
        || location.pathname.endsWith('/review')
        || location.pathname.endsWith('/ask');
    const [mode, setMode] = useState<'overview' | 'section'>(deepLinkedToSection ? 'section' : 'overview');

    const goToTab = (tab: EventDetailTab, opts?: { anchor?: string }) => {
        setActiveTab(tab);
        setPendingAnchor(opts?.anchor ?? null);
        setMode('section');
    };

    // After a tab switch that requested an anchor, scroll to it once painted.
    useEffect(() => {
        if (!pendingAnchor) return;
        const id = pendingAnchor;
        const raf = requestAnimationFrame(() => {
            document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setPendingAnchor(null);
        });
        return () => cancelAnimationFrame(raf);
    }, [pendingAnchor, activeTab]);

    // The `/event/:id/review` path arrives from a review-prompt notification
    // ("how was it?") — auto-open the Rate modal once the event (and
    // RateEventButton) has mounted, then rewrite the URL to the canonical
    // `/event/:id#community` so it doesn't reopen on refresh/back-navigation
    // and closing the modal leaves the user on the reviews section. A path
    // segment (not a query param) is used because it survives mobile PWA
    // link-capture and redirects far more reliably than `?query`/`#hash`.
    // Captured once via ref since `event` loads asynchronously and we must
    // not lose the flag before it's read below. Bumping the token must wait
    // until `event` is loaded: while it's still null this page renders a
    // "Loading…" placeholder and RateEventButton isn't mounted yet, so its
    // `autoOpenToken` ref would initialize to the already-bumped value and
    // never see a "change" to react to.
    const autoOpenRatingRef = useRef(location.pathname.endsWith('/review'));
    useEffect(() => {
        if (!autoOpenRatingRef.current || !event || authLoading) return;
        if (!user) {
            // Not signed in yet (e.g. clicked a review-prompt email/push
            // link cold) — send to login, then bounce straight back to this
            // exact review URL once authenticated.
            const returnTo = `${location.pathname}${location.search}${location.hash}`;
            navigate(`/login?next=${encodeURIComponent(returnTo)}`, { replace: true });
            return;
        }
        autoOpenRatingRef.current = false;
        setReviewOpenToken((t) => t + 1);
        navigate(
            { pathname: `/event/${eventId}`, search: location.search, hash: '#community' },
            { replace: true },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, user, authLoading]);


    // The `/event/:id/ask` path arrives from an event-reminder "ask a
    // question" CTA (email/push) — auto-open the message board's compose
    // form once the event has mounted, then rewrite the URL to the
    // canonical `/event/:id#messages`. Mirrors the `/review` handler above.
    const autoOpenAskRef = useRef(location.pathname.endsWith('/ask'));
    useEffect(() => {
        if (!autoOpenAskRef.current || !event || authLoading) return;
        if (!user) {
            const returnTo = `${location.pathname}${location.search}${location.hash}`;
            navigate(`/login?next=${encodeURIComponent(returnTo)}`, { replace: true });
            return;
        }
        autoOpenAskRef.current = false;
        setAskComposeToken((t) => t + 1);
        navigate(
            { pathname: `/event/${eventId}`, search: location.search, hash: '#messages' },
            { replace: true },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, user, authLoading]);


    // Scroll to the community reviews section when arriving via a
    // `#community` link (e.g. clicking a Review button on a card, modal, or
    // map pin elsewhere in the app). React Router doesn't auto-scroll to
    // hash targets on client-side navigation, so this handles it manually
    // once the event (and the section) has rendered.
    useEffect(() => {
        if (location.hash !== '#community' || !event) return;
        setActiveTab((prev) => (prev === 'reviews' ? prev : 'reviews'));
        setMode('section');
    }, [location.hash, event]);

    // Switch to the Discussion tab when arriving via a `#messages` link (e.g.
    // an event-message notification). Mirrors the `#community` handler above.
    useEffect(() => {
        if (location.hash !== '#messages' || !event) return;
        setActiveTab((prev) => (prev === 'discussion' ? prev : 'discussion'));
        setMode('section');
    }, [location.hash, event]);

    // Capture `?ref=share&src=` from the URL so any subsequent RSVP on
    // this event can be attributed back to the originating share_code.
    useReferralAttribution(eventId);

    useEffect(() => {
        if (!eventId) return;
        let cancelled = false;
        fetchEvent(eventId, { fresh: true })
            .then((e) => {
                if (cancelled) return;
                setEvent(e);
                setTitleValue(e.title);
                trackView(eventId, searchParams.get('src') ?? 'direct');
            })
            .catch(() => { if (!cancelled) setError(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [eventId]);

    const handleBack = () => {
        if (window.history.length > 1) navigate(-1);
        else navigate('/');
    };

    const handleFieldSave = async (changes: Partial<CalendarEvent>) => {
        if (!event) return;
        const updated = await updateEvent(event.event_id, changes);
        setEvent(updated);
        setTitleValue(updated.title);
    };

    const handleTagsUpdated = () => {
        if (!eventId) return;
        fetchEvent(eventId, { fresh: true })
            .then((e) => { setEvent(e); setTitleValue(e.title); })
            .catch(() => { });
    };

    const handleTitleBlur = async () => {
        if (titleCancelledRef.current) { titleCancelledRef.current = false; return; }
        if (!event || titleValue === event.title) { setEditingTitle(false); return; }
        setSavingTitle(true);
        try {
            const updated = await updateEvent(event.event_id, { title: titleValue });
            setEvent(updated);
        } finally {
            setSavingTitle(false);
            setEditingTitle(false);
        }
    };

    const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); handleTitleBlur(); }
        if (e.key === 'Escape') { titleCancelledRef.current = true; setTitleValue(event?.title ?? ''); setEditingTitle(false); }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-canvas">
                <p className="text-ink-soft">Loading event…</p>
            </div>
        );
    }

    if (error || !event) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-canvas gap-4">
                <p className="text-ink-soft text-lg">Event not found</p>
                <button onClick={handleBack} className="text-rose-600 hover:underline text-sm">← Back</button>
            </div>
        );
    }

    const start = new Date(event.start);
    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const end = new Date(event.end);
    const isPast = end.getTime() < Date.now();

    const pageTitle = `${event.title} — ${formatDate(start)}`;
    const pageDescription = [
        event.location && `📍 ${event.location}`,
        !event.all_day && `🕐 ${formatTime(start)} – ${formatTime(end)}`,
        event.price_is_free && '🎉 Free',
        event.description?.slice(0, 120),
    ].filter(Boolean).join(' · ');

    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'DanceEvent',
        name: event.title,
        startDate: event.start,
        endDate: event.end,
        description: event.description || undefined,
        ...(event.location && {
            location: {
                '@type': 'Place',
                name: event.location,
                ...(event.latitude != null && event.longitude != null && {
                    geo: { '@type': 'GeoCoordinates', latitude: event.latitude, longitude: event.longitude },
                }),
            },
        }),
        ...(event.price_is_free
            ? { isAccessibleForFree: true }
            : event.price_min != null && event.price_currency && {
                offers: {
                    '@type': 'Offer',
                    price: event.price_min,
                    ...(event.price_max != null && event.price_max !== event.price_min && { highPrice: event.price_max }),
                    priceCurrency: event.price_currency,
                    availability: 'https://schema.org/InStock',
                },
            }),
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    };

    const shareUrl = window.location.href;

    return (
        <>
            <Helmet>
                <title>{pageTitle}</title>
                <meta name="description" content={pageDescription} />
                <meta property="og:title" content={event.title} />
                <meta property="og:description" content={pageDescription} />
                <meta property="og:type" content="website" />
                <meta property="og:url" content={shareUrl} />
                <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
            </Helmet>

            <div className="min-h-screen bg-canvas overflow-x-hidden">
                <div className="mx-auto max-w-[480px] px-3 py-5 sm:py-8">
                    {/* Back link — hidden in section mode, where the compact
                        header carries its own back arrow (to the overview). */}
                    {mode === 'overview' && (
                        <button
                            onClick={handleBack}
                            className="text-sm text-action hover:underline mb-3 inline-flex items-center gap-1"
                        >
                            ← Back
                        </button>
                    )}
                    {editMode && user?.is_admin ? (
                        <>
                            {/* Admin inline editing keeps the legacy detail editor. */}
                            {editingTitle ? (
                                <div className="mb-4">
                                    <input
                                        autoFocus
                                        type="text"
                                        value={titleValue}
                                        onChange={(e) => setTitleValue(e.target.value)}
                                        onBlur={handleTitleBlur}
                                        onKeyDown={handleTitleKeyDown}
                                        disabled={savingTitle}
                                        className="w-full text-2xl font-bold text-ink leading-tight border-b-2 border-line bg-transparent focus:outline-none py-1"
                                    />
                                </div>
                            ) : (
                                <h1
                                    className="text-2xl font-bold text-ink leading-tight mb-4 cursor-text hover:bg-surface -mx-2 px-2 py-1 rounded transition"
                                    onClick={() => setEditingTitle(true)}
                                    title="Click to edit title"
                                >
                                    {event.title}
                                </h1>
                            )}
                            <article className="bg-surface rounded-card shadow-sm overflow-hidden">
                                <div className="px-4 py-4">
                                    <AdminEventDetailContent
                                        event={event}
                                        onFieldSave={handleFieldSave}
                                        onTagsUpdated={handleTagsUpdated}
                                    />
                                </div>
                                <div className="border-t border-card-line px-4 py-3 flex items-center gap-2 flex-wrap">
                                    <GoingButton eventId={event.event_id} appearance="pill" isPast={isPast} />
                                    <SaveEventButton eventId={event.event_id} appearance="pill" />
                                    <ShareButton eventId={event.event_id} title={event.title} url={shareUrl} />
                                    {user?.is_admin && (
                                        <button
                                            onClick={() => setEditMode(false)}
                                            className="ml-auto inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition shrink-0 bg-slate-800 text-white hover:bg-slate-700"
                                        >
                                            Done
                                        </button>
                                    )}
                                </div>
                            </article>
                        </>
                    ) : (
                        <>
                            {mode === 'overview' ? (
                                <>
                                    {/* Overview — the shared summary (identical to the
                                        modal's) followed by the section entry-tabs. The
                                        persistent dock owns the actions, so the summary
                                        hides its inline action row here. */}
                                    <EventSummary
                                        event={event}
                                        variant="page"
                                        shareUrl={shareUrl}
                                        onOpenTab={goToTab}
                                        onPostMessage={() => { setAskComposeToken((t) => t + 1); goToTab('discussion'); }}
                                        showActions={false}
                                    />

                                    <div className="mt-4">
                                        <EventDetailTabsBar
                                            active={activeTab}
                                            onSelect={(t) => goToTab(t)}
                                            variant="entry"
                                        />
                                    </div>
                                </>
                            ) : (
                                <>
                                    {/* Section mode — the overview is replaced by a
                                        compact sticky header + tab bar, and only the
                                        selected section renders below. */}
                                    <div className="sticky top-0 z-20 -mx-3">
                                        <EventSectionHeader
                                            event={event}
                                            shareUrl={shareUrl}
                                            onBack={() => setMode('overview')}
                                        />
                                        <EventDetailTabsBar
                                            active={activeTab}
                                            onSelect={(t) => goToTab(t)}
                                        />
                                    </div>

                                    <div className="mt-4">
                                        {activeTab === 'about' && <AboutTab event={event} />}
                                        {activeTab === 'location' && <LocationTab event={event} />}
                                        {activeTab === 'people' && <PeopleTab eventId={event.event_id} />}
                                        {activeTab === 'reviews' && (
                                            showRatings ? (
                                                <div id="community">
                                                    <ReviewsTab
                                                        eventId={event.event_id}
                                                        isPast={isPast}
                                                        onAggregateLoaded={(a) => setReviewCount(a?.count ?? 0)}
                                                        onOpenReviewForm={() => setReviewOpenToken((t) => t + 1)}
                                                        refreshToken={reviewsRefreshToken}
                                                    />
                                                </div>
                                            ) : (
                                                <p className="text-sm text-ink-soft">Reviews are not available for this event.</p>
                                            )
                                        )}
                                        {activeTab === 'discussion' && (
                                            <div id="messages">
                                                <DiscussionTab
                                                    eventId={event.event_id}
                                                    isPast={isPast}
                                                    openComposeToken={askComposeToken}
                                                />
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </>
                    )}

                    {/* Suggest tags modal */}
                    {showSuggestTags && (
                        <SuggestTagsButton
                            eventId={event.event_id}
                            tagGroups={tagGroups}
                            existingTagIds={new Set(event.tags?.map((t) => t.id) ?? [])}
                            deviceId={getDeviceId()}
                            onClose={() => setShowSuggestTags(false)}
                        />
                    )}
                </div>

                {/* Persistent, prominent action dock — visible in both overview
                    and section modes so Save / I'm going / Review / Share stay
                    reachable without scrolling. */}
                {!editMode && (
                    <EventActionDock
                        event={event}
                        isPast={isPast}
                        shareUrl={shareUrl}
                        reviewOpenToken={reviewOpenToken}
                        onRatingChanged={() => setReviewsRefreshToken((t) => t + 1)}
                        eventHasReviews={reviewCount > 0}
                        onPostMessage={() => { setAskComposeToken((t) => t + 1); goToTab('discussion'); }}
                        onSuggestEdit={() => {
                            if (!tagGroups.length) fetchTagGroups().then(setTagGroups).catch(() => { });
                            setShowSuggestTags(true);
                        }}
                    />
                )}
                {/* Spacer so the dock never overlaps page content. Matches the
                    dock's vertical footprint. */}
                <div className="h-20" aria-hidden="true" />
            </div>

        </>
    );
}
