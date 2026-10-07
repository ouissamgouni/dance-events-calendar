import { Bell, ChartColumn, Database, Settings, Users, type LucideIcon } from 'lucide-react';

export type AdminTab = 'data' | 'configuration' | 'analytics' | 'users' | 'notifications';

const TABS: { tab: AdminTab; label: string; icon: LucideIcon }[] = [
    { tab: 'data', label: 'Data', icon: Database },
    { tab: 'configuration', label: 'Config', icon: Settings },
    { tab: 'analytics', label: 'Analytics', icon: ChartColumn },
    { tab: 'users', label: 'Users', icon: Users },
    { tab: 'notifications', label: 'Notifs', icon: Bell },
];

interface Props {
    active: AdminTab;
    onChange: (tab: AdminTab) => void;
    dataBadge?: number;
}

/** Mobile-only admin tab bar; desktop uses the top tab buttons in Admin.tsx. */
export default function AdminBottomNav({ active, onChange, dataBadge = 0 }: Props) {
    return (
        <nav
            aria-label="Admin sections"
            className="flex items-stretch border-t border-line bg-surface"
            style={{ height: 'calc(60px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
            {TABS.map(({ tab, label, icon: Icon }) => {
                const isActive = tab === active;
                return (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => onChange(tab)}
                        aria-current={isActive ? 'page' : undefined}
                        className={`relative flex flex-1 flex-col items-center justify-center gap-1 text-xs transition ${isActive ? 'font-medium text-action' : 'text-ink-soft hover:text-ink'}`}
                    >
                        {isActive && (
                            <span aria-hidden="true" className="absolute top-0 left-1/2 h-[3px] w-[60%] -translate-x-1/2 bg-action" />
                        )}
                        <span className="relative">
                            <Icon className="h-5 w-5" aria-hidden="true" />
                            {tab === 'data' && dataBadge > 0 && (
                                <span className="absolute -top-1.5 left-3 inline-flex h-4 min-w-4 items-center justify-center bg-action px-1 text-[10px] font-semibold leading-none text-white">
                                    {dataBadge > 99 ? '99+' : dataBadge}
                                </span>
                            )}
                        </span>
                        <span>{label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
