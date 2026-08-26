import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type FullCalendar from '@fullcalendar/react';
import { ChevronLeft, ChevronRight, Route } from 'lucide-react';
import { fetchEventsByIds } from '../api';
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
import EventMap from '../components/EventMap';
import EventModal from '../components/EventModal';
import MyEventsAddSearch from '../components/MyEventsAddSearch';
import MyEventsList from '../components/MyEventsList';
import MyEventsMapPreview from '../components/MyEventsMapPreview';
import MyEventsViewControls from '../components/MyEventsViewControls';
import SuggestEventModal from '../components/SuggestEventModal';

const Calendar = lazy(() => import('../components/Calendar'));

const tabs: Array<{ id: MyEventsTab; label: string }> = [
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'saved', label: 'Saved' },
    { id: 'past', label: 'Past' },
];

const initialViews: Record<MyEventsTab, MyEventsView> = {
    upcoming: 'list',
    saved: 'list',
    past: 'list',
};

const initialRoutes: Record<MyEventsTab, boolean> = {
    upcoming: true,
    saved: false,
    past: true,
};

export default function MyEventsExperience() {
    const { savedEventIds, isSaved } = useSavedEvents();
    const { attendingEventIds, isAttending, loading: attendanceLoading } = useAttendingEvents();
    const { myEventsRouteEnabled } = useFeatureFlags();
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<MyEventsTab>(() => initialMyEventsTab(window.location.search));
    const [views, setViews] = useState<Record<MyEventsTab, MyEventsView>>(initialViews);
    const [routes, setRoutes] = useState<Record<MyEventsTab, boolean>>(initialRoutes);
    const [selectedByTab, setSelectedByTab] = useState<Record<MyEventsTab, string | null>>({ upcoming: null, saved: null, past: null });
    const [modalEvent, setModalEvent] = useState<CalendarEvent | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [suggestOpen, setSuggestOpen] = useState(false);
    const calendarRef = useRef<FullCalendar>(null);

    const allEventIds = useMemo(
        () => [...new Set([...savedEventIds, ...attendingEventIds])],
        [savedEventIds, attendingEventIds],
    );

    useEffect(() => {
        if (allEventIds.length === 0) return;
        let cancelled = false;
        fetchEventsByIds(allEventIds)
            .then((rows) => { if (!cancelled) setEvents(rows); })
            .catch(() => { if (!cancelled) setEvents([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [allEventIds]);

    const activeEvents = useMemo(
        () => eventsForMyEventsTab(events, activeTab, isSaved, isAttending),
        [events, activeTab, isSaved, isAttending],
    );
    const sequence = useMemo(() => sequenceMappableEvents(activeEvents), [activeEvents]);
    const sequenceNumbers = useMemo(
        () => Object.fromEntries(sequence.map(({ event, sequence: number }) => [event.event_id, number])),
        [sequence],
    );
    const view = views[activeTab];
    const routeOn = myEventsRouteEnabled && routes[activeTab];
    const selectedId = selectedByTab[activeTab];
    const storedSelectedIndex = sequence.findIndex(({ event }) => event.event_id === selectedId);
    const selectedIndex = storedSelectedIndex >= 0 ? storedSelectedIndex : sequence.length > 0 ? 0 : -1;
    const selected = selectedIndex >= 0 ? sequence[selectedIndex] : null;
    const unmappedCount = activeEvents.length - sequence.length;
    const activeLoading = attendanceLoading || (allEventIds.length > 0 && loading);

    const changeView = (nextView: MyEventsView) => {
        setViews((current) => ({ ...current, [activeTab]: nextView }));
        setSearchOpen(false);
    };

    const selectSequenceIndex = (index: number) => {
        const item = sequence[index];
        if (!item) return;
        setSelectedByTab((current) => ({ ...current, [activeTab]: item.event.event_id }));
    };

    return (
        <div className="relative min-h-[calc(100dvh-160px)] bg-canvas">
            <nav aria-label="My Events" className="sticky top-0 z-[7600] grid grid-cols-3 border-b border-line bg-surface">
                {tabs.map((tab) => {
                    const active = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => { setActiveTab(tab.id); setSearchOpen(false); }}
                            aria-selected={active}
                            role="tab"
                            className={`relative py-3 text-xs font-semibold transition ${active ? 'text-action' : 'text-ink-soft hover:text-ink'}`}
                        >
                            {tab.label}
                            {active && <span className="absolute inset-x-4 bottom-0 h-0.5 bg-action" />}
                        </button>
                    );
                })}
            </nav>

            {activeLoading && <p className="py-20 text-center text-sm text-muted">Loading your events…</p>}

            {!activeLoading && view === 'list' && (
                <MyEventsList events={activeEvents} tab={activeTab} onEventClick={setModalEvent} />
            )}

            {!activeLoading && view === 'calendar' && (
                <div className="mx-auto max-w-5xl px-3 pb-32 pt-4">
                    <div className="mb-3 flex items-center justify-center gap-2" aria-label="Calendar navigation">
                        <button
                            type="button"
                            onClick={() => calendarRef.current?.getApi().prev()}
                            aria-label="Previous month"
                            className="inline-flex h-9 w-9 items-center justify-center border border-line bg-surface text-ink-soft hover:text-action"
                        >
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            onClick={() => calendarRef.current?.getApi().today()}
                            className="h-9 border border-line bg-surface px-4 text-xs font-semibold text-ink hover:text-action"
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            onClick={() => calendarRef.current?.getApi().next()}
                            aria-label="Next month"
                            className="inline-flex h-9 w-9 items-center justify-center border border-line bg-surface text-ink-soft hover:text-action"
                        >
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                    <Suspense fallback={<p className="py-20 text-center text-sm text-muted">Loading calendar…</p>}>
                        <Calendar ref={calendarRef} events={activeEvents} onEventClick={(event) => setModalEvent(event)} />
                    </Suspense>
                </div>
            )}

            {!activeLoading && view === 'map' && (
                <div className="relative h-[calc(100dvh-190px)] min-h-[420px]">
                    {sequence.length > 0 ? (
                        <EventMap
                            events={sequence.map(({ event }) => event)}
                            hoveredEventId={selected?.event.event_id ?? null}
                            onMarkerSelect={(event) => setSelectedByTab((current) => ({ ...current, [activeTab]: event.event_id }))}
                            disablePopups
                            journeySequence={sequenceNumbers}
                            journeyRouteOn={routeOn}
                            journeySelectedEventId={selected?.event.event_id}
                        />
                    ) : (
                        <div className="flex h-full items-center justify-center px-6 text-center">
                            <p className="text-sm text-ink-soft">These events do not have map locations yet.</p>
                        </div>
                    )}
                    {myEventsRouteEnabled && sequence.length > 1 && (
                        <label className="absolute right-3 top-3 z-[750] inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 text-xs font-medium text-ink shadow-md">
                            <Route className="h-4 w-4 text-action" aria-hidden="true" />
                            Route
                            <input
                                type="checkbox"
                                checked={routeOn}
                                onChange={(changeEvent) => setRoutes((current) => ({ ...current, [activeTab]: changeEvent.target.checked }))}
                                className="h-4 w-4 accent-action"
                            />
                        </label>
                    )}
                    {unmappedCount > 0 && (
                        <button
                            type="button"
                            onClick={() => changeView('list')}
                            className="absolute left-3 top-3 z-[750] rounded-full border border-line bg-surface px-3 py-2 text-xs font-medium text-ink shadow-md"
                        >
                            {unmappedCount} without map location · List
                        </button>
                    )}
                    {selected && (
                        <MyEventsMapPreview
                            event={selected.event}
                            sequence={selected.sequence}
                            tab={activeTab}
                            hasPrevious={selectedIndex > 0}
                            hasNext={selectedIndex < sequence.length - 1}
                            onPrevious={() => selectSequenceIndex(selectedIndex - 1)}
                            onNext={() => selectSequenceIndex(selectedIndex + 1)}
                            onOpen={() => setModalEvent(selected.event)}
                        />
                    )}
                </div>
            )}

            {searchOpen && <MyEventsAddSearch tab={activeTab} onSuggest={() => setSuggestOpen(true)} />}
            <MyEventsViewControls view={view} searchOpen={searchOpen} onViewChange={changeView} onToggleSearch={() => setSearchOpen((open) => !open)} />

            {modalEvent && <EventModal event={modalEvent} onClose={() => setModalEvent(null)} />}
            {suggestOpen && <SuggestEventModal onClose={() => setSuggestOpen(false)} />}
        </div>
    );
}
