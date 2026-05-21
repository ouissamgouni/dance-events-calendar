import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EventRating, TagGroup } from '../types';
import { useAuth } from '../context/AuthContext';
import { deleteMyRating, fetchTagGroups, submitFeedback } from '../api';
import { getDeviceId } from '../utils/deviceId';
import RatingStars from './RatingStars';
import SuggestTagsButton, { type InlineTagSuggestion } from './SuggestTagsButton';
import { trackRatingDeleted, trackRatingSubmitFailed, trackRatingSubmitted } from '../utils/tracking';
import { ConfirmDialog } from './AppDialog';

interface Props {
    eventId: string;
    initialRating: EventRating | null;
    onClose: () => void;
    onSubmitted: (rating: EventRating) => void;
    onDeleted?: () => void;
}

type Identity = 'name' | 'anonymous';

export default function RateEventModal({ eventId, initialRating, onClose, onSubmitted, onDeleted }: Props) {
    const { user } = useAuth();
    const [stars, setStars] = useState<number>(initialRating?.stars ?? 0);
    const [comment, setComment] = useState<string>(initialRating?.comment ?? '');
    const [reviewTagIds, setReviewTagIds] = useState<Set<number>>(
        new Set(initialRating?.review_tag_ids ?? []),
    );
    const [identity, setIdentity] = useState<Identity>(
        initialRating?.is_anonymous ? 'anonymous' : 'name',
    );
    const [showSuggestTags, setShowSuggestTags] = useState(false);
    const [tagSuggestions, setTagSuggestions] = useState<InlineTagSuggestion[]>([]);
    const [tagGroups, setTagGroups] = useState<TagGroup[] | null>(null);
    const [website, setWebsite] = useState(''); // honeypot
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [thanks, setThanks] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    useEffect(() => {
        fetchTagGroups().then(setTagGroups).catch(() => setTagGroups([]));
    }, []);

    useEffect(() => {
        if (!showSuggestTags) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.stopImmediatePropagation();
            setShowSuggestTags(false);
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [showSuggestTags]);

    const reviewGroup = useMemo(
        () => tagGroups?.find((g) => g.slug === 'review-tags') ?? null,
        [tagGroups],
    );
    const otherGroups = useMemo(
        () => tagGroups?.filter((g) => g.slug !== 'review-tags' && g.enabled) ?? [],
        [tagGroups],
    );

    const minCommentNeeded = stars > 0 && stars <= 2;
    const trimmedComment = comment.trim();
    const commentTooShort = minCommentNeeded && trimmedComment.length < 30;

    const toggleReviewTag = (id: number) => {
        setReviewTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleSubmit = async () => {
        if (stars < 1) {
            setError('Please choose a star rating.');
            return;
        }
        if (commentTooShort) {
            setError('Please add at least 30 characters explaining your rating.');
            return;
        }
        setError('');
        setSubmitting(true);
        try {
            const res = await submitFeedback(eventId, {
                stars,
                comment: trimmedComment || undefined,
                review_tag_ids: Array.from(reviewTagIds),
                is_anonymous: identity === 'anonymous',
                tag_suggestions: tagSuggestions,
                website: website || undefined,
            });
            trackRatingSubmitted({
                stars,
                commentLength: trimmedComment.length,
                tagCount: reviewTagIds.size,
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

    const handleDelete = async () => {
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

    return createPortal(
        <>
            <div
                className="fixed inset-0 z-[1100] bg-slate-900/50 flex items-center justify-center p-4"
                onClick={onClose}
            >
                <div
                    className="bg-white shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto border border-slate-200"
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label={thanks ? 'Feedback received' : 'Rate this event'}
                >
                    {thanks ? (
                        <div className="p-5 text-center space-y-3">
                            <div className="text-2xl text-sky-600">★</div>
                            <h2 className="text-base font-semibold text-slate-800">Thanks for your feedback!</h2>
                            <p className="text-xs text-slate-600">
                                Your review is being checked by our team and will appear once approved.
                            </p>
                            <button
                                onClick={onClose}
                                className="mt-2 bg-sky-600 text-white px-4 py-1.5 text-xs hover:bg-sky-700"
                            >
                                Close
                            </button>
                        </div>
                    ) : (
                        <div className="p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-base font-semibold text-slate-800">
                                    {initialRating ? 'Edit your rating' : 'Rate this event'}
                                </h2>
                                <button
                                    onClick={onClose}
                                    aria-label="Close"
                                    className="text-slate-400 hover:text-slate-600 text-xl leading-none"
                                >
                                    ×
                                </button>
                            </div>

                            {initialRating?.status === 'approved' && (
                                <div className="border border-amber-200 bg-amber-50 text-amber-800 text-[11px] px-2.5 py-2">
                                    Your edit will be re-reviewed before re-publishing. The current public version stays visible until approval.
                                </div>
                            )}
                            {initialRating?.status === 'rejected' && (
                                <div className="border border-slate-200 bg-slate-50 text-slate-700 text-[11px] px-2.5 py-2">
                                    Your previous review was rejected. Editing will resubmit it for moderation.
                                </div>
                            )}
                            {initialRating?.status === 'pending' && (
                                <div className="border border-amber-200 bg-amber-50 text-amber-800 text-[11px] px-2.5 py-2">
                                    Your review is awaiting moderation. You can still edit it before approval.
                                </div>
                            )}
                            {/* Stars */}
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">
                                    Your rating
                                </label>
                                <RatingStars value={stars} onChange={setStars} interactive size="lg" />
                            </div>

                            {/* Comment */}
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">
                                    Comment {minCommentNeeded && <span className="text-slate-500">(min 30 chars)</span>}
                                </label>
                                <textarea
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value.slice(0, 2000))}
                                    rows={3}
                                    placeholder="Tell others about your experience…"
                                    className="w-full border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-sky-400"
                                />
                                <div className="mt-0.5 text-right text-[10px] text-slate-400 tabular-nums">
                                    {comment.length}/2000
                                </div>
                            </div>

                            {/* Review tags */}
                            {reviewGroup && reviewGroup.tags.length > 0 && (
                                <div>
                                    <label className="block text-xs font-medium text-slate-600 mb-1">
                                        What stood out?
                                    </label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {reviewGroup.tags.map((t) => {
                                            const sel = reviewTagIds.has(t.id);
                                            return (
                                                <button
                                                    key={t.id}
                                                    type="button"
                                                    onClick={() => toggleReviewTag(t.id)}
                                                    className={`px-2 py-0.5 text-xs border transition ${sel ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-600 border-slate-300 hover:border-sky-400'}`}
                                                >
                                                    {sel && '✓ '}
                                                    {t.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Identity */}
                            <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Post as</label>
                                <div className="inline-flex border border-slate-300 overflow-hidden text-xs">
                                    <button
                                        type="button"
                                        onClick={() => setIdentity('name')}
                                        className={`px-3 py-1 ${identity === 'name' ? 'bg-sky-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        {user?.name ?? user?.email ?? 'My name'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setIdentity('anonymous')}
                                        className={`px-3 py-1 border-l border-slate-300 ${identity === 'anonymous' ? 'bg-sky-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        Anonymous
                                    </button>
                                </div>
                            </div>

                            {/* Embedded tag suggestions */}
                            {otherGroups.length > 0 && (
                                <div className="border-t pt-3">
                                    <button
                                        type="button"
                                        onClick={() => setShowSuggestTags(true)}
                                        className="text-xs text-slate-600 hover:text-slate-900 font-medium"
                                    >
                                        + Improve event tags
                                    </button>
                                    {tagSuggestions.length > 0 && (
                                        <p className="mt-1 text-[11px] text-slate-500">
                                            {tagSuggestions.length} tag suggestion{tagSuggestions.length !== 1 ? 's' : ''} added to this review.
                                        </p>
                                    )}
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

                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={handleSubmit}
                                    disabled={submitting || stars < 1}
                                    className="flex-1 bg-sky-600 text-white text-xs px-3 py-1.5 hover:bg-sky-700 disabled:opacity-50"
                                >
                                    {submitting ? 'Submitting…' : initialRating ? 'Update review' : 'Submit'}
                                </button>
                                {initialRating && (
                                    <button
                                        onClick={handleDelete}
                                        disabled={submitting}
                                        className="border border-slate-300 text-slate-700 text-xs px-3 py-1.5 hover:bg-slate-50"
                                    >
                                        Delete
                                    </button>
                                )}
                                <button
                                    onClick={onClose}
                                    disabled={submitting}
                                    className="border border-slate-300 text-slate-600 text-xs px-3 py-1.5 hover:bg-slate-50"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                    <ConfirmDialog
                        open={confirmDeleteOpen}
                        title="Delete Rating"
                        message="Delete your rating?"
                        confirmLabel="Delete"
                        destructive
                        onCancel={() => setConfirmDeleteOpen(false)}
                        onConfirm={() => void confirmDelete()}
                    />
                </div>
            </div>
            {showSuggestTags && (
                <div
                    className="fixed inset-0 z-[11000] flex items-center justify-center bg-slate-900/50 p-4"
                    onClick={(event) => {
                        event.stopPropagation();
                        setShowSuggestTags(false);
                    }}
                >
                    <div
                        className="w-full max-w-md max-h-[90vh] overflow-y-auto border border-slate-200 bg-white shadow-xl"
                        onClick={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="rating-suggest-tags-title"
                    >
                        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                            <h3 id="rating-suggest-tags-title" className="text-sm font-semibold text-slate-800">Improve event tags</h3>
                            <button
                                type="button"
                                onClick={() => setShowSuggestTags(false)}
                                className="text-xl leading-none text-slate-400 hover:text-slate-600"
                                aria-label="Close improve event tags"
                            >
                                ×
                            </button>
                        </div>
                        <div className="p-4 space-y-3">
                            <SuggestTagsButton
                                eventId={eventId}
                                tagGroups={otherGroups}
                                existingTagIds={new Set()}
                                deviceId={getDeviceId()}
                                onClose={() => setShowSuggestTags(false)}
                                mode="embedded"
                                onChange={setTagSuggestions}
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={() => setShowSuggestTags(false)}
                                    className="bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>,
        document.body,
    );
}
