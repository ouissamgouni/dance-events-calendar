import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import useBackToClose from '../hooks/useBackToClose';
import type { EventAssetVisibility, EventUserAsset } from '../types';
import { VISIBILITY_ICONS, VISIBILITY_LABELS } from '../utils/eventAssets';
import { reportMailto } from '../utils/report';

interface Props {
    assets: EventUserAsset[];
    initialIndex: number;
    onClose: () => void;
    onDelete: (asset: EventUserAsset) => void;
    onUpdate: (asset: EventUserAsset, update: { visibility?: EventAssetVisibility; caption?: string }) => Promise<void>;
}

const VISIBILITIES: EventAssetVisibility[] = ['private', 'friends', 'attendees'];

export default function EventAssetViewer({ assets, initialIndex, onClose, onDelete, onUpdate }: Props) {
    const [index, setIndex] = useState(initialIndex);
    const [saving, setSaving] = useState(false);
    useBackToClose(onClose, true);

    const asset = assets[Math.min(index, assets.length - 1)];

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, assets.length - 1));
            if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [assets.length, onClose]);

    if (!asset) return null;
    const isMemory = asset.kind === 'memory';

    const save = async (update: { visibility?: EventAssetVisibility; caption?: string }) => {
        setSaving(true);
        try {
            await onUpdate(asset, update);
        } finally {
            setSaving(false);
        }
    };

    return createPortal(
        <div role="dialog" aria-modal="true" aria-label={isMemory ? 'Memory' : 'Ticket'} className="fixed inset-0 z-[10700] flex flex-col bg-black text-white">
            <div className="flex shrink-0 items-center justify-between px-2 py-2">
                <span className="px-2 text-sm">{assets.length > 1 ? `${index + 1} / ${assets.length}` : ''}</span>
                <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center">
                    <X className="h-6 w-6" aria-hidden="true" />
                </button>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
                {asset.full_url ? (
                    <img src={asset.full_url} alt={asset.caption ?? (isMemory ? 'Memory' : 'Ticket')} className="max-h-full max-w-full object-contain" />
                ) : (
                    <a href={asset.file_url ?? asset.url ?? '#'} target="_blank" rel="noopener noreferrer" className="bg-action px-4 py-2 text-sm font-medium text-white hover:opacity-90">
                        Open {asset.kind === 'ticket_link' ? 'ticket link' : 'PDF'}
                    </a>
                )}
                {index > 0 && (
                    <button type="button" onClick={() => setIndex(index - 1)} aria-label="Previous" className="absolute left-1 flex h-11 w-11 items-center justify-center bg-black/40 text-2xl">‹</button>
                )}
                {index < assets.length - 1 && (
                    <button type="button" onClick={() => setIndex(index + 1)} aria-label="Next" className="absolute right-1 flex h-11 w-11 items-center justify-center bg-black/40 text-2xl">›</button>
                )}
            </div>
            <div className="shrink-0 space-y-3 px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] text-sm">
                {!asset.is_owner && asset.owner_display_name && (
                    <p className="text-white/80">Shared by {asset.owner_display_name}</p>
                )}
                {!asset.is_owner && isMemory && (
                    <a href={reportMailto('photo', window.location.href, `memory ${asset.id}`)} className="inline-block text-xs text-white/70 hover:text-white">
                        Report this photo
                    </a>
                )}
                {isMemory && asset.is_owner ? (
                    <>
                        <label className="block">
                            <span className="sr-only">Caption</span>
                            <input
                                key={asset.id}
                                type="text"
                                defaultValue={asset.caption ?? ''}
                                maxLength={200}
                                placeholder="Add a caption"
                                onBlur={(e) => e.target.value !== (asset.caption ?? '') && save({ caption: e.target.value })}
                                className="w-full rounded-field border border-white/30 bg-transparent px-3 py-2 text-white placeholder:text-white/50"
                            />
                        </label>
                        <fieldset disabled={saving} className="flex flex-wrap gap-2">
                            <legend className="mb-1 text-white/70">Who can see</legend>
                            {VISIBILITIES.map((v) => (
                                <button
                                    key={v}
                                    type="button"
                                    aria-pressed={asset.visibility === v}
                                    onClick={() => asset.visibility !== v && save({ visibility: v })}
                                    className={`rounded-field border px-3 py-1.5 ${asset.visibility === v ? 'border-action bg-action text-white' : 'border-white/30 text-white/80'}`}
                                >
                                    {VISIBILITY_ICONS[v]} {VISIBILITY_LABELS[v]}
                                </button>
                            ))}
                        </fieldset>
                    </>
                ) : asset.caption ? (
                    <p>{asset.caption}</p>
                ) : null}
                {asset.is_owner && (
                    <div className="flex justify-end border-t border-white/15 pt-2">
                        <button
                            type="button"
                            onClick={() => onDelete(asset)}
                            className="flex min-h-11 items-center gap-2 px-3 text-white/90 hover:text-white"
                        >
                            <Trash2 className="h-5 w-5" aria-hidden="true" />
                            Delete
                        </button>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}
