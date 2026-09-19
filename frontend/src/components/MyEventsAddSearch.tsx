import { useCallback, useState } from 'react';
import type { EventSearchResult } from '../api';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import type { MyEventsTab } from '../utils/myEvents';
import { ConfirmDialog } from './AppDialog';
import ExplorerEventSearch from './ExplorerEventSearch';

interface Props {
    tab: MyEventsTab;
    onSuggest: () => void;
    onComplete?: () => void;
}

export default function MyEventsAddSearch({ tab, onSuggest, onComplete }: Props) {
    const { isAttending, toggleAttending } = useAttendingEvents();
    const { isSaved, toggleSave } = useSavedEvents();
    const [selected, setSelected] = useState<EventSearchResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');

    const resultFilter = useCallback(
        (result: EventSearchResult) => tab === 'saved' ? !isSaved(result.event_id) : !isAttending(result.event_id),
        [isAttending, isSaved, tab],
    );

    const confirm = async () => {
        if (!selected || busy) return;
        setBusy(true);
        setStatus('');
        const succeeded = tab === 'saved'
            ? await toggleSave(selected.event_id)
            : await toggleAttending(selected.event_id);
        setBusy(false);
        if (!succeeded) {
            setStatus(`Could not ${tab === 'saved' ? 'save' : tab === 'past' ? 'mark attended' : 'mark going'}. Try again.`);
            return;
        }
        setSelected(null);
        setStatus(tab === 'saved' ? 'Event saved.' : tab === 'past' ? 'Event marked attended.' : 'Event marked going.');
        onComplete?.();
    };

    const action = tab === 'saved' ? 'Save' : tab === 'past' ? 'Mark attended' : 'Mark going';
    return (
        <div className="bg-surface" data-testid="my-events-add-search">
            <ExplorerEventSearch
                embedded
                includePast={tab === 'past'}
                onSelectEvent={() => undefined}
                onSelectResult={setSelected}
                triggerLabel="Search events to add"
                guidancePrefix={tab === 'past' ? 'Searching past events only.' : 'Searching upcoming events only.'}
                resultFilter={resultFilter}
                onNoResultsAction={onSuggest}
            />
            {status && <p className="px-4 py-2 text-sm text-ink-soft" role="status">{status}</p>}
            <ConfirmDialog
                open={selected !== null}
                title={`${action}?`}
                message={selected ? `${action} “${selected.title}”?` : ''}
                confirmLabel={action}
                busy={busy}
                onConfirm={confirm}
                onCancel={() => { if (!busy) setSelected(null); }}
            />
        </div>
    );
}
