import { useState } from 'react';
import { Calendar, MapPin, Repeat } from 'lucide-react';
import { Switch } from '../ToggleRow';
import Row from './Row';
import DateTimeRow from './DateTimeRow';
import LocationPage from './LocationPage';
import RepeatPages from './RepeatPages';
import { rowSummary, weekdayOf, type RecurrenceState } from './recurrence';
import {
    errorCls,
    fieldErrorCls,
    helpCls,
    inputCls,
    inputErrorCls,
    scrollIntoViewOnFocus,
    type PatchState,
    type SuggestFormState,
} from './formState';
import {
    addMinutes,
    combine,
    datePart,
    formatDateTime,
    minutesBetween,
    parseLocal,
    timePart,
} from './datetime';
import type { FieldError } from './validation';

interface Props {
    state: SuggestFormState;
    patch: PatchState;
    error: FieldError | null;
    /** Lets the shell hide its header and footer while a sub-page is open. */
    onSubPageChange: (open: boolean) => void;
}

/** Default gap between start and end until the user sets an end themselves. */
const DEFAULT_DURATION_MIN = 120;

export default function Step1Event({ state, patch, error, onSubPageChange }: Props) {
    const [page, setPage] = useState<'none' | 'location' | 'repeat'>('none');
    const [repeatRederived, setRepeatRederived] = useState(false);

    const startDate = parseLocal(state.start);

    const open = (next: 'location' | 'repeat') => {
        setPage(next);
        onSubPageChange(true);
    };
    const close = () => {
        setPage('none');
        onSubPageChange(false);
    };

    const handleStartChange = (value: string) => {
        const next = parseLocal(value);
        const prev = startDate;
        const patchObj: Partial<SuggestFormState> = { start: value };

        // The end follows the start until the user sets one explicitly, so a
        // single tap on Start already produces a valid range.
        if (value && !state.endTouched) {
            patchObj.end = addMinutes(value, state.allDay ? 0 : DEFAULT_DURATION_MIN);
        } else if (value && state.end) {
            const gap = minutesBetween(state.start, state.end);
            if (gap !== null && gap > 0) patchObj.end = addMinutes(value, gap);
        }

        // A weekly rule that simply tracked the old start day should follow the
        // new one; anything the user hand-picked is left untouched.
        if (
            next &&
            prev &&
            state.recurrence.mode === 'weekly' &&
            state.recurrence.weekdays.length === 1 &&
            state.recurrence.weekdays[0] === weekdayOf(prev) &&
            weekdayOf(next) !== weekdayOf(prev)
        ) {
            patchObj.recurrence = { ...state.recurrence, weekdays: [weekdayOf(next)] };
            setRepeatRederived(true);
        } else if (next && prev && state.recurrence.mode !== 'none' && state.recurrence.mode !== 'dates') {
            setRepeatRederived(true);
        }
        patch(patchObj);
    };

    const handleAllDayChange = (checked: boolean) => {
        if (checked) {
            // Park the times so switching back restores exactly what was set.
            patch({
                allDay: true,
                hiddenTimes: { start: timePart(state.start), end: timePart(state.end) },
                start: datePart(state.start),
                end: datePart(state.end),
            });
            return;
        }
        patch({
            allDay: false,
            hiddenTimes: null,
            start: combine(datePart(state.start), state.hiddenTimes?.start || '19:00'),
            end: combine(datePart(state.end), state.hiddenTimes?.end || '23:00'),
        });
    };

    const locationUnverified = state.location.trim() && (state.latitude === null || state.longitude === null);
    const pickerMode = state.allDay ? 'date' : 'datetime-local';
    const errorFor = (field: FieldError['field']) => (error?.field === field ? error.message : null);

    if (page === 'location') {
        return (
            <LocationPage
                value={state.location}
                onSelect={(location, latitude, longitude) => patch({ location, latitude, longitude })}
                onClose={close}
            />
        );
    }

    if (page === 'repeat') {
        return (
            <RepeatPages
                value={state.recurrence}
                start={startDate}
                onChange={(recurrence: RecurrenceState) => {
                    patch({ recurrence });
                    setRepeatRederived(false);
                }}
                onClose={close}
            />
        );
    }

    return (
        <div className="space-y-3">
            <div>
                <input
                    id="suggest-title"
                    type="text"
                    aria-label="Event name"
                    aria-invalid={errorFor('title') ? true : undefined}
                    aria-describedby={errorFor('title') ? 'suggest-title-error' : undefined}
                    value={state.title}
                    onChange={(e) => patch({ title: e.target.value })}
                    onFocus={scrollIntoViewOnFocus}
                    placeholder="Event name"
                    className={errorFor('title') ? inputErrorCls : inputCls}
                />
                {errorFor('title') ? (
                    <p id="suggest-title-error" className={fieldErrorCls}>
                        {errorFor('title')}
                    </p>
                ) : null}
            </div>

            <div>
                <Row
                    id="suggest-location"
                    icon={MapPin}
                    label="Location"
                    value={state.location || undefined}
                    placeholder="Add location"
                    invalid={Boolean(errorFor('location'))}
                    describedBy={errorFor('location') ? 'suggest-location-error' : undefined}
                    onClick={() => open('location')}
                />
                {errorFor('location') ? (
                    <p id="suggest-location-error" className={fieldErrorCls}>
                        {errorFor('location')}
                    </p>
                ) : null}
                {locationUnverified ? (
                    <p className={errorCls}>
                        We couldn&apos;t verify this address on the map. You can continue, but picking a
                        suggestion improves accuracy.
                    </p>
                ) : null}
            </div>

            <div className="flex min-h-12 items-center gap-3 rounded-field border border-line bg-surface px-4 py-2">
                <Calendar size={18} className="shrink-0 text-ink-soft" aria-hidden="true" />
                <span className="text-sm text-ink">All day</span>
                <span className="ml-auto">
                    <Switch label="All day" checked={state.allDay} onChange={handleAllDayChange} />
                </span>
            </div>

            <div>
                <DateTimeRow
                    id="suggest-start"
                    label="Start"
                    mode={pickerMode}
                    value={state.start}
                    display={formatDateTime(state.start, state.allDay)}
                    placeholder="Select date"
                    invalid={Boolean(errorFor('start'))}
                    describedBy={errorFor('start') ? 'suggest-start-error' : undefined}
                    onChange={handleStartChange}
                />
                {errorFor('start') ? (
                    <p id="suggest-start-error" className={fieldErrorCls}>
                        {errorFor('start')}
                    </p>
                ) : null}
            </div>

            <div>
                <DateTimeRow
                    id="suggest-end"
                    label="End"
                    mode={pickerMode}
                    value={state.end}
                    min={state.start || undefined}
                    display={formatDateTime(state.end, state.allDay)}
                    placeholder="Select date"
                    invalid={Boolean(errorFor('end'))}
                    describedBy={errorFor('end') ? 'suggest-end-error' : undefined}
                    onChange={(end) => patch({ end, endTouched: true })}
                />
                {errorFor('end') ? (
                    <p id="suggest-end-error" className={fieldErrorCls}>
                        {errorFor('end')}
                    </p>
                ) : null}
            </div>

            <div>
                <Row
                    id="suggest-repeat"
                    icon={Repeat}
                    label="Repeat"
                    value={state.recurrence.mode === 'none' ? undefined : rowSummary(state.recurrence)}
                    placeholder="Does not repeat"
                    invalid={Boolean(errorFor('recurrence'))}
                    describedBy={errorFor('recurrence') ? 'suggest-repeat-error' : undefined}
                    onClick={() => open('repeat')}
                />
                {errorFor('recurrence') ? (
                    <p id="suggest-repeat-error" className={fieldErrorCls}>
                        {errorFor('recurrence')}
                    </p>
                ) : null}
                {repeatRederived && state.recurrence.mode !== 'none' ? (
                    <p className={helpCls}>Repeat now follows the new start date. Tap to review.</p>
                ) : null}
            </div>
        </div>
    );
}
