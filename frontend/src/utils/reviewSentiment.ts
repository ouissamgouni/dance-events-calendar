import type { ReviewSentiment } from '../types';

/** 5-point overall sentiment scale, ordered best → worst. No overall star is shown. */
export const SENTIMENTS: { value: ReviewSentiment; emoji: string; label: string }[] = [
    { value: 'amazing', emoji: '😍', label: 'Amazing' },
    { value: 'great', emoji: '😊', label: 'Great' },
    { value: 'okay', emoji: '😐', label: 'Okay' },
    { value: 'disappointing', emoji: '😕', label: 'Disappointing' },
    { value: 'bad', emoji: '😞', label: 'Bad' },
];

export const SENTIMENT_META: Record<ReviewSentiment, { emoji: string; label: string }> =
    Object.fromEntries(SENTIMENTS.map((s) => [s.value, { emoji: s.emoji, label: s.label }])) as Record<
        ReviewSentiment,
        { emoji: string; label: string }
    >;

/** Whether a sentiment reads as broadly positive (used to order aspect tags). */
export function isPositiveSentiment(sentiment: ReviewSentiment): boolean {
    return sentiment === 'amazing' || sentiment === 'great';
}
