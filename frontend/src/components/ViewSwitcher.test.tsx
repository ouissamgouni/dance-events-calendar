import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ViewSwitcher, { type ExploreView } from './ViewSwitcher';

describe('ViewSwitcher', () => {
    it.each<[ExploreView, ExploreView[]]>([
        ['list', ['map', 'calendar']],
        ['map', ['list', 'calendar']],
        ['calendar', ['list', 'map']],
    ])('shows only destinations outside the current %s view', (currentView, expected) => {
        render(<ViewSwitcher currentView={currentView} onSelect={vi.fn()} />);

        for (const view of ['list', 'map', 'calendar'] as ExploreView[]) {
            const button = screen.queryByTestId(`view-switcher-${view}`);
            if (expected.includes(view)) expect(button).toBeInTheDocument();
            else expect(button).toBeNull();
        }
    });

    it('reports the selected destination', async () => {
        const onSelect = vi.fn();
        render(<ViewSwitcher currentView="list" onSelect={onSelect} />);

        await userEvent.click(screen.getByRole('button', { name: 'Calendar view' }));
        expect(onSelect).toHaveBeenCalledWith('calendar');
    });
});
