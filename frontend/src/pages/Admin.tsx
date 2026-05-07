import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CalendarSetting, EventSuggestion } from '../types';
import type { AdminTagGroup } from '../api';
import {
    fetchAdminCalendars, updateCalendar, discoverCalendars, addCalendar,
    fetchSettings, updateSettings, startSyncJob,
    fetchSuggestions, fetchMostSavedEvents, fetchMostViewedEvents,
    fetchAdminTagGroups,
    fetchCalendarDefaultTags, updateCalendarDefaultTags,
    fetchSourceBreakdown, fetchTopCountries, fetchTopLinks, fetchExportStats,
    fetchMostAttendedEvents, getCurrentSyncJob,
} from '../api';
import type { MostSavedEvent, MostViewedEvent, MostAttendedEvent, SourceBreakdown, CountryBreakdown, TopLink, ExportStat } from '../api';
import { useAuth } from '../context/AuthContext';
import SyncProgressCard from '../components/SyncProgressCard';
import SyncJobsHistoryTable from '../components/SyncJobsHistoryTable';
import EventsPanel from '../components/EventsPanel';
import type { EventsPanelPreset } from '../components/EventsPanel';
import SuggestionsPanel from '../components/SuggestionsPanel';
import UnsyncedSuggestionsPanel from '../components/UnsyncedSuggestionsPanel';
import TagSuggestionsPanel from '../components/TagSuggestionsPanel';
import FeedbackPanel from '../components/FeedbackPanel';
import AdminTagCategories from '../components/AdminTagCategories';
import AdminAnalytics from '../components/AdminAnalytics';
import { useAdminCounters, notifyAdminDataChanged } from '../hooks/useAdminCounters';

