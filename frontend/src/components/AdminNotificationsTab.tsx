import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, SlidersHorizontal, X } from 'lucide-react';
import { fetchAdminNotificationActivity } from '../api';
import useMediaQuery from '../hooks/useMediaQuery';
import BottomSheet from './BottomSheet';
import AdminLoadMore from './AdminLoadMore';
import type {
    NotificationActivityChannel,
    NotificationActivityGroup,
    NotificationActivityItem,
    NotificationActivityMessage,
    NotificationActivitySummary,
    NotificationActivityTrigger,
} from '../api';

const PAGE_SIZE = 20;
const MAX_RANGE_DAYS = 31;

type RangeKey = 'today' | '7d' | '30d' | 'custom';
const RANGE_CHOICES: [RangeKey, string][] = [
    ['today', 'Today'],
    ['7d', '7 days'],
    ['30d', '30 days'],
    ['custom', 'Custom'],
];

// Keys = backend delivery features (app_settings.NOTIFICATION_FEATURES) + "other".
const TOPIC_LABELS: Record<string, string> = {
    friends_going: 'Friends going',
    plan_activity: 'Plan activity',
    social_activity: 'Follows & friends',
    friend_reviews: 'Friend reviews',
    friend_milestones: 'Friend milestones',
    interest_matches: 'Interest matches',
    milestone_unlocked: 'Milestones',
    event_messages: 'Event messages',
    suggested_events: 'Suggested events',
    ticket_prompt: 'Ticket prompt',
    memories_prompt: 'Memories prompt',
    review_prompt: 'Review prompt',
    event_reminders: 'Reminders',
    schedule_updates: 'Program & event updates',
    promo_codes: 'Promo codes',
    other: 'Other',
};

// Mirrors the user-facing feed categories in utils/notificationRender.ts.
const TOPIC_GROUPS: [string, string[]][] = [
    ['Plans', ['event_reminders', 'schedule_updates', 'event_messages', 'ticket_prompt']],
    ['Matches', ['interest_matches']],
    ['People', ['friends_going', 'plan_activity', 'social_activity', 'suggested_events']],
    ['Reviews', ['friend_reviews', 'review_prompt', 'memories_prompt']],
    ['Milestones', ['milestone_unlocked', 'friend_milestones']],
    ['Others', ['promo_codes', 'other']],
];

const CHANNEL_CHIP: Record<string, string> = {
    app: 'inline-flex items-center bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-ink',
    email: 'inline-flex items-center bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-action',
    push: 'inline-flex items-center bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700',
};
const CHANNEL_LABELS: Record<string, string> = { app: 'In-app', email: 'Email', push: 'Push' };

const TRIGGER_BADGE: Record<NotificationActivityTrigger, string> = {
    auto: 'bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-soft',
    user: 'bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-action',
    forced: 'bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800',
    unknown: 'bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-muted',
};
const TRIGGER_LABELS: Record<NotificationActivityTrigger, string> = {
    auto: 'Auto',
    user: 'User action',
    forced: 'Forced',
    unknown: 'Unknown',
};

interface Filters {
    range: RangeKey;
    customStart: string;
    customEnd: string;
    topic: string;
    channel: NotificationActivityChannel | '';
    trigger: NotificationActivityTrigger | '';
    includeInApp: boolean;
}

