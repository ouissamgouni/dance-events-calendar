import type { TagGroup } from '../../types';
import { isLinkFilled, isUrlValid, type SuggestFormState } from './formState';
import { hasDuplicateDates } from './recurrence';
import { parseLocal } from './datetime';

export type StepIndex = 1 | 2 | 3;

/** Every control a validation message can be pinned to. */
export type FieldId =
    | 'title'
    | 'location'
    | 'start'
    | 'end'
    | 'recurrence'
    | 'links'
    | 'danceTags'
    | 'reachTags'
    | 'pricing'
    | 'promo';

export interface FieldError {
    field: FieldId;
    message: string;
}

/** DOM id of the control each error focuses, so a failed step can jump to it. */
export const FIELD_ANCHOR: Record<FieldId, string> = {
    title: 'suggest-title',
    location: 'suggest-location',
    start: 'suggest-start',
    end: 'suggest-end',
    recurrence: 'suggest-repeat',
    links: 'suggest-links',
    danceTags: 'suggest-dance',
    reachTags: 'suggest-reach',
    pricing: 'suggest-pricing',
    promo: 'suggest-promo',
};

const err = (field: FieldId, message: string): FieldError => ({ field, message });

function selectedCountForGroup(state: SuggestFormState, group: TagGroup | null): number {
    if (!group) return 0;
    const selected = new Set(state.tagsValue.selectedTagIds);
    return (group.tags ?? []).filter((t) => t.enabled !== false && selected.has(t.id)).length;
}

function validateStep1(state: SuggestFormState): FieldError | null {
    // Order matches the on-screen order so the error always points forwards.
    if (!state.title.trim()) return err('title', 'Add an event name.');
    if (!state.location.trim()) return err('location', 'Add a location.');
    if (!state.start) return err('start', 'Pick a start date.');
    if (!state.end) return err('end', 'Pick an end date.');
    if (new Date(state.end) < new Date(state.start)) {
        return err('end', 'The end must come after the start.');
    }
    if (state.recurrence.mode === 'dates') {
        if (state.recurrence.dates.length === 0) {
            return err('recurrence', 'Add at least one date, or turn off Repeat.');
        }
        const bad = state.recurrence.dates.some((d) => {
            const from = parseLocal(d.start);
            const to = parseLocal(d.end);
            return !from || !to || to <= from;
        });
        if (bad) {
            return err('recurrence', 'Every selected date needs an end time after its start time.');
        }
        if (hasDuplicateDates(state.recurrence.dates)) {
            return err('recurrence', 'Two dates have the same start time.');
        }
    }
    if (state.recurrence.mode === 'weekly' && state.recurrence.weekdays.length === 0) {
        return err('recurrence', 'Pick at least one weekday to repeat on.');
    }
    return null;
}

function validateStep2(
    state: SuggestFormState,
    danceGroup: TagGroup | null,
    reachGroup: TagGroup | null,
): FieldError | null {
    if (state.links.some((l) => isLinkFilled(l.url) && !isUrlValid(l.url))) {
        return err('links', 'One of your links is not a valid URL.');
    }
    if (danceGroup && selectedCountForGroup(state, danceGroup) === 0) {
        return err('danceTags', `Pick at least one ${danceGroup.label.toLowerCase()}.`);
    }
    if (reachGroup && selectedCountForGroup(state, reachGroup) === 0) {
        return err('reachTags', `Pick at least one ${reachGroup.label.toLowerCase()}.`);
    }
    return null;
}

function validateStep3(state: SuggestFormState): FieldError | null {
    if (state.priceMode === 'paid') {
        let min: number | null = null;
        let max: number | null = null;
        if (state.priceMin.trim()) {
            const n = Number(state.priceMin);
            if (!Number.isFinite(n) || n < 0) {
                return err('pricing', 'The minimum price must be a positive number.');
            }
            min = n;
        }
        if (state.priceMax.trim()) {
            const n = Number(state.priceMax);
            if (!Number.isFinite(n) || n < 0) {
                return err('pricing', 'The maximum price must be a positive number.');
            }
            max = n;
        }
        if (min === null && max === null) return err('pricing', 'Enter a price, or choose Free event.');
        if (min !== null && max !== null && max < min) {
            return err('pricing', 'The maximum price must be at least the minimum.');
        }
    }
    if (isLinkFilled(state.promoSourceUrl) && !isUrlValid(state.promoSourceUrl)) {
        return err('promo', 'The promo link is not a valid URL.');
    }
    return null;
}

export function validateStep(
    step: StepIndex,
    state: SuggestFormState,
    danceGroup: TagGroup | null,
    reachGroup: TagGroup | null,
): FieldError | null {
    if (step === 1) return validateStep1(state);
    if (step === 2) return validateStep2(state, danceGroup, reachGroup);
    return validateStep3(state);
}

/**
 * First step that still has a problem, so a failed submit can jump straight to
 * it instead of showing an error the user cannot see the cause of.
 */
export function firstInvalidStep(
    state: SuggestFormState,
    danceGroup: TagGroup | null,
    reachGroup: TagGroup | null,
): { step: StepIndex; error: FieldError } | null {
    for (const step of [1, 2, 3] as StepIndex[]) {
        const error = validateStep(step, state, danceGroup, reachGroup);
        if (error) return { step, error };
    }
    return null;
}
