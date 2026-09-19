import type { TagsPickerValue } from '../TagsPicker';
import { NO_RECURRENCE, type RecurrenceState } from './recurrence';

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
    submitterName: string;
    submitterEmail: string;
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
        goingAudience: audience ?? 'friends',
        submitterName: name ?? '',
        submitterEmail: email ?? '',
        website: '',
    };
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
        state.links.length,
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