interface UserFilter {
    id: string;
    label: string;
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function startOfDay(date: Date): Date {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
}

function localDayKey(date: Date): string {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${m}-${d}`;
}

function parseDayKey(day: string): Date | null {
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

const today = () => localDayKey(new Date());

const DEFAULT_FILTERS: Filters = {
    range: '7d',
    customStart: localDayKey(addDays(new Date(), -6)),
    customEnd: today(),
    topic: '',
    channel: '',
    trigger: '',
    includeInApp: false,
};

/** Range bounds as local-midnight instants; custom end date is inclusive. */
function rangeBounds(filters: Filters, now = new Date()): { start: Date; end: Date } | { error: string } {
    const tomorrow = startOfDay(addDays(now, 1));
    if (filters.range === 'today') return { start: startOfDay(now), end: tomorrow };
    if (filters.range === '7d') return { start: startOfDay(addDays(now, -6)), end: tomorrow };
    if (filters.range === '30d') return { start: startOfDay(addDays(now, -29)), end: tomorrow };
    const start = parseDayKey(filters.customStart);
    const endDay = parseDayKey(filters.customEnd);
    if (!start || !endDay) return { error: 'Pick a start and end date.' };
    const end = addDays(endDay, 1);
    if (end <= start) return { error: 'End date must be on or after the start date.' };
    if (Math.round((end.getTime() - start.getTime()) / 86_400_000) > MAX_RANGE_DAYS) {
        return { error: `Pick at most ${MAX_RANGE_DAYS} days.` };
    }
    return { start, end };
}

function dayLabel(day: string, now = new Date()): string {
    if (day === localDayKey(now)) return 'Today';
    if (day === localDayKey(addDays(now, -1))) return 'Yesterday';
    const date = parseDayKey(day);
    return date ? date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : day;
}

function fmtTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(iso: string): string {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatLatency(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
}

function pct(part: number, whole: number): string {
    return whole ? `${Math.round((100 * part) / whole)}%` : '—';
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function topicLabel(topic: string | undefined): string {
    if (!topic) return 'Notification';
    return TOPIC_LABELS[topic] ?? topic.replace(/_/g, ' ');
}

function userLabel(user: NotificationActivityGroup['user']): string {
    if (user.display_name && user.handle) return `${user.display_name} (@${user.handle})`;
    return user.display_name || (user.handle ? `@${user.handle}` : user.email);
}

function ChannelChip({ channel }: { channel: string }) {
    return <span className={CHANNEL_CHIP[channel] ?? CHANNEL_CHIP.app}>{CHANNEL_LABELS[channel] ?? channel}</span>;
}

function TriggerBadge({ trigger, source }: { trigger: NotificationActivityTrigger; source: string | null }) {
    return (
        <span className={TRIGGER_BADGE[trigger] ?? TRIGGER_BADGE.unknown} title={source ? `Source: ${source}` : 'Source not recorded'}>
            {TRIGGER_LABELS[trigger] ?? trigger}
        </span>
    );
}

function ItemRow({ item }: { item: NotificationActivityItem }) {
    const ticks: [string, string | null, string | null, string][] = [
        ['In-app', item.app_at, item.read_at, 'read'],
        ['Email', item.email_at, item.email_clicked_at, 'clicked'],
        ['Push', item.push_at, item.push_opened_at, 'opened'],
    ];
    return (
        <li className="text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-ink">{item.summary}</span>
                <span className="text-[10px] uppercase tracking-wide text-ink-soft">{topicLabel(item.topic)}</span>
                {item.event_id && (
                    <Link to={`/event/${item.event_id}`} target="_blank" rel="noopener noreferrer" className="text-action hover:underline">
                        View event ↗
                    </Link>
                )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-soft">
                {ticks.flatMap(([label, at, engagedAt, verb]) => at ? [(
                    <span key={label}>
                        {label} ✓ {fmtDateTime(at)}
                        {engagedAt && <span className="text-success"> · {verb}</span>}
                    </span>
                )] : [])}
                {item.latency_seconds != null && (
                    <span title="Time from creation to this send">+{formatLatency(item.latency_seconds)} after created</span>
                )}
            </div>
        </li>
    );
}

function ItemList({ items, total }: { items: NotificationActivityItem[]; total: number }) {
    return (
        <ul className="ml-4 space-y-2 border-l-2 border-line pb-3 pl-3 pr-3 sm:ml-8">
            {items.map((item) => <ItemRow key={item.notification_id} item={item} />)}
            {total > items.length && (
                <li className="text-[11px] text-ink-soft">+{total - items.length} more not shown</li>
            )}
        </ul>
    );
}

function MessageRow({ message }: { message: NotificationActivityMessage }) {
    const [open, setOpen] = useState(false);
    const n = message.item_count;
    const isDigest = message.mode === 'digest';
    const title = isDigest
        ? `Digest · ${plural(n, 'item')}`
        : `${topicLabel(message.topics[0]?.topic)}${n > 1 ? ` · ${plural(n, 'item')}` : ''}`;
    const hasEmail = message.channels.includes('email');
    const hasPush = message.channels.includes('push');
    const verb = hasEmail && hasPush ? 'engaged' : hasEmail ? 'clicked' : 'opened';
    return (
        <li>
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex min-h-11 w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-canvas sm:min-h-0"
            >
                {open ? <ChevronDown className="h-3.5 w-3.5 text-ink-soft" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-soft" aria-hidden="true" />}
                <span className="w-11 shrink-0 tabular-nums text-ink-soft">{fmtTime(message.sent_at)}</span>
                {message.channels.map((c) => <ChannelChip key={c} channel={c} />)}
                <span className="font-medium text-ink">{title}</span>
                {(isDigest || message.topics.length > 1) && (
                    <span className="hidden text-ink-soft sm:inline">
                        {message.topics.map((t) => `${topicLabel(t.topic)} ${t.count}`).join(' · ')}
                    </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                    {message.engaged_count > 0 && <span className="text-success">{message.engaged_count} {verb}</span>}
                    <TriggerBadge trigger={message.trigger} source={message.source} />
                </span>
            </button>
            {open && <ItemList items={message.items} total={n} />}
        </li>
    );
}

function InAppRow({ inApp }: { inApp: NonNullable<NotificationActivityGroup['in_app']> }) {
    const [open, setOpen] = useState(false);
    return (
        <li>
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex min-h-11 w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-canvas sm:min-h-0"
            >
                {open ? <ChevronDown className="h-3.5 w-3.5 text-ink-soft" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-soft" aria-hidden="true" />}
                <span className="w-11 shrink-0" />
                <ChannelChip channel="app" />
                <span className="font-medium text-ink">New in feed · {plural(inApp.item_count, 'item')}</span>
                <span className="hidden text-ink-soft sm:inline">
                    {inApp.topics.map((t) => `${topicLabel(t.topic)} ${t.count}`).join(' · ')}
                </span>
                {inApp.read_count > 0 && <span className="ml-auto text-success">{inApp.read_count} read</span>}
            </button>
            {open && <ItemList items={inApp.items} total={inApp.item_count} />}
        </li>
    );
}

function UserDayCard({ group, onSelectUser }: { group: NotificationActivityGroup; onSelectUser: (user: UserFilter) => void }) {
    const label = userLabel(group.user);
    return (
        <article className="border border-card-line bg-surface">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <button
                    type="button"
                    onClick={() => onSelectUser({ id: group.user.id, label })}
                    className="min-h-11 min-w-0 truncate text-sm font-semibold text-ink hover:text-action sm:min-h-0"
                    title="Show only this user"
                >
                    {label}
                </button>
                <span className="text-xs text-ink-soft">
                    {plural(group.messages.length, 'message')}
                    {group.in_app ? ` · ${group.in_app.item_count} in-app` : ''}
                </span>
            </header>
            <ul className="divide-y divide-line border-t border-line">
                {group.messages.map((m, i) => <MessageRow key={`${i}-${m.sent_at}`} message={m} />)}
                {group.in_app && <InAppRow inApp={group.in_app} />}
            </ul>
        </article>
    );
}

function KpiStrip({ summary, includeInApp }: { summary: NotificationActivitySummary; includeInApp: boolean }) {
    const s = summary;
    const tiles: [string, string, string][] = [
        ['Emails', String(s.email_digest + s.email_instant), `${s.email_digest} digest · ${s.email_instant} instant`],
        ['Push', String(s.push), plural(s.push_items, 'item')],
        ['In-app', includeInApp ? String(s.in_app_items) : '—', includeInApp ? `${pct(s.app_read, s.in_app_items)} read` : 'Hidden'],
        ['Forced', String(s.forced), `${s.auto} auto · ${s.user} user${s.unknown ? ` · ${s.unknown} unknown` : ''}`],
        ['Email clicks', pct(s.email_clicked, s.email_items), `${s.email_clicked}/${s.email_items} items`],
        ['Push opens', pct(s.push_opened, s.push_items), `${s.push_opened}/${s.push_items} items`],
    ];
    return (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map(([label, value, hint]) => (
                <div key={label} className="border border-card-line bg-surface px-3 py-2">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">{label}</dt>
                    <dd className="text-lg font-semibold text-ink">{value}</dd>
                    <dd className="truncate text-[11px] text-ink-soft">{hint}</dd>
                </div>
            ))}
        </dl>
    );
}

function FilterFields({ filters, onChange, mobile }: { filters: Filters; onChange: (patch: Partial<Filters>) => void; mobile: boolean }) {
    const pill = mobile ? 'min-h-11 border px-3 text-sm' : 'border px-2 py-1 text-xs';
    const field = mobile
        ? 'min-h-11 w-full border border-line bg-surface px-3 text-base text-ink'
        : 'border border-line bg-surface px-2 py-1 text-xs';
    const labelCls = mobile ? 'block space-y-1' : 'flex items-center gap-1.5';
    const caption = mobile ? 'block text-[11px] font-semibold uppercase tracking-wide text-ink-soft' : '';
    return (
        <>
            <div role="group" aria-label="Date range" className="flex flex-wrap items-center gap-1">
                {RANGE_CHOICES.map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        aria-pressed={filters.range === key}
                        onClick={() => onChange({ range: key })}
                        className={filters.range === key ? `${pill} border-action bg-action text-white` : `${pill} border-line bg-surface text-ink hover:bg-canvas`}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {filters.range === 'custom' && (
                <div className="flex items-center gap-2">
                    <input type="date" aria-label="From date" value={filters.customStart} max={filters.customEnd} onChange={(e) => onChange({ customStart: e.target.value })} className={field} />
                    <span className="text-ink-soft">–</span>
                    <input type="date" aria-label="To date" value={filters.customEnd} min={filters.customStart} onChange={(e) => onChange({ customEnd: e.target.value })} className={field} />
                </div>
            )}
            <label className={labelCls}>
                <span className={caption}>Topic</span>
                <select value={filters.topic} onChange={(e) => onChange({ topic: e.target.value })} className={field} aria-label="Filter by topic">
                    <option value="">Any</option>
                    {TOPIC_GROUPS.map(([group, topics]) => (
                        <optgroup key={group} label={group}>
                            {topics.map((t) => <option key={t} value={t}>{TOPIC_LABELS[t]}</option>)}
                        </optgroup>
                    ))}
                </select>
            </label>
            <label className={labelCls}>
                <span className={caption}>Channel</span>
                <select value={filters.channel} onChange={(e) => onChange({ channel: e.target.value as Filters['channel'] })} className={field} aria-label="Filter by channel">
                    <option value="">Any</option>
                    <option value="email">Email</option>
                    <option value="push">Push</option>
                    <option value="app">In-app</option>
                </select>
            </label>
            <label className={labelCls}>
                <span className={caption}>Trigger</span>
                <select value={filters.trigger} onChange={(e) => onChange({ trigger: e.target.value as Filters['trigger'] })} className={field} aria-label="Filter by trigger">
                    <option value="">Any</option>
                    <option value="auto">Auto</option>
                    <option value="user">User action</option>
                    <option value="forced">Forced (admin)</option>
                    <option value="unknown">Unknown</option>
                </select>
            </label>
            <label className={mobile ? 'flex min-h-11 items-center gap-2 text-sm text-ink' : 'flex items-center gap-1.5'}>
                <input type="checkbox" checked={filters.includeInApp} onChange={(e) => onChange({ includeInApp: e.target.checked })} />
                Include in-app
            </label>
        </>
    );
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Admin Notifications tab: notification activity grouped by day (browser
 * timezone) → recipient → outbound message (one email/push send; a digest is
 * one message with N items) → items. In-app-only items are hidden by default.
 */
export default function AdminNotificationsTab() {
    const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
    const [q, setQ] = useState('');
    const [user, setUser] = useState<UserFilter | null>(null);
    const [groups, setGroups] = useState<NotificationActivityGroup[]>([]);
    const [summary, setSummary] = useState<NotificationActivitySummary | null>(null);
    const [total, setTotal] = useState(0);
    const [loadedKey, setLoadedKey] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isMobile = useMediaQuery('(max-width: 639px)');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const requestRef = useRef(0);

    const queryKey = JSON.stringify([filters, q.trim(), user?.id ?? null]);
    const loading = loadedKey !== queryKey || loadingMore;
    const bounds = rangeBounds(filters);
    const rangeError = 'error' in bounds ? bounds.error : null;

    const fetchPage = useCallback((offset: number) => {
        const b = rangeBounds(filters);
        if ('error' in b) return Promise.reject(new Error(b.error));
        return fetchAdminNotificationActivity({
            start: b.start.toISOString(),
            end: b.end.toISOString(),
            tz: TZ,
            user_id: user?.id,
            q: q.trim() || undefined,
            topic: filters.topic || undefined,
            channel: filters.channel || undefined,
            trigger: filters.trigger || undefined,
            include_in_app: filters.includeInApp,
            limit: PAGE_SIZE,
            offset,
        });
    }, [filters, q, user]);

    useEffect(() => {
        const id = ++requestRef.current;
        fetchPage(0)
            .then((res) => {
                if (id !== requestRef.current) return;
                setGroups(res.groups);
                setSummary(res.summary);
                setTotal(res.total_groups);
                setError(null);
            })
            .catch((e: unknown) => {
                if (id !== requestRef.current) return;
                setGroups([]);
                setSummary(null);
                setTotal(0);
                setError(e instanceof Error ? e.message : 'Failed to load notifications');
            })
            .finally(() => {
                if (id === requestRef.current) setLoadedKey(queryKey);
            });
    }, [fetchPage, queryKey]);

    const loadMore = async () => {
        const id = ++requestRef.current;
        setLoadingMore(true);
        try {
            const res = await fetchPage(groups.length);
            if (id !== requestRef.current) return;
            const seen = new Set(groups.map((g) => `${g.day}|${g.user.id}`));
            setGroups([...groups, ...res.groups.filter((g) => !seen.has(`${g.day}|${g.user.id}`))]);
            setTotal(res.total_groups);
        } catch (e) {
            if (id === requestRef.current) setError(e instanceof Error ? e.message : 'Failed to load notifications');
        } finally {
            setLoadingMore(false);
        }
    };

    const patchFilters = (patch: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...patch }));
    const activeFilterCount = [filters.topic, filters.channel, filters.trigger].filter(Boolean).length
        + (filters.includeInApp ? 1 : 0)
        + (filters.range !== DEFAULT_FILTERS.range ? 1 : 0);

    return (
        <section className="space-y-4">
            <header className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Notifications</h2>
                <span className="text-xs text-ink-soft">
                    {loading ? 'Loading…' : `${plural(total, 'user-day')}`}
                </span>
            </header>

            {isMobile ? (
                <div className="flex gap-2">
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search recipient"
                        className="min-h-11 min-w-0 flex-1 border border-line px-3 text-base"
                        aria-label="Search notifications by recipient"
                    />
                    <button
                        type="button"
                        onClick={() => setFiltersOpen(true)}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-line bg-surface px-3 text-sm font-medium text-ink"
                    >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                        Filters
                        {activeFilterCount > 0 && (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center bg-action px-1 text-[11px] font-semibold text-white">{activeFilterCount}</span>
                        )}
                    </button>
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-4 text-xs">
                    <FilterFields filters={filters} onChange={patchFilters} mobile={false} />
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search recipient handle, name, email"
                        className="w-56 border border-line px-2 py-1 text-xs"
                        aria-label="Search notifications by recipient"
                    />
                </div>
            )}

            {user && (
                <div className="flex items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 border border-action bg-blue-50 px-2 py-1 text-action">
                        User: {user.label}
                        <button type="button" onClick={() => setUser(null)} aria-label="Clear user filter" className="text-action hover:opacity-70">
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </span>
                </div>
            )}

            {rangeError && <p className="text-xs text-danger">{rangeError}</p>}
            {error && !rangeError && !loading && (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-danger">{error}</div>
            )}

            {summary && <KpiStrip summary={summary} includeInApp={filters.includeInApp || filters.channel === 'app'} />}

            <div className={isMobile ? '-mx-4 space-y-3' : 'space-y-3'}>
                {!loading && !error && groups.length === 0 && (
                    <p className="px-4 py-8 text-center text-sm text-ink-soft">No notifications match these filters.</p>
                )}
                {groups.map((g, i) => (
                    <Fragment key={`${g.day}|${g.user.id}`}>
                        {(i === 0 || groups[i - 1].day !== g.day) && (
                            <h3 className={isMobile ? 'px-4 pt-2 text-sm font-semibold text-ink' : 'pt-2 text-sm font-semibold text-ink'}>{dayLabel(g.day)}</h3>
                        )}
                        <UserDayCard group={g} onSelectUser={setUser} />
                    </Fragment>
                ))}
                <AdminLoadMore shown={groups.length} total={total} loading={loading} onLoadMore={loadMore} />
            </div>

            {isMobile && filtersOpen && (
                <BottomSheet
                    title="Filters"
                    onClose={() => setFiltersOpen(false)}
                    headerAction={activeFilterCount > 0 ? (
                        <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="min-h-11 px-2 text-sm font-medium text-action">Reset</button>
                    ) : undefined}
                    footer={
                        <button type="button" onClick={() => setFiltersOpen(false)} className="min-h-11 w-full bg-action text-sm font-semibold text-white hover:opacity-90">
                            {loading ? 'Loading…' : `Show ${plural(total, 'user-day')}`}
                        </button>
                    }
                >
                    <div className="space-y-4 pb-2">
                        <FilterFields filters={filters} onChange={patchFilters} mobile />
                    </div>
                </BottomSheet>
            )}
        </section>
    );
}
