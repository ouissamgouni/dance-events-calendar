import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookmarkCheck, BookmarkPlus, ChevronRight, Info, Plus } from 'lucide-react';
import type { EventSchedule, OverviewItemAttendanceSummary, ScheduleIssue, ScheduleOverviewItem } from '../../types';
import { formatTimeRange, isSessionActive, overviewItemHasDetails, overviewItemOpensSchedule, overviewItemsForDay, sessionsInOverviewWindow, type DraftStatus } from '../../utils/schedule';
import { scheduleColor } from '../../utils/scheduleColors';
import RoomPill from './RoomPill';
import { DraftPill } from './ScheduleGrid';
import SessionAttendeeStack from './SessionAttendeeStack';

interface AdminProps {
    issues: ScheduleIssue[];
    drafts?: Map<string, DraftStatus>;
    onEdit: (item: ScheduleOverviewItem) => void;
    onAddMoment: (parent: ScheduleOverviewItem) => void;
}

interface PlanProps {
    plannedIds: Set<string>;
    onToggle: (item: ScheduleOverviewItem) => Promise<void>;
    attendeeSummaries?: Map<string, OverviewItemAttendanceSummary>;
}

interface Props {
    schedule: EventSchedule;
    day: string;
    onOpenSchedule?: (item: ScheduleOverviewItem) => void;
    onOpenDetails?: (item: ScheduleOverviewItem) => void;
    admin?: AdminProps;
    plan?: PlanProps;
}

export default function ProgramOverview({ schedule, day, onOpenSchedule, onOpenDetails, admin, plan }: Props) {
    const [typeFilter, setTypeFilter] = useState<number | null>(null);
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    const usedTypes = useMemo(() => {
        const ids = new Set((schedule.overview_items ?? []).filter((item) => !item.parent_id).map((item) => item.activity_type_id));
        return schedule.activity_types.filter((type) => ids.has(type.id));
    }, [schedule.activity_types, schedule.overview_items]);
    const entries = overviewItemsForDay(schedule.overview_items, day, schedule.timezone, schedule.day_start_hour)
        .filter((entry) => typeFilter == null || entry.item.activity_type_id === typeFilter);
    const issuesByItem = useMemo(() => {
        const result = new Map<string, ScheduleIssue[]>();
        for (const issue of admin?.issues ?? []) {
            for (const id of issue.overview_item_ids ?? []) result.set(id, [...(result.get(id) ?? []), issue]);
        }
        return result;
    }, [admin?.issues]);

    return (
        <div className="min-h-0 flex-1 overflow-y-auto bg-canvas" data-testid="program-overview">
            <div className="mx-auto max-w-3xl px-4 py-4">
                {usedTypes.length > 1 ? (
                    <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Filter by category">
                        <FilterChip active={typeFilter == null} onClick={() => setTypeFilter(null)}>All</FilterChip>
                        {usedTypes.map((type) => (
                            <FilterChip key={type.id} active={typeFilter === type.id} onClick={() => setTypeFilter(typeFilter === type.id ? null : type.id)} dotClass={scheduleColor(type.color).accent}>{type.name}</FilterChip>
                        ))}
                    </div>
                ) : null}
                {entries.length ? (
                    <ol className="space-y-3">
                        {entries.map(({ item, moments }) => (
                            <OverviewCard
                                key={item.id}
                                schedule={schedule}
                                item={item}
                                moments={moments}
                                now={now}
                                onOpenSchedule={onOpenSchedule}
                                onOpenDetails={onOpenDetails}
                                admin={admin}
                                plan={plan}
                                issuesByItem={issuesByItem}
                            />
                        ))}
                    </ol>
                ) : (
                    <p className="py-12 text-center text-sm text-ink-soft">Nothing in the overview for this day.</p>
                )}
            </div>
        </div>
    );
}

