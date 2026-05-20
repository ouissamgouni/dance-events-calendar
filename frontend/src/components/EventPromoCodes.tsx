import { useEffect, useState } from 'react';
import {
    fetchEventPromoCodes,
    submitEventPromoCode,
    updateEventPromoCode,
    deleteEventPromoCode,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type { PromoCode } from '../types';

interface Props {
    eventId: string;
}

interface FormState {
    code: string;
    description: string;
    source_url: string;
    expires_at: string; // yyyy-mm-dd
}

const emptyForm: FormState = { code: '', description: '', source_url: '', expires_at: '' };

function formatExpiry(iso: string | null): string {
    if (!iso) return 'No expiry';
    try {
        return `Expires ${new Date(iso).toLocaleDateString()}`;
    } catch {
        return 'Expires —';
    }
}

export function EventPromoCodes({ eventId }: Props) {
    const { promoCodesEnabled } = useFeatureFlags();
    const { user } = useAuth();
    const [codes, setCodes] = useState<PromoCode[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [collapsed, setCollapsed] = useState(true);
    const [openPromoId, setOpenPromoId] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [toastMsg, setToastMsg] = useState<string | null>(null);

    useEffect(() => {
        if (!promoCodesEnabled) return;
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
    }, [eventId, promoCodesEnabled]);

    if (!promoCodesEnabled) return null;

    const isAuthed = !!user;

    const openEdit = (promo: PromoCode) => {
        setEditingId(promo.id);
        setForm({
            code: promo.code,
            description: promo.description ?? '',
            source_url: promo.source_url ?? '',
            expires_at: promo.expires_at ? promo.expires_at.slice(0, 10) : '',
        });
        setShowForm(true);
        setOpenPromoId(null);
        setFormError(null);
    };

    const resetForm = () => {
        setShowForm(false);
        setEditingId(null);
        setForm(emptyForm);
        setFormError(null);
    };

    const submit = async () => {
        if (!form.code.trim()) {
            setFormError('Code is required');
            return;
        }
        if (form.source_url && !/^https?:\/\//i.test(form.source_url)) {
            setFormError('Source URL must start with http:// or https://');
            return;
        }
        setSubmitting(true);
        setFormError(null);
        try {
            const body = {
                code: form.code.trim(),
                description: form.description.trim() || null,
                source_url: form.source_url.trim() || null,
                expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
            };
            const saved = editingId
                ? await updateEventPromoCode(eventId, editingId, body)
                : await submitEventPromoCode(eventId, body);
            setCodes((prev) => {
                const others = prev.filter((p) => p.id !== saved.id);
                return [saved, ...others];
            });
            setToastMsg(
                editingId
                    ? 'Promo code updated — pending re-review.'
                    : 'Promo code submitted — awaiting admin approval.',
            );
            resetForm();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Failed to save promo code';
            setFormError(msg);
        } finally {
            setSubmitting(false);
        }
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
            setFormError(msg);
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

    return (
        <section className="border-t border-slate-100 pt-3 text-xs" data-testid="promo-codes-section">
            <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
                className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
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
                <span className="ml-1 text-slate-400 font-normal normal-case tracking-normal">({codes.length})</span>
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
                                className="inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700 hover:border-blue-400 hover:bg-blue-50"
                            >
                                {promo.code}
                                {promo.status === 'pending' && (
                                    <span className="text-[9px] uppercase tracking-wide text-amber-700 bg-amber-50 px-1 py-0">
                                        pending
                                    </span>
                                )}
                            </button>
                        ))}
                        {isAuthed && !showForm && (
                            <button
                                type="button"
                                onClick={() => {
                                    setShowForm(true);
                                    setEditingId(null);
                                    setForm(emptyForm);
                                    setFormError(null);
                                }}
                                className="border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 hover:text-blue-600 hover:border-blue-400"
                            >
                                + Add a promo code
                            </button>
                        )}
                    </div>

                    {showForm && (
                        <div className="border border-slate-200 bg-white p-3 flex flex-col gap-2">
                            <div className="text-[11px] font-medium text-slate-700">
                                {editingId ? 'Edit promo code' : 'New promo code'}
                            </div>
                            <input
                                type="text"
                                placeholder="Code (e.g. SALSA20)"
                                aria-label="Promo code"
                                value={form.code}
                                maxLength={64}
                                onChange={(e) => setForm({ ...form, code: e.target.value })}
                                className="border border-slate-300 px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-blue-400"
                            />
                            <input
                                type="text"
                                placeholder="Short description (optional)"
                                aria-label="Description"
                                value={form.description}
                                maxLength={200}
                                onChange={(e) => setForm({ ...form, description: e.target.value })}
                                className="border border-slate-300 px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400"
                            />
                            <input
                                type="url"
                                placeholder="Source URL (https://…) — optional"
                                aria-label="Source URL"
                                value={form.source_url}
                                maxLength={500}
                                onChange={(e) => setForm({ ...form, source_url: e.target.value })}
                                className="border border-slate-300 px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400"
                            />
                            <label className="text-[10px] text-slate-500 flex items-center gap-2">
                                Expires
                                <input
                                    type="date"
                                    value={form.expires_at}
                                    onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
                                    className="border border-slate-300 px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400"
                                />
                            </label>
                            {formError && (
                                <div className="text-[10px] text-red-600">{formError}</div>
                            )}
                            <div className="flex gap-2 pt-1">
                                <button
                                    type="button"
                                    disabled={submitting}
                                    onClick={submit}
                                    className="text-[11px] bg-blue-500 text-white px-3 py-1 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Submit'}
                                </button>
                                <button
                                    type="button"
                                    onClick={resetForm}
                                    className="text-[11px] text-slate-500 hover:text-slate-700 px-2"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
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
                        className="bg-white border border-slate-200 shadow-xl w-full max-w-sm p-4 text-[12px] text-slate-700"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-3 mb-2">
                            <div className="font-mono text-sm font-semibold text-slate-900 break-all">
                                {openPromo.code}
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpenPromoId(null)}
                                aria-label="Close"
                                className="text-slate-400 hover:text-slate-700 text-sm leading-none"
                            >
                                ✕
                            </button>
                        </div>
                        {openPromo.description && (
                            <div className="mb-2">{openPromo.description}</div>
                        )}
                        <div className="text-[11px] text-slate-500">
                            {formatExpiry(openPromo.expires_at)}
                        </div>
                        <div className="text-[11px] text-slate-500">
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
                                className="mt-2 inline-block text-blue-600 hover:underline break-all"
                            >
                                Where to use →
                            </a>
                        )}
                        <div className="flex flex-wrap gap-2 mt-4">
                            <button
                                type="button"
                                onClick={() => copy(openPromo.code)}
                                className="text-[11px] bg-blue-500 text-white px-3 py-1 hover:bg-blue-600"
                            >
                                Copy code
                            </button>
                            {isOwnPromo && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => openEdit(openPromo)}
                                        className="text-[11px] border border-slate-200 bg-white text-slate-700 px-3 py-1 hover:bg-slate-50"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        disabled={submitting}
                                        onClick={() => remove(openPromo)}
                                        className="text-[11px] bg-red-600 text-white px-3 py-1 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Delete
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {toastMsg && (
                <div
                    role="status"
                    className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-50 border border-slate-200 text-slate-700 text-xs px-4 py-2 shadow-lg cursor-pointer"
                    onClick={() => setToastMsg(null)}
                >
                    {toastMsg}
                </div>
            )}
        </section>
    );
}
