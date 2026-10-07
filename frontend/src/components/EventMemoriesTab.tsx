import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useOptionalAttendingEvents } from '../context/AttendingEventsContext';
import useEventAssets from '../hooks/useEventAssets';
import useBackToClose from '../hooks/useBackToClose';
import type { CalendarEvent, EventAssetVisibility, EventUserAsset } from '../types';
import {
    MEMORY_ACCEPT,
    MEMORY_VISIBILITIES,
    VISIBILITY_HINTS,
    VISIBILITY_ICONS,
    VISIBILITY_LABELS,
    formatAssetDate,
    groupMemoriesByOwner,
    rememberMemoryVisibility,
    rememberedMemoryVisibility,
    revealsAttendance,
} from '../utils/eventAssets';
import type { MemoryTrail } from '../utils/eventAssets';
import { ConfirmDialog } from './AppDialog';
import EventAssetViewer from './EventAssetViewer';

const TILE = 'relative flex h-24 w-24 shrink-0 snap-start items-center justify-center overflow-hidden rounded-field border border-card-line bg-canvas';
const TRAIL_TILES = 10;
const MAX_TRAILS = 5;

type Filter = 'all' | 'friends' | 'mine';

export default function EventMemoriesTab({ event }: { event: CalendarEvent }) {
    const { user } = useAuth();
    const attending = useOptionalAttendingEvents();
    const { data, error, busy, load, upload, remove, update } = useEventAssets(event.event_id, Boolean(user));
    const [viewer, setViewer] = useState<{ trail: string; index: number } | null>(null);
    const [pendingDelete, setPendingDelete] = useState<EventUserAsset | null>(null);
    const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
    const [filter, setFilter] = useState<Filter>('all');
    const [expanded, setExpanded] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const byHandle = new URLSearchParams(useLocation().search).get('by');

    const trails = useMemo(() => groupMemoriesByOwner(data?.assets ?? []), [data]);

    useEffect(() => {
        if (!byHandle || !trails.some((t) => t.handle === byHandle)) return;
        document.getElementById(`memories-by-${byHandle}`)?.scrollIntoView?.({ block: 'center' });
    }, [byHandle, trails]);

    if (!user || !data) return <p className="text-sm text-ink-soft">Loading…</p>;

    const hasFriends = trails.some((t) => t.isFriend);
    const ownTrail = trails.find((t) => t.isOwner);
    const filtered = trails.filter((t) => filter === 'all' || (filter === 'mine' ? t.isOwner : t.isFriend));
    const shownTrails = expanded
        ? filtered
        : filtered.filter((t, i) => i < MAX_TRAILS || (byHandle != null && t.handle === byHandle));
    const hiddenCount = filtered.length - shownTrails.length;
    const showOwnAddRow = data.can_add_memory && !ownTrail && filter !== 'friends';
    const viewerTrail = viewer ? trails.find((t) => t.key === viewer.trail) : undefined;

    const confirmDelete = async () => {
        if (!pendingDelete) return;
        const target = pendingDelete;
        setPendingDelete(null);
        setViewer(null);
        await remove(target);
    };

    const addTile = data.can_add_memory && (
        <li>
            <button
                type="button"
                disabled={busy}
                onClick={() => input.current?.click()}
                className={`${TILE} flex-col gap-1 border-dashed text-xs text-ink-soft disabled:cursor-not-allowed disabled:opacity-50`}
            >
                <span className="text-xl" aria-hidden>+</span>
                {busy ? 'Uploading…' : 'Add'}
            </button>
        </li>
    );

    return (
        <section id="memories" aria-labelledby="memories-title">
            <div className="flex items-baseline justify-between">
                <h2 id="memories-title" className="text-lg font-semibold text-ink">📸 Memories</h2>
                {data.is_going && (
                    <span className="text-xs text-ink-soft tabular-nums">{data.memory_count} / {data.max_memories}</span>
                )}
            </div>

            {trails.length > 1 && (
                <div className="mt-3 flex gap-2" role="group" aria-label="Filter memories">
                    {(['all', ...(hasFriends ? ['friends'] : []), ...(ownTrail ? ['mine'] : [])] as Filter[]).map((value) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={filter === value}
                            onClick={() => setFilter(value)}
                            className={`rounded-field border px-3 py-1 text-xs font-medium ${filter === value ? 'border-action bg-action text-white' : 'border-line bg-surface text-ink hover:bg-canvas'}`}
                        >
                            {value === 'all' ? 'All' : value === 'friends' ? 'Friends' : 'Mine'}
                        </button>
                    ))}
                </div>
            )}

            {trails.length === 0 && !data.can_add_memory ? (
                <p className="mt-3 text-sm text-ink-soft">No memories shared yet.</p>
            ) : (
                <div className="mt-3 space-y-5">
                    {showOwnAddRow && (
                        <TrailRow trail={{ key: 'me', isOwner: true, isFriend: false, handle: null, name: 'You', avatarUrl: null, assets: [] }} highlighted={false} onOpen={() => { }}>
                            {addTile}
                        </TrailRow>
                    )}
                    {shownTrails.map((trail) => (
                        <TrailRow
                            key={trail.key}
                            trail={trail}
                            highlighted={byHandle != null && trail.handle === byHandle}
                            onOpen={(index) => setViewer({ trail: trail.key, index })}
                        >
                            {trail.isOwner ? addTile : null}
                        </TrailRow>
                    ))}
                    {hiddenCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setExpanded(true)}
                            className="w-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-canvas"
                        >
                            Show {hiddenCount} more {hiddenCount === 1 ? 'dancer' : 'dancers'}
                        </button>
                    )}
                </div>
            )}

            {data.is_going && (
                <p className="mt-3 text-xs text-ink-soft">
                    {data.can_add_memory
                        ? `Add memories until ${formatAssetDate(data.memory_window_closes_at)}.`
                        : data.memory_count >= data.max_memories
                            ? `Limit reached (${data.max_memories}).`
                            : 'Upload window closed.'}
                </p>
            )}
            {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}

            <input
                ref={input}
                type="file"
                accept={MEMORY_ACCEPT}
                multiple
                hidden
                data-testid="memory-file-input"
                onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length) setPendingFiles(files);
                }}
            />

            {pendingFiles && (
                <MemoryAudienceDialog
                    count={pendingFiles.length}
                    rsvpAudience={attending?.getAudience(event.event_id)}
                    onCancel={() => setPendingFiles(null)}
                    onConfirm={(visibility) => {
                        const files = pendingFiles;
                        setPendingFiles(null);
                        rememberMemoryVisibility(visibility);
                        void upload(files, 'memory', visibility);
                    }}
                />
            )}

            <ConfirmDialog
                open={pendingDelete !== null}
                title="Delete memory?"
                message="This can't be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={confirmDelete}
                onCancel={() => setPendingDelete(null)}
            />

            {viewer && viewerTrail && (
                <EventAssetViewer
                    assets={viewerTrail.assets}
                    initialIndex={viewer.index}
                    onClose={() => { setViewer(null); load(); }}
                    onDelete={setPendingDelete}
                    onUpdate={async (asset, change) => { await update(asset, change); }}
                />
            )}
        </section>
    );
}