function FilterChip({ active, onClick, dotClass, children }: { active: boolean; onClick: () => void; dotClass?: string; children: React.ReactNode }) {
    return (
        <button type="button" aria-pressed={active} onClick={onClick} className={`flex shrink-0 items-center gap-1.5 rounded-field border px-3 py-1.5 text-xs font-semibold ${active ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink-soft'}`}>
            {/* eslint-disable-next-line no-restricted-syntax -- legend dot is intentionally circular */}
            {dotClass ? <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dotClass}`} /> : null}
            {children}
        </button>
    );
}

interface CardProps {
    schedule: EventSchedule;
    item: ScheduleOverviewItem;
    moments: ScheduleOverviewItem[];
    now: Date;
    onOpenSchedule?: (item: ScheduleOverviewItem) => void;
    onOpenDetails?: (item: ScheduleOverviewItem) => void;
    admin?: AdminProps;
    plan?: PlanProps;
    issuesByItem: Map<string, ScheduleIssue[]>;
}

function OverviewCard({ schedule, item, moments, now, onOpenSchedule, onOpenDetails, admin, plan, issuesByItem }: CardProps) {
    const activityType = schedule.activity_types.find((type) => type.id === item.activity_type_id);
    const rooms = schedule.rooms.filter((room) => item.room_ids.includes(room.id));
    const venue = schedule.venues.find((row) => row.id === item.venue_id);
    const sessionCount = item.opens_detail ? sessionsInOverviewWindow(schedule.sessions, item).length : 0;
    const plannable = Boolean(plan && item.allow_plan && !item.is_cancelled);
    const planned = Boolean(plan?.plannedIds.has(item.id));
    const attendance = plan?.attendeeSummaries?.get(item.id);
    const [planBusy, setPlanBusy] = useState(false);
    const opensSchedule = !admin && overviewItemOpensSchedule(item, schedule.sessions);
    const opensDetails = !admin && !opensSchedule && (overviewItemHasDetails(item) || plannable);
    const active = !item.is_cancelled && isSessionActive(item, now);
    const draft = admin?.drafts?.get(item.id);
    const togglePlan = async () => {
        if (!plan) return;
        setPlanBusy(true);
        try {
            await plan.onToggle(item);
        } catch {
            // The page restores the previous plan on failure.
        } finally {
            setPlanBusy(false);
        }
    };
    const onClick = admin
        ? () => admin.onEdit(item)
        : opensSchedule
            ? () => onOpenSchedule?.(item)
            : opensDetails
                ? () => onOpenDetails?.(item)
                : undefined;
    const content = (
        <>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-ink-soft">
                {draft ? <span title={draft.fields.length ? `Edited: ${draft.fields.join(', ')}` : 'Not published yet'}><DraftPill status={draft.status} /></span> : null}
                <span className="tabular-nums">{formatTimeRange(item, schedule.timezone)}</span>
                {activityType ? <span className={`rounded-field px-1.5 py-0.5 font-medium ${scheduleColor(activityType.color).pill}`}>{activityType.name}</span> : null}
                {active ? <span className="bg-action px-1.5 py-0.5 font-bold text-white">Now</span> : null}
                {item.is_cancelled ? <span className="font-semibold text-danger">Cancelled</span> : null}
            </span>
            <span className={`mt-1 block text-base font-semibold text-ink ${item.is_cancelled ? 'line-through' : ''}`}>{item.title}</span>
            {item.subtitle ? <span className="mt-0.5 block text-sm text-ink-soft">{item.subtitle}</span> : null}
            {rooms.length || venue ? <span className="mt-2 block"><RoomPill rooms={rooms} venue={venue} compact /></span> : null}
            {attendance?.visible_count ? (
                <span className="mt-2 block" aria-label={`${attendance.visible_count} people in their plan`}>
                    <SessionAttendeeStack summary={attendance} max={3} size="sm" />
                </span>
            ) : null}
            {admin ? <AdminBadges item={item} sessionCount={sessionCount} issues={issuesByItem.get(item.id) ?? []} /> : null}
        </>
    );
    return (
        <li className={`flex overflow-hidden rounded-card border bg-surface ${draft?.status === 'new' ? 'border-dashed border-action' : 'border-card-line'}`}>
            <span aria-hidden="true" className={`w-1 shrink-0 ${scheduleColor(activityType?.color ?? 'slate').accent}`} />
            <div className="min-w-0 flex-1">
                <div className="flex items-start">
                    {onClick ? (
                        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-start gap-3 p-4 text-left hover:bg-canvas">
                            <span className="min-w-0 flex-1">{content}</span>
                            {opensSchedule ? (
                                <span className="flex shrink-0 items-center gap-1 self-center text-xs font-semibold text-action">
                                    {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
                                    <ChevronRight size={16} aria-hidden="true" />
                                </span>
                            ) : opensDetails && !plannable ? <Info size={16} aria-hidden="true" className="shrink-0 self-center text-ink-soft" /> : null}
                        </button>
                    ) : (
                        <div className="min-w-0 flex-1 p-4">{content}</div>
                    )}
                    {plannable ? (
                        <button
                            type="button"
                            onClick={togglePlan}
                            disabled={planBusy}
                            aria-pressed={planned}
                            aria-label={planned ? `Remove ${item.title} from My Plan` : `Add ${item.title} to My Plan`}
                            className={`m-2 flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-field disabled:opacity-50 ${planned ? 'bg-action text-white' : 'border border-line bg-surface text-action hover:bg-canvas'}`}
                        >
                            {planned ? <BookmarkCheck size={18} aria-hidden="true" /> : <BookmarkPlus size={18} aria-hidden="true" />}
                        </button>
                    ) : null}
                </div>
                {moments.length ? (
                    <ol className="mx-4 mb-4 space-y-1 border-l-2 border-line pl-3" aria-label={`${item.title} moments`}>
                        {moments.map((moment) => (
                            <MomentRow key={moment.id} schedule={schedule} moment={moment} now={now} onOpenDetails={onOpenDetails} admin={admin} issues={issuesByItem.get(moment.id) ?? []} />
                        ))}
                    </ol>
                ) : null}
                {admin ? (
                    <button type="button" onClick={() => admin.onAddMoment(item)} className="mx-4 mb-3 flex items-center gap-1 text-xs font-semibold text-action">
                        <Plus size={14} aria-hidden="true" />Add moment
                    </button>
                ) : null}
            </div>
        </li>
    );
}

function MomentRow({ schedule, moment, now, onOpenDetails, admin, issues }: { schedule: EventSchedule; moment: ScheduleOverviewItem; now: Date; onOpenDetails?: (item: ScheduleOverviewItem) => void; admin?: AdminProps; issues: ScheduleIssue[] }) {
    const active = !moment.is_cancelled && isSessionActive(moment, now);
    const draft = admin?.drafts?.get(moment.id);
    const onClick = admin ? () => admin.onEdit(moment) : overviewItemHasDetails(moment) ? () => onOpenDetails?.(moment) : undefined;
    const content = (
        <>
            <span className="w-24 shrink-0 text-xs font-semibold tabular-nums text-ink-soft">{formatTimeRange(moment, schedule.timezone)}</span>
            <span className="min-w-0 flex-1">
                <span className={`block text-sm font-medium text-ink ${moment.is_cancelled ? 'line-through' : ''}`}>{draft ? <DraftPill status={draft.status} /> : null}{moment.title}</span>
                {moment.subtitle ? <span className="block text-xs text-ink-soft">{moment.subtitle}</span> : null}
                {admin && issues.length ? <IssueList issues={issues} /> : null}
            </span>
            {active ? <span className="shrink-0 bg-action px-1.5 py-0.5 text-xs font-bold text-white">Now</span> : null}
            {!admin && onClick ? <Info size={14} aria-hidden="true" className="shrink-0 text-ink-soft" /> : null}
        </>
    );
    return (
        <li>
            {onClick ? (
                <button type="button" onClick={onClick} className="flex w-full items-start gap-2 py-1 text-left hover:bg-canvas">{content}</button>
            ) : (
                <div className="flex items-start gap-2 py-1">{content}</div>
            )}
        </li>
    );
}

function AdminBadges({ item, sessionCount, issues }: { item: ScheduleOverviewItem; sessionCount: number; issues: ScheduleIssue[] }) {
    return (
        <span className="mt-2 block space-y-1">
            {item.opens_detail ? <span className="block text-xs font-semibold text-action">→ {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'} in full schedule</span> : null}
            {item.allow_plan ? <span className="block text-xs font-semibold text-success">Attendees can add to My Plan</span> : null}
            <IssueList issues={issues} />
        </span>
    );
}

function IssueList({ issues }: { issues: ScheduleIssue[] }) {
    if (!issues.length) return null;
    return (
        <>
            {issues.map((issue) => (
                <span key={issue.code} className={`flex items-start gap-1 text-xs font-medium ${issue.severity === 'error' ? 'text-danger' : 'text-amber-800'}`}>
                    <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />{issue.message}
                </span>
            ))}
        </>
    );
}
