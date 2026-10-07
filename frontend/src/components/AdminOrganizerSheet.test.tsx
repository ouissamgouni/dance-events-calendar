import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { adminUpdateUserOrganizer, fetchAdminOrganizedEvents, searchEvents } from '../api';
import AdminOrganizerSheet from './AdminOrganizerSheet';

vi.mock('../api', () => ({
    adminUpdateUserOrganizer: vi.fn(),
    fetchAdminOrganizedEvents: vi.fn(),
    searchEvents: vi.fn(),
}));

describe('AdminOrganizerSheet', () => {
    it('stages an assignment and a removal, then saves them in one call', async () => {
        const user = userEvent.setup();
        vi.mocked(fetchAdminOrganizedEvents).mockResolvedValue([
            { event_id: 'ev-old', title: 'Old Social', start: null, city: null },
        ]);
        vi.mocked(searchEvents).mockResolvedValue([
            { event_id: 'ev-new', title: 'New Social', start: null, location: null, city: 'Paris', country: null, matched_fields: ['title'], matched_tags: [] },
        ]);
        vi.mocked(adminUpdateUserOrganizer).mockResolvedValue({ is_verified_organizer: true, events: [] });
        const onChanged = vi.fn();
        const onClose = vi.fn();
        render(
            <MemoryRouter>
                <AdminOrganizerSheet userId="u-1" label="@olive" verified={false} onClose={onClose} onChanged={onChanged} />
            </MemoryRouter>,
        );

        const save = screen.getByRole('button', { name: 'Save changes' });
        expect(save).toBeDisabled();

        await user.click(await screen.findByRole('button', { name: 'Remove Old Social' }));
        await user.type(screen.getByLabelText('Search events to assign'), 'New');
        await user.click(await screen.findByRole('button', { name: /New Social/ }));

        expect(screen.getByTestId('staged-add')).toHaveTextContent('New Social');
        expect(screen.getByText('@olive will be notified.')).toBeInTheDocument();
        expect(adminUpdateUserOrganizer).not.toHaveBeenCalled();

        await user.click(save);

        expect(adminUpdateUserOrganizer).toHaveBeenCalledWith('u-1', {
            is_verified_organizer: true,
            add_event_ids: ['ev-new'],
            remove_event_ids: ['ev-old'],
        });
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onChanged).toHaveBeenCalled();
    });
});
