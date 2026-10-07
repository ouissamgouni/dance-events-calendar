import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMySubmissions, fetchOwnEventChanges, requestOwnSuggestionPublic, withdrawOwnEventChange, withdrawOwnSuggestionChanges } from '../api';
import type { OwnSuggestion } from '../types';
import MySubmissionsPage from './MySubmissionsPage';

vi.mock('../api', () => ({
    SUBMISSIONS_CHANGED_EVENT: 'submissions:changed',
    deleteOwnSuggestion: vi.fn(),
    fetchMySubmissions: vi.fn(),
    fetchOwnEventChanges: vi.fn(() => Promise.resolve([])),
    requestOwnSuggestionPublic: vi.fn(),
    withdrawOwnEventChange: vi.fn(),
    withdrawOwnSuggestion: vi.fn(),
    withdrawOwnSuggestionChanges: vi.fn(),
}));
const authUser = vi.hoisted(() => ({ name: 'Ouissam Gouni' }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock('../context/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ organizerClaimsEnabled: true }) }));

const fetchMySubmissionsMock = vi.mocked(fetchMySubmissions);
const withdrawOwnSuggestionChangesMock = vi.mocked(withdrawOwnSuggestionChanges);
const requestOwnSuggestionPublicMock = vi.mocked(requestOwnSuggestionPublic);

function suggestion(overrides: Partial<OwnSuggestion>): OwnSuggestion {
    return {
        id: 'submission-1',
        status: 'pending',
        edit_locked: false,
        can_edit: true,
        title: 'Paris Salsa Night',
        description: null,
        location: 'Paris',
        links: null,
        latitude: null,
        longitude: null,
        start: '2026-10-03T20:00:00Z',
        end: '2026-10-03T23:00:00Z',
        all_day: false,
        recurrence_rule: null,
        recurrence_dates: null,
        suggested_tag_ids: null,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: null,
        image_key: null,
        image_thumb_url: null,
        created_event_id: null,
        created_at: '2026-10-01T12:00:00Z',
        rejection_reason: null,
        pending_changes: null,
        ...overrides,
    };
}

describe('MySubmissionsPage', () => {
    beforeEach(() => {
        fetchMySubmissionsMock.mockResolvedValue([
            suggestion({ id: 'pending-1', title: 'Pending event', status: 'pending' }),
            suggestion({
                id: 'approved-1',
                title: 'Live event',
                status: 'approved',
                created_event_id: 'event-1',
                pending_changes: {
                    location: { old: 'A', new: 'B' },
                    start: { old: '2026-10-03T20:00:00Z', new: '2026-10-03T21:00:00Z' },
                },
            }),
            suggestion({ id: 'declined-1', title: 'Declined event', status: 'declined', created_event_id: 'event-2', rejection_reason: 'Too little event detail.' }),
            suggestion({ id: 'withdrawn-1', title: 'Withdrawn event', status: 'withdrawn', can_edit: false }),
        ]);
        withdrawOwnSuggestionChangesMock.mockResolvedValue(suggestion({
            id: 'approved-1',
            title: 'Live event',
            status: 'approved',
            created_event_id: 'event-1',
            pending_changes: null,
        }));
    });

    it('shows who can see each event, curator notes, and withdraws pending changes', async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><MySubmissionsPage /></MemoryRouter>);

        expect(await screen.findByText('Waiting to go public')).toBeInTheDocument();
        expect(screen.getByText('Public')).toBeInTheDocument();
        expect(screen.getByText('Only you')).toBeInTheDocument();
        expect(screen.getByText(/still in your events/)).toBeInTheDocument();
        expect(screen.getByText('Deleted')).toBeInTheDocument();
        expect(screen.getByText('Too little event detail.')).toBeInTheDocument();
        expect(screen.getByText('Changed: Venue, Time')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Withdraw changes' }));

        expect(withdrawOwnSuggestionChangesMock).toHaveBeenCalledWith('approved-1');
        await waitFor(() => expect(screen.queryByText('Changed: Venue, Time')).not.toBeInTheDocument());
    });

    it('asks to make a declined event public again', async () => {
        const user = userEvent.setup();
        requestOwnSuggestionPublicMock.mockResolvedValue(suggestion({ id: 'declined-1', title: 'Declined event', status: 'pending' }));
        render(<MemoryRouter><MySubmissionsPage /></MemoryRouter>);

        await user.click(await screen.findByRole('button', { name: 'Ask to make public' }));

        expect(requestOwnSuggestionPublicMock).toHaveBeenCalledWith('declined-1');
        await waitFor(() => expect(screen.getAllByText('Waiting to go public')).toHaveLength(2));
    });

    it('lists changes suggested to other events and withdraws an open one', async () => {
        const user = userEvent.setup();
        const change = {
            id: 7,
            event_id: 'ev-1',
            event_title: 'Salsa Friday',
            source: 'user' as const,
            status: 'pending' as const,
            changes: { location: { old: 'Studio A', new: 'Studio B' } },
            created_at: '2026-10-01T12:00:00Z',
            decided_at: null,
        };
        vi.mocked(fetchOwnEventChanges).mockResolvedValue([change]);
        vi.mocked(withdrawOwnEventChange).mockResolvedValue({ ...change, status: 'rejected' });
        render(<MemoryRouter><MySubmissionsPage /></MemoryRouter>);

        const section = await screen.findByRole('region', { name: 'Changes I suggested' });
        expect(section).toHaveTextContent('Salsa Friday');
        expect(section).toHaveTextContent('Changed: Venue');
        expect(section).toHaveTextContent('Waiting for review');
        await user.click(screen.getByRole('button', { name: 'Withdraw' }));

        expect(withdrawOwnEventChange).toHaveBeenCalledWith(7);
        await waitFor(() => expect(section).toHaveTextContent('Not applied'));
    });

    it('reloads after a submission is sent from the wizard opened over it', async () => {
        render(<MemoryRouter><MySubmissionsPage /></MemoryRouter>);
        await screen.findByText('Pending event');
        fetchMySubmissionsMock.mockResolvedValue([suggestion({ id: 'new-1', title: 'Fresh event', status: 'private' })]);

        window.dispatchEvent(new Event('submissions:changed'));

        expect(await screen.findByText('Fresh event')).toBeInTheDocument();
    });
});
