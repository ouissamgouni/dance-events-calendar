import { useEffect, useState } from 'react';
import {
    fetchEventPromoCodes,
    deleteEventPromoCode,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { isPromoSectionVisible } from '../utils/sectionVisibility';
import type { CalendarEvent, PromoCode } from '../types';
import EventPromoCodeDialog from './EventPromoCodeDialog';

interface Props {
    event: CalendarEvent;
    /**
     * 'compact' (default) keeps the legacy collapsible chip list. 'rows'
     * renders an always-expanded list where each promo is a full row with an
     * inline Copy button — used inside the Details tab's "Price & promo codes"
     * section, which supplies its own heading.
     */
    variant?: 'compact' | 'rows';
    refreshToken?: number;
}

function formatExpiry(iso: string | null): string {
    if (!iso) return 'No expiry';
    try {
        return `Expires ${new Date(iso).toLocaleDateString()}`;
    } catch {
        return 'Expires —';
    }
}

export function EventPromoCodes({ event, variant = 'compact', refreshToken = 0 }: Props) {
    const eventId = event.event_id;
    const { promoCodesEnabled } = useFeatureFlags();
    const visible = isPromoSectionVisible(event, promoCodesEnabled);
    const { user } = useAuth();
    const [codes, setCodes] = useState<PromoCode[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [collapsed, setCollapsed] = useState(true);
    const [openPromoId, setOpenPromoId] = useState<string | null>(null);
    const [showAddDialog, setShowAddDialog] = useState(false);
    const [editingPromo, setEditingPromo] = useState<PromoCode | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [toastMsg, setToastMsg] = useState<string | null>(null);

    useEffect(() => {
        if (!visible) return;
        let alive = true;
        fetchEventPromoCodes(eventId)
            .then((rows) => {
                if (!alive) return;
                setCodes(rows);
                setLoaded(true);
            })
            .catch(() => {
                if (alive) setLoaded(true);
            });
        return () => {
            alive = false;
        };
    }, [eventId, visible, refreshToken]);

    if (!visible) return null;

    const isAuthed = !!user;

    const openEdit = (promo: PromoCode) => {
        setEditingPromo(promo);
        setOpenPromoId(null);
    };

    const remove = async (promo: PromoCode) => {
        if (!user) return;
        setSubmitting(true);
        try {
            await deleteEventPromoCode(eventId, promo.id);
            setCodes((prev) => prev.filter((p) => p.id !== promo.id));
            setOpenPromoId(null);
            setToastMsg('Promo code deleted.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Failed to delete promo code';
            setToastMsg(msg);
        } finally {
            setSubmitting(false);
        }
    };

    const copy = async (code: string) => {
        try {
            await navigator.clipboard.writeText(code);
            setToastMsg(`Copied "${code}" to clipboard`);
        } catch {
            setToastMsg('Copy failed — select and copy manually');
        }
    };

    if (!loaded) return null;
    // Anonymous + empty → hide entirely (per spec).
    if (!isAuthed && codes.length === 0) return null;

    const openPromo = openPromoId ? codes.find((p) => p.id === openPromoId) ?? null : null;
    const isOwnPromo = openPromo && user?.user_id === openPromo.submitter.user_id;

    const toast = toastMsg ? (
        <div
            role="status"
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-canvas border border-line text-ink text-xs px-4 py-2 shadow-lg cursor-pointer rounded-md"
            onClick={() => setToastMsg(null)}
        >
            {toastMsg}
        </div>
    ) : null;

    const promoDialog = showAddDialog || editingPromo ? (
        <EventPromoCodeDialog
            eventId={eventId}
            promo={editingPromo ?? undefined}
            onClose={() => {
                setShowAddDialog(false);
                setEditingPromo(null);
            }}
            onSubmitted={(saved) => {
                setCodes((current) => [saved, ...current.filter((promo) => promo.id !== saved.id)]);
            }}
        />
    ) : null;

    if (variant === 'rows') {
        return (
            <section
                className="space-y-3 rounded-card border border-card-line bg-surface p-4 text-sm"
                data-testid="promo-codes-section"
            >
                <div className="flex min-h-10 items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-ink">Promo codes</h3>
                    {isAuthed && (
                        <button
                            type="button"
                            onClick={() => setShowAddDialog(true)}
                            aria-label="Add promo code"
                            className="shrink-0 text-xs font-medium text-action hover:underline"
                        >
                            + Add promo code
                        </button>
                    )}
                </div>

                {codes.length > 0 && (
                    <div className="divide-y divide-card-line">
                        {codes.map((promo) => {
                            const own = user?.user_id === promo.submitter.user_id;
                            return (
                                <div
                                    key={promo.id}
                                    className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="break-all font-mono text-sm font-semibold text-ink">
                                                {promo.code}
                                            </span>
                                            {promo.status === 'pending' && (
                                                <span className="bg-amber-50 px-1 py-0 text-[9px] uppercase text-amber-700">
                                                    pending
                                                </span>
                                            )}
                                        </div>
                                        {promo.description && (
                                            <div className="mt-0.5 truncate text-xs text-ink-soft">
                                                {promo.description}
                                            </div>
                                        )}
                                        <div className="mt-0.5 text-[11px] text-muted">
                                            {formatExpiry(promo.expires_at)}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {own && (
                                            <button
                                                type="button"
                                                onClick={() => openEdit(promo)}
                                                className="text-xs text-ink-soft hover:text-ink"
                                            >
                                                Edit
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => copy(promo.code)}
                                            aria-label={`Copy promo code ${promo.code}`}
                                            className="rounded-field bg-blue-50 px-3 py-1 text-xs font-medium text-action hover:bg-blue-100"
                                        >
                                            Copy
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {promoDialog}
                {toast}
            </section>
        );
    }

    return (
        <section className="border-t border-card-line pt-3 text-xs" data-testid="promo-codes-section">
            <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
                className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-soft hover:text-ink"
            >
                <span
                    aria-hidden="true"
                    className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`}
                >
                    ▸
                </span>
                <img
                    src="/promo-code.png"
                    alt=""
                    aria-hidden="true"
                    className="w-4 h-4 object-contain"
                />
                Promo codes
                <span className="ml-1 text-muted font-normal normal-case tracking-normal">({codes.length})</span>
            </button>

            {!collapsed && (
                <div className="mt-2 flex flex-col gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {codes.map((promo) => (
                            <button
                                key={promo.id}
                                type="button"
                                onClick={() => setOpenPromoId(promo.id)}
                                title={promo.description ?? promo.code}
                                className="inline-flex items-center gap-1 border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-ink hover:border-blue-400 hover:bg-blue-50"
                            >
                                {promo.code}
                                {promo.status === 'pending' && (
                                    <span className="text-[9px] uppercase tracking-wide text-amber-700 bg-amber-50 px-1 py-0">
                                        pending
                                    </span>
                                )}
                            </button>
                        ))}
                        {isAuthed && (
                            <button
                                type="button"
                                onClick={() => setShowAddDialog(true)}
                                className="border border-dashed border-line px-2 py-0.5 text-[11px] text-ink-soft hover:text-action hover:border-blue-400"
                            >
                                + Add a promo code
                            </button>
                        )}
                    </div>

                </div>
            )}

            {openPromo && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Promo code ${openPromo.code}`}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    onClick={() => setOpenPromoId(null)}
                >
                    <div
                        className="bg-surface border border-line shadow-xl w-full max-w-sm p-4 text-[12px] text-ink"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-3 mb-2">
                            <div className="font-mono text-sm font-semibold text-ink break-all">
                                {openPromo.code}
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpenPromoId(null)}
                                aria-label="Close"
                                className="text-muted hover:text-ink text-sm leading-none"
                            >
                                ✕
                            </button>
                        </div>
                        {openPromo.description && (
                            <div className="mb-2">{openPromo.description}</div>
                        )}
                        <div className="text-[11px] text-ink-soft">
                            {formatExpiry(openPromo.expires_at)}
                        </div>
                        <div className="text-[11px] text-ink-soft">
                            Submitted by{' '}
                            {openPromo.submitter.handle
                                ? `@${openPromo.submitter.handle}`
                                : openPromo.submitter.display_name ?? 'unknown'}{' '}
                            · {new Date(openPromo.created_at).toLocaleDateString()}
                        </div>
                        {openPromo.source_url && (
                            <a
                                href={openPromo.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-block text-action hover:underline break-all"
                            >
                                Where to use →
                            </a>
                        )}
                        <div className="flex flex-wrap gap-2 mt-4">
                            <button
                                type="button"
                                onClick={() => copy(openPromo.code)}
                                className="text-[11px] bg-action text-white px-3 py-1 hover:bg-action"
                            >
                                Copy code
                            </button>
                            {isOwnPromo && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => openEdit(openPromo)}
                                        className="text-[11px] border border-line bg-surface text-ink px-3 py-1 hover:bg-canvas"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        disabled={submitting}
                                        onClick={() => remove(openPromo)}
                                        className="text-[11px] bg-danger text-white px-3 py-1 hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Delete
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {promoDialog}

            {toastMsg && (
                <div
                    role="status"
                    className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-canvas border border-line text-ink text-xs px-4 py-2 shadow-lg cursor-pointer"
                    onClick={() => setToastMsg(null)}
                >
                    {toastMsg}
                </div>
            )}
        </section>
    );
}
