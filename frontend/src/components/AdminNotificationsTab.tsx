import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, CircleQuestionMark, Mail, SlidersHorizontal, Smartphone, UserRound, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fetchAdminNotificationActivity } from '../api';
import useMediaQuery from '../hooks/useMediaQuery';
import BottomSheet from './BottomSheet';
import AdminLoadMore from './AdminLoadMore';
import type {
    NotificationActivityChannel,
    NotificationActivityGroup,
    NotificationActivityItem,
    NotificationActivityOutcome,
    NotificationActivityRow,
    NotificationActivitySummary,
    NotificationActivityTopicCount,
    NotificationActivityTrigger,
    NotificationActivityUser,
} from '../api';

const ROW_PAGE_SIZE = 50;
const GROUP_PAGE_SIZE = 20;
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
    promo_code_matches: 'Deals',
    people_suggestions: 'People suggestions',
    install_invite: 'Install invite',
    other: 'Other',
};

// Mirrors the user-facing feed categories in utils/notificationRender.ts.
const TOPIC_GROUPS: [string, string[]][] = [
    ['Plans', ['event_reminders', 'schedule_updates', 'event_messages', 'ticket_prompt']],
    ['Matches', ['interest_matches', 'promo_code_matches']],
    ['People', ['friends_going', 'plan_activity', 'social_activity', 'suggested_events', 'people_suggestions']],
    ['Reviews', ['friend_reviews', 'review_prompt', 'memories_prompt']],
    ['Milestones', ['milestone_unlocked', 'friend_milestones']],
    ['Others', ['promo_codes', 'install_invite', 'other']],
];

const TOPIC_GROUP_BY_TOPIC: Record<string, string> = Object.fromEntries(
    TOPIC_GROUPS.flatMap(([group, topics]) => topics.map((t) => [t, group])),
);
const GROUP_PILL: Record<string, string> = {
    Plans: 'bg-blue-50 text-blue-700',
    Matches: 'bg-emerald-50 text-emerald-700',
    People: 'bg-purple-50 text-purple-700',
    Reviews: 'bg-amber-50 text-amber-800',
    Milestones: 'bg-pink-50 text-pink-700',
    Others: 'bg-slate-100 text-ink-soft',
};

const CHANNEL_ICON: Record<NotificationActivityChannel, { Icon: LucideIcon; label: string; className: string }> = {
    email: { Icon: Mail, label: 'Email', className: 'text-action' },
    push: { Icon: Smartphone, label: 'Push', className: 'text-purple-700' },
    app: { Icon: Bell, label: 'In-app', className: 'text-ink-soft' },
};

const TRIGGER_META: Record<NotificationActivityTrigger, { label: string; Icon: LucideIcon | null; className: string }> = {
    auto: { label: 'Scheduled', Icon: null, className: '' },
    user: { label: 'Real-time (user action)', Icon: UserRound, className: 'text-action' },
    forced: { label: 'Admin (forced)', Icon: Zap, className: 'text-amber-700' },
    unknown: { label: 'Unknown source', Icon: CircleQuestionMark, className: 'text-muted' },
};

// Same column template for the header and every row; the recipient column drops when grouped.
const GRID_WITH_RECIPIENT = 'sm:grid-cols-[3rem_11rem_3.5rem_10rem_minmax(0,1fr)_8rem_1.25rem]';
const GRID_NO_RECIPIENT = 'sm:grid-cols-[3rem_3.5rem_10rem_minmax(0,1fr)_8rem_1.25rem]';

interface Filters {
    range: RangeKey;
    customStart: string;
    customEnd: string;
    topic: string;
    channel: NotificationActivityChannel | '';
    trigger: NotificationActivityTrigger | '';
    includeInApp: boolean;
    engaged: boolean;
    unread: boolean;
    outcome: NotificationActivityOutcome;
    byRecipient: boolean;
}

