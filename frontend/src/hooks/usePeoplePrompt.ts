import { useCallback, useEffect, useState } from 'react';
import { fetchPeoplePrompt, postPeoplePromptImpression, type PeoplePrompt } from '../api';
import { homeOverlaysShown, markHomeOverlayShown } from './useHomeOverlays';

export const PEOPLE_PROMPT_SESSION_KEY = 'movida:people-prompt-checked';
const SETTLE_MS = 800;

function alreadyChecked(userId: string): boolean {
    try {
        return window.sessionStorage.getItem(PEOPLE_PROMPT_SESSION_KEY) === userId;
    } catch {
        return false;
    }
}

function markChecked(userId: string): void {
    try {
        window.sessionStorage.setItem(PEOPLE_PROMPT_SESSION_KEY, userId);
    } catch { /* private mode: server-side caps still apply */ }
}

export function clearPeoplePromptSession(): void {
    try {
        window.sessionStorage.removeItem(PEOPLE_PROMPT_SESSION_KEY);
    } catch { /* ignore */ }
}

/**
 * Asks the server (which owns tiers, cooldowns and forces) once per session
 * whether Home should open the "Build your tribe" sheet. ``enabled`` should
 * only turn true once higher-priority prompts (review) have settled.
 */
export function usePeoplePrompt(enabled: boolean, userId: string) {
    const [prompt, setPrompt] = useState<PeoplePrompt | null>(null);

    useEffect(() => {
        if (!enabled || alreadyChecked(userId)) return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            fetchPeoplePrompt()
                .then((res) => {
                    if (cancelled) return;
                    markChecked(userId);
                    if (!res.show || res.items.length === 0) return;
                    if (!res.forced && homeOverlaysShown(userId) >= res.overlays_per_session) return;
                    markHomeOverlayShown(userId);
                    setPrompt(res);
                    postPeoplePromptImpression('shown').catch(() => { });
                })
                .catch(() => { /* no prompt this visit */ });
        }, SETTLE_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [enabled, userId]);

    const close = useCallback((followedCount: number) => {
        postPeoplePromptImpression(followedCount > 0 ? 'followed' : 'dismissed', followedCount).catch(() => { });
        setPrompt(null);
    }, []);

    return { prompt, close };
}
