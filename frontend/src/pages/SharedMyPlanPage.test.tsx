import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import SharedMyPlanPage from './SharedMyPlanPage';

const sharedPlan = {
    event_id: 'festival-1',
    event_title: 'Movida Weekend',
    owner_display_name: 'Alba',
    schedule: {
        event_id: 'festival-1',
        timezone: 'Europe/Paris',
        day_start_hour: 6,
        days: ['2026-10-16'],
        venues: [],
        rooms: [],
        levels: [],
        activity_types: [],
        sessions: [],
        version: 1,
        published_at: '2026-09-27T12:00:00Z',
    },
    entries: [{
        session_id: 'session-1',
        status: 'active',
        session: {
            id: 'session-1',
            title: 'Mambo Foundations',
            instructors: 'Alba & Luis',
            start: '2026-10-16T10:00:00Z',
            end: '2026-10-16T11:00:00Z',
            room_id: null,
            venue_id: null,
            level_id: null,
            activity_type_id: null,
            attendee_note: null,
            allow_plan: true,
            is_cancelled: false,
        },
    }],
};

function renderPage(token = 'plan-token') {
    return render(
        <MemoryRouter initialEntries={[`/shared/plan/${token}`]}>
            <Routes><Route path="/shared/plan/:token" element={<SharedMyPlanPage />} /></Routes>
        </MemoryRouter>,
    );
}

describe('SharedMyPlanPage', () => {
    it('renders an anonymous read-only live itinerary', async () => {
        server.use(http.get('*/api/share/plan/plan-token', () => HttpResponse.json(sharedPlan)));
        renderPage();

        expect(await screen.findByRole('heading', { name: "Alba's plan for Movida Weekend" })).toBeInTheDocument();
        expect(screen.getByText('Mambo Foundations')).toBeInTheDocument();
        expect(screen.getByText('Alba & Luis')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Full program' })).toHaveAttribute('href', '/event/festival-1/program');
        expect(screen.queryByRole('button', { name: /Remove .* from My Plan/ })).not.toBeInTheDocument();
    });

    it('shows a revoked-link state', async () => {
        server.use(http.get('*/api/share/plan/*', () => new HttpResponse(null, { status: 404 })));
        renderPage('revoked');

        await waitFor(() => expect(screen.getByText('This plan is no longer available')).toBeInTheDocument());
    });
});
