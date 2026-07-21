import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GeocodeSuggestion, SiteSettings } from '../api';
import { fetchSettings, fetchTagGroups, searchSuggestionAddress, submitSuggestion } from '../api';
import type { Tag, TagGroup } from '../types';
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

type StepKey = 'basics' | 'description' | 'links' | 'tags' | 'price' | 'promo' | 'rsvp';

type SectionState = {
    key: StepKey;
    title: string;
};

const steps: SectionState[] = [
    { key: 'basics', title: 'Name, dates, location' },
    { key: 'description', title: 'Description' },
    { key: 'links', title: 'Links' },
    { key: 'tags', title: 'Tags' },
    { key: 'price', title: 'Price' },
    { key: 'promo', title: 'Promo code' },
    { key: 'rsvp', title: 'Going' },
];

const warningCls = 'mt-2 border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800';

function locationPreview(loc: string): string {
    const parts = loc.split(',').map((p) => p.trim()).filter(Boolean);
    let combined: string;
    if (parts.length <= 1) {
        combined = loc;
    } else {
        const country = parts[parts.length - 1];
        let cityIdx = parts.length - 2;
        while (cityIdx > 0 && /^[0-9\s-]+$/.test(parts[cityIdx])) cityIdx--;
        combined = `${parts[cityIdx]}, ${country}`;
    }
    return combined.length > 40 ? `${combined.slice(0, 40)}…` : combined;
}

function formatDateRange(startValue: string, endValue: string, allDayValue: boolean): string {
    if (!startValue) return '';
    const startDate = new Date(startValue);
    if (Number.isNaN(startDate.getTime())) return '';
    const datePart = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (allDayValue) return datePart;
    const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    const timePart = startDate.toLocaleTimeString(undefined, timeOpts);
    if (!endValue) return `${datePart} · ${timePart}`;
    const endDate = new Date(endValue);
    if (Number.isNaN(endDate.getTime())) return `${datePart} · ${timePart}`;
    const endTimePart = endDate.toLocaleTimeString(undefined, timeOpts);
    return `${datePart} · ${timePart}–${endTimePart}`;
}

function TagPillPreview({ label, color }: { label: string; color?: string | null }) {
    const c = color || '#64748b';
    return (
        <span
            className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium border"
            style={{ backgroundColor: c, borderColor: c, color: 'white' }}
        >
            {label}
        </span>
    );
}

const inputCls =
    'border border-slate-300 px-2 py-1.5 text-xs placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
const inputClsFull = `w-full ${inputCls}`;
const btnPrimary =
    'bg-blue-500 px-4 py-2 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition';
const btnSecondary =
    'border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition';

function SectionHeader({
    title,
    summary,
    open,
    valid,
    onToggle,
}: {
    title: string;
    summary?: ReactNode;
    open: boolean;
    valid: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-start justify-between gap-3 border-b border-slate-100 px-0 pb-2 text-left"
            aria-expanded={open}
        >
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {!open && valid ? (
                        <span
                            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[9px] text-white"
                            aria-label="Complete"
                        >
                            ✓
                        </span>
                    ) : null}
                    <span>{title}</span>
                </div>
                {summary ? <div className="mt-1 min-w-0 text-[11px] text-slate-500">{summary}</div> : null}
            </div>
            <span className="shrink-0 text-slate-400">{open ? '▾' : '▸'}</span>
        </button>
    );
}

