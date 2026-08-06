import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EventRating, ReviewSentiment, Tag, TagGroup } from '../types';
import { useAuth } from '../context/AuthContext';
import {
    deleteMyRating,
    fetchAspectTagGroups,
    fetchAudienceTagGroups,
    fetchEvent,
    submitFeedback,
} from '../api';
import { trackRatingDeleted, trackRatingSubmitFailed, trackRatingSubmitted } from '../utils/tracking';
import { SENTIMENTS, SENTIMENT_META } from '../utils/reviewSentiment';
import { ConfirmDialog } from './AppDialog';

interface Props {
    eventId: string;
    initialRating: EventRating | null;
    onClose: () => void;
    onSubmitted: (rating: EventRating) => void;
    onDeleted?: () => void;
}

type Identity = 'name' | 'anonymous';

const MAX_COMMENT = 300;
const MAX_TAGS_PER_ASPECT = 5;
const TAGS_SHOWN_COLLAPSED = 8;

/**
 * Order an aspect's tags for display. A clear mood shows the matching polarity
 * first (great → positive, poor → negative); no mood yet or "okay" interleaves
 * positive and negative so the collapsed top row shows a mix of both.
 */
function orderAspectTags(tags: Tag[], score: number): Tag[] {
    const byOrdinal = (a: Tag, b: Tag) => a.ordinal - b.ordinal;
    const positives = tags.filter((t) => t.polarity !== 'negative').sort(byOrdinal);
    const negatives = tags.filter((t) => t.polarity === 'negative').sort(byOrdinal);
    if (score >= 4) return [...positives, ...negatives];
    if (score === 1 || score === 2) return [...negatives, ...positives];
    // No mood picked yet (0) or "okay" (3): interleave both polarities.
    const mixed: Tag[] = [];
    for (let i = 0; i < Math.max(positives.length, negatives.length); i++) {
        if (positives[i]) mixed.push(positives[i]);
        if (negatives[i]) mixed.push(negatives[i]);
    }
    return mixed;
}

/** Modal-only chip colors: positive aspect tags read as light green, negative
 * as light orange, so reviewers can tell them apart at a glance. Full literal
 * class strings (Tailwind JIT can't see interpolated suffixes). */
function aspectTagClasses(polarity: string | null | undefined, selected: boolean, atCap: boolean): string {
    if (polarity === 'negative') {
        return selected
            ? 'bg-orange-200 text-orange-900 border-orange-400 ring-1 ring-orange-500'
            : `bg-orange-50 text-orange-800 border-orange-200 ${atCap ? 'opacity-40' : 'hover:border-orange-400'}`;
    }
    return selected
        ? 'bg-green-200 text-green-900 border-green-400 ring-1 ring-green-500'
        : `bg-green-50 text-green-800 border-green-200 ${atCap ? 'opacity-40' : 'hover:border-green-400'}`;
}

/** Segmented "mood" scale reused for the overall step. */
const SENTIMENT_ITEMS = SENTIMENTS.map((s) => ({
    key: s.value,
    emoji: s.emoji,
    label: s.label,
    value: s.value,
}));

/** Per-aspect 1–5 rating reuses the same mood buttons (Amazing→5 … Bad→1). */
const ASPECT_ITEMS = SENTIMENTS.map((s, i) => ({
    key: s.value,
    emoji: s.emoji,
    label: s.label,
    value: 5 - i,
}));

const CHIP_BASE = 'rounded-full border px-3 py-1.5 text-xs transition';

/** Many audience labels embed their own leading emoji; this captures it. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*\ufe0f?)\s*/u;

/** Fallback icons for audience tags whose label has no leading emoji. */
const AUDIENCE_ICONS: Record<string, string> = {
    'first-social': '🌱',
    'relaxed-dancing': '🧘',
    'high-energy-dancing': '⚡',
    'meet-new-people': '🤝',
    'budget-friendly': '💸',
    'drinks-lovers': '🍹',
    'food-lovers': '🍽️',
    beginners: '🔰',
    intermediate: '📊',
    advanced: '🏆',
};

/** Split an audience tag into an icon + clean label, preferring the label's own emoji. */
function audienceIcon(tag: Tag): { icon: string; label: string } {
    const m = tag.label.match(LEADING_EMOJI);
    if (m) return { icon: m[1], label: tag.label.slice(m[0].length) };
    return { icon: AUDIENCE_ICONS[tag.slug] ?? '👥', label: tag.label };
}

