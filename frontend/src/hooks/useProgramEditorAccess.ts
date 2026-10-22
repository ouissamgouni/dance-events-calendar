import { useEffect, useState } from 'react';
import { fetchEventScheduleEditorAccess } from '../api';
import { useOptionalAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarEvent } from '../types';

// Shared so the strip and the ••• menu of one event cost a single request.
const accessRequests = new Map<string, Promise<boolean>>();

function delegatedAccess(key: string, eventId: string): Promise<boolean> {
    let request = accessRequests.get(key);
    if (!request) {
        request = fetchEventScheduleEditorAccess(eventId).then((value) => value.can_edit, () => false);
        accessRequests.set(key, request);
    }
    return request;
}

/** Whether the viewer organizes this event and whether they may edit its program. */
export function useProgramEditorAccess(event: CalendarEvent): { isOrganizer: boolean; canEditProgram: boolean } {
    const user = useOptionalAuth()?.user;
    const { eventScheduleEnabled } = useOptionalFeatureFlags();
    const isOrganizer = Boolean(user && event.organizer?.user_id === user.user_id);
    const known = isOrganizer || Boolean(user?.is_admin);
    // Editor grants live on an existing program, so events without one skip the lookup.
    const hasProgram = Boolean(event.schedule_published || event.schedule_under_work);
    const key = `${user?.user_id ?? ''}:${event.event_id}`;
    const shouldFetch = Boolean(eventScheduleEnabled && user && !known && hasProgram);
    const [granted, setGranted] = useState<{ key: string; canEdit: boolean } | null>(null);
    useEffect(() => {
        if (!shouldFetch) return;
        let cancelled = false;
        delegatedAccess(key, event.event_id).then((canEdit) => { if (!cancelled) setGranted({ key, canEdit }); });
        return () => { cancelled = true; };
    }, [event.event_id, key, shouldFetch]);
    const delegated = shouldFetch && granted?.key === key && granted.canEdit;
    return { isOrganizer, canEditProgram: Boolean(eventScheduleEnabled) && (known || delegated) };
}
