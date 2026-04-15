import { useState } from 'react';
import type { GeocodeSuggestion } from '../api';
import { submitSuggestion, searchSuggestionAddress } from '../api';
import AddressAutocomplete from './AddressAutocomplete';

interface Props {
    onClose: () => void;
}

interface LinkRow {
    url: string;
    label: string;
}

export default function SuggestEventModal({ onClose }: Props) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [latitude, setLatitude] = useState<number | null>(null);
    const [longitude, setLongitude] = useState<number | null>(null);
    const [links, setLinks] = useState<LinkRow[]>([{ url: '', label: '' }]);
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [submitterName, setSubmitterName] = useState('');
    const [submitterEmail, setSubmitterEmail] = useState('');
    const [website, setWebsite] = useState(''); // honeypot
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

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
        // Validation
        if (!title.trim()) {
            setError('Title is required');
            return;
        }
        if (!start) {
            setError('Start date is required');
            return;
        }
        if (!end) {
            setError('End date is required');
            return;
        }
        if (new Date(end) < new Date(start)) {
            setError('End must be after start');
            return;
        }

        // Validate link URLs
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
                <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="text-4xl mb-3">🎉</div>
                    <h2 className="text-lg font-bold text-slate-900 mb-2">Thank you!</h2>
                    <p className="text-sm text-slate-600 mb-4">Your suggestion is under review. We'll take a look soon.</p>
                    <button onClick={onClose} className="rounded-full bg-rose-600 px-5 py-2 text-sm font-medium text-white hover:bg-rose-700 transition">
                        Close
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-100 px-6 pt-5 pb-4">
                    <h2 className="text-lg font-bold text-slate-900">Suggest an Event</h2>
                    <button onClick={onClose} className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition" aria-label="Close">✕</button>
                </div>

                {/* Form */}
                <div className="overflow-y-auto overscroll-contain px-6 py-4 space-y-3 text-sm">
                    {/* Honeypot — hidden from humans */}
                    <div style={{ display: 'none' }} aria-hidden="true">
                        <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" />
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Title *</label>
                        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event name" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Description</label>
                        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Tell us about the event…" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Location</label>
                        <AddressAutocomplete
                            value={location}
                            onChange={setLocation}
                            onSelect={handleAddressSelect}
                            searchFn={searchSuggestionAddress}
                        />
                    </div>

                    {/* Links */}
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Links</label>
                        {links.map((link, i) => (
                            <div key={i} className="flex gap-2 mb-1.5">
                                <input type="url" value={link.url} onChange={(e) => handleLinkChange(i, 'url', e.target.value)} placeholder="https://…" className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                                <input type="text" value={link.label} onChange={(e) => handleLinkChange(i, 'label', e.target.value)} placeholder="Label (e.g. Tickets)" className="w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm placeholder:text-slate-400 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                                {links.length > 1 && (
                                    <button type="button" onClick={() => handleRemoveLink(i)} className="text-slate-400 hover:text-red-500 text-sm px-1">✕</button>
                                )}
                            </div>
                        ))}
                        {links.length < 3 && (
                            <button type="button" onClick={handleAddLink} className="text-xs text-rose-600 hover:text-rose-700">+ Add link</button>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">Start *</label>
                            <input type={allDay ? 'date' : 'datetime-local'} value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">End *</label>
                            <input type={allDay ? 'date' : 'datetime-local'} value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                        </div>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="rounded border-slate-300" />
                        All day event
                    </label>

                    <div className="border-t border-slate-200 pt-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Your info (optional)</p>
                        <div className="grid grid-cols-2 gap-3">
                            <input type="text" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} placeholder="Your name" className="rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                            <input type="email" value={submitterEmail} onChange={(e) => setSubmitterEmail(e.target.value)} placeholder="Your email" className="rounded-md border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500" />
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-slate-100 px-6 py-3 flex items-center justify-between">
                    {error && <p className="text-xs text-red-600">{error}</p>}
                    {!error && <div />}
                    <div className="flex gap-2">
                        <button onClick={onClose} className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition">Cancel</button>
                        <button onClick={handleSubmit} disabled={submitting} className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50 transition">
                            {submitting ? 'Submitting…' : 'Submit'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