/** Rounded, light chip styling for the aspect picker and audience chips. */
function chipClass(selected: boolean): string {
    return selected
        ? `${CHIP_BASE} bg-sky-100 text-sky-800 border-sky-300`
        : `${CHIP_BASE} bg-white text-slate-600 border-slate-200 hover:border-sky-200 hover:bg-sky-50`;
}

/** Rounded, light segmented mood/rating control shared by the overall step and each aspect. */
function SegmentedMood<T>({
    items,
    isSelected,
    onSelect,
    ariaLabel,
}: {
    items: { key: string; emoji: string; label: string; value: T }[];
    isSelected: (value: T) => boolean;
    onSelect: (value: T) => void;
    ariaLabel: string;
}) {
    return (
        <div className="flex gap-2" role="radiogroup" aria-label={ariaLabel}>
            {items.map((it) => {
                const sel = isSelected(it.value);
                return (
                    <button
                        key={it.key}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => onSelect(it.value)}
                        className={`flex-1 flex flex-col items-center gap-1 rounded-2xl border px-1 py-2.5 text-[11px] transition ${sel ? 'bg-sky-100 text-sky-800 border-sky-300' : 'bg-white text-slate-500 border-slate-200 hover:border-sky-200 hover:bg-sky-50'}`}
                    >
                        <span className="text-xl leading-none">{it.emoji}</span>
                        {it.label}
                    </button>
                );
            })}
        </div>
    );
}

type WizardStep =
    | { kind: 'intro' }
    | { kind: 'aspect'; slug: string }
    | { kind: 'audience' }
    | { kind: 'comment' }
    | { kind: 'identity' };

