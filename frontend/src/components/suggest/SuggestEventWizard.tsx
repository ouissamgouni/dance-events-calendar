import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import useBackToClose from '../../hooks/useBackToClose';
import { Check, ChevronLeft, X } from 'lucide-react';
import type { SimilarEvent, SiteSettings } from '../../api';
import { fetchEvent, fetchOwnSuggestion, fetchSettings, fetchSimilarEvents, fetchTagGroups, proposeEventChange, submitEventPromoCode, submitSuggestion, updateOwnSuggestion } from '../../api';
import type { CalendarEvent, EventChangeCreate, TagGroup } from '../../types';
import EventModal from '../EventModal';
import { useAuth } from '../../context/AuthContext';
import Step1Event from './Step1Event';
import Step2Details from './Step2Details';
import Step3Publish from './Step3Publish';
import StepProgress from './StepProgress';
import { toOccurrenceDates, toRRule } from './recurrence';
import {
    btnPrimary,
    btnSecondary,
    formStateFromEvent,
    formStateFromSuggestion,
    initialFormState,
    isDirty,
    isLinkFilled,
    type SuggestFormState,
} from './formState';
import { datePart, parseLocal } from './datetime';
import { allDayBounds } from '../../utils/eventDates';
import { zonedInputToIso } from '../../utils/schedule';
import {
    FIELD_ANCHOR,
    firstInvalidStep,
    validateStep,
    type FieldError,
    type StepIndex,
} from './validation';

interface Props {
    onClose: () => void;
    /** Edit this saved suggestion instead of creating a new one. */
    suggestionId?: string;
    /** Suggest a change to this public event (reviewed by an admin, also for its organizer). */
    changeEventId?: string;
}

const STEP_TITLES: Record<StepIndex, string> = {
    1: 'Event',
    2: 'Details',
    3: 'Publish',
};

/** Sends the user straight to the control that blocked the step. */
function focusField(error: FieldError) {
    // After the step that owns the control has rendered its error.
    requestAnimationFrame(() => {
        const el = document.getElementById(FIELD_ANCHOR[error.field]);
        if (!el) return;
        el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        el.focus({ preventScroll: true });
    });
}

/** Wizard wall-clock value → UTC ISO, read in the event's time zone. */
function toIso(value: string, timeZone: string): string {
    if (value.length >= 16) return zonedInputToIso(value.slice(0, 16), timeZone);
    const date = parseLocal(value);
    return (date ?? new Date(value)).toISOString();
}

function eventBounds(state: SuggestFormState): { start: string; end: string } {
    return state.allDay
        ? allDayBounds(datePart(state.start), datePart(state.end))
        : { start: toIso(state.start, state.timezone), end: toIso(state.end, state.timezone) };
}

/** Only what the user changed from the live event; the server diffs again. */
function changedFields(
    state: SuggestFormState,
    base: SuggestFormState,
    bounds: { start: string; end: string },
    priced: boolean,
): EventChangeCreate {
    const body: EventChangeCreate = {};
    if (state.title.trim() !== base.title.trim()) body.title = state.title.trim();
    if (state.description.trim() !== base.description.trim()) body.description = state.description.trim() || null;
    if (state.location.trim() !== base.location.trim() || state.latitude !== base.latitude) {
        body.location = state.location.trim() || null;
        body.latitude = state.latitude;
        body.longitude = state.longitude;
    }
    if (state.start !== base.start || state.end !== base.end || state.allDay !== base.allDay || state.timezone !== base.timezone) {
        body.start = bounds.start;
        body.end = bounds.end;
        body.all_day = state.allDay;
    }
    const links = state.links
        .filter((l) => isLinkFilled(l.url))
        .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null }));
    if (JSON.stringify(state.links) !== JSON.stringify(base.links)) body.links = links;
    const ids = [...state.tagsValue.selectedTagIds].sort((a, b) => a - b);
    if (JSON.stringify(ids) !== JSON.stringify([...base.tagsValue.selectedTagIds].sort((a, b) => a - b))) body.tag_ids = ids;
    if (
        state.priceMode !== base.priceMode ||
        state.priceMin !== base.priceMin ||
        state.priceMax !== base.priceMax ||
        state.priceCurrency !== base.priceCurrency
    ) {
        body.price_is_free = state.priceMode === 'free' ? true : state.priceMode === 'paid' ? false : null;
        body.price_min = priced && state.priceMin.trim() ? Number(state.priceMin) : null;
        body.price_max = priced && state.priceMax.trim() ? Number(state.priceMax) : null;
        body.price_currency = priced && (state.priceMin.trim() || state.priceMax.trim()) ? state.priceCurrency : null;
    }
    return body;
}

