import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { radiusSearchArea } from '../utils/searchArea';
import RadiusAreaEditor from './RadiusAreaEditor';

vi.mock('react-leaflet', () => ({
    MapContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    TileLayer: () => null,
    Circle: () => null,
    CircleMarker: () => null,
    useMap: () => ({ fitBounds: vi.fn() }),
}));

describe('RadiusAreaEditor', () => {
    it('updates distance through the slider and offers the map-area escape hatch', () => {
        const onChange = vi.fn();
        const onSelectMapArea = vi.fn();
        render(
            <RadiusAreaEditor
                area={radiusSearchArea('Paris', { lat: 48.8566, lng: 2.3522 })}
                onChange={onChange}
                onSelectMapArea={onSelectMapArea}
            />,
        );

        fireEvent.change(screen.getByLabelText('Distance'), { target: { value: '50' } });
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            radius_km: 50,
            label: 'Paris · 50 km',
        }));

        fireEvent.click(screen.getByRole('button', { name: 'Select a map area instead' }));
        expect(onSelectMapArea).toHaveBeenCalledOnce();
    });
});
