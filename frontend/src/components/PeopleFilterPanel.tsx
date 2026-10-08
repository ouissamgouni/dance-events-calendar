/**
 * People filter panel — the redesigned body of the explorer's "People"
 * filter section (rendered inside the FilterSheet's People sub-editor).
 *
 * Three distinct concepts, never mixed:
 *   - Tribe = who exists in the viewer's network (persistent Tribe row).
 *   - WHO   = which subset to query — Following / Friends / Specific people
 *             (single-select).
 *   - STATUS = Going / Interested (multi-select, at least one on).
 *
 * Match logic: WHO scope AND (Going OR Interested). Changes apply live via
 * `onChange`; the sheet's "Show N events" CTA merely closes.
 *
 * When the viewer has no network, the panel swaps to an in-sheet
 * "Build your tribe" acquisition state; following the first person
 * transitions to the populated filter with Following auto-selected.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchMyFollowing, type FollowUser } from '../api';
import { firstNameOf } from '../utils/displayName';
import { useAuth } from '../context/AuthContext';
import { useToast } from './Toast';
import useBackToClose from '../hooks/useBackToClose';
import type { InterestFilterChange } from './InterestFilter';
import PeoplePanel, { OverlayHeader } from './tribe/PeoplePanel';
import ReferralCard from './ReferralCard';

type Who = 'following' | 'friends' | 'specific';

interface Props {
    signedIn: boolean;
    followingCount?: number;
    friendCount?: number;
    interestSource: 'follows' | 'friends' | null;
    interestKind: 'any' | 'going' | 'saved';
    interestUserHandles: string[];
    interestMatch: 'any' | 'all';
    onChange: (next: InterestFilterChange) => void;
    /** Closes the whole filter sheet (used by "Explore all events"). */
    onExploreAll?: () => void;
}

/**
 * Persistent Tribe row: avatar stack + "X people in your tribe". Reflects
 * the network, never the current filter selection. Tapping it opens the
 * in-sheet find-people surface.
 */
function TribeRow({
    followingCount,
    sessionFollows,
    onOpen,
}: {
    followingCount?: number;
    sessionFollows: number;
    onOpen: () => void;
}) {
    const [rows, setRows] = useState<FollowUser[]>([]);
    const [total, setTotal] = useState(followingCount ?? 0);

    const load = useCallback(() => {
        fetchMyFollowing({ limit: 10 })
            .then((res) => {
                // Friends first so the stack surfaces the closest connections.
                const sorted = [...res.items].sort((a, b) => Number(b.is_friend) - Number(a.is_friend));
                setRows(sorted);
                setTotal(res.total);
            })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        load();
        const onChanged = () => load();
        window.addEventListener('network:changed', onChanged);
        return () => window.removeEventListener('network:changed', onChanged);
    }, [load]);

    const count = Math.max(total, followingCount ?? 0, sessionFollows);
    const avatars = rows.slice(0, 3);
    const overflow = count - avatars.length;

    return (
        <button
            type="button"
            onClick={onOpen}
            className="flex min-h-16 w-full items-center gap-3 rounded-card bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:bg-canvas active:bg-canvas"
            data-testid="tribe-row"
        >
            <span className="flex shrink-0 items-center">
                {avatars.map((u, i) => {
                    const label = firstNameOf(u.display_name, u.handle);
                    return u.avatar_url ? (
                        <img
                            key={u.handle}
                            src={u.avatar_url}
                            alt=""
                            // eslint-disable-next-line no-restricted-syntax -- avatar
                            className={'h-8 w-8 rounded-full border-2 border-surface object-cover' + (i ? ' -ml-3' : '')}
                            loading="lazy"
                        />
                    ) : (
                        <span
                            key={u.handle}
                            className={
                                // eslint-disable-next-line no-restricted-syntax -- avatar
                                'inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface bg-slate-200 text-xs font-semibold text-ink-soft' +
                                (i ? ' -ml-3' : '')
                            }
                        >
                            {label.replace(/^@/, '').slice(0, 1).toUpperCase()}
                        </span>
                    );
                })}
                {overflow > 0 && (
                    // eslint-disable-next-line no-restricted-syntax -- avatar overflow bubble
                    <span className="-ml-3 inline-flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-surface bg-canvas px-1 text-xs font-semibold text-ink-soft">
                        +{overflow}
                    </span>
                )}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">
                    {count} {count === 1 ? 'person' : 'people'} in your tribe
                </span>
                <span className="block truncate text-xs text-ink-soft">Find &amp; invite people</span>
            </span>
            <ChevronIcon />
        </button>
    );
}

function ChevronIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 4l6 6-6 6" />
        </svg>
    );
}

const WHO_ICONS: Record<'anyone' | Who, React.ReactNode> = {
    anyone: (
        <>
            <circle cx="10" cy="10" r="7" />
            <path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3z" />
        </>
    ),
    following: (
        <>
            <circle cx="8" cy="7" r="3" />
            <path d="M2.5 16.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5M15 6v5M12.5 8.5h5" />
        </>
    ),
    friends: (
        <>
            <circle cx="7" cy="7" r="2.75" />
            <circle cx="13.5" cy="7.5" r="2.25" />
            <path d="M2 16.5c0-2.8 2.2-4.75 5-4.75s5 1.95 5 4.75M12.5 12c2.7 0 4.5 1.8 4.5 4.5" />
        </>
    ),
    specific: (
        <>
            <circle cx="8" cy="7" r="3" />
            <path d="M2.5 16.5c0-3 2.5-5 5.5-5 1.4 0 2.6.4 3.6 1.1M12.5 15l1.8 1.8 3.2-3.6" />
        </>
    ),
};

function WhoRow({
    icon,
    label,
    subtitle,
    selected,
    onClick,
    testId,
    trailing,
}: {
    icon: 'anyone' | Who;
    label: string;
    subtitle: string;
    selected: boolean;
    onClick: () => void;
    testId: string;
    trailing?: React.ReactNode;
}) {
    return (
        <li>
            <button
                type="button"
                onClick={onClick}
                aria-pressed={selected}
                data-testid={testId}
                className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-canvas active:bg-canvas"
            >
                <span
                    aria-hidden="true"
                    className={
                        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-field ' +
                        (selected ? 'bg-blue-50 text-action' : 'bg-canvas text-ink-soft')
                    }
                >
                    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        {WHO_ICONS[icon]}
                    </svg>
                </span>
                <span className="min-w-0 flex-1">
                    <span className={'block text-sm text-ink ' + (selected ? 'font-semibold' : 'font-medium')}>{label}</span>
                    <span className="block truncate text-xs text-ink-soft">{subtitle}</span>
                </span>
                {trailing}
                {selected ? (
                    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-action" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 10.5l4 4 8-8" />
                    </svg>
                ) : (
                    <span aria-hidden="true" className="h-5 w-5 shrink-0" />
                )}
            </button>
        </li>
    );
}

