import { useCallback, useEffect, useState } from 'react';
import type { ReviewHomePrompt } from '../types';
import { fetchReviewHomePrompt, postReviewHomePromptImpression } from '../api';
import { trackRatingModalOpened, trackReviewPromptDismissed, trackReviewPromptShown } from '../utils/tracking';
import { markHomeOverlayShown } from './useHomeOverlays';

export const REVIEW_PROMPT_SESSION_KEY = 'movida:review-home-prompt-checked';
const SETTLE_MS = 1200;

function alreadyCheckedThisSession(userId: string): boolean {
    try {
        return window.sessionStorage.getItem(REVIEW_PROMPT_SESSION_KEY) === userId;
    } catch {
        return false;
    }
}

function markCheckedThisSession(userId: string): void {
    try {
        window.sessionStorage.setItem(REVIEW_PROMPT_SESSION_KEY, userId);
    } catch { /* private mode: worst case the server-side caps still apply */ }
}

export function clearReviewPromptSession(): void {
    try {
        window.sessionStorage.removeItem(REVIEW_PROMPT_SESSION_KEY);
    } catch { /* ignore */ }
}

/**
 * Asks the server (which owns the frequency caps) once per browser session
 * and signed-in user whether Home should open the review wizard, after the page settles.
 */
export function useHomeReviewPrompt(enabled: boolean, userId: string) {
    const [prompt, setPrompt] = useState<ReviewHomePrompt | null>(null);
    // True once this visit has nothing (more) to show, so lower-priority Home prompts may run.
    const [settled, setSettled] = useState(false);

    useEffect(() => {
        if (!enabled || alreadyCheckedThisSession(userId)) return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            fetchReviewHomePrompt()
                .then((res) => {
                    if (cancelled) return;
                    markCheckedThisSession(userId);
                    if (!res.prompt) {
                        setSettled(true);
                        return;
                    }
                    markHomeOverlayShown(userId);
                    setPrompt(res);
                    postReviewHomePromptImpression(res.prompt.event_id, 'shown').catch(() => { });
                    trackReviewPromptShown(res.forced);
                    trackRatingModalOpened('home-prompt', false);
                })
                .catch(() => setSettled(true));
        }, SETTLE_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [enabled, userId]);

    const dismiss = useCallback(() => {
        if (prompt?.prompt) {
            postReviewHomePromptImpression(prompt.prompt.event_id, 'dismissed').catch(() => { });
            trackReviewPromptDismissed();
        }
        setPrompt(null);
        setSettled(true);
    }, [prompt]);

    const clear = useCallback(() => {
        setPrompt(null);
        setSettled(true);
    }, []);

    return {
        prompt,
        dismiss,
        clear,
        settled: settled || (enabled && !prompt && alreadyCheckedThisSession(userId)),
    };
}
