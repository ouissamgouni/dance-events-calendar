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

    it('shows destination labels by default', () => {
        render(<ViewSwitcher currentView="list" onSelect={vi.fn()} />);

        expect(screen.getByText('Map')).toBeVisible();
        expect(screen.getByText('Calendar')).toBeVisible();
    });

    it('keeps labels desktop-only when mobile labels are disabled', () => {
        render(<ViewSwitcher currentView="list" onSelect={vi.fn()} mobileLabelsEnabled={false} />);

        expect(screen.getByText('Map')).toHaveClass('hidden', 'lg:inline');
        expect(screen.getByTestId('view-switcher-map')).toHaveClass('w-11', 'lg:w-auto');
    });

    it('renders the create (+) button only when onCreate is provided and fires it', async () => {
        const onCreate = vi.fn();
        const { rerender } = render(<ViewSwitcher currentView="map" onSelect={vi.fn()} />);
        expect(screen.queryByTestId('view-switcher-create')).toBeNull();

        rerender(<ViewSwitcher currentView="map" onSelect={vi.fn()} onCreate={onCreate} />);
        const createButton = screen.getByRole('button', { name: 'Add event' });
        expect(createButton).toHaveTextContent('Add');
        expect(createButton).not.toHaveAttribute('aria-expanded');
        await userEvent.click(createButton);
        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('presents the create action as Close when its flow is expanded', () => {
        render(<ViewSwitcher currentView="list" onSelect={vi.fn()} onCreate={vi.fn()} createExpanded />);

        const createButton = screen.getByRole('button', { name: 'Close event search' });
        expect(createButton).toHaveTextContent('Close');
        expect(createButton).toHaveAttribute('aria-expanded', 'true');
        expect(createButton.querySelector('svg')).toHaveClass('rotate-45');
    });
});
