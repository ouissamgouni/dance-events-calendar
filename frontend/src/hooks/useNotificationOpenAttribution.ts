import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { trackNotificationOpen } from '../utils/tracking';

/** Report `?via=push|email&nid=<id>` notification deep links once, then drop
 *  the params from the URL so refreshes/shares don't re-count them. */
export function useNotificationOpenAttribution(): void {
    const location = useLocation();
    const navigate = useNavigate();

    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const via = params.get('via');
        const nid = params.get('nid');
        if (!nid || (via !== 'push' && via !== 'email')) return;
        if (/^\d+$/.test(nid)) trackNotificationOpen(Number(nid), via);
        params.delete('via');
        params.delete('nid');
        const search = params.toString();
        navigate(
            { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash },
            { replace: true, state: location.state },
        );
    }, [location, navigate]);
}
