import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCurators, searchUsers } from '../api';
import UserSearchBox from './UserSearchBox';

vi.mock('../api', () => ({
    fetchCurators: vi.fn(),
    searchUsers: vi.fn(),
}));

describe('UserSearchBox', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the desktop input and opens a below-header compact search panel', async () => {
        vi.useFakeTimers();
        vi.mocked(searchUsers).mockResolvedValue({
            items: [
                {
                    handle: 'marisol',
                    display_name: 'Marisol Vega',
                    avatar_url: null,
                    is_verified_organizer: false,
                    subscribers_count: 12,
                    is_subscribed: false,
                },
            ],
        });
        vi.mocked(fetchCurators).mockResolvedValue({ items: [] });

        render(
            <MemoryRouter>
                <UserSearchBox />
            </MemoryRouter>,
        );

        const desktopInput = screen.getByRole('combobox', { name: 'Search users' });
        expect(desktopInput.parentElement).toHaveClass('lg:flex');
        const trigger = screen.getByRole('button', { name: 'Search users' });
        expect(trigger).toHaveClass('lg:hidden');

        fireEvent.click(trigger);
        const inputs = screen.getAllByRole('combobox', { name: 'Search users' });
        const compactInput = inputs[1];
        const compactPanel = compactInput.closest('[style]');
        expect(compactPanel).toHaveStyle({
            top: 'calc(64px + env(safe-area-inset-top) + 6px)',
        });

        fireEvent.change(compactInput, { target: { value: 'mari' } });
        await act(async () => vi.advanceTimersByTimeAsync(251));

        expect(screen.getAllByRole('option', { name: /Marisol Vega/ })).toHaveLength(2);
        expect(document.querySelector('#people-search-compact-option-0')).toBeInTheDocument();
        expect(document.querySelector('#people-search-desktop-option-0')).toBeInTheDocument();
        expect(searchUsers).toHaveBeenCalledWith('mari', { limit: 8 });
    });
});
