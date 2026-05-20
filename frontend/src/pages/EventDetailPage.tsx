import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { fetchEvent, updateEvent, fetchTagGroups } from '../api';
import { useAuth } from '../context/AuthContext';
import { trackView } from '../utils/tracking';
import { getDeviceId } from '../utils/deviceId';
import { useReferralAttribution } from '../hooks/useReferralAttribution';
import EventDetailContent from '../components/EventDetailContent';
import AdminEventDetailContent from '../components/AdminEventDetailContent';
import EventMap from '../components/EventMap';
import SuggestTagsButton from '../components/SuggestTagsButton';
import GoingButton from '../components/GoingButton';
import SaveEventButton from '../components/SaveEventButton';
import RateEventButton from '../components/RateEventButton';
import EventReviewsSection from '../components/EventReviewsSection';
import InterestSection from '../components/InterestSection';
import ShareButton from '../components/ShareButton';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarEvent, TagGroup } from '../types';

export default function EventDetailPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);
    const { user } = useAuth();
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
            <div className="flex items-center justify-center min-h-screen bg-slate-50">
                <p className="text-slate-500">Loading event…</p>
            </div>
        );
    }

    if (error || !event) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 gap-4">
                <p className="text-slate-600 text-lg">Event not found</p>
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

            <div className="min-h-screen bg-slate-50 overflow-x-hidden">
                <div className="mx-auto max-w-5xl px-4 py-8">
                    {/* Back link */}
                    <button
                        onClick={handleBack}
                        className="text-sm text-rose-600 hover:underline mb-4 inline-flex items-center gap-1"
                    >
                        ← Back
                    </button>

                    {/* Title — editable inline for admins in edit mode */}
                    {editingTitle ? (
                        <div className="mb-6">
                            <input
                                autoFocus
                                type="text"
                                value={titleValue}
                                onChange={(e) => setTitleValue(e.target.value)}
                                onBlur={handleTitleBlur}
                                onKeyDown={handleTitleKeyDown}
                                disabled={savingTitle}
                                className="w-full text-2xl font-bold text-slate-900 leading-tight border-b-2 border-rose-300 bg-transparent focus:outline-none py-1"
                            />
                        </div>
                    ) : (
                        <h1
                            className={`text-2xl font-bold text-slate-900 leading-tight mb-6 ${editMode && user?.is_admin ? 'cursor-text hover:bg-slate-100 -mx-2 px-2 py-1 rounded transition' : ''}`}
                            onClick={editMode && user?.is_admin ? () => setEditingTitle(true) : undefined}
                            title={editMode && user?.is_admin ? 'Click to edit title' : undefined}
                        >
                            {event.title}
                        </h1>
                    )}

                    {/* 2-column layout: details left, map right */}
                    <div className="flex flex-col lg:flex-row gap-6">
                        {/* Left: event details card */}
                        <div className="lg:w-1/3 min-w-0">
                            <article className="bg-white rounded-2xl shadow-lg overflow-hidden">
                                <div className="px-6 py-5">
                                    {editMode && user?.is_admin ? (
                                        <AdminEventDetailContent
                                            event={event}
                                            onFieldSave={handleFieldSave}
                                            onTagsUpdated={handleTagsUpdated}
                                        />
                                    ) : (
                                        <EventDetailContent
                                            event={event}
                                            onTagsUpdated={handleTagsUpdated}
                                            maxTags={event.tags?.length ?? undefined}
                                            showActions={false}
                                        />
                                    )}
                                </div>

                                {/* Suggest tags panel */}
                                {showSuggestTags && (
                                    <div className="border-t border-slate-100 px-4 pt-3 pb-2">
                                        <SuggestTagsButton
                                            eventId={event.event_id}
                                            tagGroups={tagGroups}
                                            existingTagIds={new Set(event.tags?.map((t) => t.id) ?? [])}
                                            deviceId={getDeviceId()}
                                            onClose={() => setShowSuggestTags(false)}
                                        />
                                    </div>
                                )}

                                {/* Interest — combined engagement section: going attendees + total saves.
                                    InterestSection provides its own top border + padding; only horizontal padding here.
                                    px-6 matches EventDetailContent's wrapper so this section visually aligns
                                    with the promo-codes section rendered just above (inside EventDetailContent). */}
                                <div className="px-6 pb-3">
                                    <InterestSection eventId={event.event_id} eventTitle={event.title} />
                                </div>

                                {/* Actions bar — primary CTA (Going) is visually emphasised; the
                                    rest are secondary. A sticky mobile bar mirrors the primary
                                    action so users don't have to scroll back up to convert. */}
                                <div className="border-t border-slate-100 px-4 py-3 flex items-center gap-2 flex-wrap">
                                    <GoingButton eventId={event.event_id} appearance="pill" />
                                    <SaveEventButton eventId={event.event_id} appearance="pill" />
                                    <ShareButton
                                        eventId={event.event_id}
                                        title={event.title}
                                        url={shareUrl}
                                    />
                                    {showRatings && <RateEventButton eventId={event.event_id} appearance="pill" eventHasReviews={reviewCount > 0} />}
                                    {!editMode && (
                                        <button
                                            onClick={() => {
                                                if (!tagGroups.length) fetchTagGroups().then(setTagGroups).catch(() => { });
                                                setShowSuggestTags((v) => !v);
                                            }}
                                            className="text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded px-2.5 py-1 transition shrink-0"
                                        >
                                            Suggest{' '}
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 align-[-1px]">
                                                <path fillRule="evenodd" d="M2 4.75A2.75 2.75 0 0 1 4.75 2h4.379a2.75 2.75 0 0 1 1.944.805l5.122 5.122a2.75 2.75 0 0 1 0 3.889l-4.38 4.379a2.75 2.75 0 0 1-3.888 0L2.805 11.073A2.75 2.75 0 0 1 2 9.129V4.75Zm4.5 1.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                                            </svg>
                                        </button>
                                    )}
                                    {user?.is_admin && (
                                        <button
                                            onClick={() => setEditMode((m) => !m)}
                                            className={`ml-auto inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition shrink-0 ${editMode
                                                ? 'bg-slate-800 text-white hover:bg-slate-700'
                                                : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 hover:border-slate-400'
                                                }`}
                                        >
                                            {editMode ? (
                                                <>
                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                                                        <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                                                    </svg>
                                                    Done
                                                </>
                                            ) : (
                                                <>
                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                                                        <path d="m5.433 13.917.664-2.657a2 2 0 0 1 .503-.896l6.657-6.657a2.121 2.121 0 1 1 3 3l-6.657 6.657a2 2 0 0 1-.896.503l-2.657.664a.75.75 0 0 1-.914-.914Z" />
                                                    </svg>
                                                    Edit
                                                </>
                                            )}
                                        </button>
                                    )}
                                </div>
                                {showRatings && (
                                    <div className="px-6 pb-5">
                                        <EventReviewsSection eventId={event.event_id} onAggregateLoaded={(a) => setReviewCount(a?.count ?? 0)} />
                                    </div>
                                )}
                            </article>
                        </div>

                        {/* Right: interactive map */}
                        {event.latitude != null && event.longitude != null && (
                            <div className="h-[300px] lg:w-2/3 lg:h-auto lg:aspect-[4/3] rounded-xl overflow-hidden shadow-sm">
                                <EventMap events={[event]} />
                            </div>
                        )}
                    </div>
                </div>

                {/* Sticky mobile CTA bar — mirrors the in-card actions bar so
                    every primary affordance (Going, Save, Rate, Share) is
                    reachable without scrolling. Hidden on lg+ where the
                    in-card action bar is visible alongside the description. */}
                <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur px-3 py-2 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] flex items-center gap-2 overflow-x-auto">
                    <GoingButton eventId={event.event_id} appearance="pill" />
                    <SaveEventButton eventId={event.event_id} appearance="pill" />
                    {showRatings && (
                        <RateEventButton eventId={event.event_id} appearance="pill" eventHasReviews={reviewCount > 0} />
                    )}
                    <ShareButton
                        eventId={event.event_id}
                        title={event.title}
                        url={shareUrl}
                    />
                </div>
                {/* Spacer so the sticky bar never overlaps page content on
                    mobile. Matches the bar's vertical footprint. */}
                <div className="lg:hidden h-16" aria-hidden="true" />
            </div>

        </>
    );
}
