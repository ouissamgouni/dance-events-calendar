import { useEffect, useRef } from 'react';
import { PROFILE_CHANGED_EVENT, type PublicProfile } from '../api';

/** Runs ``onChange`` whenever the signed-in user's bio or social links are saved anywhere. */
export default function useProfileChanged(onChange: (profile: PublicProfile) => void) {
    const ref = useRef(onChange);
    useEffect(() => { ref.current = onChange; });
    useEffect(() => {
        const listener = (e: Event) => ref.current((e as CustomEvent<PublicProfile>).detail);
        window.addEventListener(PROFILE_CHANGED_EVENT, listener);
        return () => window.removeEventListener(PROFILE_CHANGED_EVENT, listener);
    }, []);
}
