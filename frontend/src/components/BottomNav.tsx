import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useNavDestinations } from './navDestinations';

const SWIPE_PX = 16;

/**
 * Mobile sticky primary navigation. Hidden on md+ (desktop uses the
 * horizontal DesktopNav in the header instead). Selected destination gets a
 * primary-colour icon + label and a top indicator bar; others stay neutral.
 * On the fullscreen Explorer map and calendar view it collapses to a grab strip; revealing it
 * pushes page content up via `--bottom-nav-offset`.
 */
export default function BottomNav() {
    const { pathname, search } = useLocation();
    const navDestinations = useNavDestinations();
    const collapsible = pathname === '/calendar'
        || (pathname === '/browse' && new URLSearchParams(search).get('view') === 'map');
    const [revealed, setRevealed] = useState(false);
    const locationKey = `${pathname}${search}`;
    const [prevLocationKey, setPrevLocationKey] = useState(locationKey);
    if (prevLocationKey !== locationKey) {
        setPrevLocationKey(locationKey);
        setRevealed(false);
    }
    const navRef = useRef<HTMLElement | null>(null);
    const pointerStartY = useRef<number | null>(null);
    const navHidden = collapsible && !revealed;

    useEffect(() => {
        const root = document.documentElement;
        root.style.setProperty('--bottom-nav-offset', navHidden ? '16px' : '64px');
        return () => { root.style.removeProperty('--bottom-nav-offset'); };
    }, [navHidden]);

    useEffect(() => {
        if (!collapsible || !revealed) return;
        const hideOnOutside = (event: PointerEvent) => {
            if (!navRef.current?.contains(event.target as Node)) setRevealed(false);
        };
        document.addEventListener('pointerdown', hideOnOutside, true);
        return () => document.removeEventListener('pointerdown', hideOnOutside, true);
    }, [collapsible, revealed]);

    if (navHidden) {
        return (
            <div
                className="md:hidden shrink-0 bg-surface z-[8001]"
                style={{ height: 'calc(16px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                <button
                    type="button"
                    aria-label="Show navigation"
                    onClick={() => setRevealed(true)}
                    onPointerDown={(event) => { pointerStartY.current = event.clientY; }}
                    onPointerUp={(event) => {
                        const start = pointerStartY.current;
                        pointerStartY.current = null;
                        if (start != null && start - event.clientY > SWIPE_PX) setRevealed(true);
                    }}
                    className="flex h-4 w-full touch-none items-center justify-center"
                    data-testid="bottom-nav-reveal"
                >
                    {/* eslint-disable-next-line no-restricted-syntax -- grab handle is a pill by design */}
                    <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
                </button>
            </div>
        );
    }

    return (
        <nav
            ref={navRef}
            aria-label="Primary"
            className={`md:hidden shrink-0 flex items-stretch border-t border-line bg-surface z-[8001] ${collapsible ? 'animate-slide-up' : ''}`}
            style={{ height: 'calc(64px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
            onPointerDown={collapsible ? (event) => { pointerStartY.current = event.clientY; } : undefined}
            onPointerUp={collapsible ? (event) => {
                const start = pointerStartY.current;
                pointerStartY.current = null;
                if (start != null && event.clientY - start > SWIPE_PX) setRevealed(false);
            } : undefined}
        >
            {navDestinations.map((dest) => {
                const active = dest.isActive(pathname);
                return (
                    <Link
                        key={dest.id}
                        to={dest.path}
                        aria-current={active ? 'page' : undefined}
                        className={`relative flex-1 flex flex-col items-center justify-center gap-1 text-xs transition ${active ? 'text-action font-medium' : 'text-ink-soft hover:text-ink'
                            }`}
                    >
                        {active && (
                            <span aria-hidden="true" className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-[3px] bg-action" />
                        )}
                        <span className="relative">
                            <img
                                src={dest.icon}
                                alt=""
                                aria-hidden="true"
                                className="h-6 w-6 object-contain"
                                style={active ? undefined : { filter: 'grayscale(1)', opacity: 0.6 }}
                            />
                        </span>
                        <span>{dest.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