export default function SuggestEventModal({ onClose }: Props) {
    const { user } = useAuth();
    const [settings, setSettings] = useState<SiteSettings | null>(null);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [latitude, setLatitude] = useState<number | null>(null);
    const [longitude, setLongitude] = useState<number | null>(null);
    const [links, setLinks] = useState<LinkRow[]>([{ url: 'https://', label: '' }]);
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [allDay, setAllDay] = useState(false);
    const [submitterName, setSubmitterName] = useState(user?.name ?? '');
    const [submitterEmail, setSubmitterEmail] = useState(user?.email ?? '');
    const [website, setWebsite] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [activeStep, setActiveStep] = useState<StepKey | null>('basics');
    const [attempted, setAttempted] = useState<Record<StepKey, boolean>>({
        basics: false,
        description: false,
        links: false,
        tags: false,
        price: false,
        promo: false,
        rsvp: false,
    });

    const [tagsValue, setTagsValue] = useState<TagsPickerValue>({ selectedTagIds: [], freeTexts: {} });
    const [tagsOpen, setTagsOpen] = useState(false);
    const [priceIsFree, setPriceIsFree] = useState(false);
    const [priceMin, setPriceMin] = useState('');
    const [priceMax, setPriceMax] = useState('');
    const [priceCurrency, setPriceCurrency] = useState('EUR');
    const [promoCode, setPromoCode] = useState('');
    const [promoDescription, setPromoDescription] = useState('');
    const [promoSourceUrl, setPromoSourceUrl] = useState('https://');
    const [going, setGoing] = useState(user ? true : false);
    const [goingAudience, setGoingAudience] = useState<'public' | 'friends' | 'private'>(
        user?.share_attendance_default_audience ?? 'friends',
    );

    useEffect(() => {
        if (user?.name && !submitterName) setSubmitterName(user.name);
        if (user?.email && !submitterEmail) setSubmitterEmail(user.email);
        if (user) {
            setGoing(true);
            setGoingAudience(user.share_attendance_default_audience ?? 'friends');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    useEffect(() => {
        void Promise.all([fetchTagGroups({ scope: 'event' }), fetchSettings()])
            .then(([groups, siteSettings]) => {
                setTagGroups(groups);
                setSettings(siteSettings);
            })
            .catch(() => {
                setTagGroups([]);
                setSettings(null);
            });
    }, []);

    const tagsCount =
        tagsValue.selectedTagIds.length +
        Object.values(tagsValue.freeTexts).filter((v) => v.trim()).length;

    const selectedTagSet = useMemo(() => new Set(tagsValue.selectedTagIds), [tagsValue.selectedTagIds]);

    const allTagsById = useMemo(() => {
        const map = new Map<number, Tag>();
        tagGroups.forEach((group) => (group.tags ?? []).forEach((t) => map.set(t.id, t)));
        return map;
    }, [tagGroups]);

    const requiredDanceGroup = useMemo(() => {
        const explicit = settings?.suggest_event_required_dance_group_id;
        if (explicit) return tagGroups.find((group) => group.id === explicit) ?? null;
        return tagGroups.find((group) => group.slug === 'dance-style') ?? null;
    }, [settings?.suggest_event_required_dance_group_id, tagGroups]);

    const requiredReachGroup = useMemo(() => {
        const explicit = settings?.suggest_event_required_reach_group_id;
        if (explicit) return tagGroups.find((group) => group.id === explicit) ?? null;
        return tagGroups.find((group) => group.slug === 'reach') ?? null;
    }, [settings?.suggest_event_required_reach_group_id, tagGroups]);

    const otherGroups = useMemo(() => {
        return tagGroups.filter((group) => group.id !== requiredDanceGroup?.id && group.id !== requiredReachGroup?.id && group.enabled !== false);
    }, [tagGroups, requiredDanceGroup?.id, requiredReachGroup?.id]);

    const requiredGroups = useMemo(() => {
        const groups = [requiredDanceGroup, requiredReachGroup].filter((group): group is TagGroup => group !== null && group.enabled !== false);
        return groups;
    }, [requiredDanceGroup, requiredReachGroup]);

    const requiredTagIdsForGroup = (group: TagGroup | null): number[] => {
        if (!group) return [];
        return (group.tags ?? []).filter((tag) => tag.enabled !== false).map((tag) => tag.id);
    };

    const selectedCountForGroup = (group: TagGroup | null): number => {
        if (!group) return 0;
        return requiredTagIdsForGroup(group).filter((id) => selectedTagSet.has(id)).length;
    };

    const hasValidLocation = latitude !== null && longitude !== null;
    const validateBasics = () => {
        if (!title.trim()) return 'Title is required';
        if (!start) return 'Start date is required';
        if (!end) return 'End date is required';
        if (new Date(end) < new Date(start)) return 'End must be after start';
        if (!location.trim()) return 'Location is required';
        return null;
    };
    const locationWarning = location.trim() && !hasValidLocation
        ? "We couldn't verify this address on the map. You can continue, but pick a suggestion for better accuracy."
        : null;
    const handleAllDayChange = (checked: boolean) => {
        setAllDay(checked);
        setStart((prev) => {
            if (!prev) return prev;
            return checked ? prev.slice(0, 10) : (prev.length === 10 ? `${prev}T00:00` : prev);
        });
        setEnd((prev) => {
            if (!prev) return prev;
            return checked ? prev.slice(0, 10) : (prev.length === 10 ? `${prev}T23:59` : prev);
        });
    };
    const isLinkFilled = (url: string) => url.trim().length > 0 && url.trim() !== 'https://';
    const isUrlValid = (url: string) => {
        try {
            new URL(url.trim());
            return true;
        } catch {
            return false;
        }
    };

    const validateTags = () => {
        if (requiredGroups.length === 0) return null;
        const danceOk = selectedCountForGroup(requiredDanceGroup) > 0;
        const reachOk = selectedCountForGroup(requiredReachGroup) > 0;
        if (!danceOk || !reachOk) return 'Select at least one dance style and one reach tag';
        return null;
    };

    const validatePrices = () => {
        if (priceIsFree) return null;
        let minValue: number | null = null;
        let maxValue: number | null = null;
        if (priceMin.trim()) {
            const n = Number(priceMin);
            if (!Number.isFinite(n) || n < 0) return 'Min price must be a positive number';
            minValue = n;
        }
        if (priceMax.trim()) {
            const n = Number(priceMax);
            if (!Number.isFinite(n) || n < 0) return 'Max price must be a positive number';
            maxValue = n;
        }
        if (minValue !== null && maxValue !== null && maxValue < minValue) return 'Max price must be ≥ min price';
        return null;
    };

    const validatePromo = () => {
        if (isLinkFilled(promoSourceUrl) && !isUrlValid(promoSourceUrl)) return 'Enter a valid promo URL';
        return null;
    };

    const validateLinks = () => {
        const invalid = links.some((link) => isLinkFilled(link.url) && !isUrlValid(link.url));
        if (invalid) return 'Please enter valid URLs for links';
        return null;
    };

    const handleLinkChange = (index: number, field: 'url' | 'label', value: string) => {
        setLinks((prev) => prev.map((link, i) => (i === index ? { ...link, [field]: value } : link)));
    };

    const addLink = () => {
        if (links.length < 3) setLinks((prev) => [...prev, { url: 'https://', label: '' }]);
    };

    const removeLink = (index: number) => {
        setLinks((prev) => prev.filter((_, i) => i !== index));
    };

    const moveToStep = (step: StepKey) => {
        setActiveStep((prev) => (prev === step ? null : step));
    };

    const validateCurrentStep = (step: StepKey): string | null => {
        if (step === 'basics') return validateBasics();
        if (step === 'links') return validateLinks();
        if (step === 'tags') return validateTags();
        if (step === 'price') return validatePrices();
        if (step === 'promo') return validatePromo();
        return null;
    };

    const isStepValid = (step: StepKey): boolean => validateCurrentStep(step) === null;

    const isStepFilled = (step: StepKey): boolean => {
        switch (step) {
            case 'description':
                return description.trim().length > 0;
            case 'links':
                return links.some((link) => isLinkFilled(link.url));
            case 'tags':
                return requiredGroups.length > 0 ? true : tagsCount > 0;
            case 'price':
                return priceIsFree || priceMin.trim().length > 0 || priceMax.trim().length > 0;
            case 'promo':
                return promoCode.trim().length > 0 || isLinkFilled(promoSourceUrl) || promoDescription.trim().length > 0;
            default:
                return true;
        }
    };

    const stepShowsCheck = (step: StepKey): boolean => isStepValid(step) && isStepFilled(step);

    const formatPriceRange = (): string => {
        if (priceIsFree) return 'Free';
        const min = priceMin.trim();
        const max = priceMax.trim();
        if (!min && !max) return 'No price set';
        if (min && max) return `${min}\u2013${max} ${priceCurrency}`;
        if (min) return `From ${min} ${priceCurrency}`;
        return `Up to ${max} ${priceCurrency}`;
    };

    const linkPillLabel = (link: LinkRow): string => {
        if (link.label.trim()) return link.label.trim();
        try {
            return new URL(link.url.trim()).hostname.replace(/^www\./, '');
        } catch {
            return 'Link';
        }
    };

    const goNext = (current: StepKey, next: StepKey | null) => {
        setAttempted((prev) => ({ ...prev, [current]: true }));
        const stepError = validateCurrentStep(current);
        if (stepError) return;
        if (next) setActiveStep(next);
    };

    const handleSubmit = async () => {
        const stepsToValidate: StepKey[] = ['basics', 'links', 'tags', 'price', 'promo'];
        for (const step of stepsToValidate) {
            const stepError = validateCurrentStep(step);
            if (stepError) {
                setAttempted((prev) => ({ ...prev, [step]: true }));
                setActiveStep(step);
                return;
            }
        }

        const validLinks = links
            .filter((link) => isLinkFilled(link.url))
            .map((link) => ({ url: link.url.trim(), label: link.label.trim() || null }));

        const selectedFreeTextTags = Object.entries(tagsValue.freeTexts)
            .map(([group_slug, free_text]) => ({ free_text: free_text.trim(), group_slug }))
            .filter((tag) => tag.free_text.length > 0);

        setSubmitting(true);
        setError('');
        try {
            await submitSuggestion({
                title: title.trim(),
                description: description.trim() || undefined,
                location: location.trim() || undefined,
                links: validLinks,
                latitude: latitude ?? undefined,
                longitude: longitude ?? undefined,
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString(),
                all_day: allDay,
                submitter_name: submitterName.trim() || undefined,
                submitter_email: submitterEmail.trim() || undefined,
                suggested_tag_ids: tagsValue.selectedTagIds,
                suggested_new_tags: selectedFreeTextTags,
                going,
                going_audience: going ? goingAudience : null,
                promo_code: promoCode.trim() || undefined,
                promo_description: promoDescription.trim() || undefined,
                promo_source_url: isLinkFilled(promoSourceUrl) ? promoSourceUrl.trim() : undefined,
                price_is_free: priceIsFree,
                price_min: priceIsFree ? null : (priceMin.trim() ? Number(priceMin) : null),
                price_max: priceIsFree ? null : (priceMax.trim() ? Number(priceMax) : null),
                price_currency: priceIsFree || (!priceMin.trim() && !priceMax.trim()) ? null : priceCurrency,
                auto_save: true,
                website,
                screen_size: `${screen.width}x${screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            setSuccess(true);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to submit suggestion';
            setError(message);
        } finally {
            setSubmitting(false);
        }
    };

    if (success) {
        return (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
                <div className="w-full max-w-md bg-white p-8 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="mb-3 text-4xl">🎉</div>
                    <h2 className="mb-2 text-base font-bold text-slate-900">Thank you!</h2>
                    <p className="mb-4 text-xs text-slate-600">
                        {user ? 'Your event is live and under review.' : 'Thank you! Your suggestion is under review.'}
                    </p>
                    <button onClick={onClose} className={btnPrimary}>
                        Close
                    </button>
                </div>
            </div>
        );
    }

    const renderBasicsSummary = (): ReactNode => {
        if (!title.trim()) return 'Set your event name, dates, and location';
        const dateLabel = formatDateRange(start, end, allDay);
        const locLabel = location.trim() ? locationPreview(location) : null;
        return (
            <div className="min-w-0">
                <div className="truncate font-medium text-slate-700">{title}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-slate-500">
                    {locLabel ? <span className="truncate">{locLabel}</span> : null}
                    {locLabel && dateLabel ? <span aria-hidden="true">·</span> : null}
                    {dateLabel ? <span className="shrink-0">{dateLabel}</span> : null}
                </div>
            </div>
        );
    };

    const renderDescriptionSummary = (): ReactNode => {
        if (!description.trim()) return 'Add a short description';
        return <p className="line-clamp-2 whitespace-pre-line">{description}</p>;
    };

    const renderLinksSummary = (): ReactNode => {
        const filled = links.filter((link) => isLinkFilled(link.url));
        if (!filled.length) return 'No links yet';
        return (
            <div className="flex flex-wrap gap-1">
                {filled.map((link, index) => (
                    <TagPillPreview key={index} label={linkPillLabel(link)} />
                ))}
            </div>
        );
    };

    const renderTagsSummary = (): ReactNode => {
        const selectedTags = tagsValue.selectedTagIds
            .map((id) => allTagsById.get(id))
            .filter((t): t is Tag => Boolean(t));
        const freeTextEntries = Object.entries(tagsValue.freeTexts).filter(([, v]) => v.trim());
        if (selectedTags.length === 0 && freeTextEntries.length === 0) return 'Pick dance style and reach tags';
        return (
            <div className="flex flex-wrap gap-1">
                {selectedTags.map((t) => (
                    <TagPillPreview key={t.id} label={t.label} color={t.color} />
                ))}
                {freeTextEntries.map(([slug, text]) => (
                    <TagPillPreview key={slug} label={text} />
                ))}
            </div>
        );
    };

    const renderPromoSummary = (): ReactNode => {
        if (promoCode.trim()) return `Code: ${promoCode.trim()}`;
        if (isLinkFilled(promoSourceUrl) || promoDescription.trim()) return 'Promo details added';
        return 'No promo code';
    };

    const renderRsvpSummary = (): ReactNode => {
        if (!user) return 'Anonymous submission';
        return going ? `Going as ${goingAudience}` : 'Not going';
    };

    const sectionBody = (key: StepKey) => {
        switch (key) {
            case 'basics':
                return (
                    <div className="space-y-3 pt-3">
                        <div>
                            <label className="mb-1 block font-medium text-slate-600">Title *</label>
                            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event name" className={inputClsFull} />
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                            <div>
                                <label className="mb-1 block font-medium text-slate-600">Start *</label>
                                <input type={allDay ? 'date' : 'datetime-local'} value={start} onChange={(e) => setStart(e.target.value)} className={inputClsFull} />
                            </div>
                            <div>
                                <label className="mb-1 block font-medium text-slate-600">End *</label>
                                <input type={allDay ? 'date' : 'datetime-local'} value={end} onChange={(e) => setEnd(e.target.value)} className={inputClsFull} />
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-slate-600">
                            <input type="checkbox" checked={allDay} onChange={(e) => handleAllDayChange(e.target.checked)} className="border-slate-300" />
                            All day
                        </label>
                        <div>
                            <label className="mb-1 block font-medium text-slate-600">Location *</label>
                            <AddressAutocomplete
                                value={location}
                                onChange={(value) => {
                                    setLocation(value);
                                    setLatitude(null);
                                    setLongitude(null);
                                }}
                                onSelect={(suggestion: GeocodeSuggestion) => {
                                    setLatitude(suggestion.latitude);
                                    setLongitude(suggestion.longitude);
                                }}
                                searchFn={searchSuggestionAddress}
                            />
                            {locationWarning ? <p className={warningCls}>{locationWarning}</p> : null}
                        </div>
                        {attempted.basics && validateBasics() ? <p className={warningCls}>{validateBasics()}</p> : null}
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" className={btnSecondary} onClick={() => goNext('basics', 'description')}>
                                Next
                            </button>
                        </div>
                    </div>
                );
            case 'description':
                return (
                    <div className="space-y-3 pt-3">
                        <div>
                            <textarea aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Tell us about the event…" className={inputClsFull} />
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" className={btnSecondary} onClick={() => goNext('description', 'links')}>Next</button>
                        </div>
                    </div>
                );
            case 'links':
                return (
                    <div className="space-y-3 pt-3">
                        <div>
                            {links.map((link, index) => (
                                <div key={index} className="mb-1.5 flex items-center gap-2">
                                    <input aria-label="Link URL" type="url" value={link.url} onChange={(e) => handleLinkChange(index, 'url', e.target.value)} placeholder="https://…" className={`${inputCls} min-w-0 flex-1`} />
                                    <input aria-label="Link label" type="text" value={link.label} onChange={(e) => handleLinkChange(index, 'label', e.target.value)} placeholder="Label" className={`${inputCls} w-28 shrink-0`} />
                                    {links.length > 1 ? (
                                        <button type="button" onClick={() => removeLink(index)} className="px-1 text-slate-400 hover:text-slate-700" aria-label="Remove link">✕</button>
                                    ) : (
                                        <span className="w-3 shrink-0" aria-hidden="true" />
                                    )}
                                </div>
                            ))}
                            {links.length < 3 ? (
                                <button type="button" onClick={addLink} className="text-blue-600 hover:text-blue-700">+ Add link</button>
                            ) : null}
                        </div>
                        {attempted.links && validateLinks() ? <p className={warningCls}>{validateLinks()}</p> : null}
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" className={btnSecondary} onClick={() => goNext('links', 'tags')}>Next</button>
                        </div>
                    </div>
                );
            case 'tags':
                return (
                    <div className="space-y-4 pt-3">
                        {requiredGroups.length > 0 ? (
                            <div className="space-y-4">
                                <div>
                                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Required tags</p>
                                    {requiredDanceGroup ? (
                                        <div className="mb-3 border border-slate-200 bg-slate-50 p-3">
                                            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">{requiredDanceGroup.label}</div>
                                            <TagsPicker tagGroups={[requiredDanceGroup]} value={tagsValue} onChange={setTagsValue} searchable={false} allowFreeText={false} />
                                        </div>
                                    ) : null}
                                    {requiredReachGroup ? (
                                        <div className="border border-slate-200 bg-slate-50 p-3">
                                            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">{requiredReachGroup.label}</div>
                                            <TagsPicker tagGroups={[requiredReachGroup]} value={tagsValue} onChange={setTagsValue} searchable={false} allowFreeText={false} />
                                        </div>
                                    ) : null}
                                </div>
                                <div className="border border-slate-200 p-3">
                                    <button
                                        type="button"
                                        onClick={() => setTagsOpen((value) => !value)}
                                        className="flex w-full items-center justify-between text-left"
                                        aria-expanded={tagsOpen}
                                    >
                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">+More tags{tagsCount > 0 ? ` · ${tagsCount}` : ''}</span>
                                        <span className="text-slate-400">{tagsOpen ? '▾' : '▸'}</span>
                                    </button>
                                    {tagsOpen ? (
                                        <div className="mt-3">
                                            <TagsPicker tagGroups={otherGroups} value={tagsValue} onChange={setTagsValue} />
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        ) : (
                            <div className="border border-slate-200 p-3">
                                <TagsPicker tagGroups={tagGroups} value={tagsValue} onChange={setTagsValue} />
                            </div>
                        )}
                        {attempted.tags && validateTags() ? <p className={warningCls}>{validateTags()}</p> : null}
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" className={btnSecondary} onClick={() => goNext('tags', 'price')}>Next</button>
                        </div>
                    </div>
                );
            case 'price':
                return (
                    <div className="space-y-4 pt-3">
                        <div className="border border-slate-200 p-3">
                            <label className="mb-2 flex items-center gap-2 text-slate-600">
                                <input type="checkbox" checked={priceIsFree} onChange={(e) => setPriceIsFree(e.target.checked)} className="border-slate-300" />
                                Free event
                            </label>
                            {!priceIsFree ? (
                                <div className="flex flex-wrap gap-2">
                                    <input type="number" min={0} step="0.01" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="Min" className={`${inputCls} w-20`} />
                                    <input type="number" min={0} step="0.01" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="Max" className={`${inputCls} w-20`} />
                                    <select value={priceCurrency} onChange={(e) => setPriceCurrency(e.target.value)} className={`${inputCls} w-20`}>
                                        <option value="EUR">EUR</option>
                                        <option value="USD">USD</option>
                                        <option value="GBP">GBP</option>
                                        <option value="CHF">CHF</option>
                                    </select>
                                </div>
                            ) : null}
                        </div>
                        {attempted.price && validatePrices() ? <p className={warningCls}>{validatePrices()}</p> : null}
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" className={btnSecondary} onClick={() => goNext('price', 'promo')}>Next</button>
                        </div>
                    </div>
                );
            case 'promo':
                return (
                    <div className="space-y-4 pt-3">
                        <div className="border border-slate-200 p-3">
                            <div className="space-y-2">
                                <input type="text" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="Promo code" className={inputClsFull} />
                                <input type="url" value={promoSourceUrl} onChange={(e) => setPromoSourceUrl(e.target.value)} placeholder="https://…" className={inputClsFull} />
                                <textarea value={promoDescription} onChange={(e) => setPromoDescription(e.target.value)} rows={3} placeholder="Promo details" className={inputClsFull} />
                            </div>
                        </div>
                        {attempted.promo && validatePromo() ? <p className={warningCls}>{validatePromo()}</p> : null}
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" className={btnSecondary} onClick={() => goNext('promo', 'rsvp')}>Next</button>
                        </div>
                    </div>
                );
            case 'rsvp':
                return (
                    <div className="space-y-4 pt-3">
                        {user ? (
                            <div className="border border-slate-200 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                                        <input type="checkbox" checked={going} onChange={(e) => setGoing(e.target.checked)} />
                                        Mark me going by default
                                    </label>
                                    {going ? (
                                        <div className="inline-flex shrink-0 overflow-hidden border border-slate-300">
                                            {(['friends', 'public', 'private'] as const).map((option) => (
                                                <button
                                                    key={option}
                                                    type="button"
                                                    onClick={() => setGoingAudience(option)}
                                                    className={`px-2 py-1 text-[11px] capitalize transition-colors ${goingAudience === option ? 'bg-blue-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                                >
                                                    {option}
                                                </button>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        ) : (
                            <div className="border border-slate-200 p-3 text-xs text-slate-600">
                                Sign in to default the Going toggle for your submission.
                            </div>
                        )}
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="flex w-full max-w-2xl flex-col bg-white shadow-2xl max-h-[90vh] text-xs" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-slate-100 px-6 pt-5 pb-4">
                    <div>
                        <h2 className="text-sm font-bold text-slate-900">Suggest an Event</h2>
                        <p className="mt-1 text-[11px] text-slate-500">Complete each section, then it collapses.</p>
                    </div>
                    <button onClick={onClose} className="p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="Close">✕</button>
                </div>

                <div className="overflow-y-auto overscroll-contain px-6 py-4 text-xs">
                    <div style={{ display: 'none' }} aria-hidden="true">
                        <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" />
                    </div>

                    <div className="space-y-4">
                        {steps.map((step) => {
                            const open = activeStep === step.key;
                            const valid = stepShowsCheck(step.key);
                            const summary: ReactNode =
                                step.key === 'basics'
                                    ? renderBasicsSummary()
                                    : step.key === 'description'
                                        ? renderDescriptionSummary()
                                        : step.key === 'links'
                                            ? renderLinksSummary()
                                            : step.key === 'tags'
                                                ? renderTagsSummary()
                                                : step.key === 'price'
                                                    ? formatPriceRange()
                                                    : step.key === 'promo'
                                                        ? renderPromoSummary()
                                                        : renderRsvpSummary();
                            return (
                                <section key={step.key} className="border-b border-slate-200 pb-4 last:border-b-0">
                                    <SectionHeader
                                        title={step.title}
                                        summary={!open ? summary : undefined}
                                        open={open}
                                        valid={valid}
                                        onToggle={() => moveToStep(step.key)}
                                    />
                                    {open ? sectionBody(step.key) : null}
                                </section>
                            );
                        })}
                    </div>

                    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                        <div>
                            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Contact</div>
                            <div className="grid gap-3 md:grid-cols-2">
                                <input type="text" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} placeholder="Your name" className={inputClsFull} />
                                <input type="email" value={submitterEmail} onChange={(e) => setSubmitterEmail(e.target.value)} placeholder="Your email" className={inputClsFull} />
                            </div>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            {error ? <p className="bg-slate-100 px-2 py-1 text-xs text-slate-700">{error}</p> : <div />}
                            <div className="flex gap-2">
                                <button onClick={onClose} className={btnSecondary}>Cancel</button>
                                <button onClick={handleSubmit} className={btnPrimary} disabled={submitting}>
                                    {submitting ? 'Submitting…' : 'Submit'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