type AdminTab = 'data' | 'configuration' | 'analytics';
type SyncMode = 'incremental' | 'reseed';

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
    const [showPopularity, setShowPopularity] = useState(false);
    const [showRatings, setShowRatings] = useState(false);
    const [popularityThreshold, setPopularityThreshold] = useState(10);
    const [eventColorBarColor, setEventColorBarColor] = useState('#64748b');
    const [tagSortMode, setTagSortMode] = useState<'group' | 'event_count'>('group');
    const [editingCalId, setEditingCalId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [showSyncProgress, setShowSyncProgress] = useState(false);
    const [eventsPanelOpen, setEventsPanelOpen] = useState(false);
    const [eventsPanelPreset, setEventsPanelPreset] = useState<EventsPanelPreset>('all');
    const [eventsPanelCalendarId, setEventsPanelCalendarId] = useState<string>('');
    const [suggestionsPanelOpen, setSuggestionsPanelOpen] = useState(false);
    const [unsyncedPanelOpen, setUnsyncedPanelOpen] = useState(false);
    const [tagSuggestionsPanelOpen, setTagSuggestionsPanelOpen] = useState(false);
    const [feedbackPanelOpen, setFeedbackPanelOpen] = useState(false);
    const { counters: adminCounters, refresh: refreshAdminCounters } = useAdminCounters();
    const feedbackPendingCount = adminCounters.feedbackPending;
    const tagSuggestionCount = adminCounters.tagSuggestions;
    const pendingReviewCount = adminCounters.pendingReview;
    const ungeolocatedCount = adminCounters.ungeolocated;
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
    const [tagGroups, setTagGroups] = useState<AdminTagGroup[]>([]);
    const [calendarDefaultTagIds, setCalendarDefaultTagIds] = useState<Record<string, number[]>>({});
    const { tab: tabParam } = useParams<{ tab?: string }>();
    const isValidTab = (t: string | undefined): t is AdminTab =>
        t === 'data' || t === 'configuration' || t === 'analytics';
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
            setEventColorBarColor(s.event_color_bar_color || '#64748b');
            setTagSortMode(s.tag_sort_mode === 'event_count' ? 'event_count' : 'group');
        }).catch(() => { });
        fetchSuggestions().then(setSuggestions).catch(() => { });
        fetchMostSavedEvents().then(setMostSaved).catch(() => { });
        fetchMostViewedEvents().then(setMostViewed).catch(() => { });
        fetchMostAttendedEvents().then(setMostAttended).catch(() => { });
        fetchSourceBreakdown().then(setSourceBreakdown).catch(() => { });
        fetchTopCountries().then(setTopCountries).catch(() => { });
        fetchTopLinks().then(setTopLinks).catch(() => { });
        fetchExportStats().then(setExportStats).catch(() => { });
        // Counters (pending review, ungeolocated, tag suggestions, feedback)
        // are loaded & kept fresh by the useAdminCounters hook above — no
        // need to fetch them here.
        getCurrentSyncJob()
            .then((j) => {
                if (j && (j.status === 'running' || j.status === 'abort_requested')) {
                    setShowSyncProgress(true);
                }
            })
            .catch(() => { });
    }, []);

    const handleToggle = async (cal: CalendarSetting) => {
        const updated = await updateCalendar(cal.calendar_id, { enabled: !cal.enabled });
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

    const handleSync = async (mode: SyncMode = 'incremental') => {
        if (mode === 'reseed') {
            const ok = window.confirm(
                'Reseed: clears all sync tokens and re-fetches every event from since_date forward. Continue?',
            );
            if (!ok) return;
        }
        setBusy('sync');
        setMessage('');
        try {
            await startSyncJob(mode, syncSinceDate || null);
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

    const handleTogglePopularity = async () => {
        const newVal = !showPopularity;
        setShowPopularity(newVal);
        try {
            await updateSettings({ show_popularity: newVal });
            setMessage(`Popularity display ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setShowPopularity(!newVal);
            setMessage('Failed to update feature flag.');
        }
    };

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
                        onClick={() => setSuggestionsPanelOpen(true)}
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
                            <div className="flex-1 min-h-0">
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
                                                            onClick={() => handleShowCalendarEvents(cal.calendar_id)}
                                                            className="text-[10px] text-blue-600 hover:text-blue-800 font-medium transition"
                                                            title="Show all events from this calendar"
                                                        >
                                                            Events
                                                        </button>
                                                        <button
                                                            onClick={() => handleToggleDefaultTags(cal.calendar_id)}
                                                            className={`text-[10px] font-medium px-1.5 py-0.5 border transition ${expandedDefaultTagsCalId === cal.calendar_id
                                                                ? 'bg-violet-50 border-violet-300 text-violet-700'
                                                                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                                                }`}
                                                            title="Configure default tags for new events from this calendar"
                                                        >
                                                            Tags
                                                            {(calendarDefaultTagIds[cal.calendar_id]?.length ?? 0) > 0 && (
                                                                <span className="ml-1 inline-flex items-center justify-center bg-violet-500 text-white text-[9px] font-semibold px-1 min-w-[14px]">
                                                                    {calendarDefaultTagIds[cal.calendar_id].length}
                                                                </span>
                                                            )}
                                                        </button>
                                                        <button
                                                            onClick={() => handleToggle(cal)}
                                                            className={`text-[10px] font-medium px-2 py-0.5 transition ${cal.enabled
                                                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                                                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                                                                }`}
                                                        >
                                                            {cal.enabled ? 'On' : 'Off'}
                                                        </button>
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
                                onDismiss={() => setShowSyncProgress(false)}
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
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                    {/* Settings */}
                    <div className="border border-gray-200 bg-white">
                        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                            <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Settings</h2>
                        </div>
                        <div className="p-4 space-y-3">
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
                        </div>
                    </div>

                    {/* Feature Flags */}
                    <div className="border border-gray-200 bg-white">
                        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                            <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Feature Flags</h2>
                        </div>
                        <div className="p-4 space-y-3">
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
                                    <span className="text-[11px] font-medium text-gray-700">Show popularity</span>
                                    <p className="text-[10px] text-gray-400">View counts and badges</p>
                                </div>
                                <button
                                    onClick={handleTogglePopularity}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${showPopularity ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                >
                                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${showPopularity ? 'translate-x-4' : 'translate-x-0.5'}`} />
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
                            {showPopularity && (
                                <div className="flex items-center justify-between mt-2 pl-1">
                                    <div>
                                        <span className="text-[11px] font-medium text-gray-600">🔥 Popular threshold</span>
                                        <p className="text-[10px] text-gray-400">Min views to show badge</p>
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
                            )}
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
                        </div>
                    </div>

                    {/* Tag Categories */}
                    <div className="lg:col-span-2 border border-gray-200 bg-white lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto">
                        <AdminTagCategories />
                    </div>
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
        </div>
    );
}
