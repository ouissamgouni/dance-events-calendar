import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CalendarSetting, EventSuggestion, Tag } from '../types';
import type { AdminTagGroup } from '../api';
import {
    fetchAdminCalendars, updateCalendar, discoverCalendars, addCalendar,
    fetchSettings, updateSettings, startSyncJob,
    fetchSuggestions, fetchMostSavedEvents, fetchMostViewedEvents,
    fetchAdminTagGroups,
    fetchCalendarDefaultTags, updateCalendarDefaultTags,
    fetchSourceBreakdown, fetchTopCountries, fetchTopLinks, fetchExportStats,
    fetchMostAttendedEvents, getCurrentSyncJob,
    forceSendInterestMatches, sendDigestNow, fetchWebPushSubscriberCount,
    previewInterestMatches, fetchNotificationToggleCounts,
    sendReviewPromptNow, searchEvents, fetchReviewPromptCandidates,
} from '../api';
import type { MostSavedEvent, MostViewedEvent, MostAttendedEvent, SourceBreakdown, CountryBreakdown, TopLink, ExportStat, AdminUserRow, NotificationToggleCounts, ForceInterestMatchPreviewResponse, EventSearchResult, ReviewPromptCandidate } from '../api';
import { useAuth } from '../context/AuthContext';
import SyncProgressCard from '../components/SyncProgressCard';
import SyncJobsHistoryTable from '../components/SyncJobsHistoryTable';
import EventsPanel from '../components/EventsPanel';
import type { EventsPanelPreset } from '../components/EventsPanel';
import SuggestionsPanel from '../components/SuggestionsPanel';
import UnsyncedSuggestionsPanel from '../components/UnsyncedSuggestionsPanel';
import TagSuggestionsPanel from '../components/TagSuggestionsPanel';
import PromoCodesAdminPanel from '../components/PromoCodesAdminPanel';
import AdminEventDetailPanel from '../components/AdminEventDetailPanel';
import OrganizerClaimsAdminPanel from '../components/OrganizerClaimsAdminPanel';
import DuplicatesPanel from '../components/DuplicatesPanel';
import SeriesPanel from '../components/SeriesPanel';
import FeedbackPanel from '../components/FeedbackPanel';
import AdminTagCategories from '../components/AdminTagCategories';
import AdminAnalytics from '../components/AdminAnalytics';
import AdminUsersTab from '../components/AdminUsersTab';
import AdminNotificationsTab from '../components/AdminNotificationsTab';
import AdminUserMultiPicker from '../components/AdminUserMultiPicker';
import CalendarCurationRulesPanel from '../components/CalendarCurationRulesPanel';
import { ConfirmDialog } from '../components/AppDialog';
import { useAdminCounters, notifyAdminDataChanged } from '../hooks/useAdminCounters';
import { DATE_RANGE_PRESET_CHOICES, DEFAULT_EXPLORER_PERIOD } from '../utils/dateRangePresets';
import type { DateRangePresetKey } from '../utils/dateRangePresets';

type AdminTab = 'data' | 'configuration' | 'analytics' | 'users' | 'notifications';
type ConfigurationTab = 'events-settings' | 'feature-flags' | 'tag-categories' | 'notifications';
type SyncMode = 'incremental' | 'reseed';

function AdminInfoTooltip({ label }: { label: string }) {
    return (
        <span className="group relative inline-flex align-middle">
            <button
                type="button"
                aria-label={label}
                title={label}
                className="inline-flex h-4 w-4 items-center justify-center border border-gray-300 bg-white text-[10px] font-semibold leading-none text-gray-500 hover:border-blue-300 hover:text-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-300"
            >
                ?
            </button>
            <span className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 hidden w-72 -translate-y-1/2 border border-gray-200 bg-white px-2 py-1.5 text-[10px] font-normal leading-snug text-gray-600 shadow-lg group-hover:block group-focus-within:block">
                {label}
            </span>
        </span>
    );
}

const TRENDING_TOOLTIP = 'Final score = (5 x going + 1 x saved + 0.05 x views) / (hours since event row update + 24)^0.4. Going, saved, and views count only inside the trending window; ended events and events below the Going floor score 0. Example: 8 going, 2 saved, 4 views has raw 42.2, then time decay can reduce it to about 3.8.';
const TRENDING_TOP_PERCENT_TOOLTIP = 'Relative cap for how many eligible visible events get Trending decoration. Effective count = min(Trending top N, ceil(eligible visible events x top % / 100)). Example: with 40 eligible events, top N 5, and top % 10, only min(5, ceil(4)) = 4 events are decorated.';

