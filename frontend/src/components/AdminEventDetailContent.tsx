import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, CalendarSetting } from '../types';
import type { GeocodeSuggestion } from '../api';
import { fetchAdminCalendars, retryGeocodingSingle } from '../api';
import { parseLinks } from '../utils/parseLinks';
import { deriveLinkLabel } from '../utils/deriveLinkLabel';
import AddressAutocomplete from './AddressAutocomplete';
import AdminAutoTagSuggestions from './AdminAutoTagSuggestions';
import InlineTagsPicker from './InlineTagsPicker';
import LocationBadge from './LocationBadge';
import TagBadges from './TagBadges';
import ExpandableDescription from './ExpandableDescription';

interface Props {
    event: CalendarEvent;
    onFieldSave: (changes: Partial<CalendarEvent> & { review_status?: string; calendar_id?: string }) => Promise<void>;
    onTagsUpdated?: () => void;
    compact?: boolean;
}

/**
 * Admin-only event editor used in the admin side panel, the Home page (when an
 * admin is logged in) and the full event detail page. Always renders every
 * field as editable and ignores user-facing FeatureFlags (price/popularity are
 * always visible to admins).
 */
export default function AdminEventDetailContent({
    event,
    onFieldSave,
    onTagsUpdated,
    compact = false,
}: Props) {
    // Inline editing state
    const [editingField, setEditingField] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const cancelledRef = useRef(false);

    // Field-specific state
    const [editStart, setEditStart] = useState('');
    const [editEnd, setEditEnd] = useState('');
    const [editAllDay, setEditAllDay] = useState(false);

    const [editIsFree, setEditIsFree] = useState(false);
    const [editPriceMin, setEditPriceMin] = useState('');
    const [editPriceMax, setEditPriceMax] = useState('');
    const [editCurrency, setEditCurrency] = useState('');

    const [editLinks, setEditLinks] = useState<{ url: string; label: string }[]>([]);

    const [editLocationLat, setEditLocationLat] = useState<number | null>(null);
    const [editLocationLng, setEditLocationLng] = useState<number | null>(null);
    const [editLocationDirty, setEditLocationDirty] = useState(false);

    const [retryingGeo, setRetryingGeo] = useState(false);
    const [retryGeoMsg, setRetryGeoMsg] = useState<string | null>(null);

    // Calendars list (for calendar-id dropdown)
    const [calendars, setCalendars] = useState<CalendarSetting[]>([]);
    useEffect(() => {
        fetchAdminCalendars().then(setCalendars).catch(() => { });
    }, []);

    // Collapsible state for the tags section (collapsed shows applied tags inline).
    const [tagsExpanded, setTagsExpanded] = useState(false);

    const startEdit = (field: string, value = '') => {
        setSaveError(null);
        cancelledRef.current = false;
        setEditValue(value);
        setEditingField(field);
    };

    const startDatetimeEdit = () => {
        setSaveError(null);
        setEditStart(event.start.slice(0, 16));
        setEditEnd(event.end.slice(0, 16));
        setEditAllDay(event.all_day);
        setEditingField('datetime');
    };

    const startPriceEdit = () => {
        setSaveError(null);
        setEditIsFree(event.price_is_free);
        setEditPriceMin(event.price_min != null ? String(event.price_min) : '');
        setEditPriceMax(event.price_max != null ? String(event.price_max) : '');
        setEditCurrency(event.price_currency ?? 'EUR');
        setEditingField('price');
    };

    const startLocationEdit = () => {
        setSaveError(null);
        setEditValue(event.location ?? '');
        setEditLocationLat(event.latitude);
        setEditLocationLng(event.longitude);
        setEditLocationDirty(false);
        setEditingField('location');
    };

    const cancelEdit = () => {
        cancelledRef.current = false;
        setEditingField(null);
        setSaveError(null);
    };

    const saveField = async (changes: Partial<CalendarEvent> & { review_status?: string; calendar_id?: string }) => {
        setSaving(true);
        setSaveError(null);
        try {
            await onFieldSave(changes);
            setEditingField(null);
        } catch {
            setSaveError('Failed to save. Try again.');
        } finally {
            setSaving(false);
        }
    };

    const handleTextBlur = (field: string, value: string | null) => {
        if (cancelledRef.current) { cancelledRef.current = false; return; }
        saveField({ [field]: value || null } as Partial<CalendarEvent>);
    };

    const EditHint = () => (
        <span className="opacity-0 group-hover:opacity-40 absolute top-0.5 right-0 text-slate-400 text-[10px] pointer-events-none select-none">
            ✏
        </span>
    );

    const fallbackLinks = parseLinks(event.description);
    const structuredLinks = event.links && event.links.length > 0 ? event.links : null;
    const start = new Date(event.start);
    const end = new Date(event.end);

    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const currentCalendar = calendars.find((c) => c.calendar_id === event.calendar_id);

    return (
        <div className="space-y-2">
            {/* Calendar + review status (admin-only) */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Calendar
                </label>
                <select
                    value={event.calendar_id}
                    disabled={saving}
                    onChange={(e) => saveField({ calendar_id: e.target.value })}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                >
                    {!currentCalendar && (
                        <option value={event.calendar_id}>{event.calendar_id}</option>
                    )}
                    {calendars.map((c) => (
                        <option key={c.calendar_id} value={c.calendar_id}>
                            {c.name}
                        </option>
                    ))}
                </select>
                {currentCalendar?.color && (
                    <span
                        className="inline-block h-3 w-3 rounded-full border border-slate-300"
                        style={{ backgroundColor: currentCalendar.color }}
                        title={currentCalendar.color}
                    />
                )}

                <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Review</span>
                    <select
                        value={event.review_status ?? 'pending'}
                        disabled={saving}
                        onChange={(e) => saveField({ review_status: e.target.value })}
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                    >
                        <option value="pending">pending</option>
                        <option value="reviewed">reviewed</option>
                    </select>
                </div>
            </div>

            {/* Date + price */}
            <div>
                {editingField === 'datetime' ? (
                    <div className="space-y-2 rounded-lg bg-slate-50 p-3 border border-slate-200">
                        <label className="flex items-center gap-2 text-xs text-slate-600">
                            <input
                                type="checkbox"
                                checked={editAllDay}
                                onChange={(e) => setEditAllDay(e.target.checked)}
                                className="h-3.5 w-3.5"
                            />
                            All day
                        </label>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-[10px] text-slate-400 uppercase tracking-wide">Start</label>
                            <input
                                type={editAllDay ? 'date' : 'datetime-local'}
                                value={editAllDay ? editStart.slice(0, 10) : editStart}
                                onChange={(e) => setEditStart(e.target.value)}
                                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                            />
                            <label className="text-[10px] text-slate-400 uppercase tracking-wide">End</label>
                            <input
                                type={editAllDay ? 'date' : 'datetime-local'}
                                value={editAllDay ? editEnd.slice(0, 10) : editEnd}
                                onChange={(e) => setEditEnd(e.target.value)}
                                className="border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                            />
                        </div>
                        {saveError && <p className="text-[10px] text-red-500">{saveError}</p>}
                        <div className="flex gap-2 pt-1">
                            <button
                                disabled={saving}
                                onClick={() => {
                                    const s = editAllDay ? editStart.slice(0, 10) : new Date(editStart).toISOString();
                                    const e2 = editAllDay ? editEnd.slice(0, 10) : new Date(editEnd).toISOString();
                                    saveField({ start: s, end: e2, all_day: editAllDay });
                                }}
                                className="text-[11px] font-medium px-2.5 py-1 bg-rose-500 text-white rounded hover:bg-rose-600 disabled:opacity-50 transition"
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">Cancel</button>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                        <div
                            className="group relative cursor-pointer hover:bg-slate-50 -mx-2 px-2 py-1 rounded transition"
                            onClick={startDatetimeEdit}
                        >
                            <p className="text-slate-500 text-xs">
                                🗓 {event.all_day
                                    ? formatDate(start)
                                    : `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`}
                            </p>
                            <EditHint />
                        </div>

                        {/* Price (always shown for admin — feature flags ignored) */}
                        {editingField !== 'price' && (event.price_is_free || event.price_min != null) ? (
                            <div
                                className="ml-auto flex items-center gap-2 flex-wrap group relative cursor-pointer hover:bg-slate-50 px-2 py-1 rounded transition"
                                onClick={startPriceEdit}
                            >
                                {event.price_is_free && (
                                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                                        Free
                                    </span>
                                )}
                                {!event.price_is_free && event.price_min != null && (
                                    <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                        {event.price_max != null && event.price_max !== event.price_min
                                            ? `${event.price_currency ?? ''} ${event.price_min}\u2013${event.price_max}`
                                            : `${event.price_currency ?? ''} ${event.price_min}`}
                                    </span>
                                )}
                                {event.view_count > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                                        {event.view_count >= 10 ? '\uD83D\uDD25' : '\uD83D\uDC41'} {event.view_count}
                                    </span>
                                )}
                                <EditHint />
                            </div>
                        ) : editingField !== 'price' ? (
                            <div
                                className="ml-auto cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded px-3 py-1.5 transition w-fit"
                                onClick={startPriceEdit}
                            >+ Add price</div>
                        ) : null}
                    </div>
                )}

                {editingField === 'price' && (
                    <div className="mt-2 rounded-lg bg-slate-50 p-3 border border-slate-200 space-y-2">
                        <label className="flex items-center gap-2 text-xs text-slate-600">
                            <input
                                type="checkbox"
                                checked={editIsFree}
                                onChange={(e) => setEditIsFree(e.target.checked)}
                                className="h-3.5 w-3.5"
                            />
                            Free event
                        </label>
                        {!editIsFree && (
                            <div className="flex gap-2 items-center flex-wrap">
                                <input
                                    type="number"
                                    placeholder="Min"
                                    value={editPriceMin}
                                    onChange={(e) => setEditPriceMin(e.target.value)}
                                    className="w-20 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                                />
                                <span className="text-xs text-slate-400">–</span>
                                <input
                                    type="number"
                                    placeholder="Max"
                                    value={editPriceMax}
                                    onChange={(e) => setEditPriceMax(e.target.value)}
                                    className="w-20 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                                />
                                <input
                                    type="text"
                                    placeholder="EUR"
                                    value={editCurrency}
                                    onChange={(e) => setEditCurrency(e.target.value)}
                                    className="w-16 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                                />
                            </div>
                        )}
                        {saveError && <p className="text-[10px] text-red-500">{saveError}</p>}
                        <div className="flex gap-2 pt-1">
                            <button
                                disabled={saving}
                                onClick={() => {
                                    if (editIsFree) {
                                        saveField({ price_is_free: true, price_min: 0, price_max: 0, price_currency: '' });
                                    } else {
                                        saveField({
                                            price_is_free: false,
                                            price_min: editPriceMin !== '' ? parseFloat(editPriceMin) : null,
                                            price_max: editPriceMax !== '' ? parseFloat(editPriceMax) : null,
                                            price_currency: editCurrency || null,
                                        });
                                    }
                                }}
                                className="text-[11px] font-medium px-2.5 py-1 bg-rose-500 text-white rounded hover:bg-rose-600 disabled:opacity-50 transition"
                            >{saving ? 'Saving…' : 'Save'}</button>
                            <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">Cancel</button>
                        </div>
                    </div>
                )}
            </div>

            {/* Location */}
            {editingField === 'location' ? (
                <div className="space-y-1.5">
                    <AddressAutocomplete
                        value={editValue}
                        onChange={(v) => { setEditValue(v); setEditLocationDirty(true); }}
                        onSelect={(s: GeocodeSuggestion) => {
                            setEditValue(s.display_name);
                            setEditLocationLat(s.latitude);
                            setEditLocationLng(s.longitude);
                            setEditLocationDirty(false);
                        }}
                    />
                    {saveError && <p className="text-[10px] text-red-500 mt-1">{saveError}</p>}
                    <div className="flex gap-2">
                        <button
                            disabled={saving}
                            onClick={() => {
                                const changes: Partial<CalendarEvent> = { location: editValue || null };
                                if (!editLocationDirty) {
                                    changes.latitude = editLocationLat ?? undefined;
                                    changes.longitude = editLocationLng ?? undefined;
                                }
                                saveField(changes);
                            }}
                            className="text-[11px] font-medium px-2.5 py-1 bg-rose-500 text-white rounded hover:bg-rose-600 disabled:opacity-50 transition"
                        >{saving ? 'Saving…' : 'Save'}</button>
                        <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">Cancel</button>
                    </div>
                </div>
            ) : event.location ? (
                <div className="group relative cursor-pointer" onClick={startLocationEdit}>
                    <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 transition">
                        <span className="mt-0.5 flex items-center gap-1">
                            📍
                            <LocationBadge size="sm" location={event.location} latitude={event.latitude} longitude={event.longitude} />
                        </span>
                        <span className="flex-1">{event.location}</span>
                        <button
                            onClick={async (e) => {
                                e.stopPropagation();
                                if (retryingGeo) return;
                                setRetryingGeo(true);
                                setRetryGeoMsg(null);
                                try {
                                    const r = await retryGeocodingSingle(event.event_id);
                                    setRetryGeoMsg(
                                        r.geocoded > 0 ? '✓ geocoded' :
                                            r.failed > 0 ? '✗ still no match' : 'no change',
                                    );
                                    if (r.geocoded > 0) onTagsUpdated?.();
                                } catch {
                                    setRetryGeoMsg('error');
                                } finally {
                                    setRetryingGeo(false);
                                    setTimeout(() => setRetryGeoMsg(null), 4000);
                                }
                            }}
                            disabled={retryingGeo}
                            title="Retry geocoding"
                            className="shrink-0 self-start text-[10px] font-medium px-1.5 py-0.5 border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition"
                        >{retryingGeo ? '…' : retryGeoMsg ?? '↻ Retry geoloc'}</button>
                    </p>
                    <EditHint />
                </div>
            ) : (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded-lg px-3 py-2 transition"
                    onClick={startLocationEdit}
                >+ Add location</div>
            )}

            {/* Tags (collapsible, auto-saves on toggle) */}
            <div className="border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
                <button
                    type="button"
                    onClick={() => setTagsExpanded((v) => !v)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100 transition"
                >
                    <span className="text-slate-400 text-[10px]">{tagsExpanded ? '▾' : '▸'}</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Tags</span>
                    {!tagsExpanded && event.tags?.length > 0 && (
                        <span className="flex-1 min-w-0">
                            <TagBadges tags={event.tags} maxVisible={event.tags.length} />
                        </span>
                    )}
                    {!tagsExpanded && (!event.tags || event.tags.length === 0) && (
                        <span className="text-[11px] text-slate-400 italic">none</span>
                    )}
                </button>
                {tagsExpanded && (
                    <div className="border-t border-slate-200 bg-white max-h-72 overflow-y-auto p-3">
                        <InlineTagsPicker
                            eventId={event.event_id}
                            currentTags={event.tags || []}
                            onUpdated={() => onTagsUpdated?.()}
                        />
                    </div>
                )}
            </div>

            {/* Auto-generated tag suggestions (heuristic; admin approves/rejects). */}
            <AdminAutoTagSuggestions
                eventId={event.event_id}
                onApproved={() => onTagsUpdated?.()}
            />

            {/* Description */}
            {editingField === 'description' ? (
                <div>
                    <textarea
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleTextBlur('description', editValue)}
                        onKeyDown={(e) => { if (e.key === 'Escape') { cancelledRef.current = true; cancelEdit(); } }}
                        rows={6}
                        className={`w-full border border-slate-300 rounded p-2 leading-relaxed text-slate-600 resize-y focus:outline-none focus:ring-1 focus:ring-rose-300 ${compact ? 'text-xs' : 'text-sm'}`}
                    />
                    {saving && <p className="text-[10px] text-slate-400 mt-1">Saving…</p>}
                    {saveError && <p className="text-[10px] text-red-500 mt-1">{saveError}</p>}
                </div>
            ) : event.description ? (
                <div
                    className="group relative cursor-text rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 hover:bg-slate-100 transition"
                    onClick={() => startEdit('description', event.description ?? '')}
                >
                    <ExpandableDescription text={event.description} compact={compact} />
                    <EditHint />
                </div>
            ) : (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded-lg px-3 py-2 transition"
                    onClick={() => startEdit('description', '')}
                >+ Add description</div>
            )}

            {/* Links */}
            {editingField === 'links' ? (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                    <div className="rounded-lg bg-slate-50 p-3 border border-slate-200 space-y-2">
                        {editLinks.map((link, i) => (
                            <div key={i} className="flex gap-1.5">
                                <input
                                    type="url"
                                    value={link.url}
                                    onChange={(e) => setEditLinks((prev) => prev.map((l, j) => j === i ? { ...l, url: e.target.value } : l))}
                                    placeholder="https://…"
                                    className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                                />
                                <input
                                    type="text"
                                    value={link.label}
                                    onChange={(e) => setEditLinks((prev) => prev.map((l, j) => j === i ? { ...l, label: e.target.value } : l))}
                                    placeholder="Label"
                                    className="w-20 rounded border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-rose-300"
                                />
                                <button
                                    type="button"
                                    onClick={() => setEditLinks((prev) => prev.filter((_, j) => j !== i))}
                                    className="text-slate-400 hover:text-red-500 px-1 text-sm leading-none"
                                >✕</button>
                            </div>
                        ))}
                        {editLinks.length < 5 && (
                            <button
                                type="button"
                                onClick={() => setEditLinks((prev) => [...prev, { url: '', label: '' }])}
                                className="text-[11px] text-slate-500 hover:text-slate-700"
                            >+ Add link</button>
                        )}
                        {saveError && <p className="text-[10px] text-red-500">{saveError}</p>}
                        <div className="flex gap-2 pt-1">
                            <button
                                disabled={saving}
                                onClick={() => {
                                    const links = editLinks
                                        .filter((l) => l.url.trim())
                                        .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null }));
                                    saveField({ links });
                                }}
                                className="text-[11px] font-medium px-2.5 py-1 bg-rose-500 text-white rounded hover:bg-rose-600 disabled:opacity-50 transition"
                            >{saving ? 'Saving…' : 'Save'}</button>
                            <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">Cancel</button>
                        </div>
                    </div>
                </div>
            ) : structuredLinks ? (
                <div
                    className="space-y-1.5 border-t border-slate-100 pt-3 group relative cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded transition"
                    onClick={() => { setEditLinks(structuredLinks.map((l) => ({ url: l.url, label: l.label ?? '' }))); setEditingField('links'); }}
                >
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                    <div className="flex flex-wrap gap-1.5">
                        {structuredLinks.map((link, i) => (
                            <a
                                key={i}
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 transition"
                            >🔗 {link.label || deriveLinkLabel(link.url)}</a>
                        ))}
                    </div>
                    <EditHint />
                </div>
            ) : fallbackLinks.length > 0 ? (
                <div
                    className="space-y-1.5 border-t border-slate-100 pt-3 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded transition"
                    onClick={() => { setEditLinks(fallbackLinks.map((url) => ({ url, label: '' }))); setEditingField('links'); }}
                >
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links (from description)</p>
                    {fallbackLinks.map((url) => (
                        <span key={url} className="block text-slate-600 text-xs truncate">{url}</span>
                    ))}
                </div>
            ) : (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded px-3 py-1.5 transition w-fit"
                    onClick={() => { setEditLinks([]); setEditingField('links'); }}
                >+ Add links</div>
            )}
        </div>
    );
}
