import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, X } from 'lucide-react';
import type { SiteSettings } from '../../api';
import { fetchSettings, fetchTagGroups, submitSuggestion } from '../../api';
import type { TagGroup } from '../../types';
import { useAuth } from '../../context/AuthContext';
import Step1Event from './Step1Event';
import Step2Details from './Step2Details';
import Step3Publish from './Step3Publish';
import StepProgress from './StepProgress';
import { toOccurrenceDates, toRRule } from './recurrence';
import {
    btnPrimary,
    btnSecondary,
    initialFormState,
    isDirty,
    isLinkFilled,
    type SuggestFormState,
} from './formState';
import { parseLocal } from './datetime';
import {
    FIELD_ANCHOR,
    firstInvalidStep,
    validateStep,
    type FieldError,
    type StepIndex,
} from './validation';

interface Props {
    onClose: () => void;
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

/** Local wizard value → UTC ISO, treating the value as local wall-clock time. */
function toIso(value: string): string {
    const date = parseLocal(value);
    return (date ?? new Date(value)).toISOString();
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
export default function SuggestEventWizard({ onClose }: Props) {
    const { user } = useAuth();
    const [settings, setSettings] = useState<SiteSettings | null>(null);
    const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);

    const [step, setStep] = useState<StepIndex>(1);
    const [subPageOpen, setSubPageOpen] = useState(false);
    const [stepError, setStepError] = useState<FieldError | null>(null);
    const [submitError, setSubmitError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState(false);
    const [confirmingClose, setConfirmingClose] = useState(false);
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

    useEffect(() => {
        // Auth resolves after the first render, so seed the signed-in defaults
        // once it arrives — but only once, or we would fight the user's edits.
        if (!user || appliedUserDefaults.current) return;
        appliedUserDefaults.current = true;
        setState((prev) => ({
            ...prev,
            submitterName: prev.submitterName || (user.name ?? ''),
            submitterEmail: prev.submitterEmail || (user.email ?? ''),
            going: true,
            goingAudience: user.share_attendance_default_audience ?? prev.goingAudience,
        }));
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

    const otherGroups = useMemo(
        () =>
            tagGroups.filter(
                (g) => g.id !== danceGroup?.id && g.id !== reachGroup?.id && g.enabled !== false,
            ),
        [tagGroups, danceGroup?.id, reachGroup?.id],
    );

    const requestClose = useCallback(() => {
        if (isDirty(state) && !success) {
            setConfirmingClose(true);
            return;
        }
        onClose();
    }, [state, success, onClose]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Sub-pages handle their own Escape first.
            if (e.key === 'Escape' && !subPageOpen) requestClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [subPageOpen, requestClose]);

    const goNext = () => {
        const invalid = validateStep(step, state, danceGroup, reachGroup);
        if (invalid) {
            setStepError(invalid);
            focusField(invalid);
            return;
        }
        setStepError(null);
        setStep((s) => (s === 3 ? s : ((s + 1) as StepIndex)));
    };

    const goBack = () => {
        setStepError(null);
        setStep((s) => (s === 1 ? s : ((s - 1) as StepIndex)));
    };

    const handleSubmit = async () => {
        const invalid = firstInvalidStep(state, danceGroup, reachGroup);
        if (invalid) {
            setStep(invalid.step);
            setStepError(invalid.error);
            focusField(invalid.error);
            return;
        }

        const startDate = parseLocal(state.start) ?? new Date(state.start);
        const manualDates = toOccurrenceDates(state.recurrence);
        const priced = state.priceMode === 'paid';

        setSubmitting(true);
        setSubmitError('');
        try {
            await submitSuggestion({
                title: state.title.trim(),
                description: state.description.trim() || undefined,
                location: state.location.trim() || undefined,
                links: state.links
                    .filter((l) => isLinkFilled(l.url))
                    .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null })),
                latitude: state.latitude ?? undefined,
                longitude: state.longitude ?? undefined,
                start: startDate.toISOString(),
                end: toIso(state.end),
                all_day: state.allDay,
                recurrence_rule: toRRule(state.recurrence, startDate),
                recurrence_dates: manualDates
                    ? manualDates.map((d) => ({ start: toIso(d.start), end: toIso(d.end) }))
                    : null,
                submitter_name: state.submitterName.trim() || undefined,
                submitter_email: state.submitterEmail.trim() || undefined,
                suggested_tag_ids: state.tagsValue.selectedTagIds,
                suggested_new_tags: Object.entries(state.tagsValue.freeTexts)
                    .map(([group_slug, free_text]) => ({ free_text: free_text.trim(), group_slug }))
                    .filter((t) => t.free_text.length > 0),
                going: state.going,
                going_audience: state.going ? state.goingAudience : null,
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
                website: state.website,
                screen_size: `${screen.width}x${screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
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
                    <h2 className="mb-2 text-base font-bold text-ink">Event submitted</h2>
                    <p className="mb-5 text-sm text-ink-soft">
                        {user
                            ? 'Your event is live and under review. All of its dates are already on your calendar.'
                            : 'Your suggestion is under review. We will publish it once a curator approves it.'}
                    </p>
                    <button type="button" onClick={onClose} className={btnPrimary}>
                        Done
                    </button>
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

    const stepValid = validateStep(step, state, danceGroup, reachGroup) === null;

    return (
        <>
            <div
                className="fixed inset-0 z-[9998] hidden bg-black/50 backdrop-blur-sm sm:block"
                onClick={requestClose}
            />
            <section className={shellCls} role="dialog" aria-modal="true" aria-label="Suggest an event">
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
                                Suggest an event
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

                        {step === 1 ? (
                            <Step1Event {...stepProps} />
                        ) : step === 2 ? (
                            <Step2Details
                                {...stepProps}
                                danceGroup={danceGroup}
                                reachGroup={reachGroup}
                                otherGroups={otherGroups}
                            />
                        ) : (
                            <Step3Publish {...stepProps} signedIn={Boolean(user)} />
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
                        {step < 3 ? (
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
                                {submitting ? 'Submitting…' : 'Submit Event'}
                            </button>
                        )}
                    </div>
                ) : null}
            </section>

            {confirmingClose ? (
                <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4">
                    <div className="w-full max-w-sm rounded-card bg-surface p-5 shadow-2xl">
                        <h2 className="text-sm font-bold text-ink">Discard this event?</h2>
                        <p className="mt-1 text-sm text-ink-soft">Everything you entered will be lost.</p>
                        <div className="mt-4 flex gap-2">
                            <button
                                type="button"
                                className={btnSecondary}
                                onClick={() => setConfirmingClose(false)}
                            >
                                Keep editing
                            </button>
                            <button type="button" className={btnPrimary} onClick={onClose}>
                                Discard
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