function TrailRow({ trail, highlighted, onOpen, children }: {
    trail: MemoryTrail;
    highlighted: boolean;
    onOpen: (index: number) => void;
    children?: ReactNode;
}) {
    const list = useRef<HTMLUListElement>(null);
    const tiles = trail.assets.slice(0, TRAIL_TILES);
    const more = trail.assets.length - tiles.length;
    const scroll = (direction: 1 | -1) => list.current?.scrollBy?.({ left: direction * 240, behavior: 'smooth' });
    const headingId = `memories-trail-${trail.key.replace(/[^a-z0-9_-]/gi, '')}`;
    const initial = trail.name.trim().slice(0, 1).toUpperCase() || '?';

    return (
        <div
            id={trail.handle ? `memories-by-${trail.handle}` : undefined}
            data-testid="memory-trail"
            className={highlighted ? 'bg-blue-50 p-2 ring-2 ring-action' : undefined}
        >
            <div className="mb-2 flex items-center gap-2">
                {trail.avatarUrl ? (
                    // eslint-disable-next-line no-restricted-syntax -- avatars are circular
                    <img src={trail.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                    // eslint-disable-next-line no-restricted-syntax -- avatars are circular
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-ink-soft" aria-hidden>
                        {initial}
                    </span>
                )}
                <h3 id={headingId} className="min-w-0 truncate text-sm font-semibold text-ink">
                    {trail.handle ? (
                        <Link to={`/u/${encodeURIComponent(trail.handle)}`} className="hover:text-action hover:underline">{trail.name}</Link>
                    ) : trail.name}
                    {trail.assets.length > 0 && (
                        <span className="ml-1 font-normal text-ink-soft tabular-nums">· {trail.assets.length}</span>
                    )}
                </h3>
                {trail.isFriend && <span className="text-xs text-ink-soft">Friend</span>}
                {trail.assets.length > 3 && (
                    <div className="ml-auto hidden gap-1 sm:flex">
                        <button type="button" onClick={() => scroll(-1)} aria-label={`Scroll ${trail.name}'s memories left`} className="flex h-8 w-8 items-center justify-center border border-line bg-surface text-ink hover:bg-canvas">‹</button>
                        <button type="button" onClick={() => scroll(1)} aria-label={`Scroll ${trail.name}'s memories right`} className="flex h-8 w-8 items-center justify-center border border-line bg-surface text-ink hover:bg-canvas">›</button>
                    </div>
                )}
            </div>
            <ul
                ref={list}
                aria-labelledby={headingId}
                className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]"
            >
                {tiles.map((asset, index) => (
                    <li key={asset.id}>
                        <button
                            type="button"
                            onClick={() => onOpen(index)}
                            className={TILE}
                            aria-label={asset.caption ?? `${trail.name} memory ${index + 1}`}
                        >
                            {asset.thumb_url && <img src={asset.thumb_url} alt="" className="h-full w-full object-cover" />}
                            {asset.is_owner && (
                                <span className="absolute right-1 bottom-1 bg-surface/90 px-1 text-xs" aria-label={VISIBILITY_LABELS[asset.visibility]}>
                                    {VISIBILITY_ICONS[asset.visibility]}
                                </span>
                            )}
                        </button>
                    </li>
                ))}
                {more > 0 && (
                    <li>
                        <button
                            type="button"
                            onClick={() => onOpen(TRAIL_TILES)}
                            className={`${TILE} flex-col text-xs font-medium text-action`}
                        >
                            See all {trail.assets.length}
                        </button>
                    </li>
                )}
                {children}
            </ul>
        </div>
    );
}

