import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchTagSynonyms, createTagSynonym, deleteTagSynonym } from '../api';
import type { TagSynonymResponse } from '../api';

interface Props {
    tagId: number;
    tagLabel: string;
    onClose: () => void;
}

/**
 * Compact popover that lists existing synonym terms for a tag (as removable
 * chips) and lets the admin add a new one inline. The heuristic tag suggester
 * reads from this configuration on every taxonomy reload.
 */
export default function TagSynonymsEditor({ tagId, tagLabel, onClose }: Props) {
    const [synonyms, setSynonyms] = useState<TagSynonymResponse[]>([]);
    const [loading, setLoading] = useState(true);
    const [newTerm, setNewTerm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    // Anchor is a zero-size placeholder rendered at the caller's position;
    // the popover itself is portaled to <body> so ancestor `overflow:auto`
    // containers (e.g. the Tag Categories scroll panel) cannot clip it.
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
        fetchTagSynonyms(tagId)
            .then(setSynonyms)
            .catch(() => setError('Failed to load synonyms'))
            .finally(() => setLoading(false));
    }, [tagId]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Position the portaled popover under the anchor on mount and on resize.
    useLayoutEffect(() => {
        const updatePosition = () => {
            const el = anchorRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const popoverWidth = 288; // w-72
            // Right-align with viewport edge if it would overflow right.
            const left = Math.min(
                rect.left,
                window.innerWidth - popoverWidth - 8,
            );
            setCoords({ top: rect.bottom + 4, left: Math.max(8, left) });
        };
        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, []);

    const handleAdd = async () => {
        const term = newTerm.trim().toLowerCase();
        if (!term) return;
        setSaving(true);
        setError(null);
        try {
            const created = await createTagSynonym(tagId, term);
            setSynonyms((prev) => [...prev, created].sort((a, b) => a.term.localeCompare(b.term)));
            setNewTerm('');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to add');
        } finally {
            setSaving(false);
        }
    };

    const handleRemove = async (id: number) => {
        const previous = synonyms;
        setSynonyms((prev) => prev.filter((s) => s.id !== id));
        try {
            await deleteTagSynonym(id);
        } catch {
            setSynonyms(previous);
            setError('Failed to remove');
        }
    };

    return (
        <>
            {/* Zero-size anchor at the chip's location used to position the
                portaled popover. */}
            <span ref={anchorRef} className="absolute left-0 bottom-0 w-0 h-0" aria-hidden="true" />
            {coords && createPortal(
                <div
                    ref={popoverRef}
                    style={{ top: coords.top, left: coords.left }}
                    className="fixed z-[200] w-72 bg-white border border-slate-200 rounded shadow-lg p-3"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            Synonyms · {tagLabel}
                        </p>
                        <button
                            onClick={onClose}
                            className="text-slate-400 hover:text-slate-600 text-xs"
                            aria-label="Close synonyms editor"
                        >
                            ✕
                        </button>
                    </div>
                    <p className="text-[10px] text-slate-400 mb-2 leading-snug">
                        Terms the auto-suggester matches against event title, description and location.
                    </p>
                    {loading ? (
                        <p className="text-[11px] text-slate-400">Loading…</p>
                    ) : (
                        <div className="flex flex-wrap gap-1 mb-2 min-h-[24px]">
                            {synonyms.length === 0 ? (
                                <span className="text-[10px] text-slate-400 italic">No synonyms</span>
                            ) : (
                                synonyms.map((s) => (
                                    <span
                                        key={s.id}
                                        className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 text-[10px] px-2 py-0.5"
                                    >
                                        {s.term}
                                        <button
                                            onClick={() => handleRemove(s.id)}
                                            className="text-slate-400 hover:text-slate-600"
                                            aria-label={`Remove ${s.term}`}
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))
                            )}
                        </div>
                    )}
                    <div className="flex items-center gap-1">
                        <input
                            type="text"
                            value={newTerm}
                            onChange={(e) => setNewTerm(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleAdd();
                            }}
                            placeholder="Add term…"
                            className="flex-1 border border-slate-300 rounded px-2 py-1 text-[11px] text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                        <button
                            onClick={handleAdd}
                            disabled={!newTerm.trim() || saving}
                            className="bg-sky-600 text-white text-[11px] px-2 py-1 rounded hover:bg-sky-700 disabled:opacity-40"
                        >
                            Add
                        </button>
                    </div>
                    {error && <p className="mt-1 text-[10px] text-slate-600">{error}</p>}
                </div>,
                document.body,
            )}
        </>
    );
}
