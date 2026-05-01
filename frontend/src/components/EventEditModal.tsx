import { useState } from 'react';
import type { CalendarEvent } from '../types';
import type { GeocodeSuggestion } from '../api';
import { updateEvent } from '../api';
import AddressAutocomplete from './AddressAutocomplete';
import LocationBadge from './LocationBadge';
import EventTagEditor from './EventTagEditor';

interface Props {
    event: CalendarEvent;
    onClose: () => void;
    onSaved: (updated: CalendarEvent) => void;
}

export default function EventEditModal({ event, onClose, onSaved }: Props) {
    const [title, setTitle] = useState(event.title);
    const [description, setDescription] = useState(event.description ?? '');
    const [location, setLocation] = useState(event.location ?? '');
    const [latitude, setLatitude] = useState<number | null>(event.latitude);
    const [longitude, setLongitude] = useState<number | null>(event.longitude);
    const [start, setStart] = useState(event.start.slice(0, 16)); // datetime-local format
    const [end, setEnd] = useState(event.end.slice(0, 16));
    const [allDay, setAllDay] = useState(event.all_day);
    const [priceMin, setPriceMin] = useState<string>(event.price_min != null ? String(event.price_min) : '');
    const [priceMax, setPriceMax] = useState<string>(event.price_max != null ? String(event.price_max) : '');
    const [priceCurrency, setPriceCurrency] = useState(event.price_currency ?? 'EUR');
    const [priceIsFree, setPriceIsFree] = useState(event.price_is_free);
    const [editLinks, setEditLinks] = useState<{ url: string; label: string }[]>(
        event.links?.map((l) => ({ url: l.url, label: l.label ?? '' })) ?? [],
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [locationDirty, setLocationDirty] = useState(false);

    const handleAddressSelect = (s: GeocodeSuggestion) => {
        setLatitude(s.latitude);
        setLongitude(s.longitude);
        setLocationDirty(false); // coords now match
    };

    const handleLocationChange = (v: string) => {
        setLocation(v);
        setLocationDirty(true);
    };

    const handleSave = async () => {
        setSaving(true);
        setError('');
        try {
            const payload: Record<string, unknown> = {};
            if (title !== event.title) payload.title = title;
            if (description !== (event.description ?? '')) payload.description = description;
            if (location !== (event.location ?? '')) payload.location = location;
            if (!locationDirty && latitude !== event.latitude) payload.latitude = latitude;
            if (!locationDirty && longitude !== event.longitude) payload.longitude = longitude;
            // If user typed location manually (dirty) without selecting, let backend geocode
            if (locationDirty) {
                // don't send lat/lng — backend will geocode
            }
            if (start !== event.start.slice(0, 16)) payload.start = new Date(start).toISOString();
            if (end !== event.end.slice(0, 16)) payload.end = new Date(end).toISOString();
            if (allDay !== event.all_day) payload.all_day = allDay;

            // Price fields
            const newPriceIsFree = priceIsFree;
            if (newPriceIsFree !== event.price_is_free) payload.price_is_free = newPriceIsFree;
            if (newPriceIsFree) {
                payload.price_min = 0;
                payload.price_max = 0;
                payload.price_currency = '';
                payload.price_is_free = true;
            } else {
                const minVal = priceMin !== '' ? parseFloat(priceMin) : null;
                const maxVal = priceMax !== '' ? parseFloat(priceMax) : null;
                if (minVal !== event.price_min) payload.price_min = minVal;
                if (maxVal !== event.price_max) payload.price_max = maxVal;
                if (priceCurrency !== (event.price_currency ?? 'EUR')) payload.price_currency = priceCurrency;
            }

            // Links
            const linksPayload = editLinks
                .filter((l) => l.url.trim())
                .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null }));
            const oldLinks = JSON.stringify(event.links ?? []);
            if (JSON.stringify(linksPayload) !== oldLinks) {
                payload.links = linksPayload;
            }

            if (Object.keys(payload).length === 0) {
                onClose();
                return;
            }

            const updated = await updateEvent(event.event_id, payload as any);
            onSaved(updated);
        } catch {
            setError('Failed to save changes.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[90vh]">
                <h2 className="px-6 pt-6 pb-4 text-lg font-semibold text-slate-800 shrink-0">Edit Event</h2>

                <div className="px-6 pb-6 overflow-y-auto space-y-3">
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Title</label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">Location</label>
                        <AddressAutocomplete
                            value={location}
                            onChange={handleLocationChange}
                            onSelect={handleAddressSelect}
                        />
                        <div className="mt-1 flex items-center gap-1.5">
                            <LocationBadge location={location} latitude={latitude} longitude={longitude} />
                            {latitude != null && longitude != null && (
                                <span className="text-xs text-slate-400">
                                    {latitude.toFixed(4)}, {longitude.toFixed(4)}
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">Start</label>
                            <input
                                type="datetime-local"
                                value={start}
                                onChange={(e) => setStart(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">End</label>
                            <input
                                type="datetime-local"
                                value={end}
                                onChange={(e) => setEnd(e.target.value)}
                                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                        </div>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input
                            type="checkbox"
                            checked={allDay}
                            onChange={(e) => setAllDay(e.target.checked)}
                            className="rounded border-slate-300"
                        />
                        All day event
                    </label>

                    {/* Price section */}
                    <div className="border-t border-slate-200 pt-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Pricing</p>
                        <label className="flex items-center gap-2 text-sm text-slate-600 mb-2">
                            <input
                                type="checkbox"
                                checked={priceIsFree}
                                onChange={(e) => setPriceIsFree(e.target.checked)}
                                className="rounded border-slate-300"
                            />
                            Free event
                        </label>
                        {!priceIsFree && (
                            <div className="grid grid-cols-3 gap-2">
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-slate-600">Min</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={priceMin}
                                        onChange={(e) => setPriceMin(e.target.value)}
                                        placeholder="0"
                                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-slate-600">Max</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={priceMax}
                                        onChange={(e) => setPriceMax(e.target.value)}
                                        placeholder="0"
                                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs font-medium text-slate-600">Currency</label>
                                    <select
                                        value={priceCurrency}
                                        onChange={(e) => setPriceCurrency(e.target.value)}
                                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    >
                                        <option value="EUR">EUR</option>
                                        <option value="USD">USD</option>
                                        <option value="GBP">GBP</option>
                                        <option value="CHF">CHF</option>
                                        <option value="SEK">SEK</option>
                                        <option value="NOK">NOK</option>
                                        <option value="DKK">DKK</option>
                                        <option value="PLN">PLN</option>
                                        <option value="CZK">CZK</option>
                                    </select>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Tags section */}
                    <div className="border-t border-slate-200 pt-3">
                        <EventTagEditor
                            eventId={event.event_id}
                            currentTags={event.tags || []}
                            onUpdated={() => { }}
                        />
                    </div>

                    {/* Links section */}
                    <div className="border-t border-slate-200 pt-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                        {editLinks.map((link, i) => (
                            <div key={i} className="flex gap-2 mb-1.5">
                                <input
                                    type="url"
                                    value={link.url}
                                    onChange={(e) =>
                                        setEditLinks((prev) => prev.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))
                                    }
                                    placeholder="https://…"
                                    className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <input
                                    type="text"
                                    value={link.label}
                                    onChange={(e) =>
                                        setEditLinks((prev) => prev.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))
                                    }
                                    placeholder="Label"
                                    className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <button
                                    type="button"
                                    onClick={() => setEditLinks((prev) => prev.filter((_, j) => j !== i))}
                                    className="text-slate-400 hover:text-red-500 text-sm px-1"
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                        {editLinks.length < 3 && (
                            <button
                                type="button"
                                onClick={() => setEditLinks((prev) => [...prev, { url: '', label: '' }])}
                                className="text-xs text-blue-600 hover:text-blue-700"
                            >
                                + Add link
                            </button>
                        )}
                    </div>
                </div>

                {error && <p className="px-6 pt-3 text-sm text-red-600 shrink-0">{error}</p>}

                <div className="px-6 py-4 flex justify-end gap-2 border-t border-slate-100 shrink-0">
                    <button
                        onClick={onClose}
                        className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition"
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