export default function RateEventModal({ eventId, initialRating, onClose, onSubmitted, onDeleted }: Props) {
    const { user } = useAuth();

    const [sentiment, setSentiment] = useState<ReviewSentiment | null>(
        initialRating?.overall_sentiment ?? null,
    );
    const [aspectScores, setAspectScores] = useState<Record<string, number>>(
        initialRating?.aspect_scores ?? {},
    );
    const [aspectTagIds, setAspectTagIds] = useState<Set<number>>(
        new Set(initialRating?.aspect_tag_ids ?? []),
    );
    const [audienceTagIds, setAudienceTagIds] = useState<Set<number>>(
        new Set(initialRating?.audience_tag_ids ?? []),
    );
    const [comment, setComment] = useState<string>(initialRating?.comment ?? '');
    const [identity, setIdentity] = useState<Identity>(
        initialRating?.is_anonymous ? 'anonymous' : 'name',
    );

    const [aspectGroups, setAspectGroups] = useState<TagGroup[] | null>(null);
    const [audienceGroups, setAudienceGroups] = useState<TagGroup[] | null>(null);
    const [eventTagKeys, setEventTagKeys] = useState<string[]>([]);
    const [eventTitle, setEventTitle] = useState<string>('');
    const [selectedAspects, setSelectedAspects] = useState<Set<string>>(
        new Set(Object.keys(initialRating?.aspect_scores ?? {})),
    );
    const [expandedAspects, setExpandedAspects] = useState<Set<string>>(new Set());

    const [step, setStep] = useState(0);

    // Existing reviews open in a read-only summary first (consistent with the
    // other CTAs — a quick glance, not a multi-step form); an explicit "Edit"
    // action is required to enter the wizard. New reviews skip straight to it.
    const [mode, setMode] = useState<'view' | 'edit'>(initialRating ? 'view' : 'edit');

    const [website, setWebsite] = useState(''); // honeypot
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [thanks, setThanks] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    useEffect(() => {
        fetchAspectTagGroups().then(setAspectGroups).catch(() => setAspectGroups([]));
        fetchAudienceTagGroups().then(setAudienceGroups).catch(() => setAudienceGroups([]));
        fetchEvent(eventId)
            .then((ev) => {
                setEventTagKeys(ev.tags.map((t) => `${t.group_slug}:${t.slug}`));
                setEventTitle(ev.title);
            })
            .catch(() => setEventTagKeys([]));
    }, [eventId]);

    // Aspects offered: enabled groups whose condition (if any) matches the event's tags.
    const offeredAspects = useMemo(() => {
        if (!aspectGroups) return [];
        return aspectGroups
            .filter((g) => g.enabled)
            .filter((g) => {
                const cond = g.condition_tag_slugs;
                if (!cond || cond.length === 0) return true;
                return cond.some((key) => eventTagKeys.includes(key));
            })
            .sort((a, b) => a.ordinal - b.ordinal);
    }, [aspectGroups, eventTagKeys]);

    const audienceTags = useMemo(
        () => (audienceGroups ?? []).filter((g) => g.enabled).flatMap((g) => g.tags),
        [audienceGroups],
    );

    // Read-only view mode: resolve the saved tag ids back to labels for display.
    const allAspectTags = useMemo(() => (aspectGroups ?? []).flatMap((g) => g.tags), [aspectGroups]);
    const viewAspectTags = useMemo(
        () => allAspectTags.filter((t) => aspectTagIds.has(t.id)),
        [allAspectTags, aspectTagIds],
    );
    const viewAudienceTags = useMemo(
        () => audienceTags.filter((t) => audienceTagIds.has(t.id)),
        [audienceTags, audienceTagIds],
    );

    const selectedAspectGroups = useMemo(
        () => offeredAspects.filter((g) => selectedAspects.has(g.slug)),
        [offeredAspects, selectedAspects],
    );

    const steps: WizardStep[] = useMemo(() => {
        const list: WizardStep[] = [{ kind: 'intro' }];
        for (const g of selectedAspectGroups) list.push({ kind: 'aspect', slug: g.slug });
        if (audienceTags.length > 0) list.push({ kind: 'audience' });
        list.push({ kind: 'comment' });
        list.push({ kind: 'identity' });
        return list;
    }, [selectedAspectGroups, audienceTags.length]);

    useEffect(() => {
        setStep((cur) => Math.min(cur, steps.length - 1));
    }, [steps.length]);

    const trimmedComment = comment.trim();
    const commentStatus = initialRating?.comment_status;

    const toggleAspect = (slug: string) => {
        setSelectedAspects((prev) => {
            const next = new Set(prev);
            if (next.has(slug)) {
                next.delete(slug);
                // Clear the aspect's score + tags when deselected.
                setAspectScores((s) => {
                    const copy = { ...s };
                    delete copy[slug];
                    return copy;
                });
                const grp = offeredAspects.find((g) => g.slug === slug);
                if (grp) {
                    const ids = new Set(grp.tags.map((t) => t.id));
                    setAspectTagIds((prevTags) => new Set([...prevTags].filter((id) => !ids.has(id))));
                }
            } else {
                next.add(slug);
            }
            return next;
        });
    };

    const setAspectScore = (slug: string, score: number) => {
        setAspectScores((prev) => ({ ...prev, [slug]: score }));
    };

    const toggleAspectTag = (group: TagGroup, id: number) => {
        setAspectTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
                return next;
            }
            const selectedInGroup = group.tags.filter((t) => next.has(t.id)).length;
            if (selectedInGroup >= MAX_TAGS_PER_ASPECT) return prev;
            next.add(id);
            return next;
        });
    };

    const toggleAudienceTag = (id: number) => {
        setAudienceTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    /** Changing the headline mood implies a fresh review: reset every downstream
     * selection (aspects, per-aspect stars/tags, audience) and the comment, as if
     * the reviewer were starting over. Re-clicking the same mood is a no-op. */
    const handleSentimentChange = (next: ReviewSentiment) => {
        if (next === sentiment) return;
        setSentiment(next);
        setSelectedAspects(new Set());
        setAspectScores({});
        setAspectTagIds(new Set());
        setExpandedAspects(new Set());
        setAudienceTagIds(new Set());
        setComment('');
    };

    const handleSubmit = async () => {
        if (!sentiment) {
            setError('Please tell us how it was.');
            return;
        }
        // Each selected aspect needs a star score.
        const missing = [...selectedAspects].filter((slug) => !aspectScores[slug]);
        if (missing.length > 0) {
            setError('Please rate the aspects you selected (or deselect them).');
            return;
        }
        setError('');
        setSubmitting(true);
        try {
            const scores: Record<string, number> = {};
            for (const slug of selectedAspects) {
                if (aspectScores[slug]) scores[slug] = aspectScores[slug];
            }
            const res = await submitFeedback(eventId, {
                overall_sentiment: sentiment,
                aspect_scores: scores,
                aspect_tag_ids: Array.from(aspectTagIds),
                audience_tag_ids: Array.from(audienceTagIds),
                comment: trimmedComment || undefined,
                is_anonymous: identity === 'anonymous',
                tag_suggestions: [],
                website: website || undefined,
            });
            trackRatingSubmitted({
                sentiment,
                commentLength: trimmedComment.length,
                aspectCount: Object.keys(scores).length,
                audienceCount: audienceTagIds.size,
                isAnonymous: identity === 'anonymous',
                isEdit: !!initialRating,
            });
            onSubmitted(res.rating);
            setThanks(true);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Failed to submit. Please try again.';
            trackRatingSubmitFailed(msg.slice(0, 60));
            setError(msg);
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = () => {
        if (!initialRating) return;
        setConfirmDeleteOpen(true);
    };

    const confirmDelete = async () => {
        if (!initialRating) return;
        setConfirmDeleteOpen(false);
        setSubmitting(true);
        try {
            await deleteMyRating(eventId);
            trackRatingDeleted();
            onDeleted?.();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete rating.');
        } finally {
            setSubmitting(false);
        }
    };

    const current = steps[step] ?? steps[0];
    const isLast = step === steps.length - 1;
    const canContinue =
        current.kind === 'intro'
            ? !!sentiment
            : current.kind === 'aspect'
                ? !!aspectScores[current.slug]
                : true;
    const goBack = () => setStep((s) => Math.max(0, s - 1));
    const goNext = () => setStep((s) => Math.min(steps.length - 1, s + 1));
    const stepTitle = ((): string => {
        switch (current.kind) {
            case 'intro':
                return initialRating ? 'Edit your review' : 'How was it?';
            case 'aspect':
                return offeredAspects.find((x) => x.slug === current.slug)?.label ?? 'Rate';
            case 'audience':
                return 'Who would you recommend this event for?';
            case 'comment':
                return 'You wanna say something?';
            case 'identity':
                return 'Post as';
        }
    })();

    return createPortal(
        <>
            <div
                className="fixed inset-0 z-[10500] bg-slate-900/50 flex items-center justify-center p-4"
                onClick={onClose}
            >
                <div
                    className="bg-white shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto border border-slate-200"
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label={thanks ? 'Feedback received' : mode === 'view' ? 'Your review' : 'Rate this event'}
                >
                    {thanks ? (
                        <div className="p-5 text-center space-y-3">
                            <div className="text-3xl">🙌</div>
                            <h2 className="text-base font-semibold text-slate-800">Thanks for your feedback!</h2>
                            <p className="text-xs text-slate-600">
                                Your review is live. Any comment you added will appear once it's checked by our team.
                            </p>
                            <button
                                onClick={onClose}
                                className="mt-2 bg-sky-600 text-white px-4 py-1.5 text-xs hover:bg-sky-700"
                            >
                                Close
                            </button>
                        </div>
                    ) : mode === 'view' && initialRating ? (
                        <div className="p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-base font-semibold text-slate-800">Your review</h2>
                                <button
                                    onClick={onClose}
                                    aria-label="Close"
                                    className="shrink-0 text-slate-400 hover:text-slate-600 text-xl leading-none"
                                >
                                    ×
                                </button>
                            </div>
                            {sentiment && (
                                <p className="text-sm text-slate-700">
                                    {SENTIMENT_META[sentiment].emoji} {SENTIMENT_META[sentiment].label}
                                </p>
                            )}
                            {trimmedComment && (
                                <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{trimmedComment}</p>
                            )}
                            {commentStatus === 'pending' && (
                                <p className="text-[11px] text-amber-700">Your comment is pending moderation.</p>
                            )}
                            {(viewAspectTags.length > 0 || viewAudienceTags.length > 0) && (
                                <div className="flex flex-wrap gap-1.5">
                                    {viewAspectTags.map((t) => (
                                        <span
                                            key={`a-${t.id}`}
                                            className={`rounded-full px-2 py-0.5 text-[11px] ${t.polarity === 'negative' ? 'bg-orange-50 text-orange-800' : 'bg-green-50 text-green-800'}`}
                                        >
                                            {t.label}
                                        </span>
                                    ))}
                                    {viewAudienceTags.map((t) => (
                                        <span key={`u-${t.id}`} className="rounded-full px-2 py-0.5 text-[11px] bg-slate-100 text-slate-600">
                                            {t.label}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {error && <p className="text-xs text-slate-700">{error}</p>}
                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    type="button"
                                    onClick={() => setMode('edit')}
                                    className="flex-1 rounded-full bg-sky-500 text-white text-sm px-4 py-2 hover:bg-sky-600"
                                >
                                    Edit
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={submitting}
                                    className="rounded-full border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="p-4 space-y-4">
                            <div className="flex items-center gap-2">
                                {step > 0 && (
                                    <button
                                        type="button"
                                        onClick={goBack}
                                        disabled={submitting}
                                        aria-label="Back"
                                        className="shrink-0 -ml-1 text-slate-500 hover:text-slate-700 text-2xl leading-none disabled:opacity-50"
                                    >
                                        ←
                                    </button>
                                )}
                                <h2 className="flex-1 text-lg font-semibold text-slate-900">{stepTitle}</h2>
                                <button
                                    onClick={onClose}
                                    aria-label="Close"
                                    className="shrink-0 text-slate-400 hover:text-slate-600 text-xl leading-none"
                                >
                                    ×
                                </button>
                            </div>

                            {current.kind === 'intro' && eventTitle && (
                                <p className="-mt-2 text-xs text-slate-500">
                                    Rate your experience at {eventTitle}
                                </p>
                            )}

                            {/* Progress */}
                            <div
                                className="flex items-center gap-1.5"
                                role="progressbar"
                                aria-valuemin={1}
                                aria-valuemax={steps.length}
                                aria-valuenow={step + 1}
                                aria-label={`Step ${step + 1} of ${steps.length}`}
                            >
                                {steps.map((_, i) => (
                                    <span
                                        key={i}
                                        className={`h-1.5 flex-1 rounded-full transition ${i <= step ? 'bg-sky-400' : 'bg-slate-200'}`}
                                    />
                                ))}
                            </div>

                            {/* Intro — overall sentiment + aspect picker */}
                            {current.kind === 'intro' && (
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-semibold text-slate-700 mb-2">
                                            Your overall experience
                                        </label>
                                        <SegmentedMood
                                            items={SENTIMENT_ITEMS}
                                            isSelected={(v) => sentiment === v}
                                            onSelect={(v) => handleSentimentChange(v)}
                                            ariaLabel="Overall experience"
                                        />
                                    </div>

                                    {sentiment && offeredAspects.length > 0 && (
                                        <div>
                                            <label className="block text-sm font-semibold text-slate-700 mb-2">
                                                {'What stood out — good or bad?'}{' '}
                                                <span className="text-[11px] font-normal text-slate-400">(optional — pick what shaped it)</span>
                                            </label>
                                            <div className="flex flex-wrap gap-2.5">
                                                {offeredAspects.map((g) => {
                                                    const sel = selectedAspects.has(g.slug);
                                                    return (
                                                        <button
                                                            key={g.slug}
                                                            type="button"
                                                            onClick={() => toggleAspect(g.slug)}
                                                            className={chipClass(sel)}
                                                        >
                                                            {sel && '✓ '}
                                                            {g.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Aspect — segmented rating + tags */}
                            {current.kind === 'aspect' && (() => {
                                const g = offeredAspects.find((x) => x.slug === current.slug);
                                if (!g) return null;
                                const score = aspectScores[g.slug] ?? 0;
                                const expanded = expandedAspects.has(g.slug);
                                const ordered = orderAspectTags(g.tags, score);
                                const shown = expanded ? ordered : ordered.slice(0, TAGS_SHOWN_COLLAPSED);
                                const selectedInGroup = g.tags.filter((t) => aspectTagIds.has(t.id)).length;
                                return (
                                    <div className="space-y-4">
                                        <div>
                                            <label className="block text-sm font-semibold text-slate-700 mb-2">
                                                How was the {g.label.toLowerCase()}?
                                            </label>
                                            <SegmentedMood
                                                items={ASPECT_ITEMS}
                                                isSelected={(v) => score === v}
                                                onSelect={(v) => setAspectScore(g.slug, v)}
                                                ariaLabel={`Rate ${g.label}`}
                                            />
                                        </div>
                                        {score > 0 && g.tags.length > 0 && (
                                            <div className="flex flex-wrap gap-2.5">
                                                {shown.map((t) => {
                                                    const tsel = aspectTagIds.has(t.id);
                                                    const atCap = !tsel && selectedInGroup >= MAX_TAGS_PER_ASPECT;
                                                    return (
                                                        <button
                                                            key={t.id}
                                                            type="button"
                                                            disabled={atCap}
                                                            onClick={() => toggleAspectTag(g, t.id)}
                                                            className={`rounded-full border px-3 py-1.5 text-xs transition ${aspectTagClasses(t.polarity, tsel, atCap)}`}
                                                        >
                                                            {tsel && '✓ '}
                                                            {t.label}
                                                        </button>
                                                    );
                                                })}
                                                {ordered.length > TAGS_SHOWN_COLLAPSED && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setExpandedAspects((prev) => {
                                                                const next = new Set(prev);
                                                                if (next.has(g.slug)) next.delete(g.slug);
                                                                else next.add(g.slug);
                                                                return next;
                                                            })
                                                        }
                                                        className="px-2 py-2 text-sm text-sky-700 hover:text-sky-900"
                                                    >
                                                        {expanded ? 'Show less' : `Show more (${ordered.length - TAGS_SHOWN_COLLAPSED})`}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}

                            {/* Audience */}
                            {current.kind === 'audience' && (
                                <div className="flex flex-wrap gap-2">
                                    {audienceTags.map((t) => {
                                        const sel = audienceTagIds.has(t.id);
                                        const { icon, label } = audienceIcon(t);
                                        return (
                                            <button
                                                key={t.id}
                                                type="button"
                                                onClick={() => toggleAudienceTag(t.id)}
                                                className={chipClass(sel)}
                                            >
                                                <span className="mr-1">{sel ? '✓' : icon}</span>
                                                {label}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Comment */}
                            {current.kind === 'comment' && (
                                <div>
                                    <textarea
                                        value={comment}
                                        onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
                                        rows={4}
                                        placeholder="Tell others about the event…"
                                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-sky-300"
                                    />
                                    <div className="mt-0.5 text-right text-[10px] text-slate-400 tabular-nums">
                                        {comment.length}/{MAX_COMMENT}
                                    </div>
                                </div>
                            )}

                            {/* Identity */}
                            {current.kind === 'identity' && (
                                <div className="inline-flex overflow-hidden rounded-full border border-slate-200 text-sm">
                                    <button
                                        type="button"
                                        onClick={() => setIdentity('name')}
                                        className={`px-4 py-1.5 ${identity === 'name' ? 'bg-sky-100 text-sky-800' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        {user?.name ?? user?.email ?? 'My name'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setIdentity('anonymous')}
                                        className={`px-4 py-1.5 border-l border-slate-200 ${identity === 'anonymous' ? 'bg-sky-100 text-sky-800' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        Anonymous
                                    </button>
                                </div>
                            )}

                            {/* Honeypot */}
                            <input
                                type="text"
                                value={website}
                                onChange={(e) => setWebsite(e.target.value)}
                                className="hidden"
                                tabIndex={-1}
                                autoComplete="off"
                                aria-hidden="true"
                            />

                            {error && <p className="text-xs text-slate-700">{error}</p>}

                            {/* Footer */}
                            <div className="flex items-center gap-2 pt-1">
                                {isLast ? (
                                    <button
                                        type="button"
                                        onClick={handleSubmit}
                                        disabled={submitting || !sentiment}
                                        className="flex-1 rounded-full bg-sky-500 text-white text-sm px-4 py-2 hover:bg-sky-600 disabled:opacity-50"
                                    >
                                        {submitting ? 'Submitting…' : initialRating ? 'Update review' : 'Submit'}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={goNext}
                                        disabled={!canContinue}
                                        className="flex-1 rounded-full bg-sky-500 text-white text-sm px-4 py-2 hover:bg-sky-600 disabled:opacity-50"
                                    >
                                        Continue
                                    </button>
                                )}
                                {isLast && initialRating && (
                                    <button
                                        type="button"
                                        onClick={handleDelete}
                                        disabled={submitting}
                                        className="rounded-full border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
                                    >
                                        Delete
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                    <ConfirmDialog
                        open={confirmDeleteOpen}
                        title="Delete Review"
                        message="Delete your review?"
                        confirmLabel="Delete"
                        destructive
                        onCancel={() => setConfirmDeleteOpen(false)}
                        onConfirm={() => void confirmDelete()}
                    />
                </div>
            </div>
        </>,
        document.body,
    );
}
