import type { SuggestionImage } from '../../api';
import type { CalendarEvent, OwnSuggestion } from '../../types';
import type { TagsPickerValue } from '../TagsPicker';
import { browserTimeZone, toEditFields } from '../../utils/eventDates';
import { toZonedInput } from '../../utils/schedule';
import { parseLocal } from './datetime';
import { fromRRule, NO_RECURRENCE, type RecurrenceState } from './recurrence';

export interface LinkRow {
    url: string;
    label: string;
}

export type GoingAudience = 'public' | 'friends' | 'private';

/** Three distinct states: the submitter may also decline to say. */
export type PriceMode = 'none' | 'free' | 'paid';

/**
 * Every field the wizard collects, in one object. Steps receive the whole state
 * and a patch function so moving between steps never unmounts-and-loses data —
 * only the presentation changes.
 */
export interface SuggestFormState {
    title: string;
    description: string;
    location: string;
    latitude: number | null;
    longitude: number | null;
    links: LinkRow[];
    start: string;
    end: string;
    allDay: boolean;
    /** IANA zone the typed times are in: the venue's, else the browser's. */
    timezone: string;
    /** Set once the user edits the end themselves; stops it tracking the start. */
    endTouched: boolean;
    /** Times parked while All day is on, so turning it off can restore them. */
    hiddenTimes: { start: string; end: string } | null;
    recurrence: RecurrenceState;
    tagsValue: TagsPickerValue;
    priceMode: PriceMode;
    priceMin: string;
    priceMax: string;
    priceCurrency: string;
    promoCode: string;
    promoDescription: string;
    promoSourceUrl: string;
    going: boolean;
    goingAudience: GoingAudience;
    /** Ask curators to publish it; off keeps the event to its owner. */
    sharePublicly: boolean;
    /** Verified organizers: show them as its organizer once public. */
    isOrganizer: boolean;
    submitterName: string;
    submitterEmail: string;
    image: SuggestionImage | null;
    /** Honeypot — must stay empty for a real human. */
    website: string;
}

export type PatchState = (patch: Partial<SuggestFormState>) => void;

export function initialFormState(
    name: string | undefined,
    email: string | undefined,
    audience: GoingAudience | undefined,
    signedIn: boolean,
): SuggestFormState {
    return {
        title: '',
        description: '',
        location: '',
        latitude: null,
        longitude: null,
        links: [],
        start: '',
        end: '',
        allDay: false,
        timezone: browserTimeZone(),
        endTouched: false,
        hiddenTimes: null,
        recurrence: NO_RECURRENCE,
        tagsValue: { selectedTagIds: [], freeTexts: {} },
        priceMode: 'none',
        priceMin: '',
        priceMax: '',
        priceCurrency: 'EUR',
        promoCode: '',
        promoDescription: '',
        promoSourceUrl: '',
        going: signedIn,
        goingAudience: audience ?? 'public',
        sharePublicly: true,
        isOrganizer: false,
        submitterName: name ?? '',
        submitterEmail: email ?? '',
        image: null,
        website: '',
    };
}

type PrefillSource = Pick<
    OwnSuggestion,
    | 'title' | 'description' | 'location' | 'latitude' | 'longitude' | 'links' | 'start' | 'end' | 'all_day'
    | 'timezone' | 'recurrence_rule' | 'recurrence_dates' | 'suggested_tag_ids' | 'price_min' | 'price_max'
    | 'price_currency' | 'price_is_free' | 'image_key' | 'image_thumb_url'
>;

/** Prefill the wizard from a saved suggestion so its owner can edit it. */
export function formStateFromSuggestion(s: PrefillSource): SuggestFormState {
    const timezone = s.timezone || browserTimeZone();
    const allDayFields = s.all_day ? toEditFields(s) : null;
    const toInput = (iso: string, field: 'start' | 'end') => allDayFields?.[field] ?? toZonedInput(iso, timezone);
    const startDate = parseLocal(toZonedInput(s.start, timezone)) ?? new Date(s.start);
    const recurrence: RecurrenceState = s.recurrence_dates?.length
        ? {
            mode: 'dates',
            dates: s.recurrence_dates.map((d) => ({
                start: toZonedInput(d.start, timezone),
                end: toZonedInput(d.end, timezone),
            })),
        }
        : fromRRule(s.recurrence_rule, startDate);
    const paid = s.price_min != null || s.price_max != null;
    return {
        ...initialFormState(undefined, undefined, undefined, false),
        title: s.title,
        description: s.description ?? '',
        location: s.location ?? '',
        latitude: s.latitude,
        longitude: s.longitude,
        links: (s.links ?? []).map((l) => ({ url: l.url, label: l.label ?? '' })),
        start: toInput(s.start, 'start'),
        end: toInput(s.end, 'end'),
        allDay: s.all_day,
        timezone,
        endTouched: true,
        recurrence,
        tagsValue: { selectedTagIds: s.suggested_tag_ids ?? [], freeTexts: {} },
        priceMode: s.price_is_free ? 'free' : paid ? 'paid' : 'none',
        priceMin: s.price_min != null ? String(s.price_min) : '',
        priceMax: s.price_max != null ? String(s.price_max) : '',
        priceCurrency: s.price_currency ?? 'EUR',
        image:
            s.image_key && s.image_thumb_url
                ? { image_key: s.image_key, image_thumb_url: s.image_thumb_url }
                : null,
    };
}

