import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CalendarSetting, EventSuggestion } from '../types';
import type { SyncLogEntry, AdminTagGroup } from '../api';
import {
    fetchAdminCalendars, updateCalendar, discoverCalendars, triggerSync, addCalendar,
    fetchSettings, updateSettings, fetchSyncLogs,
    fetchSuggestions, fetchMostSavedEvents, fetchMostViewedEvents, fetchAdminTagSuggestions,
    fetchEventFilterOptions, fetchAdminTagGroups,
    fetchCalendarDefaultTags, updateCalendarDefaultTags,
    fetchSourceBreakdown, fetchTopCountries, fetchTopLinks, fetchExportStats,
    fetchMostAttendedEvents,
} from '../api';
import type { MostSavedEvent, MostViewedEvent, MostAttendedEvent, SourceBreakdown, CountryBreakdown, TopLink, ExportStat } from '../api';
import { useAuth } from '../context/AuthContext';
import SyncHistoryPanel from '../components/SyncHistoryPanel';
import EventsPanel from '../components/EventsPanel';
import type { EventsPanelPreset } from '../components/EventsPanel';
import SuggestionsPanel from '../components/SuggestionsPanel';
import UnsyncedSuggestionsPanel from '../components/UnsyncedSuggestionsPanel';
import TagSuggestionsPanel from '../components/TagSuggestionsPanel';
import AdminTagCategories from '../components/AdminTagCategories';
import AdminAnalytics from '../components/AdminAnalytics';

