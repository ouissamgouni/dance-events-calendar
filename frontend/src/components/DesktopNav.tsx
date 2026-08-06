import { Link, useLocation } from 'react-router-dom';
import { NAV_DESTINATIONS } from './navDestinations';
import { useForYouHasNew } from '../hooks/useForYouHasNew';

/**
 * Desktop primary navigation: horizontal text links rendered in the dark
 * top app bar. Hidden on mobile (that surface uses the sticky BottomNav).
 */
export default function DesktopNav({ className = '' }: { className?: string }) {
    const { pathname } = useLocation();
    const forYouActive = pathname === '/for-you';
    const hasNewForYou = useForYouHasNew(forYouActive);

    return (
        <nav aria-label="Primary" className={`hidden md:flex items-center gap-1 ${className}`}>
            {NAV_DESTINATIONS.map((dest) => {
                const active = dest.isActive(pathname);
                const showDot = dest.id === 'for-you' && hasNewForYou;
                return (
                    <Link
                        key={dest.id}
                        to={dest.path}
                        aria-current={active ? 'page' : undefined}
                        className={`relative px-2.5 py-1 text-sm transition ${active ? 'text-white font-semibold' : 'text-gray-300 hover:text-white'
                            }`}
                    >
                        {dest.label}
                        {active && (
                            <span aria-hidden="true" className="absolute -bottom-0.5 left-2.5 right-2.5 h-0.5 bg-blue-500" />
                        )}
                        {showDot && (
                            <span
                                // eslint-disable-next-line no-restricted-syntax -- small status dot (new indicator) — allowed exception per frontend rules
                                className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-blue-500"
                                aria-label="New items available"
                                data-testid="for-you-desktop-new-dot"
                            />
                        )}
                    </Link>
                );
            })}
        </nav>
    );
}