function MemoryAudienceDialog({ count, rsvpAudience, onCancel, onConfirm }: {
    count: number;
    rsvpAudience: string | undefined;
    onCancel: () => void;
    onConfirm: (visibility: EventAssetVisibility) => void;
}) {
    const [choice, setChoice] = useState<EventAssetVisibility>(rememberedMemoryVisibility);
    useBackToClose(onCancel, true);

    return createPortal(
        <div className="fixed inset-0 z-[11000] flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onCancel}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="memory-audience-title"
                className="w-full max-w-sm rounded-card bg-surface p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <h2 id="memory-audience-title" className="text-base font-semibold text-ink">
                    Who can see {count === 1 ? 'this photo' : `these ${count} photos`}?
                </h2>
                <fieldset className="mt-3 space-y-2">
                    <legend className="sr-only">Who can see</legend>
                    {MEMORY_VISIBILITIES.map((value) => (
                        <label key={value} className={`flex cursor-pointer gap-3 rounded-field border p-3 ${choice === value ? 'border-action bg-blue-50' : 'border-line'}`}>
                            <input
                                type="radio"
                                name="memory-visibility"
                                value={value}
                                checked={choice === value}
                                onChange={() => setChoice(value)}
                                className="mt-1"
                            />
                            <span>
                                <span className="block text-sm font-medium text-ink">{VISIBILITY_ICONS[value]} {VISIBILITY_LABELS[value]}</span>
                                <span className="block text-xs text-ink-soft">{VISIBILITY_HINTS[value]}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                {revealsAttendance(choice, rsvpAudience) && (
                    <p role="note" className="mt-3 border border-blue-100 bg-blue-50 p-2 text-xs text-ink">
                        Attendees outside your friends will see your name on these photos, so they'll know you went.
                    </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={onCancel} className="border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-canvas">
                        Cancel
                    </button>
                    <button type="button" onClick={() => onConfirm(choice)} className="bg-action px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                        Upload
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