// Per-feature activity-email card: Instant/Digest delivery toggles plus a
// scoped "Send now" that replays only this feature's pending notifications.
function FeatureEmailCard({
    feature,
    label,
    description,
    emailModes,
    onEmailModeChange,
    onMessage,
}: {
    feature: string;
    label: string;
    description: string;
    emailModes: Record<string, boolean>;
    onEmailModeChange: (field: string, value: boolean) => void;
    onMessage: (msg: string) => void;
}) {
    const [users, setUsers] = useState<AdminUserRow[]>([]);
    const [maxPerUser, setMaxPerUser] = useState<number | undefined>(undefined);
    const [resend, setResend] = useState(false);
    const [busy, setBusy] = useState(false);
    const [localMsg, setLocalMsg] = useState('');

    const send = async () => {
        if (users.length === 0) return;
        setBusy(true);
        try {
            const res = await sendDigestNow(users.map((u) => u.user_id), maxPerUser, resend, feature);
            const sent = res.results.filter((r) => r.status === 'sent').length;
            const msg = `${label} send-now: ${sent} of ${users.length} user(s) delivered `
                + `(${res.digests_sent} email, ${res.pushes_sent} push).`;
            setLocalMsg(msg);
            onMessage(msg);
            setUsers([]);
        } catch (e) {
            const msg = e instanceof Error ? e.message : `Failed to send ${label} now.`;
            setLocalMsg(msg);
            onMessage(msg);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="border border-gray-100 p-3 space-y-3">
            <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">{label}</span>
            <p className="text-[10px] text-gray-400">{description}</p>
            <div className="flex items-center gap-4 border-t border-gray-100 pt-2.5">
                <span className="text-[11px] font-medium text-gray-700">Email delivery</span>
                <label className="flex items-center gap-1 text-[10px] text-gray-500">
                    <input
                        type="checkbox"
                        aria-label={`${label} instant email`}
                        checked={!!emailModes[`${feature}_email_instant`]}
                        onChange={(e) => onEmailModeChange(`${feature}_email_instant`, e.target.checked)}
                    />
                    Instant
                </label>
                <label className="flex items-center gap-1 text-[10px] text-gray-500">
                    <input
                        type="checkbox"
                        aria-label={`${label} digest email`}
                        checked={!!emailModes[`${feature}_email_digest`]}
                        onChange={(e) => onEmailModeChange(`${feature}_email_digest`, e.target.checked)}
                    />
                    Digest
                </label>
            </div>
            <div className="border-t border-gray-100 pt-2.5 space-y-1.5">
                <div>
                    <span className="text-[11px] font-medium text-gray-700">Send now</span>
                    <p className="text-[10px] text-gray-400">
                        Replay this feature's pending activity for the selected users immediately,
                        bypassing the schedule and once-per-day dedup gate.
                    </p>
                </div>
                <AdminUserMultiPicker
                    selected={users}
                    onChange={(rows) => { setUsers(rows); setLocalMsg(''); }}
                    placeholder="Search email, handle, or name"
                />
                <div className="flex items-center gap-2">
                    <label className="text-[10px] text-gray-500" htmlFor={`${feature}-now-max`}>Max per user</label>
                    <input
                        id={`${feature}-now-max`}
                        type="number"
                        min={1}
                        max={200}
                        value={maxPerUser ?? ''}
                        onChange={(e) => setMaxPerUser(e.target.value === '' ? undefined : Number(e.target.value))}
                        placeholder="all"
                        className="w-16 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                    />
                    <label className="flex items-center gap-1 text-[10px] text-gray-500" htmlFor={`${feature}-now-resend`} title="Force re-sending notifications already emailed/pushed">
                        <input
                            id={`${feature}-now-resend`}
                            type="checkbox"
                            checked={resend}
                            onChange={(e) => setResend(e.target.checked)}
                        />
                        Resend
                    </label>
                    <button
                        type="button"
                        onClick={send}
                        disabled={users.length === 0 || busy}
                        className="ml-auto text-[11px] px-2.5 py-1 rounded bg-emerald-600 text-white disabled:bg-gray-300 hover:bg-emerald-700"
                    >
                        {busy ? 'Sending…' : `Send now${users.length ? ` (${users.length})` : ''}`}
                    </button>
                </div>
                {localMsg && (
                    <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 p-2">
                        {localMsg}
                    </div>
                )}
            </div>
        </div>
    );
}


export default function Admin() {
    const [calendars, setCalendars] = useState<CalendarSetting[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const [newCalId, setNewCalId] = useState('');
    const [sinceDate, setSinceDate] = useState('');
    const [syncSinceDate, setSyncSinceDate] = useState('');
    const [syncInterval, setSyncInterval] = useState(15);
    const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
    const [autoSyncMode, setAutoSyncMode] = useState<SyncMode>('incremental');
    const [showPrices, setShowPrices] = useState(false);
    // Tracked only so the server flag can be kept in sync when Trending
    // is toggled (see handleToggleTrending). The standalone "Show
    // popularity" UI toggle was removed when popularity was merged into
    // Trending.
    const [, setShowPopularity] = useState(false);
    const [showRatings, setShowRatings] = useState(false);
    const [popularityThreshold, setPopularityThreshold] = useState(10);
    // Adoption-boost feature toggles (Tracks 1-3).
    const [followingBadgeEnabled, setFollowingBadgeEnabled] = useState(false);
    const [unseenStateEnabled, setUnseenStateEnabled] = useState(false);
    const [trendingEnabled, setTrendingEnabled] = useState(false);
    const [trendingBannerEnabled, setTrendingBannerEnabled] = useState(false);
    const [trendingWindowDays, setTrendingWindowDays] = useState(30);
    const [trendingFloorGoing, setTrendingFloorGoing] = useState(3);
    const [trendingTopN, setTrendingTopN] = useState(3);
    const [trendingTopPercent, setTrendingTopPercent] = useState(100);
    const [promoCodesEnabled, setPromoCodesEnabled] = useState(false);
    const [organizerClaimsEnabled, setOrganizerClaimsEnabled] = useState(false);
    const [forYouRailEnabled, setForYouRailEnabled] = useState(false);
    const [yourNextEventsRailEnabled, setYourNextEventsRailEnabled] = useState(false);
    const [networkGoingSnapshotEnabled, setNetworkGoingSnapshotEnabled] = useState(true);
    // Notification / re-engagement gates. Booleans are master switches
    // that override the corresponding env vars in ``config/loader.py``;
    // ``digestSchedule`` follows the ``dow[,dow] @ HH:MM`` grammar the
    // backend parses in each user's local timezone.
    const [eventRemindersEnabled, setEventRemindersEnabled] = useState(true);
    const [activityDigestEmailEnabled, setActivityDigestEmailEnabled] = useState(true);
    const [interestMatchNotifsEnabled, setInterestMatchNotifsEnabled] = useState(true);
    const [webPushEnabled, setWebPushEnabled] = useState(false);
    const [reminderLeadHours, setReminderLeadHours] = useState(24);
    const [digestSchedule, setDigestSchedule] = useState('tue,fri @ 09:00');
    const [reviewPromptEnabled, setReviewPromptEnabled] = useState(true);
    const [reviewPromptDelayHours, setReviewPromptDelayHours] = useState(3);
    const [reviewPromptLookbackHours, setReviewPromptLookbackHours] = useState(24);
    const [forYouReviewWindowDays, setForYouReviewWindowDays] = useState(180);
    const [reviewMoodMinReviews, setReviewMoodMinReviews] = useState(3);
    // Count of distinct signed-in users with a registered Web Push browser
    // endpoint (`push_subscriptions` table). Informational only.
    const [webPushSubscriberCount, setWebPushSubscriberCount] = useState<number | null>(null);
    // Manual override state (force-send interest matches / send digest now)
    // — support/debugging tools, not part of the persisted site settings.
    const [forceSendUsers, setForceSendUsers] = useState<AdminUserRow[]>([]);
    const [forceSendLookbackHours, setForceSendLookbackHours] = useState(24);
    const [forceSendBusy, setForceSendBusy] = useState(false);
    // Manual review-prompt force-send: pick one event + specific attendees
    // and fire the "how was it?" prompt now, bypassing the delay window.
    const [reviewNowEvent, setReviewNowEvent] = useState<EventSearchResult | null>(null);
    const [reviewNowQuery, setReviewNowQuery] = useState('');
    const [reviewNowSearchResults, setReviewNowSearchResults] = useState<EventSearchResult[]>([]);
    const [reviewNowCandidates, setReviewNowCandidates] = useState<ReviewPromptCandidate[]>([]);
    const [reviewNowCandidatesLoading, setReviewNowCandidatesLoading] = useState(false);
    const [reviewNowUsers, setReviewNowUsers] = useState<ReviewPromptCandidate[]>([]);
    const [reviewNowResend, setReviewNowResend] = useState(false);
    const [reviewNowBusy, setReviewNowBusy] = useState(false);
    const [reviewNowMessage, setReviewNowMessage] = useState<string>('');
    // Max matched events shown inline in an interest-match digest email
    // before the rest collapse behind a "Discover more" link to "For you".
    const [interestMatchMaxEventsPerEmail, setInterestMatchMaxEventsPerEmail] = useState(10);
    // Per-feature email delivery routing (instant email / batched digest).
    // Keyed by SiteSetting field name (``<feature>_email_{instant,digest}``).
    const [emailModes, setEmailModes] = useState<Record<string, boolean>>({});
    // Count of users with each per-feature notification channel toggle on,
    // shown next to the corresponding global gate below.
    const [toggleCounts, setToggleCounts] = useState<NotificationToggleCounts | null>(null);
    // Dry-run preview of the force-send box: how many events match each
    // selected user's interest profile(s) before actually sending.
    const [previewResults, setPreviewResults] = useState<ForceInterestMatchPreviewResponse | null>(null);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [eventColorBarColor, setEventColorBarColor] = useState('#64748b');
    const [tagSortMode, setTagSortMode] = useState<'group' | 'event_count'>('group');
    const [defaultExplorerPeriod, setDefaultExplorerPeriod] = useState<DateRangePresetKey>(DEFAULT_EXPLORER_PERIOD);
    const [editingCalId, setEditingCalId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [showSyncProgress, setShowSyncProgress] = useState(false);
    const [syncJobId, setSyncJobId] = useState<string | null>(null);
    const [eventsPanelOpen, setEventsPanelOpen] = useState(false);
    const [adminDetailEventId, setAdminDetailEventId] = useState<string | null>(null);
    const [eventsPanelPreset, setEventsPanelPreset] = useState<EventsPanelPreset>('all');
    const [eventsPanelCalendarId, setEventsPanelCalendarId] = useState<string>('');
    const [suggestionsPanelOpen, setSuggestionsPanelOpen] = useState(false);
    const [unsyncedPanelOpen, setUnsyncedPanelOpen] = useState(false);
    const [tagSuggestionsPanelOpen, setTagSuggestionsPanelOpen] = useState(false);
    const [feedbackPanelOpen, setFeedbackPanelOpen] = useState(false);
    const [promoCodesPanelOpen, setPromoCodesPanelOpen] = useState(false);
    const [organizerClaimsPanelOpen, setOrganizerClaimsPanelOpen] = useState(false);
    const [duplicatesPanelOpen, setDuplicatesPanelOpen] = useState(false);
    const [seriesPanelOpen, setSeriesPanelOpen] = useState(false);
    const { counters: adminCounters, refresh: refreshAdminCounters } = useAdminCounters();
    const feedbackPendingCount = adminCounters.feedbackPending;
    const tagSuggestionCount = adminCounters.tagSuggestions;
    const pendingReviewCount = adminCounters.pendingReview;
    const ungeolocatedCount = adminCounters.ungeolocated;
    const organizerClaimsPendingCount = adminCounters.organizerClaimsPending;
    const promoCodesPendingCount = adminCounters.promoCodesPending;
    const duplicatesPendingCount = adminCounters.duplicatesPending;
    const seriesPendingCount = adminCounters.seriesPending;
    const setFeedbackPendingCount = useCallback((_n: number) => refreshAdminCounters(), [refreshAdminCounters]);
    const setTagSuggestionCount = useCallback((_n: number) => refreshAdminCounters(), [refreshAdminCounters]);
    const [suggestions, setSuggestions] = useState<EventSuggestion[]>([]);
    const [mostSaved, setMostSaved] = useState<MostSavedEvent[]>([]);
    const [mostViewed, setMostViewed] = useState<MostViewedEvent[]>([]);
    const [mostAttended, setMostAttended] = useState<MostAttendedEvent[]>([]);
    const [sourceBreakdown, setSourceBreakdown] = useState<SourceBreakdown[]>([]);
    const [topCountries, setTopCountries] = useState<CountryBreakdown[]>([]);
    const [topLinks, setTopLinks] = useState<TopLink[]>([]);
    const [exportStats, setExportStats] = useState<ExportStat[]>([]);
    const [expandedDefaultTagsCalId, setExpandedDefaultTagsCalId] = useState<string | null>(null);
    const [expandedRulesCalId, setExpandedRulesCalId] = useState<string | null>(null);
    const [openMenuCalId, setOpenMenuCalId] = useState<string | null>(null);
    const [confirmReseedOpen, setConfirmReseedOpen] = useState(false);
    const [tagGroups, setTagGroups] = useState<AdminTagGroup[]>([]);
    const allTags = useMemo<Tag[]>(() => tagGroups.flatMap((g) => g.tags), [tagGroups]);
    const [calendarDefaultTagIds, setCalendarDefaultTagIds] = useState<Record<string, number[]>>({});
    const [activeConfigTab, setActiveConfigTab] = useState<ConfigurationTab>('events-settings');
    const [forceSendMessage, setForceSendMessage] = useState<string>('');
    const { tab: tabParam } = useParams<{ tab?: string }>();
    const isValidTab = (t: string | undefined): t is AdminTab =>
        t === 'data' || t === 'configuration' || t === 'analytics' || t === 'users' || t === 'notifications';
    const [activeTab, setActiveTab] = useState<AdminTab>(isValidTab(tabParam) ? tabParam : 'data');
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    // Sync activeTab with URL param (and redirect /admin -> /admin/data)
    useEffect(() => {
        if (!tabParam) {
            navigate('/admin/data', { replace: true });
            return;
        }
        if (isValidTab(tabParam)) {
            if (tabParam !== activeTab) setActiveTab(tabParam);
        } else {
            navigate('/admin/data', { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabParam]);

    const changeTab = (tab: AdminTab) => {
        setActiveTab(tab);
        navigate(`/admin/${tab}`);
    };

    const refreshSuggestions = () => fetchSuggestions().then(setSuggestions).catch(() => { });

    const loadCalendars = () => {
        fetchAdminCalendars()
            .then((cals) => {
                setCalendars(cals);
                Promise.all(
                    cals.map((cal) =>
                        fetchCalendarDefaultTags(cal.calendar_id)
                            .then((res) => ({ calId: cal.calendar_id, tagIds: res.tag_ids }))
                            .catch(() => ({ calId: cal.calendar_id, tagIds: [] })),
                    ),
                ).then((results) => {
                    const map: Record<string, number[]> = {};
                    for (const { calId, tagIds } of results) map[calId] = tagIds;
                    setCalendarDefaultTagIds(map);
                });
            })
            .catch(() => { })
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        loadCalendars();
        fetchSettings().then((s) => {
            setSinceDate(s.since_date);
            setSyncSinceDate(s.sync_since_date);
            setSyncInterval(s.sync_interval_minutes);
            setAutoSyncEnabled(s.auto_sync_enabled);
            setAutoSyncMode(s.auto_sync_mode ?? 'incremental');
            setShowPrices(s.show_prices);
            setShowPopularity(s.show_popularity);
            setShowRatings(s.show_ratings);
            setPopularityThreshold(s.popularity_threshold ?? 10);
            setFollowingBadgeEnabled(s.following_badge_enabled ?? false);
            setUnseenStateEnabled(s.unseen_state_enabled ?? false);
            setTrendingEnabled(s.trending_enabled ?? false);
            setTrendingBannerEnabled(s.trending_banner_enabled ?? false);
            setTrendingWindowDays(s.trending_window_days ?? 30);
            setTrendingFloorGoing(s.trending_floor_going ?? 3);
            setTrendingTopN(s.trending_top_n ?? 3);
            setTrendingTopPercent(s.trending_top_percent ?? 100);
            setPromoCodesEnabled(s.promo_codes_enabled ?? false);
            setOrganizerClaimsEnabled(s.organizer_claims_enabled ?? false);
            setForYouRailEnabled(s.for_you_rail_enabled ?? false);
            setYourNextEventsRailEnabled(s.your_next_events_rail_enabled ?? false);
            setNetworkGoingSnapshotEnabled(s.network_going_snapshot_enabled ?? true);
            setEventRemindersEnabled(s.event_reminders_enabled ?? true);
            setActivityDigestEmailEnabled(s.activity_digest_email_enabled ?? true);
            setInterestMatchNotifsEnabled(s.interest_match_notifications_enabled ?? true);
            setWebPushEnabled(s.web_push_enabled ?? false);
            setReminderLeadHours(s.reminder_lead_hours ?? 24);
            setDigestSchedule(s.activity_digest_schedule ?? 'tue,fri @ 09:00');
            setReviewPromptEnabled(s.review_prompt_enabled ?? true);
            setReviewPromptDelayHours(s.review_prompt_delay_hours ?? 3);
            setReviewPromptLookbackHours(s.review_prompt_lookback_hours ?? 24);
            setForYouReviewWindowDays(s.for_you_review_window_days ?? 180);
            setReviewMoodMinReviews(s.review_mood_headline_min_reviews ?? 3);
            setInterestMatchMaxEventsPerEmail(s.interest_match_max_events_per_email ?? 10);
            setEmailModes({
                friends_going_email_instant: s.friends_going_email_instant ?? false,
                friends_going_email_digest: s.friends_going_email_digest ?? true,
                social_activity_email_instant: s.social_activity_email_instant ?? false,
                social_activity_email_digest: s.social_activity_email_digest ?? true,
                friend_reviews_email_instant: s.friend_reviews_email_instant ?? false,
                friend_reviews_email_digest: s.friend_reviews_email_digest ?? true,
                friend_milestones_email_instant: s.friend_milestones_email_instant ?? false,
                friend_milestones_email_digest: s.friend_milestones_email_digest ?? true,
                interest_matches_email_instant: s.interest_matches_email_instant ?? false,
                interest_matches_email_digest: s.interest_matches_email_digest ?? true,
            });
            setEventColorBarColor(s.event_color_bar_color || '#64748b');
            setTagSortMode(s.tag_sort_mode === 'event_count' ? 'event_count' : 'group');
            setDefaultExplorerPeriod(s.default_explorer_period ?? DEFAULT_EXPLORER_PERIOD);
        }).catch(() => { });
        fetchSuggestions().then(setSuggestions).catch(() => { });
        fetchMostSavedEvents().then(setMostSaved).catch(() => { });
        fetchMostViewedEvents().then(setMostViewed).catch(() => { });
        fetchMostAttendedEvents().then(setMostAttended).catch(() => { });
        fetchSourceBreakdown().then(setSourceBreakdown).catch(() => { });
        fetchTopCountries().then(setTopCountries).catch(() => { });
        fetchTopLinks().then(setTopLinks).catch(() => { });
        fetchExportStats().then(setExportStats).catch(() => { });
        fetchWebPushSubscriberCount().then((r) => setWebPushSubscriberCount(r.subscriber_count)).catch(() => { });
        fetchNotificationToggleCounts().then(setToggleCounts).catch(() => { });
        // Counters (pending review, ungeolocated, tag suggestions, feedback)
        // are loaded & kept fresh by the useAdminCounters hook above — no
        // need to fetch them here.
        getCurrentSyncJob()
            .then((j) => {
                if (j && (j.status === 'running' || j.status === 'abort_requested')) {
                    setSyncJobId(j.job_id);
                    setShowSyncProgress(true);
                }
            })
            .catch(() => { });
    }, []);

    const handleToggle = async (cal: CalendarSetting) => {
        const updated = await updateCalendar(cal.calendar_id, { enabled: !cal.enabled });
        setCalendars((prev) => prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)));
    };

    const handleToggleShowEvents = async (cal: CalendarSetting) => {
        const updated = await updateCalendar(cal.calendar_id, { show_events: !cal.show_events });
        setCalendars((prev) => prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)));
    };

    const handleColorChange = async (cal: CalendarSetting, color: string) => {
        const updated = await updateCalendar(cal.calendar_id, { color });
        setCalendars((prev) => prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)));
    };

    const handleNameEdit = (cal: CalendarSetting) => {
        setEditingCalId(cal.calendar_id);
        setEditingName(cal.name);
    };

    const handleNameSave = async (cal: CalendarSetting) => {
        const trimmed = editingName.trim();
        setEditingCalId(null);
        if (!trimmed || trimmed === cal.name) return;
        const updated = await updateCalendar(cal.calendar_id, { name: trimmed });
        setCalendars((prev) => prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)));
    };

    const handleShowCalendarEvents = (calId: string) => {
        setEventsPanelCalendarId(calId);
        setEventsPanelPreset('all');
        setEventsPanelOpen(true);
    };

    const handleToggleDefaultTags = async (calId: string) => {
        if (expandedDefaultTagsCalId === calId) {
            setExpandedDefaultTagsCalId(null);
            return;
        }
        setExpandedDefaultTagsCalId(calId);
        if (tagGroups.length === 0) {
            const groups = await fetchAdminTagGroups().catch(() => []);
            setTagGroups(groups);
        }
        if (!(calId in calendarDefaultTagIds)) {
            const result = await fetchCalendarDefaultTags(calId).catch(() => ({ tag_ids: [] }));
            setCalendarDefaultTagIds((prev) => ({ ...prev, [calId]: result.tag_ids }));
        }
    };

    const handleToggleDefaultTag = async (calId: string, tagId: number) => {
        const current = calendarDefaultTagIds[calId] ?? [];
        const next = current.includes(tagId)
            ? current.filter((id) => id !== tagId)
            : [...current, tagId];
        setCalendarDefaultTagIds((prev) => ({ ...prev, [calId]: next }));
        await updateCalendarDefaultTags(calId, next).catch(() => {
            setCalendarDefaultTagIds((prev) => ({ ...prev, [calId]: current }));
        });
    };

    const handleDiscover = async () => {
        setBusy('discover');
        setMessage('');
        try {
            const result = await discoverCalendars();
            setMessage(
                result.discovered > 0
                    ? `Found ${result.discovered} new calendar(s). ${result.total} total.`
                    : `No new calendars found. ${result.total} total.`,
            );
            loadCalendars();
        } catch {
            setMessage('Failed to discover calendars.');
        } finally {
            setBusy('');
        }
    };

    const handleAddCalendar = async () => {
        const id = newCalId.trim();
        if (!id) return;
        setBusy('add');
        setMessage('');
        try {
            await addCalendar(id);
            setNewCalId('');
            setMessage(`Calendar added: ${id}`);
            loadCalendars();
        } catch (err: unknown) {
            setMessage(err instanceof Error ? err.message : 'Failed to add calendar.');
        } finally {
            setBusy('');
        }
    };

    const handleSync = async (mode: SyncMode = 'incremental', confirmed = false) => {
        if (mode === 'reseed' && !confirmed) {
            setConfirmReseedOpen(true);
            return;
        }
        setBusy('sync');
        setMessage('');
        try {
            const job = await startSyncJob(mode, syncSinceDate || null);
            setSyncJobId(job.job_id);
            setShowSyncProgress(true);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : '';
            if (msg.includes('already running') || msg.includes('409')) {
                setShowSyncProgress(true);
            } else {
                setMessage(msg || 'Failed to start sync job.');
            }
        } finally {
            setBusy('');
        }
    };

    const handleLogout = async () => {
        await logout();
        navigate('/login', { replace: true });
    };

    const handleSinceDateSave = async () => {
        setBusy('since');
        setMessage('');
        try {
            const result = await updateSettings({ since_date: sinceDate });
            setSinceDate(result.since_date);
            setMessage('Display cutoff date saved.');
        } catch {
            setMessage('Failed to save setting.');
        } finally {
            setBusy('');
        }
    };

    const handleSyncSinceDateChange = async (value: string) => {
        const prev = syncSinceDate;
        setSyncSinceDate(value);
        if (!value) return;
        try {
            const result = await updateSettings({ sync_since_date: value });
            setSyncSinceDate(result.sync_since_date);
        } catch {
            setSyncSinceDate(prev);
            setMessage('Failed to save sync cutoff date.');
        }
    };

    const handleSyncIntervalSave = async () => {
        setBusy('interval');
        setMessage('');
        try {
            const result = await updateSettings({ sync_interval_minutes: syncInterval });
            setSyncInterval(result.sync_interval_minutes);
            setMessage('Sync interval saved.');
        } catch {
            setMessage('Failed to save setting.');
        } finally {
            setBusy('');
        }
    };

    const handleToggleAutoSync = async () => {
        const newVal = !autoSyncEnabled;
        setAutoSyncEnabled(newVal);
        try {
            await updateSettings({ auto_sync_enabled: newVal });
            setMessage(`Automatic sync ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setAutoSyncEnabled(!newVal);
            setMessage('Failed to update auto sync setting.');
        }
    };

    const handleAutoSyncModeChange = async (mode: SyncMode) => {
        const prev = autoSyncMode;
        setAutoSyncMode(mode);
        try {
            await updateSettings({ auto_sync_mode: mode });
        } catch {
            setAutoSyncMode(prev);
            setMessage('Failed to update auto sync mode.');
        }
    };

    const handleTogglePrices = async () => {
        const newVal = !showPrices;
        setShowPrices(newVal);
        try {
            await updateSettings({ show_prices: newVal });
            setMessage(`Price display ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setShowPrices(!newVal);
            setMessage('Failed to update feature flag.');
        }
    };

    // Trending owns the popularity surface now — the standalone
    // "Show popularity" toggle has been removed from the UI but its
    // server flag is still synced via handleToggleTrending so legacy
    // consumers keep working.

    const handleToggleRatings = async () => {
        const newVal = !showRatings;
        setShowRatings(newVal);
        try {
            await updateSettings({ show_ratings: newVal });
            setMessage(`Ratings ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setShowRatings(!newVal);
            setMessage('Failed to update feature flag.');
        }
    };

    const handlePopularityThresholdChange = async (value: number) => {
        if (isNaN(value) || value < 1) return;
        setPopularityThreshold(value);
        try {
            await updateSettings({ popularity_threshold: value });
        } catch {
            setMessage('Failed to update popularity threshold.');
        }
    };

    const handleToggleFollowingBadge = async () => {
        const newVal = !followingBadgeEnabled;
        setFollowingBadgeEnabled(newVal);
        try {
            await updateSettings({ following_badge_enabled: newVal });
            setMessage(`Following badge ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setFollowingBadgeEnabled(!newVal);
            setMessage('Failed to update following badge.');
        }
    };

    const handleToggleUnseenState = async () => {
        const newVal = !unseenStateEnabled;
        setUnseenStateEnabled(newVal);
        try {
            await updateSettings({ unseen_state_enabled: newVal });
            setMessage(`New event markers ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setUnseenStateEnabled(!newVal);
            setMessage('Failed to update new event markers.');
        }
    };

    const handleToggleTrending = async () => {
        const newVal = !trendingEnabled;
        setTrendingEnabled(newVal);
        // "Show popularity" was merged into the Trending toggle: the
        // legacy view-count surface no longer exists independently, so
        // the two server flags move in lockstep.
        setShowPopularity(newVal);
        try {
            await updateSettings({ trending_enabled: newVal, show_popularity: newVal });
            setMessage(`Trending ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setTrendingEnabled(!newVal);
            setShowPopularity(!newVal);
            setMessage('Failed to update trending toggle.');
        }
    };

    const handleToggleTrendingBanner = async () => {
        const newVal = !trendingBannerEnabled;
        setTrendingBannerEnabled(newVal);
        try {
            await updateSettings({ trending_banner_enabled: newVal });
            setMessage(`Trending banner ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setTrendingBannerEnabled(!newVal);
            setMessage('Failed to update trending banner toggle.');
        }
    };

    const handleToggleForYouRail = async () => {
        const newVal = !forYouRailEnabled;
        setForYouRailEnabled(newVal);
        try {
            await updateSettings({ for_you_rail_enabled: newVal });
            setMessage(`"For you" rail ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setForYouRailEnabled(!newVal);
            setMessage('Failed to update "For you" rail toggle.');
        }
    };

    const handleToggleYourNextEventsRail = async () => {
        const newVal = !yourNextEventsRailEnabled;
        setYourNextEventsRailEnabled(newVal);
        try {
            await updateSettings({ your_next_events_rail_enabled: newVal });
            setMessage(`"Your next events" rail ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setYourNextEventsRailEnabled(!newVal);
            setMessage('Failed to update "Your next events" rail toggle.');
        }
    };

    const handleToggleNetworkGoingSnapshot = async () => {
        const newVal = !networkGoingSnapshotEnabled;
        setNetworkGoingSnapshotEnabled(newVal);
        try {
            await updateSettings({ network_going_snapshot_enabled: newVal });
            setMessage(`"Your Network" snapshot ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setNetworkGoingSnapshotEnabled(!newVal);
            setMessage('Failed to update "Your Network" snapshot toggle.');
        }
    };

    const handleTogglePromoCodes = async () => {
        const newVal = !promoCodesEnabled;
        setPromoCodesEnabled(newVal);
        try {
            await updateSettings({ promo_codes_enabled: newVal });
            setMessage(`Promo codes ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setPromoCodesEnabled(!newVal);
            setMessage('Failed to update promo codes toggle.');
        }
    };

    const handleToggleOrganizerClaims = async () => {
        const newVal = !organizerClaimsEnabled;
        setOrganizerClaimsEnabled(newVal);
        try {
            await updateSettings({ organizer_claims_enabled: newVal });
            setMessage(`Organizer claims ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setOrganizerClaimsEnabled(!newVal);
            setMessage('Failed to update organizer claims toggle.');
        }
    };

    const handleTrendingWindowDaysChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 365) return;
        setTrendingWindowDays(value);
        try {
            await updateSettings({ trending_window_days: value });
        } catch {
            setMessage('Failed to update trending window.');
        }
    };

    const handleTrendingFloorGoingChange = async (value: number) => {
        if (isNaN(value) || value < 0 || value > 100) return;
        setTrendingFloorGoing(value);
        try {
            await updateSettings({ trending_floor_going: value });
        } catch {
            setMessage('Failed to update trending floor.');
        }
    };

    const handleTrendingTopNChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 50) return;
        setTrendingTopN(value);
        try {
            await updateSettings({ trending_top_n: value });
        } catch {
            setMessage('Failed to update trending top N.');
        }
    };

    const handleTrendingTopPercentChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 100) return;
        setTrendingTopPercent(value);
        try {
            await updateSettings({ trending_top_percent: value });
        } catch {
            setMessage('Failed to update trending top percent.');
        }
    };

    const handleTagSortModeChange = async (mode: 'group' | 'event_count') => {
        const prev = tagSortMode;
        setTagSortMode(mode);
        try {
            await updateSettings({ tag_sort_mode: mode });
            setMessage(`Tag pill order: ${mode === 'event_count' ? 'by event count' : 'by group'}.`);
        } catch {
            setTagSortMode(prev);
            setMessage('Failed to update tag sort order.');
        }
    };

    const handleDefaultExplorerPeriodChange = async (period: DateRangePresetKey) => {
        const prev = defaultExplorerPeriod;
        setDefaultExplorerPeriod(period);
        try {
            await updateSettings({ default_explorer_period: period });
            const label = DATE_RANGE_PRESET_CHOICES.find((choice) => choice.key === period)?.label ?? 'selected period';
            setMessage(`Explorer default period: ${label}.`);
        } catch {
            setDefaultExplorerPeriod(prev);
            setMessage('Failed to update Explorer default period.');
        }
    };

    const handleEventColorBarColorChange = async (value: string) => {
        const v = value.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
            setMessage('Color must be a 6-digit hex like #64748b.');
            return;
        }
        const prev = eventColorBarColor;
        setEventColorBarColor(v);
        try {
            await updateSettings({ event_color_bar_color: v });
            setMessage('Event bar color updated.');
        } catch {
            setEventColorBarColor(prev);
            setMessage('Failed to update event bar color.');
        }
    };

    const handleToggleReminders = async () => {
        const newVal = !eventRemindersEnabled;
        setEventRemindersEnabled(newVal);
        try {
            await updateSettings({ event_reminders_enabled: newVal });
            setMessage(`Event reminders ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setEventRemindersEnabled(!newVal);
            setMessage('Failed to update reminders toggle.');
        }
    };

    const handleToggleActivityEmail = async () => {
        const newVal = !activityDigestEmailEnabled;
        setActivityDigestEmailEnabled(newVal);
        try {
            await updateSettings({ activity_digest_email_enabled: newVal });
            setMessage(`Activity digest email ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setActivityDigestEmailEnabled(!newVal);
            setMessage('Failed to update activity email toggle.');
        }
    };

    const handleToggleInterestMatchNotifs = async () => {
        const newVal = !interestMatchNotifsEnabled;
        setInterestMatchNotifsEnabled(newVal);
        try {
            await updateSettings({ interest_match_notifications_enabled: newVal });
            setMessage(`Interest-match notifications ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setInterestMatchNotifsEnabled(!newVal);
            setMessage('Failed to update interest notifications toggle.');
        }
    };

    const handleToggleWebpush = async () => {
        const newVal = !webPushEnabled;
        setWebPushEnabled(newVal);
        try {
            await updateSettings({ web_push_enabled: newVal });
            setMessage(`Web push ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setWebPushEnabled(!newVal);
            setMessage('Failed to update web push toggle.');
        }
    };

    const handleReminderLeadHoursChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 720) return;
        const prev = reminderLeadHours;
        setReminderLeadHours(value);
        try {
            await updateSettings({ reminder_lead_hours: value });
            setMessage(`Reminder lead time set to ${value}h.`);
        } catch {
            setReminderLeadHours(prev);
            setMessage('Failed to update reminder lead time.');
        }
    };

    const handleDigestScheduleChange = async (value: string) => {
        const v = value.trim().toLowerCase();
        // Mirror the backend regex: <dow>[,<dow>...] @ HH:MM.
        if (!/^([a-z]{3})(,[a-z]{3})*\s*@\s*\d{1,2}:\d{2}$/.test(v)) {
            setMessage('Digest schedule must look like "tue,fri @ 09:00".');
            return;
        }
        const prev = digestSchedule;
        setDigestSchedule(v);
        try {
            await updateSettings({ activity_digest_schedule: v });
            setMessage(`Digest schedule set to "${v}".`);
        } catch {
            setDigestSchedule(prev);
            setMessage('Failed to update digest schedule.');
        }
    };

    const handleEmailModeChange = async (field: string, value: boolean) => {
        const prev = emailModes[field];
        setEmailModes((m) => ({ ...m, [field]: value }));
        try {
            await updateSettings({ [field]: value } as Record<string, boolean>);
        } catch {
            setEmailModes((m) => ({ ...m, [field]: prev }));
            setMessage('Failed to update email delivery mode.');
        }
    };

    const handleToggleReviewPrompt = async () => {
        const newVal = !reviewPromptEnabled;
        setReviewPromptEnabled(newVal);
        try {
            await updateSettings({ review_prompt_enabled: newVal });
            setMessage(`Review prompts ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setReviewPromptEnabled(!newVal);
            setMessage('Failed to update review prompt toggle.');
        }
    };

    const handleReviewPromptDelayHoursChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 720) return;
        const prev = reviewPromptDelayHours;
        setReviewPromptDelayHours(value);
        try {
            await updateSettings({ review_prompt_delay_hours: value });
            setMessage(`Review prompt delay set to ${value}h.`);
        } catch {
            setReviewPromptDelayHours(prev);
            setMessage('Failed to update review prompt delay.');
        }
    };

    const handleReviewPromptLookbackHoursChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 720) return;
        const prev = reviewPromptLookbackHours;
        setReviewPromptLookbackHours(value);
        try {
            await updateSettings({ review_prompt_lookback_hours: value });
            setMessage(`Review prompt lookback set to ${value}h.`);
        } catch {
            setReviewPromptLookbackHours(prev);
            setMessage('Failed to update review prompt lookback.');
        }
    };

    const handleForYouReviewWindowDaysChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 3650) return;
        const prev = forYouReviewWindowDays;
        setForYouReviewWindowDays(value);
        try {
            await updateSettings({ for_you_review_window_days: value });
            setMessage(`"Share your experience" window set to ${value} days.`);
        } catch {
            setForYouReviewWindowDays(prev);
            setMessage('Failed to update review window.');
        }
    };

    const handleReviewMoodMinReviewsChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 1000) return;
        const prev = reviewMoodMinReviews;
        setReviewMoodMinReviews(value);
        try {
            await updateSettings({ review_mood_headline_min_reviews: value });
            setMessage(`Mood headline threshold set to ${value} reviews.`);
        } catch {
            setReviewMoodMinReviews(prev);
            setMessage('Failed to update mood headline threshold.');
        }
    };

    const handleInterestMatchMaxEventsChange = async (value: number) => {
        if (isNaN(value) || value < 1 || value > 50) return;
        const prev = interestMatchMaxEventsPerEmail;
        setInterestMatchMaxEventsPerEmail(value);
        try {
            await updateSettings({ interest_match_max_events_per_email: value });
            setMessage(`Max events per interest-match email set to ${value}.`);
        } catch {
            setInterestMatchMaxEventsPerEmail(prev);
            setMessage('Failed to update max events per email.');
        }
    };

    const handlePreviewInterestMatches = async () => {
        if (forceSendUsers.length === 0) return;
        setPreviewBusy(true);
        setPreviewResults(null);
        try {
            const res = await previewInterestMatches(
                forceSendUsers.map((u) => u.user_id),
                forceSendLookbackHours,
            );
            setPreviewResults(res);
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to preview interest matches.');
        } finally {
            setPreviewBusy(false);
        }
    };

    const handleForceSendInterestMatches = async () => {
        if (forceSendUsers.length === 0) return;
        setForceSendBusy(true);
        try {
            const res = await forceSendInterestMatches(
                forceSendUsers.map((u) => u.user_id),
                forceSendLookbackHours,
            );
            const sent = res.results.filter((r) => r.status === 'sent').length;
            const msg = `Interest-match force-send: ${res.notifications_created} match(es) found, `
                + `${sent} of ${forceSendUsers.length} user(s) delivered (${res.digests_sent} digest email(s), ${res.pushes_sent} push).`;
            setForceSendMessage(msg);
            setMessage(msg);
            setForceSendUsers([]);
            setPreviewResults(null);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to force-send interest matches.';
            setForceSendMessage(msg);
            setMessage(msg);
        } finally {
            setForceSendBusy(false);
        }
    };

    // Debounced typeahead for the review-prompt "Send now" event picker.
    // include_past=true so already-ended events (the review-prompt targets)
    // surface — the default search only returns upcoming events.
    useEffect(() => {
        const q = reviewNowQuery.trim();
        if (q.length < 2) {
            setReviewNowSearchResults([]);
            return;
        }
        const t = setTimeout(() => {
            searchEvents(q, 8, true)
                .then(setReviewNowSearchResults)
                .catch(() => setReviewNowSearchResults([]));
        }, 250);
        return () => clearTimeout(t);
    }, [reviewNowQuery]);

    // Load the selected event's attendees as the force-send candidate list.
    useEffect(() => {
        if (!reviewNowEvent) {
            setReviewNowCandidates([]);
            setReviewNowUsers([]);
            return;
        }
        let cancelled = false;
        setReviewNowCandidatesLoading(true);
        fetchReviewPromptCandidates(reviewNowEvent.event_id)
            .then((rows) => { if (!cancelled) setReviewNowCandidates(rows); })
            .catch(() => { if (!cancelled) setReviewNowCandidates([]); })
            .finally(() => { if (!cancelled) setReviewNowCandidatesLoading(false); });
        return () => { cancelled = true; };
    }, [reviewNowEvent]);

    const handleSendReviewPromptNow = async () => {
        if (!reviewNowEvent || reviewNowUsers.length === 0) return;
        setReviewNowBusy(true);
        try {
            const res = await sendReviewPromptNow(
                reviewNowEvent.event_id,
                reviewNowUsers.map((u) => u.user_id),
                reviewNowResend,
            );
            const sent = res.results.filter((r) => r.status === 'sent').length;
            const skipped = res.results.length - sent;
            const msg = `Review prompt send-now: ${sent} of ${reviewNowUsers.length} user(s) sent `
                + `(${res.emailed} email, ${res.pushed} push, ${res.in_app_created} in-app)`
                + (skipped ? `; ${skipped} skipped.` : '.');
            setReviewNowMessage(msg);
            setMessage(msg);
            setReviewNowUsers([]);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to send review prompt now.';
            setReviewNowMessage(msg);
            setMessage(msg);
        } finally {
            setReviewNowBusy(false);
        }
    };

    const enabledCount = calendars.filter((c) => c.enabled).length;

    const tabBtnClass = (tab: AdminTab) =>
        `text-[11px] font-medium px-2 py-1 sm:px-2.5 transition border ${activeTab === tab
            ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
            : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
        }`;

    return (
        <div className="mx-auto max-w-7xl px-5 py-6">
            {/* ── Header ── */}
            <div className="mb-5 space-y-2">
                <h1 className="-mt-2 text-sm font-semibold text-gray-900 uppercase tracking-wide">Admin</h1>
                <div className="flex flex-wrap items-start gap-2 sm:items-start sm:justify-between">
                    <div className="flex items-center gap-1.5 sm:gap-2">
                        <button onClick={() => changeTab('data')} className={tabBtnClass('data')}>Data</button>
                        <button onClick={() => changeTab('configuration')} className={tabBtnClass('configuration')}>Configuration</button>
                        <button onClick={() => changeTab('analytics')} className={tabBtnClass('analytics')}>Analytics</button>
                        <button onClick={() => changeTab('users')} className={tabBtnClass('users')}>Users</button>
                        <button onClick={() => changeTab('notifications')} className={tabBtnClass('notifications')}>Notifications</button>
                    </div>
                    <div className="ml-auto flex min-w-0 flex-col items-end gap-1">
                        <button
                            onClick={handleLogout}
                            className="whitespace-nowrap bg-gray-100 text-gray-600 text-[11px] font-medium px-2.5 py-1 hover:bg-gray-200 transition border border-gray-200"
                        >
                            Logout
                        </button>
                        {user && (
                            <span className="max-w-[82vw] break-all text-right text-[11px] text-gray-400 sm:max-w-none">{user.email}</span>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Action Bar (Data tab only) ── */}
            {activeTab === 'data' && (
                <div className="mb-4 flex items-center gap-2 flex-wrap">
                    <button
                        onClick={() => { setEventsPanelPreset('all'); setEventsPanelCalendarId(''); setEventsPanelOpen(true); }}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Events
                    </button>
                    <button
                        onClick={() => { setEventsPanelPreset('pending'); setEventsPanelOpen(true); }}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Pending Review
                        {pendingReviewCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {pendingReviewCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => {
                            setSuggestionsPanelOpen(true);
                            if (tagGroups.length === 0) {
                                fetchAdminTagGroups().then(setTagGroups).catch(() => { });
                            }
                        }}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Suggestions
                        {suggestions.filter((s) => s.status === 'pending').length > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {suggestions.filter((s) => s.status === 'pending').length}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => { setUnsyncedPanelOpen(true); }}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Unsynced
                        {suggestions.filter((s) => s.status === 'approved' && !s.synced_to_google).length > 0 && (
                            <span className="inline-flex items-center justify-center bg-orange-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {suggestions.filter((s) => s.status === 'approved' && !s.synced_to_google).length}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setTagSuggestionsPanelOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Tag Suggestions
                        {tagSuggestionCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-violet-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {tagSuggestionCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setPromoCodesPanelOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Promo Codes
                        {promoCodesPendingCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {promoCodesPendingCount}
                            </span>
                        )}
                    </button>
                    {organizerClaimsEnabled && (
                        <button
                            onClick={() => setOrganizerClaimsPanelOpen(true)}
                            className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                        >
                            Organizer Claims
                            {organizerClaimsPendingCount > 0 && (
                                <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                    {organizerClaimsPendingCount}
                                </span>
                            )}
                        </button>
                    )}
                    <button
                        onClick={() => setFeedbackPanelOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Feedback
                        {feedbackPendingCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {feedbackPendingCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setDuplicatesPanelOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Duplicates
                        {duplicatesPendingCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {duplicatesPendingCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setSeriesPanelOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Series
                        {seriesPendingCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {seriesPendingCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => { setEventsPanelPreset('ungeolocated'); setEventsPanelOpen(true); }}
                        className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                    >
                        Ungeolocated
                        {ungeolocatedCount > 0 && (
                            <span className="inline-flex items-center justify-center bg-orange-500 text-white text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                                {ungeolocatedCount}
                            </span>
                        )}
                    </button>
                </div>
            )}

            {message && (
                <p className="mb-4 bg-blue-50 border border-blue-100 px-3 py-1.5 text-[11px] text-blue-700">{message}</p>
            )}

            {/* ── Data Tab ── */}
            {activeTab === 'data' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
                    {/* Left col (1/3): Calendar Sources */}
                    <div className="border border-gray-200 bg-white flex flex-col">
                        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                            <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Calendar Sources</h2>
                        </div>
                        <div className="p-4 flex flex-col flex-1 gap-3">
                            {/* Discover + Add Calendar Input row */}
                            <div className="flex gap-1.5">
                                <button
                                    onClick={handleDiscover}
                                    disabled={!!busy}
                                    className="bg-gray-800 text-white text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-700 disabled:opacity-50 transition shrink-0"
                                >
                                    {busy === 'discover' ? '…' : 'Discover'}
                                </button>
                                <input
                                    type="text"
                                    value={newCalId}
                                    onChange={(e) => setNewCalId(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddCalendar()}
                                    placeholder="Calendar ID (e.g. user@gmail.com)"
                                    className="flex-1 min-w-0 border border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <button
                                    onClick={handleAddCalendar}
                                    disabled={!!busy || !newCalId.trim()}
                                    className="bg-gray-800 text-white text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-700 disabled:opacity-50 transition shrink-0"
                                >
                                    {busy === 'add' ? '…' : 'Add'}
                                </button>
                            </div>

                            {/* Calendar List */}
                            <div className="flex-1 min-h-0 max-h-80 overflow-y-auto sm:max-h-none sm:overflow-visible">
                                {loading ? (
                                    <p className="text-[11px] text-gray-400">Loading…</p>
                                ) : calendars.length === 0 ? (
                                    <p className="text-[11px] text-gray-400">No calendars. Use "Discover" to find them.</p>
                                ) : (
                                    <ul className="divide-y divide-gray-100">
                                        {calendars.map((cal) => (
                                            <li key={cal.calendar_id} className="py-2 first:pt-0 last:pb-0">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <input
                                                            type="color"
                                                            value={cal.color || '#3b82f6'}
                                                            onChange={(e) => handleColorChange(cal, e.target.value)}
                                                            className="h-4 w-4 cursor-pointer border-0 p-0 shrink-0"
                                                            title="Change color"
                                                        />
                                                        <div className="min-w-0">
                                                            {editingCalId === cal.calendar_id ? (
                                                                <input
                                                                    type="text"
                                                                    value={editingName}
                                                                    onChange={(e) => setEditingName(e.target.value)}
                                                                    onBlur={() => handleNameSave(cal)}
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === 'Enter') handleNameSave(cal);
                                                                        if (e.key === 'Escape') setEditingCalId(null);
                                                                    }}
                                                                    autoFocus
                                                                    className="text-[11px] font-medium text-gray-700 border border-blue-400 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full"
                                                                />
                                                            ) : (
                                                                <span
                                                                    className="text-[11px] font-medium text-gray-700 cursor-pointer hover:text-blue-600 transition block truncate"
                                                                    onClick={() => handleNameEdit(cal)}
                                                                    title={cal.calendar_id}
                                                                >
                                                                    {cal.name}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 shrink-0">
                                                        <button
                                                            onClick={() => handleToggle(cal)}
                                                            className={`text-[10px] font-medium px-2 py-0.5 transition ${cal.enabled
                                                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                                                                }`}
                                                            title="Whether the background job syncs new events from this calendar"
                                                        >
                                                            {cal.enabled ? 'Sync On' : 'Sync Off'}
                                                        </button>
                                                        <button
                                                            onClick={() => handleToggleShowEvents(cal)}
                                                            className={`text-[10px] font-medium px-2 py-0.5 transition ${cal.show_events
                                                                ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                                                                }`}
                                                            title="Whether this calendar's already-synced events are shown publicly"
                                                        >
                                                            {cal.show_events ? 'Shown' : 'Hidden'}
                                                        </button>
                                                        <div className="relative">
                                                            <button
                                                                onClick={() => setOpenMenuCalId((prev) => (prev === cal.calendar_id ? null : cal.calendar_id))}
                                                                className={`flex h-5 w-5 items-center justify-center border transition ${openMenuCalId === cal.calendar_id
                                                                    ? 'bg-gray-100 border-gray-300 text-gray-700'
                                                                    : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                                                    }`}
                                                                title="More actions"
                                                                aria-label="More actions"
                                                                aria-haspopup="true"
                                                                aria-expanded={openMenuCalId === cal.calendar_id}
                                                            >
                                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                                                    <circle cx="12" cy="5" r="2" />
                                                                    <circle cx="12" cy="12" r="2" />
                                                                    <circle cx="12" cy="19" r="2" />
                                                                </svg>
                                                            </button>
                                                            {openMenuCalId === cal.calendar_id && (
                                                                <>
                                                                    <div className="fixed inset-0 z-10" onClick={() => setOpenMenuCalId(null)} />
                                                                    <div className="absolute right-0 top-full z-20 mt-1 w-40 border border-gray-200 bg-white shadow-lg">
                                                                        <button
                                                                            onClick={() => { setOpenMenuCalId(null); handleShowCalendarEvents(cal.calendar_id); }}
                                                                            className="block w-full px-3 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                                                                            title="Show all events from this calendar"
                                                                        >
                                                                            Events
                                                                        </button>
                                                                        <button
                                                                            onClick={() => { setOpenMenuCalId(null); handleToggleDefaultTags(cal.calendar_id); }}
                                                                            className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] hover:bg-gray-50 ${expandedDefaultTagsCalId === cal.calendar_id ? 'text-violet-700' : 'text-gray-700'
                                                                                }`}
                                                                            title="Configure default tags for new events from this calendar"
                                                                        >
                                                                            <span>Tags</span>
                                                                            {(calendarDefaultTagIds[cal.calendar_id]?.length ?? 0) > 0 && (
                                                                                <span className="ml-2 inline-flex items-center justify-center bg-violet-500 text-white text-[9px] font-semibold px-1 min-w-[14px]">
                                                                                    {calendarDefaultTagIds[cal.calendar_id].length}
                                                                                </span>
                                                                            )}
                                                                        </button>
                                                                        <button
                                                                            onClick={() => { setOpenMenuCalId(null); setExpandedRulesCalId((prev) => (prev === cal.calendar_id ? null : cal.calendar_id)); }}
                                                                            className={`block w-full px-3 py-1.5 text-left text-[11px] hover:bg-gray-50 ${expandedRulesCalId === cal.calendar_id ? 'text-indigo-700' : 'text-gray-700'
                                                                                }`}
                                                                            title="Manage per-calendar curation (auto-add events to managed users' lists)"
                                                                        >
                                                                            Curation
                                                                        </button>
                                                                    </div>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                {expandedDefaultTagsCalId === cal.calendar_id && (
                                                    <div className="mt-2 pl-6">
                                                        <p className="text-[10px] text-gray-400 mb-1.5">
                                                            Default tags — applied to new events synced from this calendar:
                                                        </p>
                                                        <div className="flex flex-wrap gap-1">
                                                            {tagGroups.filter((g) => g.enabled && (g.scope ?? 'event') === 'event').map((group) =>
                                                                group.tags.filter((t) => t.enabled).map((tag) => {
                                                                    const active = (calendarDefaultTagIds[cal.calendar_id] ?? []).includes(tag.id);
                                                                    return (
                                                                        <button
                                                                            key={tag.id}
                                                                            onClick={() => handleToggleDefaultTag(cal.calendar_id, tag.id)}
                                                                            className={`text-[10px] px-2 py-0.5 border transition ${active
                                                                                ? 'text-white border-transparent'
                                                                                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                                                                                }`}
                                                                            style={active ? { backgroundColor: tag.color || '#7c3aed', borderColor: tag.color || '#7c3aed' } : {}}
                                                                        >
                                                                            {tag.label}
                                                                        </button>
                                                                    );
                                                                })
                                                            )}
                                                            {tagGroups.length === 0 && (
                                                                <span className="text-[10px] text-gray-400">No tags configured yet.</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                                {expandedRulesCalId === cal.calendar_id && (
                                                    <CalendarCurationRulesPanel calendarId={cal.calendar_id} />
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            {/* Sync controls — under calendar list */}
                            <div className="border-t border-gray-100 pt-3 space-y-2">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <label
                                        className="inline-flex items-center gap-1 text-[11px] text-gray-600"
                                        title="Lower bound for fetching events from upstream calendars. Used on Reseed and on the first-ever sync of each calendar (or after a sync token expires). Incremental syncs always return only changes since the last successful fetch."
                                    >
                                        <span className="text-gray-500">From</span>
                                        <input
                                            type="date"
                                            value={syncSinceDate}
                                            onChange={(e) => handleSyncSinceDateChange(e.target.value)}
                                            className="border border-gray-200 px-1.5 py-1 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        />
                                    </label>
                                    <button
                                        onClick={() => handleSync('incremental')}
                                        disabled={!!busy || enabledCount === 0}
                                        className="bg-blue-600 text-white text-[11px] font-medium px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50 transition"
                                    >
                                        {busy === 'sync' ? 'Syncing…' : `Sync Now (${enabledCount})`}
                                    </button>
                                    <button
                                        onClick={() => handleSync('reseed')}
                                        disabled={!!busy || enabledCount === 0}
                                        className="bg-white border border-gray-300 text-gray-700 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 disabled:opacity-50 transition"
                                        title="Clear all sync tokens and re-fetch every event from the configured From date forward."
                                    >
                                        Reseed
                                    </button>
                                </div>

                                <div className="border border-gray-100 bg-gray-50 px-2.5 py-2 space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11px] font-medium text-gray-700">Auto sync</span>
                                        <button
                                            onClick={handleToggleAutoSync}
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${autoSyncEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${autoSyncEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11px] text-gray-500">Mode</span>
                                        <select
                                            value={autoSyncMode}
                                            onChange={(e) => handleAutoSyncModeChange(e.target.value as SyncMode)}
                                            disabled={!autoSyncEnabled}
                                            className="border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                                        >
                                            <option value="incremental">Incremental</option>
                                            <option value="reseed">Reseed</option>
                                        </select>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11px] text-gray-500">Interval</span>
                                        <div className="flex items-center gap-1">
                                            <input
                                                type="number"
                                                min={1}
                                                max={1440}
                                                value={syncInterval}
                                                onChange={(e) => setSyncInterval(Number(e.target.value))}
                                                disabled={!autoSyncEnabled}
                                                className="w-14 border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                                            />
                                            <span className="text-[11px] text-gray-400">min</span>
                                            <button
                                                onClick={handleSyncIntervalSave}
                                                disabled={!autoSyncEnabled || !!busy || syncInterval < 1 || syncInterval > 1440}
                                                className="bg-gray-800 text-white text-[11px] font-medium px-2 py-0.5 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                                            >
                                                {busy === 'interval' ? '…' : 'Save'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right col (2/3): Progress card (when running) + Sync History */}
                    <div className="lg:col-span-2 flex flex-col gap-4 min-w-0">
                        {showSyncProgress && (
                            <SyncProgressCard
                                visible={showSyncProgress}
                                jobId={syncJobId ?? undefined}
                                onDismiss={() => { setShowSyncProgress(false); setSyncJobId(null); }}
                                onJobComplete={() => {
                                    // Refresh admin badges (pending review,
                                    // ungeolocated, tag suggestions, …) so
                                    // they reflect the freshly-synced state.
                                    notifyAdminDataChanged();
                                }}
                            />
                        )}
                        <div className="flex-1 min-h-0">
                            <SyncJobsHistoryTable />
                        </div>
                    </div>
                </div>
            )}

            {/* ── Configuration Tab ── */}
            {activeTab === 'configuration' && (
                <div className="space-y-4">
                    {/* Configuration Sub-tabs */}
                    <div className="flex flex-wrap items-center gap-1">
                        <button
                            onClick={() => setActiveConfigTab('events-settings')}
                            className={`text-[11px] font-medium px-2.5 py-1 transition border ${activeConfigTab === 'events-settings'
                                ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                                }`}
                        >
                            Events settings
                        </button>
                        <button
                            onClick={() => setActiveConfigTab('feature-flags')}
                            className={`text-[11px] font-medium px-2.5 py-1 transition border ${activeConfigTab === 'feature-flags'
                                ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                                }`}
                        >
                            Feature flags
                        </button>
                        <button
                            onClick={() => setActiveConfigTab('tag-categories')}
                            className={`text-[11px] font-medium px-2.5 py-1 transition border ${activeConfigTab === 'tag-categories'
                                ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                                }`}
                        >
                            Tag categories
                        </button>
                        <button
                            onClick={() => setActiveConfigTab('notifications')}
                            className={`text-[11px] font-medium px-2.5 py-1 transition border ${activeConfigTab === 'notifications'
                                ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                                }`}
                        >
                            Notifications
                        </button>
                    </div>

                    {/* Events Settings Tab */}
                    {activeConfigTab === 'events-settings' && (
                        <div className="border border-gray-200 bg-white">
                            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                                <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Settings</h2>
                            </div>
                            <div className="p-4 space-y-3 max-w-2xl">
                                <div>
                                    <label className="text-[11px] font-medium text-gray-500 block mb-1">
                                        Show events since
                                    </label>
                                    <div className="flex gap-1.5">
                                        <input
                                            type="date"
                                            value={sinceDate}
                                            onChange={(e) => setSinceDate(e.target.value)}
                                            className="flex-1 border border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        />
                                        <button
                                            onClick={handleSinceDateSave}
                                            disabled={!!busy || !sinceDate}
                                            className="bg-gray-800 text-white text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-700 disabled:opacity-50 transition"
                                        >
                                            {busy === 'since' ? '…' : 'Save'}
                                        </button>
                                    </div>
                                    <p className="mt-1 text-[10px] text-gray-400">
                                        Display only — events older than this date are hidden in the calendar shown to users.
                                    </p>
                                </div>
                                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Event bar color</span>
                                        <p className="text-[10px] text-gray-400">Background of event bars in the calendar</p>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <input
                                            type="color"
                                            value={eventColorBarColor}
                                            onChange={(e) => setEventColorBarColor(e.target.value)}
                                            onBlur={(e) => handleEventColorBarColorChange(e.target.value)}
                                            className="h-6 w-8 cursor-pointer border border-gray-200 rounded p-0"
                                            aria-label="Event bar color picker"
                                        />
                                        <input
                                            type="text"
                                            value={eventColorBarColor}
                                            onChange={(e) => setEventColorBarColor(e.target.value)}
                                            onBlur={(e) => handleEventColorBarColorChange(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && handleEventColorBarColorChange(eventColorBarColor)}
                                            placeholder="#64748b"
                                            className="w-20 text-[11px] font-mono text-gray-900 border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                        />
                                    </div>
                                </div>
                                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Tag pill order</span>
                                        <p className="text-[10px] text-gray-400">Hero pills always come first</p>
                                    </div>
                                    <select
                                        value={tagSortMode}
                                        onChange={(e) => handleTagSortModeChange(e.target.value as 'group' | 'event_count')}
                                        className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                    >
                                        <option value="group">By group</option>
                                        <option value="event_count">By event count</option>
                                    </select>
                                </div>
                                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Explorer default period</span>
                                        <p className="text-[10px] text-gray-400">Used for fresh visits and Clear all</p>
                                    </div>
                                    <select
                                        value={defaultExplorerPeriod}
                                        onChange={(e) => handleDefaultExplorerPeriodChange(e.target.value as DateRangePresetKey)}
                                        className="text-[11px] border border-gray-200 px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                        {DATE_RANGE_PRESET_CHOICES.map((choice) => (
                                            <option key={choice.key} value={choice.key}>{choice.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Mood headline threshold (reviews)</span>
                                        <p className="text-[10px] text-gray-400">Minimum reviews before an event/series shows a computed "Overall Mood" label; below this it shows "Early feedback" (1–1000)</p>
                                    </div>
                                    <input
                                        type="number"
                                        min={1}
                                        max={1000}
                                        value={reviewMoodMinReviews}
                                        onChange={(e) => setReviewMoodMinReviews(Number(e.target.value))}
                                        onBlur={(e) => handleReviewMoodMinReviewsChange(Number(e.target.value))}
                                        onKeyDown={(e) => e.key === 'Enter' && handleReviewMoodMinReviewsChange(reviewMoodMinReviews)}
                                        className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                        aria-label="Mood headline minimum reviews"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Feature Flags Tab */}
                    {activeConfigTab === 'feature-flags' && (
                        <div className="border border-gray-200 bg-white">
                            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                                <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Feature Flags</h2>
                            </div>
                            <div className="p-4 space-y-3 max-w-4xl">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Show prices</span>
                                        <p className="text-[10px] text-gray-400">Price badges on events</p>
                                    </div>
                                    <button
                                        onClick={handleTogglePrices}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${showPrices ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${showPrices ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Show ratings</span>
                                        <p className="text-[10px] text-gray-400">Star ratings and reviews</p>
                                    </div>
                                    <button
                                        onClick={handleToggleRatings}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${showRatings ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${showRatings ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* Trending container — owns popularity end-to-end.
                                The old "Show popularity" toggle was merged in:
                                trending_enabled now drives both the badge surface
                                AND the threshold/cap knobs. */}
                                <div className="border border-gray-200 bg-gray-50/40 p-3 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="inline-flex items-center gap-1">
                                                <span className="text-[11px] font-semibold text-gray-700">Trending</span>
                                                <AdminInfoTooltip label={TRENDING_TOOLTIP} />
                                            </div>
                                            <p className="text-[10px] text-gray-400">
                                                Drives the 🔥 chip, the orange map ring, and the "Popular" sort.
                                            </p>
                                        </div>
                                        <button
                                            onClick={handleToggleTrending}
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${trendingEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${trendingEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    {trendingEnabled && (
                                        <>
                                            <div className="flex items-center justify-between mt-1 pl-1">
                                                <div>
                                                    <span className="text-[11px] font-medium text-gray-600">Trending banner</span>
                                                    <p className="text-[10px] text-gray-400">Highlights top trending events in the filtered Explorer scope.</p>
                                                </div>
                                                <button
                                                    onClick={handleToggleTrendingBanner}
                                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${trendingBannerEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                                >
                                                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${trendingBannerEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                                </button>
                                            </div>
                                            <div className="flex items-center justify-between mt-1 pl-1">
                                                <div>
                                                    <span className="text-[11px] font-medium text-gray-600">🔥 Popular threshold</span>
                                                    <p className="text-[10px] text-gray-400">Min popularity score required to show the badge</p>
                                                </div>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={10000}
                                                    value={popularityThreshold}
                                                    onChange={(e) => setPopularityThreshold(Number(e.target.value))}
                                                    onBlur={(e) => handlePopularityThresholdChange(Number(e.target.value))}
                                                    onKeyDown={(e) => e.key === 'Enter' && handlePopularityThresholdChange(popularityThreshold)}
                                                    className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                />
                                            </div>
                                            <div className="flex items-center justify-between mt-1 pl-1">
                                                <div>
                                                    <span className="text-[11px] font-medium text-gray-600">Trending window (days)</span>
                                                    <p className="text-[10px] text-gray-400">Only count signals from the last N days</p>
                                                </div>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={365}
                                                    value={trendingWindowDays}
                                                    onChange={(e) => setTrendingWindowDays(Number(e.target.value))}
                                                    onBlur={(e) => handleTrendingWindowDaysChange(Number(e.target.value))}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleTrendingWindowDaysChange(trendingWindowDays)}
                                                    className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                />
                                            </div>
                                            <div className="flex items-center justify-between mt-1 pl-1">
                                                <div>
                                                    <span className="text-[11px] font-medium text-gray-600">Trending floor (going)</span>
                                                    <p className="text-[10px] text-gray-400">
                                                        Min RSVPs required to be eligible. Anti-view-bait gate;
                                                        events below this floor get score 0.
                                                    </p>
                                                </div>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={100}
                                                    value={trendingFloorGoing}
                                                    onChange={(e) => setTrendingFloorGoing(Number(e.target.value))}
                                                    onBlur={(e) => handleTrendingFloorGoingChange(Number(e.target.value))}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleTrendingFloorGoingChange(trendingFloorGoing)}
                                                    className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                />
                                            </div>
                                            <div className="flex items-center justify-between mt-1 pl-1">
                                                <div>
                                                    <span className="text-[11px] font-medium text-gray-600">Trending top N</span>
                                                    <p className="text-[10px] text-gray-400">
                                                        Absolute cap: never decorate more than N events as Trending,
                                                        no matter how many are visible.
                                                    </p>
                                                </div>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={50}
                                                    value={trendingTopN}
                                                    onChange={(e) => setTrendingTopN(Number(e.target.value))}
                                                    onBlur={(e) => handleTrendingTopNChange(Number(e.target.value))}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleTrendingTopNChange(trendingTopN)}
                                                    className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                />
                                            </div>
                                            <div className="flex items-center justify-between mt-1 pl-1">
                                                <div>
                                                    <div className="inline-flex items-center gap-1">
                                                        <span className="text-[11px] font-medium text-gray-600">Trending top %</span>
                                                        <AdminInfoTooltip label={TRENDING_TOP_PERCENT_TOOLTIP} />
                                                    </div>
                                                    <p className="text-[10px] text-gray-400">
                                                        Relative cap (1-100). Effective decoration count is
                                                        min(top N, ceil(visible × %  ⁄ 100)). Keeps the chip rare
                                                        on small lists.
                                                    </p>
                                                </div>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={100}
                                                    value={trendingTopPercent}
                                                    onChange={(e) => setTrendingTopPercent(Number(e.target.value))}
                                                    onBlur={(e) => handleTrendingTopPercentChange(Number(e.target.value))}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleTrendingTopPercentChange(trendingTopPercent)}
                                                    className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                />
                                            </div>
                                        </>
                                    )}
                                </div>

                                {/* Adoption-boost: Following badge (Track 1) */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Following badge</span>
                                        <p className="text-[10px] text-gray-400">Avatar/dot when a mutual friend is going or saved</p>
                                    </div>
                                    <button
                                        onClick={handleToggleFollowingBadge}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${followingBadgeEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${followingBadgeEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* Adoption-boost: New event markers (Track 2) */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">New event markers</span>
                                        <p className="text-[10px] text-gray-400">Dot + bold title for events added after the viewer's baseline</p>
                                    </div>
                                    <button
                                        onClick={handleToggleUnseenState}
                                        aria-label="Toggle new event markers"
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${unseenStateEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${unseenStateEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* Explorer "For you" discovery rail */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">For you rail</span>
                                        <p className="text-[10px] text-gray-400">Collapsible Explorer rail with You might like/Friends going/New lenses</p>
                                    </div>
                                    <button
                                        onClick={handleToggleForYouRail}
                                        aria-label="Toggle for you rail"
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${forYouRailEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${forYouRailEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* Explorer "Your next events" rail */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Your next events rail</span>
                                        <p className="text-[10px] text-gray-400">Explorer rail showing the viewer's own saved/going events</p>
                                    </div>
                                    <button
                                        onClick={handleToggleYourNextEventsRail}
                                        aria-label="Toggle your next events rail"
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${yourNextEventsRailEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${yourNextEventsRailEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* Tribe > Calendars "Your Network" going snapshot */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Network going snapshot</span>
                                        <p className="text-[10px] text-gray-400">Tribe &gt; Calendars header showing upcoming events people you follow are going to</p>
                                    </div>
                                    <button
                                        onClick={handleToggleNetworkGoingSnapshot}
                                        aria-label="Toggle network going snapshot"
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${networkGoingSnapshotEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${networkGoingSnapshotEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* User contributions: promo codes */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Promo codes</span>
                                        <p className="text-[10px] text-gray-400">Let users submit promo codes per event. Admin-moderated.</p>
                                    </div>
                                    <button
                                        onClick={handleTogglePromoCodes}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${promoCodesEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${promoCodesEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>

                                {/* User contributions: organizer claims */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-700">Organizer claims</span>
                                        <p className="text-[10px] text-gray-400">Let users request organizer badge + claim per-event ownership. Admin-moderated.</p>
                                    </div>
                                    <button
                                        onClick={handleToggleOrganizerClaims}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${organizerClaimsEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${organizerClaimsEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Tag Categories Tab */}
                    {activeConfigTab === 'tag-categories' && (
                        <div className="border border-gray-200 bg-white lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto">
                            <AdminTagCategories />
                        </div>
                    )}

                    {/* Notifications Tab */}
                    {activeConfigTab === 'notifications' && (
                        <div className="border border-gray-200 bg-white">
                            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                                <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Notifications</h2>
                            </div>
                            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* Interest-match */}
                                <div className="border border-gray-100 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Interest-match</span>
                                        <button
                                            onClick={handleToggleInterestMatchNotifs}
                                            aria-label="Toggle interest notifications"
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${interestMatchNotifsEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${interestMatchNotifsEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-gray-400">Alert users when a new event matches their interest profile</p>
                                    {toggleCounts && (
                                        <p className="text-[10px] text-gray-500">
                                            {toggleCounts.interest_match.email} email · {toggleCounts.interest_match.push} push enabled
                                            {' '}(of {toggleCounts.total_users} users)
                                        </p>
                                    )}
                                    <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Max events per email</span>
                                            <p className="text-[10px] text-gray-400">Events beyond this hide behind a "Discover more" link (1–50)</p>
                                        </div>
                                        <input
                                            type="number"
                                            min={1}
                                            max={50}
                                            value={interestMatchMaxEventsPerEmail}
                                            onChange={(e) => setInterestMatchMaxEventsPerEmail(Number(e.target.value))}
                                            onBlur={(e) => handleInterestMatchMaxEventsChange(Number(e.target.value))}
                                            onKeyDown={(e) => e.key === 'Enter' && handleInterestMatchMaxEventsChange(interestMatchMaxEventsPerEmail)}
                                            className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            aria-label="Max events per interest-match email"
                                        />
                                    </div>
                                    <div className="flex items-center gap-4 border-t border-gray-100 pt-2.5">
                                        <span className="text-[11px] font-medium text-gray-700">Email delivery</span>
                                        <label className="flex items-center gap-1 text-[10px] text-gray-500">
                                            <input
                                                type="checkbox"
                                                aria-label="Interest matches instant email"
                                                checked={!!emailModes['interest_matches_email_instant']}
                                                onChange={(e) => handleEmailModeChange('interest_matches_email_instant', e.target.checked)}
                                            />
                                            Instant
                                        </label>
                                        <label className="flex items-center gap-1 text-[10px] text-gray-500">
                                            <input
                                                type="checkbox"
                                                aria-label="Interest matches digest email"
                                                checked={!!emailModes['interest_matches_email_digest']}
                                                onChange={(e) => handleEmailModeChange('interest_matches_email_digest', e.target.checked)}
                                            />
                                            Digest
                                        </label>
                                    </div>
                                    <div className="border-t border-gray-100 pt-2.5 space-y-1.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Force-send interest matches</span>
                                            <p className="text-[10px] text-gray-400">
                                                Scan for interest-profile matches over a custom lookback window for selected
                                                users and deliver immediately, bypassing the 24h scan window and digest schedule.
                                            </p>
                                        </div>
                                        <AdminUserMultiPicker
                                            selected={forceSendUsers}
                                            onChange={(rows) => { setForceSendUsers(rows); setPreviewResults(null); setForceSendMessage(''); }}
                                            placeholder="Search email, handle, or name"
                                        />
                                        <div className="flex items-center gap-2">
                                            <label className="text-[10px] text-gray-500" htmlFor="force-send-lookback">Lookback (hours)</label>
                                            <input
                                                id="force-send-lookback"
                                                type="number"
                                                min={1}
                                                max={720}
                                                value={forceSendLookbackHours}
                                                onChange={(e) => { setForceSendLookbackHours(Number(e.target.value)); setPreviewResults(null); }}
                                                className="w-20 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            />
                                            <button
                                                type="button"
                                                onClick={handlePreviewInterestMatches}
                                                disabled={forceSendUsers.length === 0 || previewBusy || forceSendBusy}
                                                className="ml-auto text-[11px] px-2.5 py-1 rounded border border-emerald-600 text-emerald-700 disabled:border-gray-300 disabled:text-gray-400 hover:bg-emerald-50"
                                            >
                                                {previewBusy ? 'Previewing…' : 'Preview'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleForceSendInterestMatches}
                                                disabled={forceSendUsers.length === 0 || forceSendBusy}
                                                className="text-[11px] px-2.5 py-1 rounded bg-emerald-600 text-white disabled:bg-gray-300 hover:bg-emerald-700"
                                            >
                                                {forceSendBusy ? 'Sending…' : `Force send${forceSendUsers.length ? ` (${forceSendUsers.length})` : ''}`}
                                            </button>
                                        </div>
                                        {previewResults && (
                                            <div className="text-[10px] text-gray-600 bg-gray-50 border border-gray-100 p-2 space-y-1">
                                                <div className="text-gray-400">
                                                    {previewResults.candidates_scanned} candidate event(s) in window globally (all users, not just selected)
                                                </div>
                                                {previewResults.results.map((r) => (
                                                    <div key={r.user_id} className="flex items-center justify-between gap-2">
                                                        <span className="truncate">{r.email}</span>
                                                        <span className="whitespace-nowrap">{r.matched_events} matched · {r.new_events} new</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {forceSendMessage && (
                                            <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 p-2">
                                                {forceSendMessage}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Event reminders */}
                                <div className="border border-gray-100 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Event reminders</span>
                                        <button
                                            onClick={handleToggleReminders}
                                            aria-label="Toggle event reminders"
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${eventRemindersEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${eventRemindersEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-gray-400">Pre-event nudge (in-app + email) for saved / going users</p>
                                    {toggleCounts && (
                                        <p className="text-[10px] text-gray-500">
                                            {toggleCounts.event_reminders.email} email · {toggleCounts.event_reminders.push} push enabled
                                            {' '}(of {toggleCounts.total_users} users)
                                        </p>
                                    )}
                                    <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Reminder lead time (hours)</span>
                                            <p className="text-[10px] text-gray-400">How far ahead of an event's start to fire the reminder (1–720)</p>
                                        </div>
                                        <input
                                            type="number"
                                            min={1}
                                            max={720}
                                            value={reminderLeadHours}
                                            onChange={(e) => setReminderLeadHours(Number(e.target.value))}
                                            onBlur={(e) => handleReminderLeadHoursChange(Number(e.target.value))}
                                            onKeyDown={(e) => e.key === 'Enter' && handleReminderLeadHoursChange(reminderLeadHours)}
                                            className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            aria-label="Reminder lead time in hours"
                                        />
                                    </div>
                                </div>

                                {/* Review prompt */}
                                <div className="border border-gray-100 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Review prompt</span>
                                        <button
                                            onClick={handleToggleReviewPrompt}
                                            aria-label="Toggle review prompt"
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${reviewPromptEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${reviewPromptEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-gray-400">Post-event "how was it?" nudge (in-app + email) for going users who haven't rated yet</p>
                                    {toggleCounts && (
                                        <p className="text-[10px] text-gray-500">
                                            {toggleCounts.review_prompt.email} email · {toggleCounts.review_prompt.push} push enabled
                                            {' '}(of {toggleCounts.total_users} users)
                                        </p>
                                    )}
                                    <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Delay after event ends (hours)</span>
                                            <p className="text-[10px] text-gray-400">How long after an event's end to fire the prompt (1–720)</p>
                                        </div>
                                        <input
                                            type="number"
                                            min={1}
                                            max={720}
                                            value={reviewPromptDelayHours}
                                            onChange={(e) => setReviewPromptDelayHours(Number(e.target.value))}
                                            onBlur={(e) => handleReviewPromptDelayHoursChange(Number(e.target.value))}
                                            onKeyDown={(e) => e.key === 'Enter' && handleReviewPromptDelayHoursChange(reviewPromptDelayHours)}
                                            className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            aria-label="Review prompt delay in hours"
                                        />
                                    </div>
                                    <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Scan lookback (hours)</span>
                                            <p className="text-[10px] text-gray-400">How far past the delay window to scan for newly-eligible events each tick (1–720)</p>
                                        </div>
                                        <input
                                            type="number"
                                            min={1}
                                            max={720}
                                            value={reviewPromptLookbackHours}
                                            onChange={(e) => setReviewPromptLookbackHours(Number(e.target.value))}
                                            onBlur={(e) => handleReviewPromptLookbackHoursChange(Number(e.target.value))}
                                            onKeyDown={(e) => e.key === 'Enter' && handleReviewPromptLookbackHoursChange(reviewPromptLookbackHours)}
                                            className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            aria-label="Review prompt lookback in hours"
                                        />
                                    </div>
                                    <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">"Share your experience" window (days)</span>
                                            <p className="text-[10px] text-gray-400">How far back attended-but-unreviewed events surface in the "For you" trail (1–3650)</p>
                                        </div>
                                        <input
                                            type="number"
                                            min={1}
                                            max={3650}
                                            value={forYouReviewWindowDays}
                                            onChange={(e) => setForYouReviewWindowDays(Number(e.target.value))}
                                            onBlur={(e) => handleForYouReviewWindowDaysChange(Number(e.target.value))}
                                            onKeyDown={(e) => e.key === 'Enter' && handleForYouReviewWindowDaysChange(forYouReviewWindowDays)}
                                            className="w-16 text-right text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            aria-label="Share your experience review window in days"
                                        />
                                    </div>
                                    <div className="border-t border-gray-100 pt-2.5 space-y-1.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Send now</span>
                                            <p className="text-[10px] text-gray-400">
                                                Fire the "how was it?" prompt for a specific event to hand-picked
                                                attendees now, bypassing the delay window. Non-attendees and users
                                                who already rated are skipped; per-channel opt-outs are respected.
                                            </p>
                                        </div>
                                        {reviewNowEvent ? (
                                            <div className="flex items-center gap-2 text-[11px] border border-gray-200 rounded px-2 py-1">
                                                <span className="min-w-0 flex-1 truncate">
                                                    <span className="font-medium text-gray-800">{reviewNowEvent.title}</span>
                                                    {reviewNowEvent.start && (
                                                        <span className="text-gray-400"> · {new Date(reviewNowEvent.start).toLocaleDateString()}</span>
                                                    )}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => { setReviewNowEvent(null); setReviewNowMessage(''); }}
                                                    className="text-gray-400 hover:text-gray-600"
                                                    aria-label="Clear selected event"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="relative">
                                                <input
                                                    type="text"
                                                    value={reviewNowQuery}
                                                    onChange={(e) => setReviewNowQuery(e.target.value)}
                                                    placeholder="Search past event by title"
                                                    className="w-full text-[11px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                                    aria-label="Search event for review prompt"
                                                />
                                                {reviewNowSearchResults.length > 0 && (
                                                    <ul className="absolute z-10 mt-0.5 w-full max-h-48 overflow-auto bg-white border border-gray-200 rounded shadow">
                                                        {reviewNowSearchResults.map((ev) => (
                                                            <li key={ev.event_id}>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setReviewNowEvent(ev);
                                                                        setReviewNowQuery('');
                                                                        setReviewNowSearchResults([]);
                                                                        setReviewNowMessage('');
                                                                    }}
                                                                    className="w-full text-left text-[11px] px-2 py-1 hover:bg-gray-50"
                                                                >
                                                                    <span className="font-medium text-gray-800">{ev.title}</span>
                                                                    {ev.start && (
                                                                        <span className="text-gray-400"> · {new Date(ev.start).toLocaleDateString()}</span>
                                                                    )}
                                                                </button>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        )}
                                        {reviewNowEvent && (
                                            <div className="border border-gray-200 rounded">
                                                <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100">
                                                    <span className="text-[10px] font-medium text-gray-600">
                                                        Attendees{reviewNowCandidates.length ? ` (${reviewNowCandidates.length})` : ''}
                                                    </span>
                                                    {reviewNowCandidates.some((c) => !c.already_rated) && (
                                                        <button
                                                            type="button"
                                                            className="text-[10px] text-emerald-700 hover:underline"
                                                            onClick={() => {
                                                                setReviewNowMessage('');
                                                                const selectable = reviewNowCandidates.filter((c) => !c.already_rated);
                                                                setReviewNowUsers(
                                                                    reviewNowUsers.length === selectable.length ? [] : selectable,
                                                                );
                                                            }}
                                                        >
                                                            {reviewNowUsers.length === reviewNowCandidates.filter((c) => !c.already_rated).length ? 'Clear all' : 'Select all'}
                                                        </button>
                                                    )}
                                                </div>
                                                {reviewNowCandidatesLoading ? (
                                                    <p className="text-[10px] text-gray-400 px-2 py-2">Loading attendees…</p>
                                                ) : reviewNowCandidates.length === 0 ? (
                                                    <p className="text-[10px] text-gray-400 px-2 py-2">No attendees for this event.</p>
                                                ) : (
                                                    <ul className="max-h-40 overflow-auto divide-y divide-gray-50">
                                                        {reviewNowCandidates.map((c) => {
                                                            const checked = reviewNowUsers.some((u) => u.user_id === c.user_id);
                                                            return (
                                                                <li key={c.user_id}>
                                                                    <label
                                                                        className={`flex items-center gap-2 px-2 py-1 text-[11px] ${c.already_rated ? 'text-gray-300' : 'text-gray-700 hover:bg-gray-50 cursor-pointer'}`}
                                                                        title={c.already_rated ? 'Already rated — will be skipped' : undefined}
                                                                    >
                                                                        <input
                                                                            type="checkbox"
                                                                            disabled={c.already_rated}
                                                                            checked={checked}
                                                                            onChange={() => {
                                                                                setReviewNowMessage('');
                                                                                setReviewNowUsers((prev) =>
                                                                                    prev.some((u) => u.user_id === c.user_id)
                                                                                        ? prev.filter((u) => u.user_id !== c.user_id)
                                                                                        : [...prev, c],
                                                                                );
                                                                            }}
                                                                        />
                                                                        <span className="min-w-0 flex-1 truncate">
                                                                            {c.name || c.handle || c.email}
                                                                            <span className="text-gray-400"> · {c.email}</span>
                                                                        </span>
                                                                        {c.already_rated && <span className="text-[9px] text-gray-400">rated</span>}
                                                                    </label>
                                                                </li>
                                                            );
                                                        })}
                                                    </ul>
                                                )}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2">
                                            <label className="flex items-center gap-1 text-[10px] text-gray-500" htmlFor="review-now-resend" title="Re-send email/push even to users already prompted for this event">
                                                <input
                                                    id="review-now-resend"
                                                    type="checkbox"
                                                    checked={reviewNowResend}
                                                    onChange={(e) => setReviewNowResend(e.target.checked)}
                                                />
                                                Resend
                                            </label>
                                            <button
                                                type="button"
                                                onClick={handleSendReviewPromptNow}
                                                disabled={!reviewNowEvent || reviewNowUsers.length === 0 || reviewNowBusy}
                                                className="ml-auto text-[11px] px-2.5 py-1 rounded bg-emerald-600 text-white disabled:bg-gray-300 hover:bg-emerald-700"
                                            >
                                                {reviewNowBusy ? 'Sending…' : `Send now${reviewNowUsers.length ? ` (${reviewNowUsers.length})` : ''}`}
                                            </button>
                                        </div>
                                        {reviewNowMessage && (
                                            <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 p-2">
                                                {reviewNowMessage}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Activity digest */}
                                <div className="border border-gray-100 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Activity digest</span>
                                        <button
                                            onClick={handleToggleActivityEmail}
                                            aria-label="Toggle activity digest"
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${activityDigestEmailEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${activityDigestEmailEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-gray-400">Batched summary of new friends / follows / saves</p>
                                    {toggleCounts && (
                                        <p className="text-[10px] text-gray-500">
                                            {toggleCounts.activity_digest.email} email · {toggleCounts.activity_digest.push} push enabled
                                            {' '}(of {toggleCounts.total_users} users)
                                        </p>
                                    )}
                                    <div className="border-t border-gray-100 pt-2.5 space-y-1">
                                        <span className="text-[11px] font-medium text-gray-700">Schedule</span>
                                        <p className="text-[10px] text-gray-400">
                                            Format: <code className="font-mono">dow[,dow] @ HH:MM</code> — interpreted in each user's timezone.
                                        </p>
                                        <input
                                            type="text"
                                            value={digestSchedule}
                                            onChange={(e) => setDigestSchedule(e.target.value)}
                                            onBlur={(e) => handleDigestScheduleChange(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && handleDigestScheduleChange(digestSchedule)}
                                            placeholder="tue,fri @ 09:00"
                                            className="w-full text-[11px] font-mono border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                            aria-label="Digest schedule"
                                        />
                                    </div>
                                    <p className="text-[10px] text-gray-400 border-t border-gray-100 pt-2.5">
                                        Each activity feature has its own card below with an Instant/Digest
                                        email toggle and a scoped "Send now". In-app and push are always
                                        immediate.
                                    </p>
                                </div>

                                {/* Per-feature activity email delivery + scoped Send now */}
                                <FeatureEmailCard
                                    feature="friends_going"
                                    label="Friends going"
                                    description="A friend or follow marks Going to an event."
                                    emailModes={emailModes}
                                    onEmailModeChange={handleEmailModeChange}
                                    onMessage={setMessage}
                                />
                                <FeatureEmailCard
                                    feature="social_activity"
                                    label="Friends & social"
                                    description="New followers and friend requests."
                                    emailModes={emailModes}
                                    onEmailModeChange={handleEmailModeChange}
                                    onMessage={setMessage}
                                />
                                <FeatureEmailCard
                                    feature="friend_reviews"
                                    label="Friend reviews"
                                    description="A friend or follow shares a review of an event."
                                    emailModes={emailModes}
                                    onEmailModeChange={handleEmailModeChange}
                                    onMessage={setMessage}
                                />
                                <FeatureEmailCard
                                    feature="friend_milestones"
                                    label="Friend milestones"
                                    description="A friend or follow reaches a dance-passport milestone."
                                    emailModes={emailModes}
                                    onEmailModeChange={handleEmailModeChange}
                                    onMessage={setMessage}
                                />

                                {/* Web push */}
                                <div className="border border-gray-100 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Web push</span>
                                        <button
                                            onClick={handleToggleWebpush}
                                            aria-label="Toggle web push"
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${webPushEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${webPushEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-gray-400">Requires VAPID keys configured server-side</p>
                                    <div className="flex items-center justify-between border-t border-gray-100 pt-2.5">
                                        <div>
                                            <span className="text-[11px] font-medium text-gray-700">Registered users</span>
                                            <p className="text-[10px] text-gray-400">Accounts with at least one active push subscription</p>
                                        </div>
                                        <span className="text-[13px] font-semibold text-gray-700">
                                            {webPushSubscriberCount ?? '—'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Analytics Tab ── */}
            {activeTab === 'analytics' && (
                <AdminAnalytics
                    mostViewed={mostViewed}
                    mostSaved={mostSaved}
                    mostAttended={mostAttended}
                    sourceBreakdown={sourceBreakdown}
                    topCountries={topCountries}
                    topLinks={topLinks}
                    exportStats={exportStats}
                />
            )}

            {/* ── Users Tab ── */}
            {activeTab === 'users' && (
                <AdminUsersTab />
            )}

            {/* ── Notifications Tab ── */}
            {activeTab === 'notifications' && (
                <AdminNotificationsTab />
            )}

            {/* Slide-Out Panels */}
            <EventsPanel
                isOpen={eventsPanelOpen}
                onClose={() => setEventsPanelOpen(false)}
                preset={eventsPanelPreset}
                initialCalendarId={eventsPanelCalendarId}
            />
            <SuggestionsPanel
                isOpen={suggestionsPanelOpen}
                onClose={() => setSuggestionsPanelOpen(false)}
                suggestions={suggestions}
                calendars={calendars}
                allTags={allTags}
                onUpdated={(updated) => {
                    setSuggestions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                }}
                onRefresh={refreshSuggestions}
            />
            <UnsyncedSuggestionsPanel
                isOpen={unsyncedPanelOpen}
                onClose={() => setUnsyncedPanelOpen(false)}
                suggestions={suggestions}
                calendars={calendars}
                onUpdated={(updated) => {
                    setSuggestions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                }}
                onRefresh={refreshSuggestions}
            />
            <TagSuggestionsPanel
                isOpen={tagSuggestionsPanelOpen}
                onClose={() => setTagSuggestionsPanelOpen(false)}
                onCountChange={setTagSuggestionCount}
            />
            <FeedbackPanel
                isOpen={feedbackPanelOpen}
                onClose={() => setFeedbackPanelOpen(false)}
                onCountChange={setFeedbackPendingCount}
            />
            <PromoCodesAdminPanel
                isOpen={promoCodesPanelOpen}
                onClose={() => setPromoCodesPanelOpen(false)}
                onOpenEvent={(id) => setAdminDetailEventId(id)}
            />
            <AdminEventDetailPanel
                eventId={adminDetailEventId}
                onClose={() => setAdminDetailEventId(null)}
            />
            <OrganizerClaimsAdminPanel
                isOpen={organizerClaimsPanelOpen}
                onClose={() => setOrganizerClaimsPanelOpen(false)}
            />
            <DuplicatesPanel
                isOpen={duplicatesPanelOpen}
                onClose={() => setDuplicatesPanelOpen(false)}
                onOpenEvent={(id) => setAdminDetailEventId(id)}
            />
            <SeriesPanel
                isOpen={seriesPanelOpen}
                onClose={() => setSeriesPanelOpen(false)}
                onOpenEvent={(id) => setAdminDetailEventId(id)}
            />
            <ConfirmDialog
                open={confirmReseedOpen}
                title="Reseed Calendars"
                message="Reseed clears all sync tokens and re-fetches every event from the From date forward. Continue?"
                confirmLabel="Reseed"
                onCancel={() => setConfirmReseedOpen(false)}
                onConfirm={() => {
                    setConfirmReseedOpen(false);
                    void handleSync('reseed', true);
                }}
            />
        </div>
    );
}
