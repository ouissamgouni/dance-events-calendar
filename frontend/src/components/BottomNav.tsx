import { Link, useLocation } from 'react-router-dom';
import { NAV_DESTINATIONS } from './navDestinations';
import { useForYouHasNew } from '../hooks/useForYouHasNew';

/**
 * Mobile sticky primary navigation. Hidden on md+ (desktop uses the
 * horizontal DesktopNav in the header instead). Selected destination gets a
 * primary-colour icon + label and a top indicator bar; others stay neutral.
 */
export default function BottomNav() {
    const { pathname } = useLocation();
    const forYouActive = pathname === '/for-you';
    const hasNewForYou = useForYouHasNew(forYouActive);

    return (
        <nav
            aria-label="Primary"
            className="md:hidden shrink-0 flex items-stretch border-t border-slate-200 bg-slate-100"
            style={{ height: 'calc(68px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
            {NAV_DESTINATIONS.map((dest) => {
                const active = dest.isActive(pathname);
                const showDot = dest.id === 'for-you' && hasNewForYou;
                return (
                    <Link
                        key={dest.id}
                        to={dest.path}
                        aria-current={active ? 'page' : undefined}
                        className={`relative flex-1 flex flex-col items-center justify-center gap-1 text-[11px] transition ${active ? 'text-blue-600 font-medium' : 'text-slate-500 hover:text-slate-700'
                            }`}
                    >
                        {active && (
                            <span aria-hidden="true" className="absolute top-0 left-0 right-0 h-0.5 bg-blue-600" />
                        )}
                        <span className="relative">
                            <img
                                src={dest.icon}
                                alt=""
                                aria-hidden="true"
                                className="h-6 w-6 object-contain"
                                style={active ? undefined : { filter: 'grayscale(1)', opacity: 0.6 }}
                            />
                            {showDot && (
                                <span
                                    // eslint-disable-next-line no-restricted-syntax -- small status dot (new indicator) — allowed exception per frontend rules
                                    className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-blue-500"
                                    aria-label="New items available"
                                    data-testid="for-you-nav-new-dot"
                                />
                            )}
                        </span>
                        <span>{dest.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
