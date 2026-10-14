import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useSignIn } from '../context/SignInSheetContext';
import OrganizerClaimSheet from '../components/OrganizerClaimSheet';
import type { CalendarEvent } from '../types';

/** "I organize this event": shown while the event has no organizer; signs in first when needed. */
export default function useOrganizerClaimAction(event: CalendarEvent) {
    const { user } = useAuth();
    const { organizerClaimsEnabled } = useFeatureFlags();
    const openSignIn = useSignIn();
    const [open, setOpen] = useState(false);

    const available = organizerClaimsEnabled && !event.organizer && !event.owner_preview && !event.is_cancelled;
    const start = () => {
        if (!user) {
            openSignIn('claim', { onSignedIn: () => setOpen(true) });
            return;
        }
        setOpen(true);
    };
    // Portaled: the action dock is a fixed, z-indexed stacking context.
    const sheet = open ? createPortal(
        <OrganizerClaimSheet
            initialEvent={{ event_id: event.event_id, title: event.title, start: event.start }}
            onClose={() => setOpen(false)}
        />,
        document.body,
    ) : null;

    return { available, start, sheet };
}
