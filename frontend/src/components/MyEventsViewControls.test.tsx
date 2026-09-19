import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render';
import MyEventsViewControls from './MyEventsViewControls';

describe('MyEventsViewControls', () => {
    it.each([
        ['list', ['Calendar view', 'Map view'], 'List view'],
        ['calendar', ['List view', 'Map view'], 'Calendar view'],
        ['map', ['List view', 'Calendar view'], 'Map view'],
    ] as const)('shows alternative destinations when %s is active', (view, visible, hidden) => {
        renderWithProviders(
            <MyEventsViewControls
                view={view}
                searchOpen={false}
                onViewChange={vi.fn()}
                onToggleSearch={vi.fn()}
            />,
        );

        visible.forEach((label) => expect(screen.getByRole('button', { name: label })).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add an event' })).toBeInTheDocument();
    });

    it('changes to the selected destination', async () => {
        const onViewChange = vi.fn();
        const { user } = renderWithProviders(
            <MyEventsViewControls
                view="list"
                searchOpen={false}
                onViewChange={onViewChange}
                onToggleSearch={vi.fn()}
            />,
        );

        expect(screen.getByRole('button', { name: 'Calendar view' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Map view' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Calendar view' }));
        expect(onViewChange).toHaveBeenCalledWith('calendar');
    });

    it.each([
        ['list', ['Map view', 'Calendar view']],
        ['calendar', ['List view', 'Map view']],
        ['map', ['List view', 'Calendar view']],
    ] as const)('orders destinations for the %s view', (view, labels) => {
        renderWithProviders(
            <MyEventsViewControls view={view} searchOpen={false} onViewChange={vi.fn()} onToggleSearch={vi.fn()} />,
        );

        const controls = screen.getByTestId('my-events-view-controls');
        expect(Array.from(controls.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))).toEqual([
            ...labels,
            'Add an event',
        ]);
    });
});