/** Prefill the wizard from a live event for a suggested change. */
export function formStateFromEvent(e: CalendarEvent): SuggestFormState {
    return formStateFromSuggestion({
        title: e.title,
        description: e.description,
        location: e.location,
        latitude: e.latitude,
        longitude: e.longitude,
        links: e.links,
        start: e.start,
        end: e.end,
        all_day: e.all_day,
        timezone: e.timezone ?? null,
        recurrence_rule: null,
        recurrence_dates: null,
        suggested_tag_ids: e.tags.map((t) => t.id),
        price_min: e.price_min,
        price_max: e.price_max,
        price_currency: e.price_currency,
        price_is_free: e.price_is_free,
        image_key: null,
        image_thumb_url: null,
    });
}

/** True once the user has typed anything worth warning about on close. */
export function isDirty(state: SuggestFormState): boolean {
    return Boolean(
        state.title.trim() ||
        state.description.trim() ||
        state.location.trim() ||
        state.start ||
        state.promoCode.trim() ||
        state.tagsValue.selectedTagIds.length ||
        state.links.length ||
        state.image,
    );
}

export function isLinkFilled(url: string): boolean {
    const trimmed = url.trim();
    return trimmed.length > 0 && trimmed !== 'https://';
}

export function isUrlValid(url: string): boolean {
    try {
        const parsed = new URL(url.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/* ---------------------------------------------------------------- styling */
/* `rounded-field` (8px) is the wizard's field radius; 16px (`text-base`)
   inputs stop iOS zooming on focus and `min-h-12` keeps every interactive
   target above the 44px minimum. */

/* Split so the invalid variant swaps the border colour instead of stacking a
   second `border-*` utility, whose winner would depend on CSS source order. */
const inputBase =
    'w-full min-h-12 rounded-field border bg-surface px-4 py-3 text-base text-ink placeholder:text-muted focus:outline-none focus:ring-1';

export const inputCls = `${inputBase} border-line focus:border-action focus:ring-action`;

export const inputErrorCls = `${inputBase} border-danger focus:border-danger focus:ring-danger`;

export const btnPrimary =
    'flex min-h-12 w-full items-center justify-center rounded-field bg-action px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

export const btnSecondary =
    'flex min-h-12 w-full items-center justify-center rounded-field border border-line bg-surface px-4 text-sm font-semibold text-ink transition hover:bg-canvas';

const rowBase =
    'flex min-h-12 w-full items-center gap-3 rounded-field border bg-surface px-4 py-2 text-left transition hover:bg-canvas';

export const rowCls = `${rowBase} border-line`;

export const rowErrorCls = `${rowBase} border-danger`;

/** Small heading above a chip group, e.g. `Dance style *`. */
export const sectionLabelCls = 'mb-2 block text-sm font-semibold text-ink';

/** Caption for the sub-editor fields the screenshot does label, e.g. `Minimum`. */
export const fieldLabelCls = 'mb-1.5 block text-xs font-medium text-ink-soft';

export const errorCls = 'mt-2 rounded-field border border-line bg-canvas px-3 py-2 text-xs text-danger';

/** Inline message pinned under the control it belongs to. */
export const fieldErrorCls = 'mt-1.5 text-xs font-medium text-danger';

export const helpCls = 'mt-1.5 text-xs text-ink-soft';

export function chipCls(active: boolean): string {
    return `min-h-9 rounded-field border px-3 py-1.5 text-sm font-medium transition ${active ? 'border-action bg-action text-white' : 'border-line bg-canvas text-ink-soft hover:bg-surface'
        }`;
}

/** Keeps focused inputs above the on-screen keyboard on small devices. */
export function scrollIntoViewOnFocus(e: React.FocusEvent<HTMLElement>) {
    const target = e.currentTarget;
    window.setTimeout(() => {
        // jsdom (and very old browsers) do not implement scrollIntoView.
        target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, 250);
}
