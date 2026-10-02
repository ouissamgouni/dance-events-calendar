import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MyEventsUtilityMenu from './MyEventsUtilityMenu';

const authState: { user: { id: string } | null } = { user: null };
vi.mock('../context/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../api', () => ({
    createShareToken: vi.fn(async () => ({ token: 'tok-1' })),
    getShareToken: vi.fn(async () => { throw new Error('not_found'); }),
    exportIcs: vi.fn(),
    exportXlsx: vi.fn(),
    getAppShareUrl: (token: string) => `https://app.test/shared/${token}`,
    getCalendarFeedUrl: (token: string) => `https://api.test/share/calendar/${token}.ics`,
}));

function renderMenu() {
    return {
        user: userEvent.setup(),
        ...render(
            <MemoryRouter initialEntries={['/my-events']}>
                <Routes>
                    <Route path="/my-events" element={<MyEventsUtilityMenu activeTab="upcoming" eventIds={[]} />} />
                    <Route path="/login" element={<p>Login page</p>} />
                </Routes>
            </MemoryRouter>,
        ),
    };
}

describe('MyEventsUtilityMenu', () => {
    beforeEach(() => {
        authState.user = { id: 'u1' };
    });

    it('opens the approved Share and export sheet without RSS', async () => {
        const { user } = renderMenu();

        await user.click(screen.getByRole('button', { name: 'Share and export My Events' }));

        expect(screen.getByRole('dialog', { name: /Share & export/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Share My Events/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Subscribe in another calendar/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Export calendar \(.ics\)/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Export spreadsheet \(.xlsx\)/ })).toBeInTheDocument();
        expect(screen.queryByText(/RSS/i)).not.toBeInTheDocument();
    });

    it('expands only the tapped share entry', async () => {
        const { user } = renderMenu();
        await user.click(screen.getByRole('button', { name: 'Share and export My Events' }));

        await user.click(screen.getByRole('button', { name: /Subscribe in another calendar/ }));

        expect(await screen.findByTitle('https://api.test/share/calendar/tok-1.ics')).toBeInTheDocument();
        expect(screen.queryByTitle('https://app.test/shared/tok-1')).not.toBeInTheDocument();
    });

    it('sends signed-out users to sign in instead of creating a link', async () => {
        authState.user = null;
        const { user } = renderMenu();
        await user.click(screen.getByRole('button', { name: 'Share and export My Events' }));

        await user.click(screen.getByRole('button', { name: /Share My Events/ }));

        expect(screen.getByText('Login page')).toBeInTheDocument();
    });
});