function StatusChip({
    label,
    checked,
    onClick,
    testId,
}: {
    label: string;
    checked: boolean;
    onClick: () => void;
    testId: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={checked}
            data-testid={testId}
            className={
                'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-field border px-3 text-sm font-semibold transition-colors ' +
                (checked
                    ? 'border-action bg-action text-white active:opacity-80'
                    : 'border-line bg-surface text-ink hover:border-action hover:text-action active:bg-canvas')
            }
        >
            {checked && (
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 10.5l4 4 8-8" />
                </svg>
            )}
            {label}
        </button>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <h4 className="px-1 text-2xs font-semibold uppercase tracking-wide text-ink-soft">{children}</h4>;
}

function InviteOverlay({ onBack }: { onBack: () => void }) {
    useBackToClose(onBack);
    return (
        <div className="absolute inset-0 z-[9000] flex flex-col bg-surface" data-testid="invite-overlay">
            <OverlayHeader title="Invite a friend" onBack={onBack} />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-canvas px-4 py-4">
                <ReferralCard />
            </div>
        </div>
    );
}

export default function PeopleFilterPanel({
    signedIn,
    followingCount,
    friendCount,
    interestSource,
    interestKind,
    interestUserHandles,
    onChange,
    onExploreAll,
}: Props) {
    const { refreshUser } = useAuth();
    const toast = useToast();
    // 'build' (empty-network acquisition) is sticky so the viewer can follow
    // several people before returning; 'find'/'pick'/'invite' are stacked overlays.
    const [view, setView] = useState<'main' | 'build' | 'find' | 'pick' | 'invite'>(
        (followingCount ?? 0) > 0 ? 'main' : 'build',
    );
    // Draft selection for the Specific-people picker (committed only on Done).
    const [pickDraft, setPickDraft] = useState<string[]>([]);
    // Handles followed within this sheet session — drives the optimistic
    // empty→populated transition before `refreshUser` lands.
    const [sessionFollows, setSessionFollows] = useState<Set<string>>(new Set());

    const hasNetwork = (followingCount ?? 0) > 0 || sessionFollows.size > 0;

    const whoSelected: Who | null =
        interestUserHandles.length > 0
            ? 'specific'
            : interestSource === 'friends'
                ? 'friends'
                : interestSource === 'follows'
                    ? 'following'
                    : null;

    const goingOn = interestKind !== 'saved';
    const savedOn = interestKind !== 'going';

    const handleFollowed = useCallback(
        (handle: string, displayName: string) => {
            const wasEmpty = (followingCount ?? 0) === 0 && sessionFollows.size === 0;
            setSessionFollows((prev) => new Set(prev).add(handle));
            toast.push({ title: `✓ ${displayName} added to your tribe`, variant: 'success', duration: 3000 });
            void refreshUser();
            // First follow from the empty state auto-selects Following in the
            // background; the surface stays open so more people can be added.
            if (wasEmpty) {
                onChange({ source: 'follows', kind: 'going', userHandles: [] });
            }
        },
        [followingCount, sessionFollows, toast, refreshUser, onChange],
    );

    const toggleStatus = (which: 'going' | 'saved') => {
        const nextGoing = which === 'going' ? !goingOn : goingOn;
        const nextSaved = which === 'saved' ? !savedOn : savedOn;
        if (!nextGoing && !nextSaved) return; // at least one must stay on
        onChange({ kind: nextGoing && nextSaved ? 'any' : nextGoing ? 'going' : 'saved' });
    };

    const openPicker = () => {
        setPickDraft(interestUserHandles);
        setView('pick');
    };

    const openInvite = () => {
        setView('invite');
    };

    const togglePick = (handle: string) => {
        setPickDraft((prev) => (prev.includes(handle) ? prev.filter((h) => h !== handle) : [...prev, handle]));
    };

    const commitSpecific = (handles: string[]) => {
        if (handles.length > 0) {
            onChange({ source: 'follows', userHandles: handles, match: 'any' });
        } else {
            onChange({ userHandles: [] });
        }
        setView('main');
    };

    // --- Anonymous ---------------------------------------------------------
    if (!signedIn) {
        return (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center" data-testid="people-signed-out">
                <span aria-hidden="true" className="inline-flex h-12 w-12 items-center justify-center rounded-card bg-blue-50 text-action">
                    <svg viewBox="0 0 20 20" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        {WHO_ICONS.friends}
                    </svg>
                </span>
                <p className="max-w-xs text-sm text-ink-soft">Sign in to filter events by people you follow.</p>
                <Link to="/login" className="inline-flex min-h-11 w-full max-w-xs items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90 active:opacity-80">
                    Sign in
                </Link>
            </div>
        );
    }

    // --- Specific-people picker (overlay) ----------------------------------
    if (view === 'pick') {
        return (
            <div className="absolute inset-0 z-[9000] flex flex-col bg-surface" data-testid="people-picker-overlay">
                <PeoplePanel
                    mode="select"
                    variant="overlay"
                    followedHandles={sessionFollows}
                    onFollowed={handleFollowed}
                    selected={pickDraft}
                    onToggleSelect={togglePick}
                    onDone={commitSpecific}
                    onBack={() => setView('main')}
                    onOpenInvite={openInvite}
                />
            </div>
        );
    }

    // --- Find-more-people (overlay from the Tribe row) ---------------------
    if (view === 'find') {
        return (
            <div className="absolute inset-0 z-[9000] flex flex-col bg-surface" data-testid="people-discover-overlay">
                <PeoplePanel
                    mode="build"
                    variant="overlay"
                    followedHandles={sessionFollows}
                    onFollowed={handleFollowed}
                    onBack={() => setView('main')}
                    onOpenInvite={openInvite}
                />
            </div>
        );
    }

    // --- Invite sheet (overlay from People panel) --------------------------
    if (view === 'invite') {
        return <InviteOverlay onBack={() => setView('find')} />;
    }

    // --- Empty network: acquisition is the primary state -------------------
    if (view === 'build' || !hasNetwork) {
        return (
            <PeoplePanel
                mode="build"
                variant="inline"
                followedHandles={sessionFollows}
                onFollowed={handleFollowed}
                onExploreAll={onExploreAll}
                onDone={() => setView('main')}
                onOpenInvite={openInvite}
            />
        );
    }

    // --- Populated filter --------------------------------------------------
    const specificSubtitle =
        whoSelected === 'specific'
            ? `${interestUserHandles.length} ${interestUserHandles.length === 1 ? 'person' : 'people'} selected`
            : 'Pick one or more people';

    return (
        <div className="flex flex-col gap-6" data-testid="people-filter-panel">
            <TribeRow
                followingCount={followingCount}
                sessionFollows={sessionFollows.size}
                onOpen={() => setView('find')}
            />

            <section className="flex flex-col gap-2">
                <SectionLabel>Who</SectionLabel>
                <ul className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-sm">
                    <WhoRow
                        icon="anyone"
                        label="Anyone"
                        subtitle="No people filter"
                        selected={whoSelected === null}
                        onClick={() => onChange({ source: null, userHandles: [] })}
                        testId="who-anyone"
                    />
                    <WhoRow
                        icon="following"
                        label="Following"
                        subtitle="Everyone you follow"
                        selected={whoSelected === 'following'}
                        onClick={() => onChange({ source: 'follows', userHandles: [] })}
                        testId="who-following"
                    />
                    <WhoRow
                        icon="friends"
                        label="Friends"
                        subtitle="People who follow you back"
                        selected={whoSelected === 'friends'}
                        onClick={() => onChange({ source: 'friends', userHandles: [] })}
                        testId="who-friends"
                    />
                    {whoSelected === 'friends' && friendCount === 0 && (
                        <li className="bg-blue-50 px-4 py-3 text-xs text-ink-soft" data-testid="people-zero-friends-hint">
                            You have no friends yet — friends are people who follow you back.{' '}
                            <button
                                type="button"
                                onClick={() => setView('find')}
                                className="relative font-semibold text-action before:absolute before:-inset-3 before:content-[''] hover:opacity-80"
                            >
                                Find people to follow
                            </button>
                        </li>
                    )}
                    <WhoRow
                        icon="specific"
                        label="Specific people"
                        subtitle={specificSubtitle}
                        selected={whoSelected === 'specific'}
                        onClick={openPicker}
                        testId="who-specific"
                        trailing={<ChevronIcon />}
                    />
                </ul>
            </section>

            {whoSelected !== null && (
                <section className="flex flex-col gap-2">
                    <SectionLabel>They're</SectionLabel>
                    <div className="flex gap-2">
                        <StatusChip
                            label="Going"
                            checked={goingOn}
                            onClick={() => toggleStatus('going')}
                            testId="status-going"
                        />
                        <StatusChip
                            label="Interested"
                            checked={savedOn}
                            onClick={() => toggleStatus('saved')}
                            testId="status-interested"
                        />
                    </div>
                </section>
            )}
        </div>
    );
}