const UNSENT_PILLS: [Exclude<NotificationActivityOutcome, 'delivered'>, string][] = [
    ['push_failed', 'Push failed'],
    ['email_failed', 'Email failed'],
    ['digest_skipped', 'Digest skipped'],
];

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
    engaged: false,
    unread: false,
    outcome: 'delivered',
    byRecipient: false,
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
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function fmtDateTime(iso: string): string {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatLatency(seconds: number): string {
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

function userLabel(user: NotificationActivityUser): string {
    if (user.display_name && user.handle) return `${user.display_name} (@${user.handle})`;
    return user.display_name || (user.handle ? `@${user.handle}` : user.email);
}

function rowKey(row: NotificationActivityRow): string {
    return `${row.user.id}|${row.sent_at}|${row.channels.join('+')}|${row.items[0]?.notification_id ?? ''}|${row.status ?? ''}`;
}

function isSend(row: NotificationActivityRow): boolean {
    return !row.channels.includes('app');
}

function ChannelIcon({ channel }: { channel: NotificationActivityChannel }) {
    const meta = CHANNEL_ICON[channel] ?? CHANNEL_ICON.app;
    return (
        <span title={meta.label} className={`inline-flex ${meta.className}`}>
            <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{meta.label}</span>
        </span>
    );
}

function AlsoSentBy({ channels }: { channels: NotificationActivityChannel[] }) {
    if (channels.length === 0) return null;
    const label = `Also sent by ${channels.map((c) => (CHANNEL_ICON[c] ?? CHANNEL_ICON.app).label.toLowerCase()).join(' and ')}`;
    return (
        <span className="inline-flex items-center gap-0.5 text-muted" title={label}>
            <span aria-hidden="true">+</span>
            {channels.map((c) => {
                const { Icon } = CHANNEL_ICON[c] ?? CHANNEL_ICON.app;
                return <Icon key={c} className="h-3 w-3" aria-hidden="true" />;
            })}
            <span className="sr-only">{label}</span>
        </span>
    );
}

function FeaturePill({ topic, count }: { topic: string; count?: number }) {
    const cls = GROUP_PILL[TOPIC_GROUP_BY_TOPIC[topic] ?? 'Others'];
    return (
        <span className={`inline-flex shrink-0 items-center whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
            {topicLabel(topic)}
            {count != null && <span className="ml-1 tabular-nums opacity-75">{count}</span>}
        </span>
    );
}

function FeaturePills({ topics, digest }: { topics: NotificationActivityTopicCount[]; digest: boolean }) {
    // Digest rows list every feature in the preview column instead.
    const shown = digest ? [] : topics.slice(0, 2);
    const rest = digest ? 0 : topics.length - shown.length;
    return (
        <span
            className="flex min-w-0 shrink-0 items-center gap-1"
            title={topics.map((t) => `${topicLabel(t.topic)} ${t.count}`).join(' · ')}
        >
            {digest && (
                <span className="inline-flex items-center border border-line px-1.5 py-0.5 text-[10px] font-semibold text-ink">Digest</span>
            )}
            {shown.map((t) => <FeaturePill key={t.topic} topic={t.topic} />)}
            {rest > 0 && <span className="text-[10px] text-ink-soft">+{rest}</span>}
        </span>
    );
}

function TriggerIcon({ trigger, source }: { trigger: NotificationActivityTrigger; source: string | null }) {
    const meta = TRIGGER_META[trigger] ?? TRIGGER_META.unknown;
    if (!meta.Icon) return null;
    return (
        <span className={`inline-flex ${meta.className}`} title={source ? `${meta.label} · source: ${source}` : meta.label}>
            <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{meta.label}</span>
        </span>
    );
}

function EventLink({ eventId }: { eventId: string }) {
    return (
        <Link
            to={`/event/${eventId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 whitespace-nowrap text-action hover:underline"
        >
            View event ↗
        </Link>
    );
}

interface EngageCounts {
    clicked: number;
    opened: number;
    tapped: number;
    read: number;
}

// One verb per channel: email "Clicked" (a link) / "Opened" (pixel), push "Tapped", in-app "Read".
function EngagementChips({ channels, counts, total }: { channels: NotificationActivityChannel[]; counts: EngageCounts; total: number }) {
    const ratio = (n: number) => (total > 1 ? ` ${n}/${total}` : '');
    const chips: { label: string; title: string; success: boolean }[] = [];
    if (channels.includes('email')) {
        if (counts.clicked > 0) chips.push({ label: `Clicked${ratio(counts.clicked)}`, title: 'Clicked a link in the email', success: true });
        else if (counts.opened > 0) chips.push({ label: `Opened${ratio(counts.opened)}`, title: 'Email opened (image pixel, approximate)', success: false });
    }
    if (channels.includes('push') && counts.tapped > 0) {
        chips.push({ label: `Tapped${ratio(counts.tapped)}`, title: 'Tapped the push notification', success: true });
    }
    if (channels.includes('app') && counts.read > 0) {
        chips.push({ label: `Read${ratio(counts.read)}`, title: 'Read in the in-app feed', success: true });
    }
    return (
        <>
            {chips.map((c) => (
                <span key={c.label} title={c.title} className={`whitespace-nowrap ${c.success ? 'text-success' : 'text-ink-soft'}`}>{c.label}</span>
            ))}
        </>
    );
}

function ItemList({ row }: { row: NotificationActivityRow }) {
    const mixed = row.topics.length > 1;
    return (
        <ul className="ml-4 space-y-1.5 border-l-2 border-line pb-3 pl-3 pr-3 text-xs sm:ml-[18rem]">
            {row.items.map((item: NotificationActivityItem, i) => (
                <li key={item.notification_id ?? `unlinked-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-ink">{item.summary}</span>
                    {mixed && <FeaturePill topic={item.topic} />}
                    {item.event_id && <EventLink eventId={item.event_id} />}
                    <EngagementChips
                        channels={row.channels}
                        total={1}
                        counts={{
                            clicked: item.email_clicked_at ? 1 : 0,
                            opened: item.email_opened_at ? 1 : 0,
                            tapped: item.push_opened_at ? 1 : 0,
                            read: item.read_at ? 1 : 0,
                        }}
                    />
                </li>
            ))}
            {row.item_count > row.items.length && (
                <li className="text-[11px] text-ink-soft">+{row.item_count - row.items.length} more not shown</li>
            )}
        </ul>
    );
}

function ActivityRow({ row, showRecipient, onSelectUser }: {
    row: NotificationActivityRow;
    showRecipient: boolean;
    onSelectUser: (user: UserFilter) => void;
}) {
    const [open, setOpen] = useState(false);
    const n = row.item_count;
    const first = row.items[0];
    const eventIds = new Set(row.items.map((i) => i.event_id));
    const eventId = n === row.items.length && eventIds.size === 1 ? first?.event_id : null;
    const trigger = TRIGGER_META[row.trigger] ?? TRIGGER_META.unknown;
    const latency = n === 1 && first?.latency_seconds != null && first.latency_seconds >= 60
        ? ` · ${formatLatency(first.latency_seconds)} after created`
        : '';
    const timeTitle = `${fmtDateTime(row.sent_at)} · ${trigger.label}${row.source ? ` (${row.source})` : ''}${latency}`;
    const label = userLabel(row.user);
    const preview = row.mode === 'digest' ? (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
            {row.topics.map((t) => <FeaturePill key={t.topic} topic={t.topic} count={t.count} />)}
        </span>
    ) : (
        <>
            <span className="min-w-0 truncate text-ink">{first?.summary ?? ''}</span>
            {n > 1 && <span className="shrink-0 whitespace-nowrap text-ink-soft">+{n - 1} more</span>}
        </>
    );
    return (
        <li>
            <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs sm:grid sm:gap-y-0 sm:py-1.5 ${showRecipient ? GRID_WITH_RECIPIENT : GRID_NO_RECIPIENT}`}>
                <span className="shrink-0 tabular-nums text-ink-soft sm:order-1" title={timeTitle}>{fmtTime(row.sent_at)}</span>
                {showRecipient && (
                    <button
                        type="button"
                        onClick={() => onSelectUser({ id: row.user.id, label })}
                        title="Show only this user"
                        className="min-w-0 max-w-[50%] truncate text-left font-semibold text-ink hover:text-action sm:order-2 sm:max-w-none"
                    >
                        {label}
                    </button>
                )}
                <span className="inline-flex shrink-0 items-center gap-1.5 sm:order-3">
                    <ChannelIcon channel={row.channels[0]} />
                    <AlsoSentBy channels={row.channels.slice(1)} />
                </span>
                <span className="ml-auto inline-flex shrink-0 sm:order-7 sm:ml-0">
                    <TriggerIcon trigger={row.trigger} source={row.source} />
                </span>
                <span className="basis-full sm:hidden" aria-hidden="true" />
                <span className="min-w-0 sm:order-4">
                    <FeaturePills topics={row.topics} digest={row.mode === 'digest'} />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2 sm:order-5">
                    {row.status && (
                        <span
                            title={row.detail ?? undefined}
                            className={`min-w-0 max-w-[50%] shrink-0 truncate px-1.5 py-0.5 text-[10px] font-medium ${row.status === 'failed' ? 'bg-red-50 text-danger' : 'bg-slate-100 text-ink-soft'}`}
                        >
                            {row.status === 'failed' ? 'Failed' : 'Skipped'}{row.detail ? ` · ${row.detail}` : ''}
                        </span>
                    )}
                    {n > 1 ? (
                        <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => setOpen(!open)}
                            className="flex min-h-11 min-w-0 items-center gap-1 text-left hover:text-action sm:min-h-0"
                        >
                            {open
                                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-soft" aria-hidden="true" />
                                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-soft" aria-hidden="true" />}
                            {preview}
                        </button>
                    ) : (
                        <span className="flex min-w-0 items-center gap-1">{preview}</span>
                    )}
                    {eventId && <EventLink eventId={eventId} />}
                </span>
                <span className="flex shrink-0 items-center gap-2 sm:order-6">
                    <EngagementChips
                        channels={row.channels}
                        total={n}
                        counts={{ clicked: row.email_clicked, opened: row.email_opened, tapped: row.push_opened, read: row.read_count }}
                    />
                </span>
            </div>
            {open && <ItemList row={row} />}
        </li>
    );
}

function dayStats(rows: NotificationActivityRow[]): string {
    const sends = rows.filter(isSend).length;
    const inApp = rows.length - sends;
    const engaged = rows.filter((r) => r.engaged_count > 0).length;
    return [plural(sends, 'send'), inApp ? `${inApp} in-app` : '', engaged ? `${engaged} engaged` : '']
        .filter(Boolean)
        .join(' · ');
}

function RecipientGroup({ group, onSelectUser }: { group: NotificationActivityGroup; onSelectUser: (user: UserFilter) => void }) {
    const label = userLabel(group.user);
    return (
        <li>
            <div className="flex flex-wrap items-center gap-x-2 bg-canvas px-3 py-1.5 text-xs">
                <button
                    type="button"
                    onClick={() => onSelectUser({ id: group.user.id, label })}
                    title="Show only this user"
                    className="min-h-11 truncate text-left font-semibold text-ink hover:text-action sm:min-h-0"
                >
                    {label}
                </button>
                <span className="text-ink-soft">{dayStats(group.rows)}</span>
            </div>
            <ul className="divide-y divide-line/60">
                {group.rows.map((r) => <ActivityRow key={rowKey(r)} row={r} showRecipient={false} onSelectUser={onSelectUser} />)}
            </ul>
        </li>
    );
}

type TileFilter = Pick<Filters, 'channel' | 'trigger' | 'engaged' | 'unread' | 'outcome'>;
const TILE_DEFAULTS: TileFilter = { channel: '', trigger: '', engaged: false, unread: false, outcome: 'delivered' };

function tileActive(filters: Filters, tile: Partial<TileFilter>): boolean {
    return (Object.keys(TILE_DEFAULTS) as (keyof TileFilter)[])
        .every((k) => (tile[k] ?? TILE_DEFAULTS[k]) === filters[k]);
}

function KpiStrip({ summary, includeInApp, filters, onChange }: {
    summary: NotificationActivitySummary;
    includeInApp: boolean;
    filters: Filters;
    onChange: (patch: Partial<Filters>) => void;
}) {
    const s = summary;
    const tiles: { label: string; value: string; hint: string; filter: Partial<TileFilter>; extra?: Partial<Filters> }[] = [
        {
            label: 'Emails',
            value: String(s.email_digest + s.email_instant),
            hint: `${s.email_digest} digest · ${s.email_instant} instant`,
            filter: { channel: 'email' },
        },
        { label: 'Push', value: String(s.push), hint: plural(s.push_items, 'item'), filter: { channel: 'push' } },
        {
            label: 'In-app',
            value: includeInApp ? String(s.in_app_items) : '—',
            hint: includeInApp ? `${pct(s.app_read, s.in_app_items)} read` : 'Hidden',
            filter: { channel: 'app' },
        },
        {
            label: 'Unread',
            value: includeInApp ? String(s.in_app_items - s.app_read) : '—',
            hint: includeInApp ? 'in-app items' : 'Hidden',
            filter: { unread: true },
            extra: { includeInApp: true },
        },
        {
            label: 'Admin sends',
            value: String(s.forced),
            hint: `${s.auto} scheduled · ${s.user} real-time${s.unknown ? ` · ${s.unknown} unknown` : ''}`,
            filter: { trigger: 'forced' },
        },
        {
            label: 'Email click rate',
            value: pct(s.email_clicked, s.email_items),
            hint: `${s.email_clicked}/${s.email_items} items${s.email_opened ? ` · ${s.email_opened} opened` : ''}`,
            filter: { channel: 'email', engaged: true },
        },
        {
            label: 'Push tap rate',
            value: pct(s.push_opened, s.push_items),
            hint: `${s.push_opened}/${s.push_items} items`,
            filter: { channel: 'push', engaged: true },
        },
    ];
    return (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-4 sm:px-0 lg:grid-cols-7">
            {tiles.map(({ label, value, hint, filter, extra }) => {
                const active = tileActive(filters, filter);
                return (
                    <button
                        key={label}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(active ? TILE_DEFAULTS : { ...TILE_DEFAULTS, ...filter, ...extra })}
                        title={active ? 'Clear this filter' : `Show ${label.toLowerCase()} only`}
                        className={`min-w-[8.5rem] shrink-0 border px-3 py-2 text-left ${active ? 'border-action bg-blue-50' : 'border-card-line bg-surface hover:bg-canvas'}`}
                    >
                        <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-soft">{label}</span>
                        <span className="block text-lg font-semibold text-ink">{value}</span>
                        <span className="block truncate text-[11px] text-ink-soft">{hint}</span>
                    </button>
                );
            })}
        </div>
    );
}

// Unsent rows are hidden unless one of these is on.
function UnsentPills({ summary, outcome, onChange }: {
    summary: NotificationActivitySummary;
    outcome: NotificationActivityOutcome;
    onChange: (patch: Partial<Filters>) => void;
}) {
    return (
        <div role="group" aria-label="Unsent notifications" className="flex flex-wrap items-center gap-1 text-xs">
            {UNSENT_PILLS.map(([key, label]) => {
                const active = outcome === key;
                return (
                    <button
                        key={key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange({ outcome: active ? 'delivered' : key })}
                        className={`min-h-11 border px-3 sm:min-h-0 sm:px-2 sm:py-1 ${active ? 'border-danger bg-red-50 text-danger' : 'border-line bg-surface text-ink hover:bg-canvas'}`}
                    >
                        {label} <span className="tabular-nums text-ink-soft">{summary[key] ?? 0}</span>
                    </button>
                );
            })}
        </div>
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
                    <option value="auto">Scheduled</option>
                    <option value="user">Real-time (user action)</option>
                    <option value="forced">Admin (forced)</option>
                    <option value="unknown">Unknown</option>
                </select>
            </label>
            <label className={mobile ? 'flex min-h-11 items-center gap-2 text-sm text-ink' : 'flex items-center gap-1.5'}>
                <input type="checkbox" checked={filters.includeInApp} onChange={(e) => onChange({ includeInApp: e.target.checked })} />
                Show in-app feed
            </label>
            <label className={mobile ? 'flex min-h-11 items-center gap-2 text-sm text-ink' : 'flex items-center gap-1.5'}>
                <input type="checkbox" checked={filters.engaged} onChange={(e) => onChange({ engaged: e.target.checked })} />
                Engaged only
            </label>
            <label className={mobile ? 'flex min-h-11 items-center gap-2 text-sm text-ink' : 'flex items-center gap-1.5'}>
                <input type="checkbox" checked={filters.unread} onChange={(e) => onChange({ unread: e.target.checked })} />
                Has unread
            </label>
            <label className={mobile ? 'flex min-h-11 items-center gap-2 text-sm text-ink' : 'flex items-center gap-1.5'}>
                <input type="checkbox" checked={filters.byRecipient} onChange={(e) => onChange({ byRecipient: e.target.checked })} />
                Group by recipient
            </label>
        </>
    );
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Admin Notifications tab: one row per outbound send (a digest is one row
 * with N items), newest first under day headers (browser timezone). "Group by
 * recipient" switches the server to paging whole recipient-days instead.
 */
export default function AdminNotificationsTab() {
    const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
    const [q, setQ] = useState('');
    const [user, setUser] = useState<UserFilter | null>(null);
    const [rows, setRows] = useState<NotificationActivityRow[]>([]);
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
    const byRecipient = filters.byRecipient;

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
            engaged: filters.engaged,
            unread: filters.unread,
            outcome: filters.outcome === 'delivered' ? undefined : filters.outcome,
            group: filters.byRecipient ? 'recipient' : undefined,
            limit: filters.byRecipient ? GROUP_PAGE_SIZE : ROW_PAGE_SIZE,
            offset,
        });
    }, [filters, q, user]);

    useEffect(() => {
        const id = ++requestRef.current;
        fetchPage(0)
            .then((res) => {
                if (id !== requestRef.current) return;
                setRows(res.rows);
                setGroups(res.groups);
                setSummary(res.summary);
                setTotal(res.total);
                setError(null);
            })
            .catch((e: unknown) => {
                if (id !== requestRef.current) return;
                setRows([]);
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
            const res = await fetchPage(byRecipient ? groups.length : rows.length);
            if (id !== requestRef.current) return;
            if (byRecipient) {
                const seen = new Set(groups.map((g) => `${g.day}|${g.user.id}`));
                setGroups([...groups, ...res.groups.filter((g) => !seen.has(`${g.day}|${g.user.id}`))]);
            } else {
                const seen = new Set(rows.map(rowKey));
                setRows([...rows, ...res.rows.filter((r) => !seen.has(rowKey(r)))]);
            }
            setTotal(res.total);
        } catch (e) {
            if (id === requestRef.current) setError(e instanceof Error ? e.message : 'Failed to load notifications');
        } finally {
            setLoadingMore(false);
        }
    };

    const patchFilters = (patch: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...patch }));
    const activeFilterCount = [filters.topic, filters.channel, filters.trigger].filter(Boolean).length
        + (filters.includeInApp ? 1 : 0)
        + (filters.engaged ? 1 : 0)
        + (filters.unread ? 1 : 0)
        + (filters.outcome !== 'delivered' ? 1 : 0)
        + (filters.range !== DEFAULT_FILTERS.range ? 1 : 0);

    const days: { day: string; rows: NotificationActivityRow[]; groups: NotificationActivityGroup[] }[] = [];
    if (byRecipient) {
        for (const g of groups) {
            const last = days.find((d) => d.day === g.day);
            if (last) last.groups.push(g);
            else days.push({ day: g.day, rows: [], groups: [g] });
        }
    } else {
        for (const r of rows) {
            const day = localDayKey(new Date(r.sent_at));
            const last = days.at(-1);
            if (last && last.day === day) last.rows.push(r);
            else days.push({ day, rows: [r], groups: [] });
        }
    }
    const shown = byRecipient ? groups.length : rows.length;
    const unit = byRecipient ? 'recipient-day' : 'row';

    return (
        <section className="space-y-4">
            <header className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Notifications</h2>
                <span className="text-xs text-ink-soft">
                    {loading ? 'Loading…' : plural(total, unit)}
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

            {summary && (
                <KpiStrip
                    summary={summary}
                    includeInApp={filters.includeInApp || filters.channel === 'app'}
                    filters={filters}
                    onChange={patchFilters}
                />
            )}
            {summary && <UnsentPills summary={summary} outcome={filters.outcome} onChange={patchFilters} />}

            <div className={isMobile ? '-mx-4 space-y-4' : 'space-y-4'}>
                {!loading && !error && shown === 0 && (
                    <p className="px-4 py-8 text-center text-sm text-ink-soft">No notifications match these filters.</p>
                )}
                {days.length > 0 && (
                    <div className={`hidden gap-x-2 px-3 text-[10px] font-medium uppercase tracking-wide text-ink-soft sm:grid ${byRecipient ? GRID_NO_RECIPIENT : GRID_WITH_RECIPIENT}`}>
                        <span>Time</span>
                        {!byRecipient && <span>Recipient</span>}
                        <span>Channel</span>
                        <span>Feature</span>
                        <span>Preview</span>
                        <span>Engagement</span>
                        <span title="Trigger (only shown when not scheduled)" />
                    </div>
                )}
                {days.map((d) => (
                    <section key={d.day} className="space-y-1">
                        <h3 className={isMobile ? 'px-4 text-sm font-semibold text-ink' : 'text-sm font-semibold text-ink'}>
                            {dayLabel(d.day)}
                            <span className="font-normal text-ink-soft">
                                {` · ${dayStats(byRecipient ? d.groups.flatMap((g) => g.rows) : d.rows)}`}
                            </span>
                        </h3>
                        <ul className="divide-y divide-line border-y border-card-line bg-surface sm:border-x">
                            {byRecipient
                                ? d.groups.map((g) => <RecipientGroup key={`${g.day}|${g.user.id}`} group={g} onSelectUser={setUser} />)
                                : d.rows.map((r) => <ActivityRow key={rowKey(r)} row={r} showRecipient onSelectUser={setUser} />)}
                        </ul>
                    </section>
                ))}
                <AdminLoadMore shown={shown} total={total} loading={loading} onLoadMore={loadMore} />
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
                            {loading ? 'Loading…' : `Show ${plural(total, unit)}`}
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
