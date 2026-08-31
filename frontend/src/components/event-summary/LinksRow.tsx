import type { ComponentType } from 'react';
import { Ticket, Globe, Link as LinkIcon } from 'lucide-react';
import type { CalendarEvent } from '../../types';
import { parseLinks } from '../../utils/parseLinks';
import { deriveLinkLabel } from '../../utils/deriveLinkLabel';
import { trackLink } from '../../utils/tracking';

interface Props {
    event: CalendarEvent;
}

/** Line icon for a known destination, derived from the link's display label. */
function iconFor(label: string): ComponentType<{ className?: string }> {
    const l = label.toLowerCase();
    // lucide dropped brand marks, so social links fall back to the globe icon.
    if (l.includes('instagram') || l.includes('facebook')) return Globe;
    if (l.includes('ticket') || l.includes('eventbrite') || l.includes('dice') || l.includes('shotgun')) return Ticket;
    if (l.includes('website')) return Globe;
    return LinkIcon;
}

/**
 * Single-line, horizontally scrollable row of external-link chips for
 * EventSummary. Never wraps to a second row — overflow scrolls, with the next
 * item left partially peeking to signal more.
 */
export default function LinksRow({ event }: Props) {
    const structured = (event.links ?? []).filter((l) => l.url?.trim());
    const links = structured.length > 0
        ? structured.map((l) => ({ url: l.url, label: l.label || deriveLinkLabel(l.url) }))
        : parseLinks(event.description).map((url) => ({ url, label: deriveLinkLabel(url) }));

    if (links.length === 0) return null;

    return (
        <div className="space-y-1.5">
            <p className="text-sm font-semibold text-ink">Links</p>
            <div className="-mx-1 flex flex-nowrap gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {links.map((link, i) => {
                    const Icon = iconFor(link.label);
                    return (
                        <a
                            key={`${link.url}-${i}`}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => trackLink(event.event_id, link.url)}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-action transition hover:bg-blue-100"
                        >
                            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                            {link.label}
                        </a>
                    );
                })}
            </div>
        </div>
    );
}
