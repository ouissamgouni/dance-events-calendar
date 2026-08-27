import { useEffect, forwardRef, useImperativeHandle } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import CalendarMapWorkspace from './CalendarMapWorkspace';

const calendarApi = vi.hoisted(() => ({
    prev: vi.fn(),
    next: vi.fn(),
    today: vi.fn(),
}));

vi.mock('./Calendar', () => ({
    default: forwardRef(function CalendarMock({ viewMode, onDatesChange }: {
        viewMode: string;
        onDatesChange?: (start: Date, end: Date) => void;
    }, ref) {
        useImperativeHandle(ref, () => ({ getApi: () => calendarApi }));
        useEffect(() => {
            onDatesChange?.(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-22T00:00:00Z'));
        }, [onDatesChange]);
        return <div data-testid="calendar" data-view-mode={viewMode} />;
    }),
}));

describe('CalendarMapWorkspace', () => {
    afterEach(() => vi.restoreAllMocks());

    it('shares range controls, visible dates and the map-only toggle', async () => {
        const user = userEvent.setup();
        const onViewModeChange = vi.fn();
        const onDatesChange = vi.fn();

        render(
            <CalendarMapWorkspace
                events={[]}
                viewMode="3week"
                onViewModeChange={onViewModeChange}
                onDatesChange={onDatesChange}
                onEventClick={vi.fn()}
                map={(calendarVisible) => <div data-testid="map" data-calendar-visible={String(calendarVisible)} />}
            />,
        );

        expect(await screen.findByTestId('calendar')).toHaveAttribute('data-view-mode', '3week');
        expect(await screen.findByText(/Sep 1.*21, 2026/)).toBeInTheDocument();
        expect(onDatesChange).toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: '30d' }));
        expect(onViewModeChange).toHaveBeenCalledWith('month');

        await user.click(screen.getByRole('button', { name: 'Show map only' }));
        expect(screen.getByTestId('map')).toHaveAttribute('data-calendar-visible', 'false');
        expect(screen.getByRole('button', { name: 'Show calendar and map' })).toBeInTheDocument();
    });

    it('renders a calendar-only workspace without map controls', async () => {
        render(
            <CalendarMapWorkspace
                events={[]}
                viewMode="3week"
                onDatesChange={vi.fn()}
                onEventClick={vi.fn()}
            />,
        );

        expect(await screen.findByTestId('calendar')).toBeInTheDocument();
        expect(screen.queryByTestId('map')).not.toBeInTheDocument();
        expect(screen.queryByTestId('calendar-map-toggle')).not.toBeInTheDocument();
    });

    it.each([
        [500, true],
        [499, false],
    ])('renders a 200px remaining map only when the content height is %ipx', async (contentHeight, visible) => {
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
            return this.dataset.testid === 'calendar-map-content' ? contentHeight : 0;
        });
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
            return this.dataset.testid === 'calendar-container' ? 300 : 0;
        });

        render(
            <CalendarMapWorkspace
                events={[]}
                viewMode="3week"
                onEventClick={vi.fn()}
                layout="remaining-map"
                map={() => <div data-testid="map" />}
            />,
        );

        expect(await screen.findByTestId('calendar')).toBeInTheDocument();
        if (visible) {
            expect(await screen.findByTestId('calendar-remaining-map')).toHaveStyle({ height: '200px' });
            expect(screen.getByTestId('map')).toBeInTheDocument();
        } else {
            expect(screen.queryByTestId('calendar-remaining-map')).not.toBeInTheDocument();
            expect(screen.queryByTestId('map')).not.toBeInTheDocument();
        }
        expect(screen.queryByTestId('calendar-map-toggle')).not.toBeInTheDocument();
    });
});
