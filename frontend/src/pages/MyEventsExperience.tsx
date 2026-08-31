import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchEventsByIds } from '../api';
import type { CalendarViewMode } from '../components/Calendar';
import CalendarMapWorkspace from '../components/CalendarMapWorkspace';
import EventMap from '../components/EventMap';
import EventModal from '../components/EventModal';
import MyEventsAddSearch from '../components/MyEventsAddSearch';
import MyEventsList from '../components/MyEventsList';
import MyEventsMapPreview from '../components/MyEventsMapPreview';
import MyEventsUtilityMenu from '../components/MyEventsUtilityMenu';
import MyEventsViewControls from '../components/MyEventsViewControls';
import SuggestEventModal from '../components/SuggestEventModal';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import type { CalendarEvent } from '../types';
import {
    eventsForMyEventsTab,
    initialMyEventsTab,
    sequenceMappableEvents,
    type MyEventsTab,
    type MyEventsView,
} from '../utils/myEvents';

const tabs: Array<{ id: MyEventsTab; label: string }> = [
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'saved', label: 'Saved' },
    { id: 'past', label: 'Past' },
];
const initialViews: Record<MyEventsTab, MyEventsView> = { upcoming: 'list', saved: 'list', past: 'list' };
const initialModes: Record<MyEventsTab, CalendarViewMode> = { upcoming: '3week', saved: '3week', past: '3week' };
const initialRoutes: Record<MyEventsTab, boolean> = { upcoming: true, saved: false, past: true };