/**
 * Full-screen, three-step event creation flow. All steps share one state
 * object, so moving between them (or in and out of a sub-page) never loses
 * input.
 *
 * The header and the sticky footer are unmounted whenever a step opens a
 * sub-page: `Submit Event` must never be reachable from a sub-editor, and each
 * sub-editor confirms with its own `Done`/`Save` instead.
 */
export default function SuggestEventWizard({ onClose, suggestionId, changeEventId }: Props) {
    const changing = Boolean(changeEventId);
    const editing = Boolean(suggestionId) || changing;
    const { user, loading: authLoading } = useAuth();
    const [changeBase, setChangeBase] = useState<CalendarEvent | null>(null);
    const organizer = Boolean(user && changeBase?.organizer?.user_id === user.user_id);
    const [settings, setSettings] = useState<SiteSettings | null>(null);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
    const canOrganize = Boolean(user?.is_verified_organizer && settings?.organizer_claims_enabled);

    const [step, setStep] = useState<StepIndex>(1);
    const [subPageOpen, setSubPageOpen] = useState(false);
    const [stepError, setStepError] = useState<FieldError | null>(null);
    const [submitError, setSubmitError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(false);
    const [savedForReview, setSavedForReview] = useState(false);
    const [confirmingClose, setConfirmingClose] = useState(false);
    useBackToClose(() => setConfirmingClose(false), confirmingClose);
    const [discarding, setDiscarding] = useState(false);
    const [similar, setSimilar] = useState<SimilarEvent[] | null>(null);
    const [sentPublic, setSentPublic] = useState(false);
    const [preview, setPreview] = useState<CalendarEvent | null>(null);
    const checkedSimilarFor = useRef<string | null>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);
    useEffect(() => {
        if (!discarding || confirmingClose) return;
        // The confirm dialog's history entry unwinds asynchronously; leaving before it
        // does would make our back-navigation only dismiss the dialog.
        const finish = () => onCloseRef.current();
        const timer = setTimeout(() => {
            if ((window.history.state as { __overlay?: number } | null)?.__overlay !== undefined) {
                window.addEventListener('popstate', finish, { once: true });
            } else {
                finish();
            }
        }, 0);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('popstate', finish);
        };
    }, [discarding, confirmingClose]);
    const appliedUserDefaults = useRef(false);

    const [state, setState] = useState<SuggestFormState>(() =>
        initialFormState(
            user?.name,
            user?.email,
            user?.share_attendance_default_audience ?? undefined,
            Boolean(user),
        ),
    );

    const patch = useCallback((next: Partial<SuggestFormState>) => {
        setState((prev) => ({ ...prev, ...next }));
        setStepError(null);
    }, []);

    const [loadedState, setLoadedState] = useState<SuggestFormState | null>(null);
    const [loadError, setLoadError] = useState('');

    useEffect(() => {
        if (!suggestionId) return;
        let cancelled = false;
        fetchOwnSuggestion(suggestionId)
            .then((suggestion) => {
                if (cancelled) return;
                if (!suggestion.can_edit) {
                    setLoadError(
                        suggestion.edit_locked
                            ? 'An admin has locked this event, so it can no longer be edited.'
                            : 'This event was removed, so it can no longer be edited.',
                    );
                    return;
                }
                // Re-editing picks up the change already awaiting review.
                const pendingValues = Object.fromEntries(
                    Object.entries(suggestion.pending_changes ?? {}).map(([field, change]) => [field, change.new]),
                );
                const prefilled = formStateFromSuggestion({ ...suggestion, ...pendingValues });
                setState(prefilled);
                setLoadedState(prefilled);
            })
            .catch((err: unknown) => {
                if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load your event');
            });
        return () => {
            cancelled = true;
        };
    }, [suggestionId]);

    useEffect(() => {
        if (!changeEventId) return;
        let cancelled = false;
        fetchEvent(changeEventId, { fresh: true })
            .then((event) => {
                if (cancelled) return;
                const prefilled = formStateFromEvent(event);
                setChangeBase(event);
                setState(prefilled);
                setLoadedState(prefilled);
            })
            .catch((err: unknown) => {
                if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load this event');
            });
        return () => {
            cancelled = true;
        };
    }, [changeEventId]);

    useEffect(() => {
        // Auth resolves after the first render, so seed the signed-in defaults
        // once it arrives — but only once, or we would fight the user's edits.
        if (!user || appliedUserDefaults.current || editing) return;
        appliedUserDefaults.current = true;
        setState((prev) => ({
            ...prev,
            submitterName: prev.submitterName || (user.name ?? ''),
            submitterEmail: prev.submitterEmail || (user.email ?? ''),
            going: true,
            goingAudience: user.share_attendance_default_audience ?? prev.goingAudience,
            isOrganizer: Boolean(user.is_verified_organizer),
        }));
    }, [user, editing]);

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

    const danceGroup = useMemo(() => {
        const explicit = settings?.suggest_event_required_dance_group_id;
        const found = explicit
            ? (tagGroups.find((g) => g.id === explicit) ?? null)
            : (tagGroups.find((g) => g.slug === 'dance-style') ?? null);
        return found && found.enabled !== false ? found : null;
    }, [settings?.suggest_event_required_dance_group_id, tagGroups]);

    const reachGroup = useMemo(() => {
        const explicit = settings?.suggest_event_required_reach_group_id;
        const found = explicit
            ? (tagGroups.find((g) => g.id === explicit) ?? null)
            : (tagGroups.find((g) => g.slug === 'reach') ?? null);
        return found && found.enabled !== false ? found : null;
    }, [settings?.suggest_event_required_reach_group_id, tagGroups]);

    // Existing events may predate the required tags; a change shouldn't be blocked on them.
    const requiredDance = changing ? null : danceGroup;
    const requiredReach = changing ? null : reachGroup;

    const otherGroups = useMemo(
        () =>
            tagGroups.filter(
                (g) => g.id !== danceGroup?.id && g.id !== reachGroup?.id && g.enabled !== false,
            ),
        [tagGroups, danceGroup?.id, reachGroup?.id],
    );

    // The upload endpoints require a session; anonymous submitters get no picker.
    const imagesAllowed = Boolean(user) && settings?.event_images_enabled !== false && !changing;

    const requestClose = useCallback(() => {
        const dirty = editing
            ? loadedState !== null && JSON.stringify(state) !== JSON.stringify(loadedState)
            : isDirty(state);
        if (dirty && !success) {
            setConfirmingClose(true);
            return;
        }
        onClose();
    }, [editing, loadedState, state, success, onClose]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Sub-pages handle their own Escape first.
            if (e.key === 'Escape' && !subPageOpen && !preview) requestClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [subPageOpen, preview, requestClose]);

    const goNext = async () => {
        const invalid = validateStep(step, state, requiredDance, requiredReach);
        if (invalid) {
            setStepError(invalid);
            focusField(invalid);
            return;
        }
        setStepError(null);
        if (step === 1 && !editing) {
            const bounds = eventBounds(state);
            const key = `${state.title.trim()}|${bounds.start}`;
            if (checkedSimilarFor.current !== key) {
                checkedSimilarFor.current = key;
                const found = await fetchSimilarEvents(state.title.trim(), bounds.start, bounds.end).catch(() => []);
                if (found.length > 0) {
                    setSimilar(found);
                    return;
                }
            }
        }
        setStep((s) => (s === 3 ? s : ((s + 1) as StepIndex)));
    };

    const continueWithoutMatch = () => {
        setSimilar(null);
        setStep(2);
    };

    const goBack = () => {
        setStepError(null);
        setStep((s) => (s === 1 ? s : ((s - 1) as StepIndex)));
    };

    const handleSubmit = async () => {
        const invalid = firstInvalidStep(state, requiredDance, requiredReach);
        if (invalid) {
            setStep(invalid.step);
            setStepError(invalid.error);
            focusField(invalid.error);
            return;
        }

        const startDate = parseLocal(state.start) ?? new Date(state.start);
        const bounds = eventBounds(state);
        const manualDates = toOccurrenceDates(state.recurrence);
        const priced = state.priceMode === 'paid';
        const rrule = toRRule(state.recurrence, startDate);
        // Past one-off events can only be kept private.
        const publicRequest =
            state.sharePublicly && (Boolean(rrule) || Boolean(manualDates) || new Date(bounds.end) >= new Date());
        const newTags = Object.entries(state.tagsValue.freeTexts)
            .map(([group_slug, free_text]) => ({ free_text: free_text.trim(), group_slug }))
            .filter((t) => t.free_text.length > 0);

        setSubmitting(true);
        setSubmitError('');
        try {
            if (changeEventId && changeBase && loadedState) {
                const body = changedFields(state, loadedState, bounds, priced);
                const promo = state.promoCode.trim();
                if (Object.keys(body).length === 0 && !promo && newTags.length === 0) {
                    setSubmitError('Nothing changed yet.');
                    return;
                }
                if (Object.keys(body).length > 0 || newTags.length > 0) {
                    await proposeEventChange(changeEventId, newTags.length > 0 ? { ...body, suggested_new_tags: newTags } : body);
                }
                if (promo) {
                    await submitEventPromoCode(changeEventId, {
                        code: promo,
                        description: state.promoDescription.trim() || null,
                        source_url: isLinkFilled(state.promoSourceUrl) ? state.promoSourceUrl.trim() : null,
                    });
                }
                setSuccess(true);
                return;
            }
            if (suggestionId) {
                const saved = await updateOwnSuggestion(suggestionId, {
                    title: state.title.trim(),
                    // null, not undefined, so clearing a field is sent.
                    description: state.description.trim() || null,
                    location: state.location.trim() || null,
                    links: state.links
                        .filter((l) => isLinkFilled(l.url))
                        .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null })),
                    latitude: state.latitude,
                    longitude: state.longitude,
                    start: bounds.start,
                    end: bounds.end,
                    all_day: state.allDay,
                    event_timezone: state.timezone,
                    recurrence_rule: toRRule(state.recurrence, startDate),
                    recurrence_dates: manualDates
                        ? manualDates.map((d) => ({ start: toIso(d.start, state.timezone), end: toIso(d.end, state.timezone) }))
                        : null,
                    suggested_tag_ids: state.tagsValue.selectedTagIds,
                    ...(newTags.length > 0 ? { suggested_new_tags: newTags } : {}),
                    price_is_free: state.priceMode === 'free',
                    price_min: priced && state.priceMin.trim() ? Number(state.priceMin) : null,
                    price_max: priced && state.priceMax.trim() ? Number(state.priceMax) : null,
                    price_currency:
                        priced && (state.priceMin.trim() || state.priceMax.trim())
                            ? state.priceCurrency
                            : null,
                    image_key: imagesAllowed ? (state.image?.image_key ?? null) : undefined,
                });
                setSavedForReview(saved.status === 'approved');
                setSuccess(true);
                return;
            }
            await submitSuggestion({
                title: state.title.trim(),
                description: state.description.trim() || undefined,
                location: state.location.trim() || undefined,
                links: state.links
                    .filter((l) => isLinkFilled(l.url))
                    .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null })),
                latitude: state.latitude ?? undefined,
                longitude: state.longitude ?? undefined,
                start: bounds.start,
                end: bounds.end,
                all_day: state.allDay,
                event_timezone: state.timezone,
                recurrence_rule: rrule,
                recurrence_dates: manualDates
                    ? manualDates.map((d) => ({ start: toIso(d.start, state.timezone), end: toIso(d.end, state.timezone) }))
                    : null,
                submitter_name: state.submitterName.trim() || undefined,
                submitter_email: state.submitterEmail.trim() || undefined,
                suggested_tag_ids: state.tagsValue.selectedTagIds,
                suggested_new_tags: newTags,
                going: state.going,
                going_audience: state.going ? state.goingAudience : null,
                is_organizer: canOrganize && publicRequest && state.isOrganizer,
                promo_code: state.promoCode.trim() || undefined,
                promo_description: state.promoDescription.trim() || undefined,
                promo_source_url: isLinkFilled(state.promoSourceUrl)
                    ? state.promoSourceUrl.trim()
                    : undefined,
                price_is_free: state.priceMode === 'free',
                price_min: priced && state.priceMin.trim() ? Number(state.priceMin) : null,
                price_max: priced && state.priceMax.trim() ? Number(state.priceMax) : null,
                price_currency:
                    priced && (state.priceMin.trim() || state.priceMax.trim())
                        ? state.priceCurrency
                        : null,
                auto_save: true,
                share_publicly: publicRequest,
                image_key: imagesAllowed ? state.image?.image_key : undefined,
                website: state.website,
                screen_size: `${screen.width}x${screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            setSentPublic(publicRequest);
            setSuccess(true);
        } catch (err: unknown) {
            setSubmitError(err instanceof Error ? err.message : 'Failed to submit suggestion');
        } finally {
            setSubmitting(false);
        }
    };

    const shellCls =
        'fixed inset-0 z-[9999] flex flex-col bg-surface animate-slide-up ' +
        // A fixed height on desktop: sub-pages replace the body, and an auto
        // height would collapse the card to nothing while one is open.
        'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(40rem,85dvh)] sm:w-full sm:max-w-2xl ' +
        'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:shadow-2xl';

    if (success) {
        return (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
                <div className="w-full max-w-md rounded-card bg-surface p-8 text-center shadow-2xl">
                    <span
                        // eslint-disable-next-line no-restricted-syntax -- circular success badge
                        className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success/10"
                    >
                        <Check size={28} className="text-success" aria-hidden="true" />
                    </span>
                    <h2 className="mb-2 text-base font-bold text-ink">
                        {changing
                            ? organizer ? 'Changes sent for review' : 'Suggestion sent'
                            : savedForReview
                                ? 'Changes sent for review'
                                : editing
                                    ? 'Changes saved'
                                    : user && !sentPublic
                                        ? 'Event added'
                                        : 'Event submitted'}
                    </h2>
                    <p className="mb-5 text-sm text-ink-soft">
                        {changing
                            ? organizer
                                ? 'Our team reviews organizer changes before they go live. People who saved or are going are told about time, venue or title changes once applied.'
                                : 'Thanks — a curator will review it. Track it in Events I added.'
                            : savedForReview
                                ? 'Your event stays as it is until a curator approves your changes. Track them in Events I added.'
                                : editing
                                    ? 'Your event has been updated.'
                                    : !user
                                        ? 'Your suggestion is under review. We will publish it once a curator approves it.'
                                        : sentPublic
                                            ? "It's in your events now. Others will see it once a curator makes it public."
                                            : 'Only you can see it. You can ask to make it public anytime from Events I added.'}
                    </p>
                    <button type="button" onClick={onClose} className={btnPrimary}>
                        Done
                    </button>
                </div>
            </div>
        );
    }

    if (!authLoading && !user) {
        return (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
                <div
                    className="w-full max-w-md rounded-card bg-surface p-6 text-center shadow-2xl"
                    role="dialog"
                    aria-modal="true"
                    aria-label={changing ? 'Sign in to suggest a change' : 'Sign in to add an event'}
                >
                    <h2 className="mb-2 text-base font-bold text-ink">
                        {changing ? 'Sign in to suggest a change' : 'Sign in to add an event'}
                    </h2>
                    <p className="mb-5 text-sm text-ink-soft">
                        {changing
                            ? 'Spotted something wrong? Sign in and a curator will review your fix.'
                            : 'Events you add go straight into your calendar, and you can ask to make them public.'}
                    </p>
                    <div className="flex gap-2">
                        <button type="button" onClick={onClose} className={btnSecondary}>
                            Not now
                        </button>
                        <Link
                            to={`/login?next=${encodeURIComponent(changeEventId ? `/event/${changeEventId}/suggest-change` : '/suggest')}`}
                            className={btnPrimary}
                        >
                            Sign in
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    if (editing && !loadedState) {
        return (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
                <div
                    className="w-full max-w-md rounded-card bg-surface p-6 text-center shadow-2xl"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Edit event"
                >
                    {loadError ? (
                        <>
                            <p className="mb-5 text-sm text-ink-soft">{loadError}</p>
                            <button type="button" onClick={onClose} className={btnPrimary}>
                                Close
                            </button>
                        </>
                    ) : (
                        <p className="text-sm text-ink-soft" role="status">
                            Loading your event…
                        </p>
                    )}
                </div>
            </div>
        );
    }

    const stepProps = {
        state,
        patch,
        error: stepError,
        onSubPageChange: setSubPageOpen,
    };

    const stepValid = validateStep(step, state, requiredDance, requiredReach) === null;
    const heading = changing ? (organizer ? 'Edit event' : 'Suggest a change') : editing ? 'Edit event' : 'Suggest an event';

    return (
        <>
            <div
                className="fixed inset-0 z-[9998] hidden bg-black/50 backdrop-blur-sm sm:block"
                onClick={requestClose}
            />
            <section
                className={shellCls}
                role="dialog"
                aria-modal="true"
                aria-label={heading}
            >
                {!subPageOpen ? (
                    <header className="shrink-0 px-4 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 sm:pt-2">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={step === 1 ? requestClose : goBack}
                                aria-label={step > 1 ? 'Back' : 'Close'}
                                className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft transition hover:text-ink"
                            >
                                {step > 1 ? (
                                    <ChevronLeft size={20} aria-hidden="true" />
                                ) : (
                                    <X size={20} aria-hidden="true" />
                                )}
                            </button>
                            <h1 className="min-w-0 flex-1 truncate text-center text-base font-bold text-ink">
                                {heading}
                            </h1>
                            <span className="h-11 w-11 shrink-0" aria-hidden="true" />
                        </div>
                        <StepProgress step={step} total={3} label={STEP_TITLES[step]} />
                    </header>
                ) : null}

                {/* Positioned so a step's sub-page can cover the whole body. */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <div
                        className={
                            subPageOpen
                                ? 'flex min-h-0 flex-1 flex-col'
                                : 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2 pb-24'
                        }
                    >
                        <div style={{ display: 'none' }} aria-hidden="true">
                            <input
                                type="text"
                                name="website"
                                value={state.website}
                                onChange={(e) => patch({ website: e.target.value })}
                                tabIndex={-1}
                                autoComplete="off"
                            />
                        </div>

                        {similar ? (
                            <div data-testid="similar-events">
                                <h2 className="text-base font-semibold text-ink">Is it one of these?</h2>
                                <p className="mt-1 text-sm text-ink-soft">
                                    These events look like yours. If it's listed, open it and mark yourself as going instead of adding it again.
                                </p>
                                <ul className="mt-3 space-y-2">
                                    {similar.map((match) => (
                                        <li key={match.event_id}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    fetchEvent(match.event_id).then(setPreview).catch(() => { });
                                                }}
                                                className="block w-full rounded-card border border-card-line bg-surface p-3 text-left transition hover:bg-canvas"
                                            >
                                                <span className="block text-sm font-semibold text-ink">{match.title}</span>
                                                <span className="block text-xs text-ink-soft">
                                                    {new Date(match.start).toLocaleString(undefined, {
                                                        weekday: 'short',
                                                        day: 'numeric',
                                                        month: 'short',
                                                        ...(match.all_day ? {} : { hour: '2-digit', minute: '2-digit' }),
                                                    })}
                                                    {match.location ? ` · ${match.location}` : ''}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : step === 1 ? (
                            <Step1Event {...stepProps} allowRepeat={!changing} />
                        ) : step === 2 ? (
                            <Step2Details
                                {...stepProps}
                                danceGroup={danceGroup}
                                reachGroup={reachGroup}
                                otherGroups={otherGroups}
                                imagesAllowed={imagesAllowed}
                            />
                        ) : (
                            <Step3Publish {...stepProps} signedIn={Boolean(user)} editing={editing && !changing} changing={changing} canOrganize={canOrganize} promoEnabled={settings?.promo_codes_enabled === true} />
                        )}

                        {submitError && !subPageOpen ? (
                            <p className="mt-3 rounded-field bg-canvas px-3 py-2 text-sm text-danger">
                                {submitError}
                            </p>
                        ) : null}
                    </div>
                </div>

                {!subPageOpen ? (
                    <div className="shrink-0 bg-surface px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                        {similar ? (
                            <div className="flex gap-2">
                                <button type="button" onClick={() => setSimilar(null)} className={btnSecondary}>
                                    Back
                                </button>
                                <button type="button" onClick={continueWithoutMatch} className={btnPrimary}>
                                    None of these, continue
                                </button>
                            </div>
                        ) : step < 3 ? (
                            <button
                                type="button"
                                onClick={goNext}
                                // `aria-disabled`, not `disabled`: the click still has to
                                // land so it can reveal and focus the blocking field.
                                aria-disabled={!stepValid}
                                className={`${btnPrimary} ${stepValid ? '' : 'opacity-50'}`}
                            >
                                Next
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={handleSubmit}
                                disabled={submitting}
                                aria-disabled={!stepValid || undefined}
                                className={`${btnPrimary} ${stepValid ? '' : 'opacity-50'}`}
                            >
                                {submitting
                                    ? editing
                                        ? 'Saving…'
                                        : 'Submitting…'
                                    : changing
                                        ? organizer ? 'Submit for review' : 'Send suggestion'
                                        : editing
                                            ? 'Save changes'
                                            : 'Submit Event'}
                            </button>
                        )}
                    </div>
                ) : null}
            </section>

            {preview ? <EventModal event={preview} onClose={() => setPreview(null)} source="suggest-similar" /> : null}

            {confirmingClose ? (
                <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4">
                    <div className="w-full max-w-sm rounded-card bg-surface p-5 shadow-2xl">
                        <h2 className="text-sm font-bold text-ink">
                            {editing ? 'Discard your changes?' : 'Discard this event?'}
                        </h2>
                        <p className="mt-1 text-sm text-ink-soft">
                            {editing ? 'Your event stays as it was.' : 'Everything you entered will be lost.'}
                        </p>
                        <div className="mt-4 flex gap-2">
                            <button
                                type="button"
                                className={btnSecondary}
                                onClick={() => setConfirmingClose(false)}
                            >
                                Keep editing
                            </button>
                            <button
                                type="button"
                                className={btnPrimary}
                                onClick={() => {
                                    setDiscarding(true);
                                    setConfirmingClose(false);
                                }}
                            >
                                Discard
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
