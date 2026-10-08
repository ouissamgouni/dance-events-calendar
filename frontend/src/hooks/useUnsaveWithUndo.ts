import { useCallback, useEffect, useRef } from 'react';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useToast } from '../components/Toast';

/**
 * Unsave an event right away and offer an app-wide Undo toast (the card
 * itself unmounts). Call from a component that outlives the removed card.
 */
export function useUnsaveWithUndo() {
    const saved = useSavedEvents();
    const { push } = useToast();
    // toggleSave closes over the saved set, so Undo must use the latest one.
    const latest = useRef(saved);
    useEffect(() => { latest.current = saved; }, [saved]);

    return useCallback((eventId: string) => {
        const audience = latest.current.getSavedAudience(eventId);
        latest.current.toggleSave(eventId).then((ok) => {
            if (!ok) {
                push({ title: "Couldn't unsave \u2014 try again", variant: 'error', duration: 3200 });
                return;
            }
            push({
                title: 'Removed from saved',
                duration: 5000,
                action: {
                    label: 'Undo',
                    onClick: () => {
                        if (latest.current.isSaved(eventId)) return;
                        latest.current.toggleSave(eventId, audience).then((restored) => {
                            if (!restored) push({ title: "Couldn't restore \u2014 try again", variant: 'error', duration: 3200 });
                        });
                    },
                },
            });
        });
    }, [push]);
}