export default function Admin() {
    const [calendars, setCalendars] = useState<CalendarSetting[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const [newCalId, setNewCalId] = useState('');
    const [sinceDate, setSinceDate] = useState('');
    const [syncInterval, setSyncInterval] = useState(15);
    const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
    const [showPrices, setShowPrices] = useState(false);
    const [showPopularity, setShowPopularity] = useState(false);
    const [popularityThreshold, setPopularityThreshold] = useState(10);
    const [syncLogs, setSyncLogs] = useState<SyncLogEntry[]>([]);
    const [editingCalId, setEditingCalId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [syncPanelOpen, setSyncPanelOpen] = useState(false);
    const [eventsPanelOpen, setEventsPanelOpen] = useState(false);
    const [eventsPanelPreset, setEventsPanelPreset] = useState<EventsPanelPreset>('all');
    const [eventsPanelCalendarId, setEventsPanelCalendarId] = useState<string>('');
    const [suggestionsPanelOpen, setSuggestionsPanelOpen] = useState(false);
    const [unsyncedPanelOpen, setUnsyncedPanelOpen] = useState(false);
    const [tagSuggestionsPanelOpen, setTagSuggestionsPanelOpen] = useState(false);
    const [tagSuggestionCount, setTagSuggestionCount] = useState(0);
    const [pendingReviewCount, setPendingReviewCount] = useState(0);
    const [ungeolocatedCount, setUngeolocatedCount] = useState(0);
    const [suggestions, setSuggestions] = useState<EventSuggestion[]>([]);
    const [mostSaved, setMostSaved] = useState<MostSavedEvent[]>([]);
    const [mostViewed, setMostViewed] = useState<MostViewedEvent[]>([]);
    const [mostAttended, setMostAttended] = useState<MostAttendedEvent[]>([]);
    const [sourceBreakdown, setSourceBreakdown] = useState<SourceBreakdown[]>([]);
    const [topCountries, setTopCountries] = useState<CountryBreakdown[]>([]);
    const [topLinks, setTopLinks] = useState<TopLink[]>([]);
    const [exportStats, setExportStats] = useState<ExportStat[]>([]);
    // Calendar default tags: which calendar row is expanded, the tag groups data, and each calendar's tag IDs
    const [expandedDefaultTagsCalId, setExpandedDefaultTagsCalId] = useState<string | null>(null);
    const [tagGroups, setTagGroups] = useState<AdminTagGroup[]>([]);
    const [calendarDefaultTagIds, setCalendarDefaultTagIds] = useState<Record<string, number[]>>({});
    const [activeTab, setActiveTab] = useState<'config' | 'analytics'>('config');
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const loadCalendars = () => {
        fetchAdminCalendars()
            .then((cals) => {
                setCalendars(cals);
                // Eagerly load default tag counts for all calendars so badges are visible
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
            setSyncInterval(s.sync_interval_minutes);
            setAutoSyncEnabled(s.auto_sync_enabled);
            setShowPrices(s.show_prices);
            setShowPopularity(s.show_popularity);
            setPopularityThreshold(s.popularity_threshold ?? 10);
        }).catch(() => { });
        fetchSyncLogs().then(setSyncLogs).catch(() => { });
        fetchSuggestions().then(setSuggestions).catch(() => { });
        fetchMostSavedEvents().then(setMostSaved).catch(() => { });
        fetchMostViewedEvents().then(setMostViewed).catch(() => { });
        fetchMostAttendedEvents().then(setMostAttended).catch(() => { });
        fetchSourceBreakdown().then(setSourceBreakdown).catch(() => { });
        fetchTopCountries().then(setTopCountries).catch(() => { });
        fetchTopLinks().then(setTopLinks).catch(() => { });
        fetchExportStats().then(setExportStats).catch(() => { });
        fetchAdminTagSuggestions('pending').then((s) => setTagSuggestionCount(s.length)).catch(() => { });
        fetchEventFilterOptions({ future_only: true }).then((opts) => {
            setPendingReviewCount(opts.review_statuses.find((s) => s.value === 'pending')?.count ?? 0);
            setUngeolocatedCount(opts.geo_statuses.find((s) => s.value === 'ungeolocated')?.count ?? 0);
        }).catch(() => { });
    }, []);

    const handleToggle = async (cal: CalendarSetting) => {
        const updated = await updateCalendar(cal.calendar_id, { enabled: !cal.enabled });
        setCalendars((prev) =>
            prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)),
        );
    };

    const handleColorChange = async (cal: CalendarSetting, color: string) => {
        const updated = await updateCalendar(cal.calendar_id, { color });
        setCalendars((prev) =>
            prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)),
        );
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
        setCalendars((prev) =>
            prev.map((c) => (c.calendar_id === updated.calendar_id ? updated : c)),
        );
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
        // Fetch tag groups if not yet loaded
        if (tagGroups.length === 0) {
            const groups = await fetchAdminTagGroups().catch(() => []);
            setTagGroups(groups);
        }
        // Fetch this calendar's current default tags if not yet loaded
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
        // Optimistic update
        setCalendarDefaultTagIds((prev) => ({ ...prev, [calId]: next }));
        await updateCalendarDefaultTags(calId, next).catch(() => {
            // Rollback on error
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
        } catch (err: any) {
            setMessage(err.message || 'Failed to add calendar.');
        } finally {
            setBusy('');
        }
    };

    const handleSync = async () => {
        setBusy('sync');
        setMessage('');
        try {
            const stats = await triggerSync();
            setMessage(
                `Synced ${stats.calendars_synced} calendar(s): ${stats.events_upserted} upserted, ${stats.events_deleted} deleted.`,
            );
            fetchSyncLogs().then(setSyncLogs).catch(() => { });
        } catch {
            setMessage('Failed to sync.');
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

    const handleTogglePrices = async () => {
        const newVal = !showPrices;
        setShowPrices(newVal);
        try {
            await updateSettings({ show_prices: newVal } as any);
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
            await updateSettings({ show_popularity: newVal } as any);
            setMessage(`Popularity display ${newVal ? 'enabled' : 'disabled'}.`);
        } catch {
            setShowPopularity(!newVal);
            setMessage('Failed to update feature flag.');
        }
    };

    const handlePopularityThresholdChange = async (value: number) => {
        if (isNaN(value) || value < 1) return;
        setPopularityThreshold(value);
        try {
            await updateSettings({ popularity_threshold: value } as any);
        } catch {
            setMessage('Failed to update popularity threshold.');
        }
    };

    const enabledCount = calendars.filter((c) => c.enabled).length;

    return (
        <div className="mx-auto max-w-7xl px-5 py-6">
            {/* ── Header ── */}
            <div className="mb-5 space-y-2">
                <h1 className="-mt-2 text-sm font-semibold text-gray-900 uppercase tracking-wide">
                    Admin
                </h1>
                <div className="flex flex-wrap items-start gap-2 sm:items-start sm:justify-between">
                    <div className="flex items-center gap-1.5 sm:gap-2">
                        <button
                            onClick={() => setActiveTab('config')}
                            className={`text-[11px] font-medium px-2 py-1 sm:px-2.5 transition border ${activeTab === 'config'
                                ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                                }`}
                        >
                            Configuration
                        </button>
                        <button
                            onClick={() => setActiveTab('analytics')}
                            className={`text-[11px] font-medium px-2 py-1 sm:px-2.5 transition border ${activeTab === 'analytics'
                                ? 'bg-gray-800 text-white border-gray-800 hover:bg-gray-700'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                                }`}
                        >
                            Analytics
                        </button>
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

            {/* ── Action Bar (config only) ── */}
            {activeTab === 'config' && <div className="mb-4 flex items-center gap-2 flex-wrap">
                <button
                    onClick={handleDiscover}
                    disabled={!!busy}
                    className="bg-gray-800 text-white text-[11px] font-medium px-3 py-1.5 hover:bg-gray-700 disabled:opacity-50 transition"
                >
                    {busy === 'discover' ? 'Discovering…' : 'Discover'}
                </button>
                <button
                    onClick={handleSync}
                    disabled={!!busy || enabledCount === 0}
                    className="bg-blue-600 text-white text-[11px] font-medium px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50 transition"
                >
                    {busy === 'sync' ? 'Syncing…' : `Sync Now (${enabledCount})`}
                </button>

                <div className="w-px h-4 bg-gray-200 mx-1" />

                <button
                    onClick={() => setSyncPanelOpen(true)}
                    className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-600 text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-50 transition"
                >
                    Sync History
                    {syncLogs.length > 0 && (
                        <span className="inline-flex items-center justify-center bg-gray-200 text-gray-600 text-[10px] font-semibold px-1.5 py-0 min-w-[16px]">
                            {syncLogs.length}
                        </span>
                    )}
                </button>
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
            </div>}

            {activeTab === 'config' && message && (
                <p className="mb-4 bg-blue-50 border border-blue-100 px-3 py-1.5 text-[11px] text-blue-700">{message}</p>
            )}

            {/* ── 3-Column Grid (Config) ── */}
            {activeTab === 'config' && <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* Card 1: Calendar Sources */}
                <div className="border border-gray-200 bg-white">
                    <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                        <h2 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Calendar Sources</h2>
                    </div>
                    <div className="p-4">
                        {/* Add Calendar Input */}
                        <div className="flex gap-1.5 mb-3">
                            <input
                                type="text"
                                value={newCalId}
                                onChange={(e) => setNewCalId(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddCalendar()}
                                placeholder="Calendar ID (e.g. user@gmail.com)"
                                className="flex-1 border border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button
                                onClick={handleAddCalendar}
                                disabled={!!busy || !newCalId.trim()}
                                className="bg-gray-800 text-white text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-700 disabled:opacity-50 transition shrink-0"
                            >
                                {busy === 'add' ? 'Adding…' : 'Add'}
                            </button>
                        </div>

                        {/* Calendar List */}
                        {loading ? (
                            <p className="text-[11px] text-gray-400">Loading…</p>
                        ) : calendars.length === 0 ? (
                            <p className="text-[11px] text-gray-400">
                                No calendars. Use "Discover" to find them.
                            </p>
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
                                        {/* Inline default tags picker */}
                                        {expandedDefaultTagsCalId === cal.calendar_id && (
                                            <div className="mt-2 pl-6">
                                                <p className="text-[10px] text-gray-400 mb-1.5">
                                                    Default tags — applied to new events synced from this calendar:
                                                </p>
                                                <div className="flex flex-wrap gap-1">
                                                    {tagGroups.filter((g) => g.enabled).map((group) =>
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
                </div>

                {/* Card 2: Settings */}
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
                        </div>

                        <div className="border border-gray-100 bg-gray-50 px-2.5 py-2 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-medium text-gray-700">Auto sync</span>
                                <button
                                    onClick={handleToggleAutoSync}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${autoSyncEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                                >
                                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${autoSyncEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                            </div>

                            <div className="flex items-center gap-1.5">
                                <span className="text-[11px] font-medium text-gray-500">Sync interval</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={1440}
                                    value={syncInterval}
                                    onChange={(e) => setSyncInterval(Number(e.target.value))}
                                    disabled={!autoSyncEnabled}
                                    className="w-16 border border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                                />
                                <span className="text-[11px] text-gray-400">min</span>
                                <button
                                    onClick={handleSyncIntervalSave}
                                    disabled={!autoSyncEnabled || !!busy || syncInterval < 1 || syncInterval > 1440}
                                    className="bg-gray-800 text-white text-[11px] font-medium px-2.5 py-1.5 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                                >
                                    {busy === 'interval' ? '…' : 'Save'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Card 3: Feature Flags */}
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
                    </div>
                </div>

                {/* Card 4: Tag Categories (inside grid) */}
                <div className="border border-gray-200 bg-white lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto">
                    <AdminTagCategories />
                </div>
            </div>}

            {/* ── Analytics tab ── */}
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
            <SyncHistoryPanel
                isOpen={syncPanelOpen}
                onClose={() => setSyncPanelOpen(false)}
                syncLogs={syncLogs}
            />
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
                    setSuggestions((prev) =>
                        prev.map((s) => (s.id === updated.id ? updated : s)),
                    );
                }}
            />
            <UnsyncedSuggestionsPanel
                isOpen={unsyncedPanelOpen}
                onClose={() => setUnsyncedPanelOpen(false)}
                suggestions={suggestions}
                calendars={calendars}
                onUpdated={(updated) => {
                    setSuggestions((prev) =>
                        prev.map((s) => (s.id === updated.id ? updated : s)),
                    );
                }}
            />

            {/* Tag Suggestions Panel */}
            <TagSuggestionsPanel
                isOpen={tagSuggestionsPanelOpen}
                onClose={() => setTagSuggestionsPanelOpen(false)}
                onCountChange={setTagSuggestionCount}
            />

        </div>
    );
}
