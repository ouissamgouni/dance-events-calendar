import React, { useRef, useState } from 'react';
import type { CalendarEvent, TagGroup } from '../types';
import type { GeocodeSuggestion } from '../api';
import { parseLinks } from '../utils/parseLinks';
import { deriveLinkLabel } from '../utils/deriveLinkLabel';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { trackLink } from '../utils/tracking';
import { getDeviceId } from '../utils/deviceId';
import { fetchTagGroups, retryGeocodingSingle } from '../api';
import AddressAutocomplete from './AddressAutocomplete';
import EventTagEditor from './EventTagEditor';
import LocationBadge from './LocationBadge';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import AttendeeList from './AttendeeList';
import GoingWedge from './GoingWedge';
import RateEventButton from './RateEventButton';
import TagBadges from './TagBadges';
import SuggestTagsButton from './SuggestTagsButton';
import ExpandableDescription from './ExpandableDescription';
import ShareButton from './ShareButton';
import { EventPromoCodes } from './EventPromoCodes';

interface Props {
    event: CalendarEvent;
    /** Show suggest-tags and edit buttons */
    showActions?: boolean;
    onEdit?: (event: CalendarEvent) => void;
    /** Compact layout for inline / side-panel rendering */
    compact?: boolean;
    /** Admin inline editing mode — each field is click-to-edit */
    editable?: boolean;
    /** Suppress all tracking calls — set when rendered in admin context */
    disableTracking?: boolean;
    /** Called when a field is saved inline. Parent must update event prop. */
    onFieldSave?: (changes: Partial<CalendarEvent>) => Promise<void>;
    /** Max tags to show (default: 5). Pass event.tags.length or Infinity to show all. */
    maxTags?: number;
    /** Called after tags are updated inline so parent can refresh event */
    onTagsUpdated?: () => void;
}

