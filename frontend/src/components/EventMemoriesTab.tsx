import { useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import useEventAssets from '../hooks/useEventAssets';
import type { CalendarEvent, EventUserAsset } from '../types';
import { MEMORY_ACCEPT, VISIBILITY_ICONS, formatAssetDate } from '../utils/eventAssets';
import { ConfirmDialog } from './AppDialog';
import EventAssetViewer from './EventAssetViewer';

const TILE = 'relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-field border border-card-line bg-canvas';

export default function EventMemoriesTab({ event }: { event: CalendarEvent }) {
    const { user } = useAuth();
    const { data, error, busy, load, upload, remove, update } = useEventAssets(event.event_id, Boolean(user));
    const [viewerIndex, setViewerIndex] = useState<number | null>(null);
    const [pendingDelete, setPendingDelete] = useState<EventUserAsset | null>(null);
    const input = useRef<HTMLInputElement>(null);

    if (!user || !data) return <p className="text-sm text-ink-soft">Loading…</p>;

    const memories = data.assets.filter((a) => a.kind === 'memory');

    const confirmDelete = async () => {
        if (!pendingDelete) return;
        const target = pendingDelete;
        setPendingDelete(null);
        setViewerIndex(null);
        await remove(target);
    };

    return (
        <section id="memories" aria-labelledby="memories-title">
            <div className="flex items-baseline justify-between">
                <h2 id="memories-title" className="text-lg font-semibold text-ink">📸 Memories</h2>
                {data.is_going && (
                    <span className="text-xs text-ink-soft tabular-nums">{data.memory_count} / {data.max_memories}</span>
                )}
            </div>
            {memories.length === 0 && !data.can_add_memory ? (
                <p className="mt-3 text-sm text-ink-soft">No memories shared yet.</p>
            ) : (
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {memories.map((asset, index) => (
                        <button
                            key={asset.id}
                            type="button"
                            onClick={() => setViewerIndex(index)}
                            className={TILE}
                            aria-label={asset.caption ?? `Memory ${index + 1}`}
                        >
                            {asset.thumb_url && <img src={asset.thumb_url} alt="" className="h-full w-full object-cover" />}
                            <span className="absolute right-1 bottom-1 bg-surface/90 px-1 text-xs" aria-hidden>
                                {asset.is_owner ? VISIBILITY_ICONS[asset.visibility] : '👤'}
                            </span>
                        </button>
                    ))}
                    {data.can_add_memory && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => input.current?.click()}
                            className={`${TILE} flex-col gap-1 border-dashed text-xs text-ink-soft disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                            <span className="text-xl" aria-hidden>+</span>
                            {busy ? 'Uploading…' : 'Add'}
                        </button>
                    )}
                </div>
            )}
            {data.is_going && (
                <p className="mt-2 text-xs text-ink-soft">
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
                onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void upload(files, 'memory');
                }}
            />

            <ConfirmDialog
                open={pendingDelete !== null}
                title="Delete memory?"
                message="This can't be undone."
                confirmLabel="Delete"
                destructive
                onConfirm={confirmDelete}
                onCancel={() => setPendingDelete(null)}
            />

            {viewerIndex !== null && memories.length > 0 && (
                <EventAssetViewer
                    assets={memories}
                    initialIndex={viewerIndex}
                    onClose={() => { setViewerIndex(null); load(); }}
                    onDelete={setPendingDelete}
                    onUpdate={async (asset, change) => { await update(asset, change); }}
                />
            )}
        </section>
    );
}
