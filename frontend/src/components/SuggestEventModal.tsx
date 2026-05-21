import { useEffect, useState } from 'react';
import type { GeocodeSuggestion } from '../api';
import { submitSuggestion, searchSuggestionAddress, fetchTagGroups } from '../api';
import type { TagGroup } from '../types';
import AddressAutocomplete from './AddressAutocomplete';
import TagsPicker, { type TagsPickerValue } from './TagsPicker';
import { useAuth } from '../context/AuthContext';

interface Props {
    onClose: () => void;
}

interface LinkRow {
    url: string;
    label: string;
}

// Form text size: xs across the whole content area.
const inputCls =
    'border border-slate-300 px-2 py-1.5 text-xs placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
const inputClsFull = `w-full ${inputCls}`;
const btnPrimary =
    'bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition';
const btnSecondary =
    'px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition';

export default function SuggestEventModal({ onClose }: Props) {
    const { user } = useAuth();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [latitude, setLatitude] = useState<number | null>(null);
    const [longitude, setLongitude] = useState<number | null>(null);
    const [links, setLinks] = useState<LinkRow[]>([{ url: '', label: '' }]);
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [submitterName, setSubmitterName] = useState(user?.name ?? '');
    const [submitterEmail, setSubmitterEmail] = useState(user?.email ?? '');
    const [website, setWebsite] = useState(''); // honeypot
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    // Tags (optional, collapsible)
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const [tagsOpen, setTagsOpen] = useState(false);
    const [tagsValue, setTagsValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });

    // Price (optional)
    const [priceIsFree, setPriceIsFree] = useState(false);
    const [priceMin, setPriceMin] = useState<string>('');
    const [priceMax, setPriceMax] = useState<string>('');
    const [priceCurrency, setPriceCurrency] = useState<string>('EUR');

    // When the suggester is signed in, default to auto-saving the
    // approved event to their Calendar tab. Hidden for anon submissions.
    const [autoSave, setAutoSave] = useState<boolean>(true);

    useEffect(() => {
        if (user?.name && !submitterName) setSubmitterName(user.name);
        if (user?.email && !submitterEmail) setSubmitterEmail(user.email);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    useEffect(() => {
        fetchTagGroups({ scope: 'event' })
            .then((g) => setTagGroups(g))
            .catch(() => setTagGroups([]));
    }, []);

    const tagsCount =
        tagsValue.selectedTagIds.length +
        Object.values(tagsValue.freeTexts).filter((v) => v.trim()).length;

    const handleAddressSelect = (s: GeocodeSuggestion) => {
        setLatitude(s.latitude);
        setLongitude(s.longitude);
    };

    const handleLinkChange = (index: number, field: 'url' | 'label', value: string) => {
        setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
    };

    const handleAddLink = () => {
        if (links.length < 3) setLinks((prev) => [...prev, { url: '', label: '' }]);
    };

    const handleRemoveLink = (index: number) => {
        setLinks((prev) => prev.filter((_, i) => i !== index));
    };

    const handleSubmit = async () => {
        if (!title.trim()) { setError('Title is required'); return; }
        if (!start) { setError('Start date is required'); return; }
        if (!end) { setError('End date is required'); return; }
        if (new Date(end) < new Date(start)) { setError('End must be after start'); return; }

        const validLinks = links
            .filter((l) => l.url.trim())
            .map((l) => {
                try {
                    new URL(l.url.trim());
                    return { url: l.url.trim(), label: l.label.trim() || null };
                } catch {
                    return null;
                }
            });
        if (validLinks.some((l) => l === null)) {
            setError('Please enter valid URLs for links');
            return;
        }

        let pMin: number | null = null;
        let pMax: number | null = null;
        if (!priceIsFree) {
            if (priceMin.trim()) {
                const n = Number(priceMin);
                if (!Number.isFinite(n) || n < 0) { setError('Min price must be a positive number'); return; }
                pMin = n;
            }
            if (priceMax.trim()) {
                const n = Number(priceMax);
                if (!Number.isFinite(n) || n < 0) { setError('Max price must be a positive number'); return; }
                pMax = n;
            }
            if (pMin !== null && pMax !== null && pMax < pMin) {
                setError('Max price must be ≥ min price');
                return;
            }
        }

        const newTags = Object.entries(tagsValue.freeTexts)
            .map(([group_slug, free_text]) => ({ free_text: free_text.trim(), group_slug }))
            .filter((t) => t.free_text.length > 0);

        setSubmitting(true);
        setError('');
        try {
            await submitSuggestion({
                title: title.trim(),
                description: description.trim() || undefined,
                location: location.trim() || undefined,
                links: (validLinks.filter(Boolean) as { url: string; label: string | null }[]),
                latitude: latitude ?? undefined,
                longitude: longitude ?? undefined,
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString(),
                all_day: allDay,
                submitter_name: submitterName.trim() || undefined,
                submitter_email: submitterEmail.trim() || undefined,
                suggested_tag_ids: tagsValue.selectedTagIds,
                suggested_new_tags: newTags,
                price_is_free: priceIsFree,
                price_min: priceIsFree ? null : pMin,
                price_max: priceIsFree ? null : pMax,
                price_currency: priceIsFree || (pMin === null && pMax === null) ? null : priceCurrency,
                auto_save: autoSave,
                website,
                screen_size: `${screen.width}x${screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            setSuccess(true);
        } catch (err: any) {
            setError(err.message || 'Failed to submit suggestion');
        } finally {
            setSubmitting(false);
        }
    };

    if (success) {
        return (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
                <div className="w-full max-w-md bg-white p-8 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="text-4xl mb-3">🎉</div>
                    <h2 className="text-base font-bold text-slate-900 mb-2">Thank you!</h2>
                    <p className="text-xs text-slate-600 mb-4">Your suggestion is under review. We'll take a look soon.</p>
                    <button onClick={onClose} className={btnPrimary}>
                        Close
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="flex w-full max-w-lg flex-col bg-white shadow-2xl max-h-[90vh] text-xs" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-100 px-6 pt-5 pb-4">
                    <h2 className="text-sm font-bold text-slate-900">Suggest an Event</h2>
                    <button onClick={onClose} className="p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition" aria-label="Close">✕</button>
                </div>

                {/* Form */}
                <div className="overflow-y-auto overscroll-contain px-6 py-4 space-y-3 text-xs">
                    {/* Honeypot */}
                    <div style={{ display: 'none' }} aria-hidden="true">
                        <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" />
                    </div>

                    <div>
                        <label className="mb-1 block font-medium text-slate-600">Title *</label>
                        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event name" className={inputClsFull} />
                    </div>

                    <div>
                        <label className="mb-1 block font-medium text-slate-600">Description</label>
                        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Tell us about the event…" className={inputClsFull} />
                    </div>

                    <div>
                        <label className="mb-1 block font-medium text-slate-600">Location</label>
                        <AddressAutocomplete
                            value={location}
                            onChange={setLocation}
                            onSelect={handleAddressSelect}
                            searchFn={searchSuggestionAddress}
                        />
                    </div>

                    {/* Links — URL is the wide field, label narrower */}
                    <div>
                        <label className="mb-1 block font-medium text-slate-600">Links</label>
                        {links.map((link, i) => (
                            <div key={i} className="flex gap-2 mb-1.5 items-center">
                                <input
                                    type="url"
                                    value={link.url}
                                    onChange={(e) => handleLinkChange(i, 'url', e.target.value)}
                                    placeholder="https://…"
                                    className={`${inputCls} flex-1 min-w-0`}
                                />
                                <input
                                    type="text"
                                    value={link.label}
                                    onChange={(e) => handleLinkChange(i, 'label', e.target.value)}
                                    placeholder="Label"
                                    className={`${inputCls} w-24 shrink-0`}
                                />
                                {links.length > 1 ? (
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveLink(i)}
                                        className="text-slate-400 hover:text-slate-700 px-1 shrink-0"
                                        aria-label="Remove link"
                                    >
                                        ✕
                                    </button>
                                ) : (
                                    <span className="w-3 shrink-0" aria-hidden="true" />
                                )}
                            </div>
                        ))}
                        {links.length < 3 && (
                            <button type="button" onClick={handleAddLink} className="text-blue-600 hover:text-blue-700">+ Add link</button>
                        )}
                    </div>

                    {/* Date selectors — all-day checkbox to the right */}
                    <div className="flex gap-3 items-end">
                        <div className="flex-1">
                            <label className="mb-1 block font-medium text-slate-600">Start *</label>
                            <input type={allDay ? 'date' : 'datetime-local'} value={start} onChange={(e) => setStart(e.target.value)} className={inputClsFull} />
                        </div>
                        <div className="flex-1">
                            <label className="mb-1 block font-medium text-slate-600">End *</label>
                            <input type={allDay ? 'date' : 'datetime-local'} value={end} onChange={(e) => setEnd(e.target.value)} className={inputClsFull} />
                        </div>
                        <label className="flex items-center gap-1 text-slate-600 pb-2 shrink-0">
                            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="border-slate-300" />
                            All day
                        </label>
                    </div>

                    {/* Optional: Tags — collapsible */}
                    {tagGroups.length > 0 && (
                        <div className="border-t border-slate-200 pt-3">
                            <button
                                type="button"
                                onClick={() => setTagsOpen((v) => !v)}
                                className="flex items-center justify-between w-full text-left"
                                aria-expanded={tagsOpen}
                            >
                                <span className="font-semibold uppercase tracking-wide text-slate-400">
                                    Tags (optional){tagsCount > 0 && ` · ${tagsCount}`}
                                </span>
                                <span className="text-slate-400">{tagsOpen ? '▾' : '▸'}</span>
                            </button>
                            {tagsOpen && (
                                <div className="mt-2">
                                    <TagsPicker
                                        tagGroups={tagGroups}
                                        value={tagsValue}
                                        onChange={setTagsValue}
                                    />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Optional: Price range */}
                    <div className="border-t border-slate-200 pt-3">
                        <p className="mb-2 font-semibold uppercase tracking-wide text-slate-400">Price (optional)</p>
                        <label className="flex items-center gap-2 text-slate-600 mb-2">
                            <input type="checkbox" checked={priceIsFree} onChange={(e) => setPriceIsFree(e.target.checked)} className="border-slate-300" />
                            Free event
                        </label>
                        {!priceIsFree && (
                            <div className="grid grid-cols-3 gap-2">
                                <input type="number" min={0} step="0.01" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="Min" className={inputClsFull} />
                                <input type="number" min={0} step="0.01" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="Max" className={inputClsFull} />
                                <select value={priceCurrency} onChange={(e) => setPriceCurrency(e.target.value)} className={inputClsFull}>
                                    <option value="EUR">EUR</option>
                                    <option value="USD">USD</option>
                                    <option value="GBP">GBP</option>
                                    <option value="CHF">CHF</option>
                                </select>
                            </div>
                        )}
                    </div>

                    <div className="border-t border-slate-200 pt-3">
                        <p className="mb-2 font-semibold uppercase tracking-wide text-slate-400">
                            {user ? 'Your info' : 'Your info (optional)'}
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <input type="text" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} placeholder="Your name" className={inputClsFull} />
                            <input type="email" value={submitterEmail} onChange={(e) => setSubmitterEmail(e.target.value)} placeholder="Your email" className={inputClsFull} />
                        </div>
                        {user && (
                            <label className="mt-3 flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoSave}
                                    onChange={(e) => setAutoSave(e.target.checked)}
                                    className="mt-0.5"
                                />
                                <span>
                                    Add this event to my Calendar when it gets approved.
                                </span>
                            </label>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-slate-100 px-6 py-3 flex items-center justify-between">
                    {error ? <p className="text-xs text-slate-700 bg-slate-100 px-2 py-1">{error}</p> : <div />}
                    <div className="flex gap-2">
                        <button onClick={onClose} className={btnSecondary}>Cancel</button>
                        <button onClick={handleSubmit} disabled={submitting} className={btnPrimary}>
                            {submitting ? 'Submitting…' : 'Submit'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