export default function EventDetailContent({
    event,
    showActions = true,
    onEdit,
    compact = false,
    editable = false,
    disableTracking = false,
    onFieldSave,
    maxTags,
    onTagsUpdated,
}: Props) {
    const { showPrices, showPopularity, showRatings } = useFeatureFlags();
    const [showSuggestTags, setShowSuggestTags] = useState(false);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);

    // ── Inline editing state ──────────────────────────────────────────────────
    const [editingField, setEditingField] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const cancelledRef = useRef(false);

    // Datetime edit state
    const [editStart, setEditStart] = useState('');
    const [editEnd, setEditEnd] = useState('');
    const [editAllDay, setEditAllDay] = useState(false);

    // Price edit state
    const [editIsFree, setEditIsFree] = useState(false);
    const [editPriceMin, setEditPriceMin] = useState('');
    const [editPriceMax, setEditPriceMax] = useState('');
    const [editCurrency, setEditCurrency] = useState('');

    // Link edit state
    const [editLinks, setEditLinks] = useState<{ url: string; label: string }[]>([]);

    // Location geocode state
    const [editLocationLat, setEditLocationLat] = useState<number | null>(null);
    const [editLocationLng, setEditLocationLng] = useState<number | null>(null);
    const [editLocationDirty, setEditLocationDirty] = useState(false);

    // Retry geocoding state
    const [retryingGeo, setRetryingGeo] = useState(false);
    const [retryGeoMsg, setRetryGeoMsg] = useState<string | null>(null);

    // Close any open field editor when editable is toggled off
    React.useEffect(() => {
        if (!editable) setEditingField(null);
    }, [editable]);

    const startEdit = (field: string, value = '') => {
        setSaveError(null);
        cancelledRef.current = false;
        setEditValue(value);
        setEditingField(field);
    };

    const startDatetimeEdit = () => {
        setSaveError(null);
        cancelledRef.current = false;
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
        cancelledRef.current = false;
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

    const saveField = async (changes: Partial<CalendarEvent>) => {
        if (!onFieldSave) return;
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

    // Small pencil hint shown on hover when editable
    const EditHint = () => (
        <span className="opacity-0 group-hover:opacity-40 absolute top-0.5 right-0 text-slate-400 text-[10px] pointer-events-none select-none">
            ✏
        </span>
    );

    const fallbackLinks = parseLinks(event.description);
    const structuredLinks = event.links && event.links.length > 0 ? event.links : null;
    const hasVisibleBadge =
        (showPrices && (event.price_is_free || (event.price_min != null && event.price_currency))) ||
        (showPopularity && event.view_count > 0);
    const start = new Date(event.start);
    const end = new Date(event.end);

    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });

    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return (
        <div className="space-y-4">
            {/* Date + badges */}
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
                            <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <div
                        className={editable ? 'group relative cursor-pointer hover:bg-slate-50 -mx-2 px-2 py-1 rounded transition' : ''}
                        onClick={editable ? startDatetimeEdit : undefined}
                    >
                        <p className={`text-slate-500 ${compact ? 'text-xs' : 'text-sm'}`}>
                            🗓 {event.all_day
                                ? formatDate(start)
                                : `${formatDate(start)} · ${formatTime(start)} – ${formatTime(end)}`}
                        </p>
                        {editable && <EditHint />}
                    </div>
                )}

                {/* Organizer pill — surfaces an admin-approved organizer
                    attribution. ``event.organizer`` is server-gated on the
                    ``organizer_claims_enabled`` flag. */}
                {event.organizer && (
                    <div className="mt-1">
                        <a
                            href={event.organizer.handle ? `/u/${event.organizer.handle}` : '#'}
                            className="inline-flex items-center gap-1.5 bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-200 transition"
                            onClick={(e) => {
                                if (!event.organizer?.handle) e.preventDefault();
                            }}
                        >
                            {event.organizer.avatar_url && (
                                <img
                                    src={event.organizer.avatar_url}
                                    alt=""
                                    className="h-4 w-4 rounded-full object-cover"
                                />
                            )}
                            <span>
                                Organized by{' '}
                                {event.organizer.handle
                                    ? `@${event.organizer.handle}`
                                    : event.organizer.display_name ?? 'organizer'}
                            </span>
                            {event.organizer.is_verified_organizer && (
                                <img
                                    src="/orga.png"
                                    alt=""
                                    title="Verified organizer"
                                    aria-label="Verified organizer"
                                    className="w-3.5 h-3.5 object-contain"
                                />
                            )}
                        </a>
                    </div>
                )}

                {/* Price badges — shown below the date */}
                {hasVisibleBadge && editingField !== 'price' && (
                    <div className="flex items-start gap-3 mt-2 flex-wrap">
                        <div
                            className={`flex items-center gap-2 flex-wrap ${editable ? 'group relative cursor-pointer hover:bg-slate-50 -mx-2 px-2 py-1 rounded transition' : ''}`}
                            onClick={editable ? startPriceEdit : undefined}
                        >
                            {showPrices && event.price_is_free && (
                                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                                    Free
                                </span>
                            )}
                            {showPrices && !event.price_is_free && event.price_min != null && event.price_currency && (
                                <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                    {event.price_max != null && event.price_max !== event.price_min
                                        ? `${event.price_currency} ${event.price_min}\u2013${event.price_max}`
                                        : `${event.price_currency} ${event.price_min}`}
                                </span>
                            )}
                            {showPopularity && event.view_count > 0 && (
                                <span className="inline-flex items-center gap-1 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                                    <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                        <path d="M2 10s2.5-5 8-5 8 5 8 5-2.5 5-8 5-8-5-8-5Z" strokeLinejoin="round" />
                                        <circle cx="10" cy="10" r="2.25" />
                                    </svg>
                                    {event.view_count} view{event.view_count !== 1 ? 's' : ''}
                                </span>
                            )}
                            {editable && <EditHint />}
                        </div>
                    </div>
                )}

                {/* Price inline edit form */}
                {editable && !hasVisibleBadge && editingField !== 'price' && (
                    <div
                        className="mt-2 cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded px-3 py-1.5 transition w-fit"
                        onClick={startPriceEdit}
                    >
                        + Add price info
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
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">
                                Cancel
                            </button>
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
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">
                            Cancel
                        </button>
                    </div>
                </div>
            ) : event.location ? (
                <div
                    className={editable ? 'group relative cursor-pointer' : ''}
                    onClick={editable ? startLocationEdit : undefined}
                >
                    <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 transition">
                        <span className="mt-0.5 flex items-center gap-1">
                            📍
                            <LocationBadge size="sm" location={event.location} latitude={event.latitude} longitude={event.longitude} />
                        </span>
                        <span className="flex-1">{event.location}</span>
                        {editable && (
                            <button
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    if (retryingGeo) return;
                                    setRetryingGeo(true);
                                    setRetryGeoMsg(null);
                                    try {
                                        const r = await retryGeocodingSingle(event.event_id);
                                        setRetryGeoMsg(
                                            r.geocoded > 0
                                                ? '✓ geocoded'
                                                : r.failed > 0
                                                    ? '✗ still no match'
                                                    : 'no change',
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
                            >
                                {retryingGeo ? '…' : retryGeoMsg ?? '↻ Retry'}
                            </button>
                        )}
                    </p>
                    {editable && <EditHint />}
                </div>
            ) : editable ? (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded-lg px-3 py-2 transition"
                    onClick={startLocationEdit}
                >
                    + Add location
                </div>
            ) : null}

            {/* Tags */}
            {editingField === 'tags' ? (
                <div className="border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
                    <div className="max-h-72 overflow-y-auto p-3">
                        <EventTagEditor
                            eventId={event.event_id}
                            currentTags={event.tags || []}
                            onUpdated={() => { onTagsUpdated?.(); setEditingField(null); }}
                        />
                    </div>
                    <div className="border-t border-slate-200 px-3 py-2 bg-white">
                        <button
                            onClick={cancelEdit}
                            className="text-[11px] text-slate-500 hover:text-slate-700"
                        >Cancel</button>
                    </div>
                </div>
            ) : event.tags?.length > 0 ? (
                <div
                    className={editable ? 'group relative cursor-pointer hover:bg-slate-50 -mx-2 px-2 py-1 rounded transition' : ''}
                    onClick={editable ? () => setEditingField('tags') : undefined}
                >
                    <TagBadges tags={event.tags} maxVisible={maxTags ?? 5} />
                    {editable && <EditHint />}
                </div>
            ) : editable ? (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded px-3 py-1.5 transition w-fit"
                    onClick={() => setEditingField('tags')}
                >+ Add tags</div>
            ) : null}

            {/* Description */}
            {editingField === 'description' ? (
                <div>
                    <textarea
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => handleTextBlur('description', editValue)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') { cancelledRef.current = true; cancelEdit(); }
                        }}
                        rows={6}
                        className={`w-full border border-slate-300 rounded p-2 leading-relaxed text-slate-600 resize-y focus:outline-none focus:ring-1 focus:ring-rose-300 ${compact ? 'text-xs' : 'text-sm'}`}
                    />
                    {saving && <p className="text-[10px] text-slate-400 mt-1">Saving…</p>}
                    {saveError && <p className="text-[10px] text-red-500 mt-1">{saveError}</p>}
                </div>
            ) : event.description ? (
                <div
                    className={editable ? 'group relative cursor-text hover:bg-slate-50 -mx-2 px-2 py-1 rounded transition' : ''}
                    onClick={editable ? () => startEdit('description', event.description ?? '') : undefined}
                >
                    <ExpandableDescription text={event.description} compact={compact} />
                    {editable && <EditHint />}
                </div>
            ) : editable ? (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded p-2 transition"
                    onClick={() => startEdit('description', '')}
                >
                    + Add description
                </div>
            ) : null}

            {/* Promo codes — collapsible section under the description. */}
            <EventPromoCodes eventId={event.event_id} />

            {/* Links */}
            {editable && editingField === 'links' ? (
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
                                    saveField({ links } as Partial<CalendarEvent>);
                                }}
                                className="text-[11px] font-medium px-2.5 py-1 bg-rose-500 text-white rounded hover:bg-rose-600 disabled:opacity-50 transition"
                            >{saving ? 'Saving…' : 'Save'}</button>
                            <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-700 px-2">Cancel</button>
                        </div>
                    </div>
                </div>
            ) : structuredLinks ? (
                <div
                    className={`space-y-1.5 border-t border-slate-100 pt-3 ${editable ? 'group relative cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded transition' : ''}`}
                    onClick={editable ? () => { setEditLinks(structuredLinks.map((l) => ({ url: l.url, label: l.label ?? '' }))); setEditingField('links'); } : undefined}
                >
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                    <div className="flex flex-wrap gap-1.5">
                        {structuredLinks.map((link, i) => (
                            <a
                                key={i}
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => { e.stopPropagation(); if (!disableTracking) trackLink(event.event_id, link.url); }}
                                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 transition"
                            >
                                🔗 {link.label || deriveLinkLabel(link.url)}
                            </a>
                        ))}
                    </div>
                    {editable && <EditHint />}
                </div>
            ) : fallbackLinks.length > 0 ? (
                <div className="space-y-1.5 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Links</p>
                    {fallbackLinks.map((url) => (
                        <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => { if (!disableTracking) trackLink(event.event_id, url); }}
                            className="block text-slate-600 hover:text-slate-800 hover:underline text-xs"
                        >{url}</a>
                    ))}
                </div>
            ) : editable ? (
                <div
                    className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded px-3 py-1.5 transition w-fit"
                    onClick={() => { setEditLinks([]); setEditingField('links'); }}
                >+ Add links</div>
            ) : null}

            {/* Suggest tags modal */}
            {showSuggestTags && (
                <SuggestTagsButton
                    eventId={event.event_id}
                    tagGroups={tagGroups}
                    existingTagIds={new Set(event.tags?.map((t) => t.id) ?? [])}
                    deviceId={getDeviceId()}
                    onClose={() => setShowSuggestTags(false)}
                />
            )}

            {/* Who's going */}
            {showActions && (
                <div className="border-t border-slate-100 pt-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                        Who's going
                    </h3>
                    <AttendeeList eventId={event.event_id} expanded />
                </div>
            )}

            {/* Phase E (E5) — friends / FoF social-proof wedge.
                Renders nothing for anon viewers and nothing when all
                three buckets are empty, so it's safe to mount
                unconditionally alongside AttendeeList. */}
            {showActions && <GoingWedge eventId={event.event_id} />}

            {/* Action bar */}
            {showActions && (
                <div className="border-t border-slate-100 pt-3 flex items-center gap-2 flex-wrap">
                    <SaveEventButton eventId={event.event_id} appearance="pill" />
                    <GoingButton eventId={event.event_id} appearance="pill" />
                    {showRatings && <RateEventButton eventId={event.event_id} appearance="pill" />}
                    <ShareButton
                        eventId={event.event_id}
                        title={event.title}
                        url={`${window.location.origin}/event/${event.event_id}`}
                        className="text-xs text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-1 transition"
                    />
                    {!editable && (
                        <button
                            onClick={() => {
                                if (!tagGroups.length) fetchTagGroups().then(setTagGroups).catch(() => { });
                                setShowSuggestTags(!showSuggestTags);
                            }}
                            className="text-xs text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-1 transition"
                        >
                            Suggest{' '}
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 align-[-1px]">
                                <path fillRule="evenodd" d="M2 4.75A2.75 2.75 0 0 1 4.75 2h4.379a2.75 2.75 0 0 1 1.944.805l5.122 5.122a2.75 2.75 0 0 1 0 3.889l-4.38 4.379a2.75 2.75 0 0 1-3.888 0L2.805 11.073A2.75 2.75 0 0 1 2 9.129V4.75Zm4.5 1.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    )}
                    {/* Edit button only shown in non-editable mode (inline editing replaces it when editable=true) */}
                    {!editable && onEdit && (
                        <button
                            onClick={() => onEdit(event)}
                            className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-slate-900"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                                <path d="m5.433 13.917.664-2.657a2 2 0 0 1 .503-.896l6.657-6.657a2.121 2.121 0 1 1 3 3l-6.657 6.657a2 2 0 0 1-.896.503l-2.657.664a.75.75 0 0 1-.914-.914Z" />
                                <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v11.5C2 17.216 2.784 18 3.75 18h11.5A1.75 1.75 0 0 0 17 16.25V12a.75.75 0 0 0-1.5 0v4.25a.25.25 0 0 1-.25.25H3.75a.25.25 0 0 1-.25-.25V4.75a.25.25 0 0 1 .25-.25H8a.75.75 0 0 0 0-1.5H3.75Z" />
                            </svg>
                            Edit
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
