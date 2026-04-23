import { useEffect } from 'react';
import type { CSSProperties, DOMAttributes } from 'react';
import type { CalendarEvent } from '../types';
import EventDetailsPanel from './EventDetailsPanel';

interface Props {
    event: CalendarEvent;
    anchorRect: DOMRect | null;
    onClose: () => void;
    onEdit?: (event: CalendarEvent) => void;
    source?: string;
}

const VIEWPORT_PADDING = 16;
const PANEL_WIDTH = 420;
const PANEL_GAP = 12;

function getPanelStyle(anchorRect: DOMRect | null): CSSProperties {
    if (!anchorRect) {
        return {
            position: 'fixed',
            top: VIEWPORT_PADDING,
            left: '50%',
            transform: 'translateX(-50%)',
            width: `min(${PANEL_WIDTH}px, calc(100vw - ${VIEWPORT_PADDING * 2}px))`,
            maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
            zIndex: 9998,
        };
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = Math.min(PANEL_WIDTH, viewportWidth - VIEWPORT_PADDING * 2);
    const openToRight = anchorRect.left <= viewportWidth - anchorRect.right;
    const unclampedLeft = openToRight
        ? anchorRect.right + PANEL_GAP
        : anchorRect.left - panelWidth - PANEL_GAP;
    const unclampedTop = anchorRect.top - 12;

    return {
        position: 'fixed',
        top: Math.max(VIEWPORT_PADDING, Math.min(unclampedTop, viewportHeight - VIEWPORT_PADDING - 560)),
        left: Math.max(VIEWPORT_PADDING, Math.min(unclampedLeft, viewportWidth - VIEWPORT_PADDING - panelWidth)),
        width: panelWidth,
        maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        zIndex: 9998,
    };
}

export default function EventAnchoredDetailPanel({ event, anchorRect, onClose, onEdit, source }: Props) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };

        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    const panelStyle = getPanelStyle(anchorRect);
    const stopClick: DOMAttributes<HTMLDivElement>['onClick'] = (e) => e.stopPropagation();

    return (
        <>
            <div className="fixed inset-0 z-[9997]" onClick={onClose} />
            <div style={panelStyle} onClick={stopClick}>
                <EventDetailsPanel
                    event={event}
                    onClose={onClose}
                    onEdit={onEdit}
                    surface="card"
                    className="max-h-[calc(100vh-32px)]"
                    bodyClassName="max-h-[calc(100vh-120px)]"
                    source={source}
                />
            </div>
        </>
    );
}
