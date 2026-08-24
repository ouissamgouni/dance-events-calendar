import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AdminRating, TagSuggestionResponse } from '../types';
import {
    approveRating,
    approveTagSuggestion,
    fetchAdminTagSuggestions,
    rejectRating,
    rejectTagSuggestion,
} from '../api';
import { SENTIMENT_META } from '../utils/reviewSentiment';

interface Props {
    rating: AdminRating;
    onClose: () => void;
    onUpdated: (updated: AdminRating) => void;
}

export default function RatingReviewModal({ rating, onClose, onUpdated }: Props) {
    const [adminNotes, setAdminNotes] = useState(rating.admin_notes ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [linked, setLinked] = useState<TagSuggestionResponse[]>([]);
    const [loadingLinked, setLoadingLinked] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (rating.linked_tag_suggestion_ids.length === 0) {
            setLinked([]);
            return;
        }
        setLoadingLinked(true);
        // Fetch all tag suggestions and filter — endpoint doesn't support id-based filter
        fetchAdminTagSuggestions()
            .then((all) => {
                const idSet = new Set(rating.linked_tag_suggestion_ids);
                setLinked(all.filter((s) => idSet.has(s.id)));
            })
            .catch(() => setLinked([]))
            .finally(() => setLoadingLinked(false));
    }, [rating.linked_tag_suggestion_ids]);

    const handleApprove = async () => {
        setSubmitting(true);
        setError('');
        try {
            const updated = await approveRating(rating.id, adminNotes || undefined);
            onUpdated(updated);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to approve');
        } finally {
            setSubmitting(false);
        }
    };

    const handleReject = async () => {
        setSubmitting(true);
        setError('');
        try {
            const updated = await rejectRating(rating.id, adminNotes || undefined);
            onUpdated(updated);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to reject');
        } finally {
            setSubmitting(false);
        }
    };

    const handleApproveSuggestion = async (id: number, tagId?: number) => {
        try {
            const updated = await approveTagSuggestion(id, tagId);
            setLinked((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to approve suggestion');
        }
    };

    const handleRejectSuggestion = async (id: number) => {
        try {
            const updated = await rejectTagSuggestion(id);
            setLinked((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to reject suggestion');
        }
    };

    const statusBadge = (status: string) => {
        const colors: Record<string, string> = {
            pending: 'bg-amber-50 text-amber-700 border-amber-200',
            approved: 'bg-sky-50 text-sky-700 border-sky-200',
            rejected: 'bg-slate-100 text-ink-soft border-line',
        };
        return (
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 border ${colors[status] ?? 'bg-slate-100 text-ink-soft border-line'}`}>
                {status}
            </span>
        );
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[1100] bg-slate-900/50 flex items-center justify-center p-4"
            onClick={onClose}
        >
            <div
                className="bg-surface shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto border border-line"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Review rating"
            >
                <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-semibold text-ink">Review feedback</h2>
                            <p className="text-[11px] text-ink-soft mt-0.5">{rating.event_title || rating.event_id}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            {statusBadge(rating.comment_status)}
                            <button
                                onClick={onClose}
                                aria-label="Close"
                                className="text-muted hover:text-ink-soft text-xl leading-none"
                            >
                                ×
                            </button>
                        </div>
                    </div>

                    {/* Overall sentiment */}
                    <div className="flex items-center gap-2">
                        {rating.overall_sentiment && (
                            <span className="text-sm text-ink">
                                {SENTIMENT_META[rating.overall_sentiment].emoji}{' '}
                                {SENTIMENT_META[rating.overall_sentiment].label}
                            </span>
                        )}
                        {rating.status === 'rejected' && (
                            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 border border-line bg-slate-100 text-ink-soft">
                                review hidden
                            </span>
                        )}
                        {rating.auto_flagged && (
                            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 border border-amber-200 bg-amber-50 text-amber-700">
                                ⚠ auto-flagged
                            </span>
                        )}
                    </div>

                    {/* Aspect ratings */}
                    {Object.keys(rating.aspect_scores).length > 0 && (
                        <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1">Aspect ratings</label>
                            <div className="flex flex-wrap gap-1.5">
                                {Object.entries(rating.aspect_scores).map(([slug, score]) => (
                                    <span key={slug} className="px-1.5 py-0.5 text-[10px] bg-canvas text-ink border border-line">
                                        {slug}: {score}/5
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Comment */}
                    {rating.comment && (
                        <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1">
                                Comment <span className="font-normal text-muted">({rating.comment_status})</span>
                            </label>
                            <p className="text-xs text-ink bg-canvas border border-line p-2 whitespace-pre-wrap">
                                {rating.comment}
                            </p>
                        </div>
                    )}

                    {/* Aspect + audience tags */}
                    {(rating.aspect_tags.length > 0 || rating.audience_tags.length > 0) && (
                        <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1">Tags</label>
                            <div className="flex flex-wrap gap-1">
                                {rating.aspect_tags.map((t) => (
                                    <span
                                        key={`a-${t.id}`}
                                        className={`px-1.5 py-0.5 text-[10px] border ${t.polarity === 'positive' ? 'bg-sky-50 text-sky-700 border-sky-200' : t.polarity === 'negative' ? 'bg-orange-50 text-orange-800 border-orange-200' : 'bg-slate-100 text-ink-soft border-line'}`}
                                    >
                                        {t.label}
                                    </span>
                                ))}
                                {rating.audience_tags.map((t) => (
                                    <span
                                        key={`u-${t.id}`}
                                        className="px-1.5 py-0.5 text-[10px] bg-surface text-ink-soft border border-line"
                                    >
                                        {t.label}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Reviewer */}
                    <div className="text-xs text-ink-soft grid grid-cols-2 gap-1">
                        <div>
                            <span className="text-muted">Reviewer:</span>{' '}
                            {rating.is_anonymous ? 'Anonymous' : (rating.user_email || rating.user_display_name || 'Unknown')}
                        </div>
                        <div>
                            <span className="text-muted">Submitted:</span>{' '}
                            {new Date(rating.created_at).toLocaleString()}
                        </div>
                        {rating.submitter_country && (
                            <div>
                                <span className="text-muted">Country:</span> {rating.submitter_country}
                            </div>
                        )}
                        {rating.submitter_ip && (
                            <div>
                                <span className="text-muted">IP:</span> <span className="font-mono">{rating.submitter_ip}</span>
                            </div>
                        )}
                        {rating.submitter_user_agent && (
                            <div className="col-span-2 truncate">
                                <span className="text-muted">UA:</span>{' '}
                                <span className="font-mono text-[10px]">{rating.submitter_user_agent}</span>
                            </div>
                        )}
                    </div>

                    {/* Admin notes */}
                    <div>
                        <label className="block text-xs font-medium text-ink-soft mb-1">Admin notes</label>
                        <textarea
                            value={adminNotes}
                            onChange={(e) => setAdminNotes(e.target.value)}
                            rows={2}
                            placeholder="Optional notes…"
                            className="w-full border border-line px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-sky-400"
                        />
                    </div>

                    {error && <p className="text-xs text-ink">{error}</p>}

                    {/* Actions */}
                    <div className="flex gap-2">
                        <button
                            onClick={handleApprove}
                            disabled={submitting || rating.comment_status !== 'pending'}
                            className="flex-1 bg-sky-600 text-white text-xs px-3 py-1.5 hover:bg-sky-700 disabled:opacity-50"
                        >
                            Approve comment
                        </button>
                        <button
                            onClick={handleReject}
                            disabled={submitting || rating.comment_status === 'rejected'}
                            className="flex-1 border border-line text-ink text-xs px-3 py-1.5 hover:bg-canvas disabled:opacity-50"
                        >
                            Reject comment
                        </button>
                        <button
                            onClick={onClose}
                            className="border border-line text-ink-soft text-xs px-3 py-1.5 hover:bg-canvas"
                        >
                            Close
                        </button>
                    </div>

                    {/* Linked tag suggestions */}
                    {rating.linked_tag_suggestion_ids.length > 0 && (
                        <div className="border-t pt-3">
                            <h3 className="text-xs font-semibold text-ink mb-2">
                                Linked tag suggestions ({rating.linked_tag_suggestion_ids.length})
                            </h3>
                            {loadingLinked ? (
                                <p className="text-[11px] text-muted">Loading…</p>
                            ) : (
                                <ul className="space-y-2">
                                    {linked.map((s) => (
                                        <li key={s.id} className="border border-line bg-canvas p-2 text-xs">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex-1 min-w-0">
                                                    {s.tag ? (
                                                        <span className="inline-block px-1.5 py-0.5 text-[10px] bg-sky-50 text-sky-700 border border-sky-200">
                                                            {s.tag.group_label}: {s.tag.label}
                                                        </span>
                                                    ) : s.free_text ? (
                                                        <span className="italic text-ink-soft">&ldquo;{s.free_text}&rdquo;</span>
                                                    ) : null}
                                                </div>
                                                {statusBadge(s.status)}
                                            </div>
                                            {s.status === 'pending' && (
                                                <div className="mt-2 flex gap-1.5">
                                                    {s.tag && (
                                                        <button
                                                            onClick={() => handleApproveSuggestion(s.id, s.tag!.id)}
                                                            className="bg-sky-600 text-white px-2 py-0.5 text-[10px] hover:bg-sky-700"
                                                        >
                                                            Approve
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleRejectSuggestion(s.id)}
                                                        className="border border-line text-ink px-2 py-0.5 text-[10px] hover:bg-canvas"
                                                    >
                                                        Reject
                                                    </button>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
