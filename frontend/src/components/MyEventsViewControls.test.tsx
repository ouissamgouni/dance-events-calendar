import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render';
import MyEventsViewControls from './MyEventsViewControls';

describe('MyEventsViewControls', () => {
    it('hides the current view and changes to a contextual option', async () => {
        const onViewChange = vi.fn();
        const { user } = renderWithProviders(
            <MyEventsViewControls
                view="list"
                searchOpen={false}
                onViewChange={onViewChange}
                onToggleSearch={vi.fn()}
            />,
        );

        expect(screen.queryByRole('button', { name: 'List view' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Calendar view' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Map view' }));
        expect(onViewChange).toHaveBeenCalledWith('map');
    });
});
