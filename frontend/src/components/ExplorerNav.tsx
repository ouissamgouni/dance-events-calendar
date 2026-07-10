import ExplorerTabs, { type ExplorerTab } from './ExplorerTabs';
import ExplorerEventSearch from './ExplorerEventSearch';
import FollowsButton from './FollowsButton';
import MineButton from './MineButton';

interface ExplorerNavProps {
    active: ExplorerTab;
    /** Called with the selected event id when a search result is chosen. */
    onSelectSearchEvent: (eventId: string) => void;
}

/**
 * Shared top-of-page navigation for the Explorer and For you pages:
 * Explorer/For you tabs, the event search trigger, then the Mine group
 * (saved / going / following shortcuts). Keeping this in one component
 * means the search button and the Mine group (including Follows) stay
 * visible and consistent across both tabs instead of disappearing on
 * pages that don't render them themselves.
 */
export default function ExplorerNav({ active, onSelectSearchEvent }: ExplorerNavProps) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <ExplorerTabs active={active} />
            <div className="flex gap-1 bg-slate-200 p-1 shrink-0 w-fit">
                <MineButton />
                <FollowsButton />
            </div>
        </div>
    );
}