export default function MyEventsExperience() {
    const { myEventsRouteEnabled } = useFeatureFlags();
    const { savedEventIds, isSaved } = useSavedEvents();
    const { attendingEventIds, isAttending, loading: attendanceLoading } = useAttendingEvents();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<MyEventsTab>(() => initialMyEventsTab(window.location.search));
    const [views, setViews] = useState(initialViews);
    const [modes, setModes] = useState(initialModes);
    const [routes, setRoutes] = useState(initialRoutes);
    const [selectedIds, setSelectedIds] = useState<Record<MyEventsTab, string | null>>({ upcoming: null, saved: null, past: null });
    const [modalEvent, setModalEvent] = useState<CalendarEvent | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [suggestOpen, setSuggestOpen] = useState(false);
    const [calendarRange, setCalendarRange] = useState<{ start: Date; end: Date } | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    const allEventIds = useMemo(() => [...new Set([...savedEventIds, ...attendingEventIds])], [savedEventIds, attendingEventIds]);
    useEffect(() => {
        if (allEventIds.length === 0) return;
        let cancelled = false;
        fetchEventsByIds(allEventIds)
            .then((rows) => { if (!cancelled) setEvents(rows); })
            .catch(() => { if (!cancelled) setEvents([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [allEventIds]);

    const activeEvents = useMemo(() => eventsForMyEventsTab(events, activeTab, isSaved, isAttending), [events, activeTab, isSaved, isAttending]);
    const sequence = useMemo(() => sequenceMappableEvents(activeEvents), [activeEvents]);
    const sequenceNumbers = useMemo(() => Object.fromEntries(sequence.map(({ event, sequence: number }) => [event.event_id, number])), [sequence]);
    const calendarMapEvents = useMemo(() => {
        if (!calendarRange) return [];
        return activeEvents.filter((event) => (
            event.latitude != null
            && event.longitude != null
            && new Date(event.start) < calendarRange.end
            && new Date(event.end || event.start) > calendarRange.start
        ));
    }, [activeEvents, calendarRange]);
    const view = views[activeTab];
    const routeOn = myEventsRouteEnabled && routes[activeTab];
    const storedIndex = sequence.findIndex(({ event }) => event.event_id === selectedIds[activeTab]);
    const selectedIndex = storedIndex >= 0 ? storedIndex : sequence.length > 0 ? 0 : -1;
    const selected = selectedIndex >= 0 ? sequence[selectedIndex] : null;
    const activeLoading = attendanceLoading || (allEventIds.length > 0 && loading);

    useLayoutEffect(() => {
        rootRef.current?.closest('main')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }, [view]);

    const changeView = (next: MyEventsView) => {
        setViews((current) => ({ ...current, [activeTab]: next }));
        setSearchOpen(false);
    };
    const selectIndex = (index: number) => {
        const item = sequence[index];
        if (item) setSelectedIds((current) => ({ ...current, [activeTab]: item.event.event_id }));
    };
    const activeTabEventIds = useMemo(() => activeEvents.map(e => e.event_id), [activeEvents]);

    return (
        <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col bg-canvas">
            <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 bg-surface border-b border-line">
                <h1 className="text-2xl font-bold text-ink">My Events</h1>
                <MyEventsUtilityMenu activeTab={activeTab} eventIds={activeTabEventIds} />
            </div>
            <div className="sticky top-0 z-[7600] shrink-0 bg-surface">
                <nav aria-label="My Events" className="grid grid-cols-3 border-b border-line bg-surface">
                    {tabs.map((tab) => {
                        const active = activeTab === tab.id;
                        return (
                            <button key={tab.id} type="button" role="tab" aria-selected={active} onClick={() => { setActiveTab(tab.id); setSearchOpen(false); }} className={`relative py-4 text-sm font-medium transition ${active ? 'text-action' : 'text-ink hover:text-action'}`}>
                                {tab.label}
                                {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-action" />}
                            </button>
                        );
                    })}
                </nav>
                <MyEventsViewControls view={view} searchOpen={searchOpen} onViewChange={changeView} onToggleSearch={() => setSearchOpen((open) => !open)} />
            </div>
            {activeLoading && <p className="py-20 text-center text-sm text-muted">Loading your events…</p>}
            {!activeLoading && searchOpen && <div className="min-h-0 flex-1 overflow-y-auto"><MyEventsAddSearch tab={activeTab} onSuggest={() => setSuggestOpen(true)} onComplete={() => setSearchOpen(false)} /></div>}
            {!activeLoading && !searchOpen && view === 'list' && <div className="min-h-0 flex-1 overflow-y-auto"><MyEventsList events={activeEvents} tab={activeTab} onEventClick={setModalEvent} /></div>}
            {!activeLoading && !searchOpen && view === 'calendar' && (
                <CalendarMapWorkspace
                    events={activeEvents}
                    initialDate={activeEvents[0]?.start}
                    viewMode={modes[activeTab]}
                    onViewModeChange={(mode) => setModes((current) => ({ ...current, [activeTab]: mode }))}
                    rangeSelector="always"
                    layout="remaining-map"
                    onDatesChange={(start, end) => setCalendarRange({ start, end })}
                    onEventClick={setModalEvent}
                    map={calendarMapEvents.length > 0 ? () => (
                        <EventMap
                            events={calendarMapEvents}
                            onEventClick={setModalEvent}
                            cooperativeGestures
                            fitMarkersControl
                        />
                    ) : undefined}
                />
            )}
            {!activeLoading && !searchOpen && view === 'map' && (
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <div className="relative min-h-0 flex-1">
                        {sequence.length > 0 ? (
                            <EventMap
                                events={sequence.map(({ event }) => event)}
                                hoveredEventId={selected?.event.event_id ?? null}
                                onMarkerSelect={(event) => setSelectedIds((current) => ({ ...current, [activeTab]: event.event_id }))}
                                disablePopups
                                fitMarkersControl
                                journeySequence={sequenceNumbers}
                                journeyRouteOn={routeOn}
                                onJourneyRouteToggle={myEventsRouteEnabled && sequence.length > 1
                                    ? () => setRoutes((current) => ({ ...current, [activeTab]: !current[activeTab] }))
                                    : undefined}
                                journeySelectedEventId={selected?.event.event_id}
                            />
                        ) : <div className="flex h-full items-center justify-center px-6 text-center"><p className="text-sm text-ink-soft">No events with map locations in this view.</p></div>}
                        <div className={`absolute right-3 z-[750] flex items-center gap-2 ${myEventsRouteEnabled && sequence.length > 1 ? 'top-14' : 'top-3'}`}>
                            {activeEvents.length > sequence.length && <button type="button" onClick={() => changeView('list')} className="bg-surface px-3 py-2 text-xs font-medium text-ink shadow-md">{activeEvents.length - sequence.length} without map location · List</button>}
                        </div>
                    </div>
                    {selected && (
                        <MyEventsMapPreview
                            event={selected.event}
                            sequence={selected.sequence}
                            hasPrevious={selectedIndex > 0}
                            hasNext={selectedIndex < sequence.length - 1}
                            onPrevious={() => selectIndex(selectedIndex - 1)}
                            onNext={() => selectIndex(selectedIndex + 1)}
                            onOpen={() => setModalEvent(selected.event)}
                            showAvatars={activeTab === 'upcoming'}
                            showActions={activeTab === 'saved'}
                            actions={activeTab === 'saved' ? ['going'] : undefined}
                        />
                    )}
                </div>
            )}
            {modalEvent && <EventModal event={modalEvent} onClose={() => setModalEvent(null)} />}
            {suggestOpen && <SuggestEventModal onClose={() => setSuggestOpen(false)} />}
        </div>
    );
}
