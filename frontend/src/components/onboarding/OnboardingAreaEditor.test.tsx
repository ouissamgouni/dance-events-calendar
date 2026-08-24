import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreferredAreaPayload } from '../../api';
import OnboardingAreaEditor from './OnboardingAreaEditor';

const mapHarness = vi.hoisted(() => {
    const handlers = new Map<string, () => void>();
    let coordinateOffset = 0;
    const map = {
        dragging: { disable: vi.fn(), enable: vi.fn() },
        touchZoom: { disable: vi.fn(), enable: vi.fn() },
        invalidateSize: vi.fn(),
        fitBounds: vi.fn(),
        setView: vi.fn(),
        getCenter: () => ({ lat: 42, lng: 15 }),
        getZoom: () => 3,
        getSize: () => ({ x: 390, y: 400 }),
        containerPointToLatLng: (point: { x: number; y: number }) => ({
            lat: 70 - point.y / 5 + coordinateOffset,
            lng: -40 + point.x / 5 + coordinateOffset,
        }),
        on: vi.fn((events: string, handler: () => void) => {
            events.split(' ').forEach((event) => handlers.set(event, handler));
        }),
        off: vi.fn((events: string) => {
            events.split(' ').forEach((event) => handlers.delete(event));
        }),
    };
    return {
        handlers,
        map,
        setCoordinateOffset(value: number) { coordinateOffset = value; },
    };
});

vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    TileLayer: () => null,
    useMap: () => mapHarness.map,
}));

const europe: PreferredAreaPayload = { label: 'Europe', min_lat: 20, min_lng: -10, max_lat: 65, max_lng: 40 };

function EditorHarness() {
    const [area, setArea] = useState(europe);
    const [manualName, setManualName] = useState(false);
    return (
        <OnboardingAreaEditor
            area={area}
            alertsEnabled
            nameManuallyEdited={manualName}
            onAreaChange={setArea}
            onAlertsChange={() => undefined}
            onNameManuallyEdited={() => setManualName(true)}
            onBack={() => undefined}
            onContinue={() => undefined}
        />
    );
}

describe('OnboardingAreaEditor', () => {
    beforeEach(() => {
        mapHarness.handlers.clear();
        mapHarness.setCoordinateOffset(0);
        vi.clearAllMocks();
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 390 });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 });
        Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
    });

    it('focuses naming, applies Custom after meaningful movement, and preserves a manual name', async () => {
        const user = userEvent.setup();
        render(<EditorHarness />);

        const input = await screen.findByLabelText('Name');
        await user.click(await screen.findByRole('button', { name: 'Use this area' }));
        await waitFor(() => expect(input).toHaveFocus());
        expect((input as HTMLInputElement).selectionStart).toBe(0);
        expect((input as HTMLInputElement).selectionEnd).toBe('Europe'.length);

        mapHarness.setCoordinateOffset(3);
        act(() => mapHarness.handlers.get('moveend')?.());
        expect(input).toHaveValue('Custom');

        await user.clear(input);
        await user.type(input, 'Summer Europe');
        mapHarness.setCoordinateOffset(8);
        act(() => mapHarness.handlers.get('zoomend')?.());
        expect(input).toHaveValue('Summer Europe');
    });

    it('gives a corner resize gesture priority over map pan and zoom', async () => {
        render(<EditorHarness />);
        const handle = await screen.findByRole('button', { name: 'Resize area from north west' });

        fireEvent.pointerDown(handle, { pointerId: 7, clientX: 80, clientY: 80 });
        expect(mapHarness.map.dragging.disable).toHaveBeenCalledOnce();
        expect(mapHarness.map.touchZoom.disable).toHaveBeenCalledOnce();

        fireEvent.pointerUp(handle, { pointerId: 7 });
        expect(mapHarness.map.dragging.enable).toHaveBeenCalledOnce();
        expect(mapHarness.map.touchZoom.enable).toHaveBeenCalledOnce();
    });
});
