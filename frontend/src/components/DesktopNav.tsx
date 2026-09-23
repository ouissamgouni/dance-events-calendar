import { Link, useLocation } from 'react-router-dom';
import { useNavDestinations } from './navDestinations';

/**
 * Desktop primary navigation: horizontal text links rendered in the dark
 * top app bar. Hidden on mobile (that surface uses the sticky BottomNav).
 */
export default function DesktopNav({ className = '' }: { className?: string }) {
    const { pathname } = useLocation();
    const navDestinations = useNavDestinations();

    return (
        <nav aria-label="Primary" className={`hidden md:flex items-center gap-1 ${className}`}>
            {navDestinations.map((dest) => {
                const active = dest.isActive(pathname);
                return (
                    <Link
                        key={dest.id}
                        to={dest.path}
                        aria-current={active ? 'page' : undefined}
                        className={`relative inline-flex items-center gap-1.5 px-2.5 py-1 text-sm transition ${active ? 'text-action font-semibold' : 'text-ink-soft hover:text-ink'
                            }`}
                    >
                        <img src={dest.icon} alt="" aria-hidden="true" className="h-4 w-4" />
                        {dest.label}
                        {active && (
                            <span aria-hidden="true" className="absolute -bottom-0.5 left-2.5 right-2.5 h-0.5 bg-action" />
                        )}
                    </Link>
                );
            })}
        </nav>
    );
}
