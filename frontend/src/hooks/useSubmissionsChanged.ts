import { useEffect, useRef } from 'react';
import { SUBMISSIONS_CHANGED_EVENT } from '../api';

/** Runs ``onChange`` whenever the user submits or edits an event or proposes a change. */
export default function useSubmissionsChanged(onChange: () => void) {
    const ref = useRef(onChange);
    useEffect(() => { ref.current = onChange; });
    useEffect(() => {
        const listener = () => ref.current();
        window.addEventListener(SUBMISSIONS_CHANGED_EVENT, listener);
        return () => window.removeEventListener(SUBMISSIONS_CHANGED_EVENT, listener);
    }, []);
}
