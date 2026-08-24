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
import type { InterestFilterChange } from './InterestFilter';
import PeoplePanel from './tribe/PeoplePanel';
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
            className="flex w-full items-center gap-3 border border-line bg-surface px-3 py-2.5 text-left hover:bg-canvas"
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
                            className={'h-7 w-7 rounded-full border-2 border-surface object-cover' + (i ? ' -ml-2.5' : '')}
                            loading="lazy"
                        />
                    ) : (
                        <span
                            key={u.handle}
                            className={
                                'inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface bg-slate-200 text-[10px] font-semibold text-ink-soft' +
                                (i ? ' -ml-2.5' : '')
                            }
                        >
                            {label.replace(/^@/, '').slice(0, 1).toUpperCase()}
                        </span>
                    );
                })}
                {overflow > 0 && (
                    <span className="-ml-2.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-surface bg-slate-100 px-1 text-[10px] font-semibold text-ink-soft">
                        +{overflow}
                    </span>
                )}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {count} {count === 1 ? 'person' : 'people'} in your tribe
            </span>
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 4l6 6-6 6" />
            </svg>
        </button>
    );
}

function RadioRow({
    label,
    subtitle,
    selected,
    onClick,
    testId,
}: {
    label: string;
    subtitle: string;
    selected: boolean;
    onClick: () => void;
    testId: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            data-testid={testId}
            className={
                'flex w-full items-center gap-3 border px-3 py-2.5 text-left transition ' +
                (selected ? 'border-action bg-blue-50' : 'border-line bg-surface hover:bg-canvas')
            }
        >
            <span
                aria-hidden="true"
                className={
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ' +
                    (selected ? 'border-action' : 'border-line')
                }
            >
                {selected && <span className="h-2 w-2 rounded-full bg-action" />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{label}</span>
                <span className="block text-xs text-ink-soft">{subtitle}</span>
            </span>
        </button>
    );
}

function CheckRow({
    label,
    subtitle,
    checked,
    onClick,
    testId,
}: {
    label: string;
    subtitle: string;
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
                'flex w-full items-center gap-3 border px-3 py-2.5 text-left transition ' +
                (checked ? 'border-action bg-blue-50' : 'border-line bg-surface hover:bg-canvas')
            }
        >
            <span
                aria-hidden="true"
                className={
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center border ' +
                    (checked ? 'border-action bg-action text-white' : 'border-line bg-surface')
                }
            >
                {checked && (
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 10.5l4 4 8-8" />
                    </svg>
                )}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{label}</span>
                <span className="block text-xs text-ink-soft">{subtitle}</span>
            </span>
        </button>
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
            <div className="flex flex-col items-center gap-2 py-6 text-center" data-testid="people-signed-out">
                <p className="text-sm text-ink-soft">Sign in to filter events by people you follow.</p>
                <Link to="/login" className="inline-flex items-center bg-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
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
        return (
            <div className="absolute inset-0 z-[9000] flex flex-col bg-surface" data-testid="invite-overlay">
                <div className="flex items-center justify-between border-b border-line px-2 py-2">
                    <button
                        type="button"
                        onClick={() => setView('find')}
                        className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink"
                        aria-label="Back"
                    >
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 4l-6 6 6 6" />
                        </svg>
                        Back
                    </button>
                    <span className="text-sm font-semibold text-ink">Invite a friend</span>
                    <span className="w-12" />
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-3">
                    <ReferralCard />
                </div>
            </div>
        );
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
        <div className="flex flex-col gap-4" data-testid="people-filter-panel">
            <TribeRow
                followingCount={followingCount}
                sessionFollows={sessionFollows.size}
                onOpen={() => setView('find')}
            />

            <section className="flex flex-col gap-2">
                <h4 className="px-0.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">Who</h4>
                <RadioRow
                    label="Anyone"
                    subtitle="No people filter"
                    selected={whoSelected === null}
                    onClick={() => onChange({ source: null, userHandles: [] })}
                    testId="who-anyone"
                />
                <RadioRow
                    label="Following"
                    subtitle="Everyone you follow"
                    selected={whoSelected === 'following'}
                    onClick={() => onChange({ source: 'follows', userHandles: [] })}
                    testId="who-following"
                />
                <RadioRow
                    label="Friends"
                    subtitle="Friends only"
                    selected={whoSelected === 'friends'}
                    onClick={() => onChange({ source: 'friends', userHandles: [] })}
                    testId="who-friends"
                />
                {whoSelected === 'friends' && friendCount === 0 && (
                    <p className="px-0.5 text-[11px] text-ink-soft" data-testid="people-zero-friends-hint">
                        You have no friends yet — friends are people who follow you back.{' '}
                        <button
                            type="button"
                            onClick={() => setView('find')}
                            className="text-action underline hover:opacity-80"
                        >
                            Find people to follow →
                        </button>
                    </p>
                )}
                <RadioRow
                    label="Specific people"
                    subtitle={specificSubtitle}
                    selected={whoSelected === 'specific'}
                    onClick={openPicker}
                    testId="who-specific"
                />
            </section>

            {whoSelected !== null && (
                <section className="flex flex-col gap-2">
                    <h4 className="px-0.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">Status</h4>
                    <CheckRow
                        label="Going"
                        subtitle="They're attending"
                        checked={goingOn}
                        onClick={() => toggleStatus('going')}
                        testId="status-going"
                    />
                    <CheckRow
                        label="Interested"
                        subtitle="They saved / show interest"
                        checked={savedOn}
                        onClick={() => toggleStatus('saved')}
                        testId="status-interested"
                    />
                </section>
            )}
        </div>
    );
}
