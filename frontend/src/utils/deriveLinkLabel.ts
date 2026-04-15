const DOMAIN_LABELS: Record<string, string> = {
    'facebook.com': 'Facebook',
    'eventbrite.com': 'Eventbrite',
    'meetup.com': 'Meetup',
    'instagram.com': 'Instagram',
    'ticketmaster.com': 'Tickets',
    'dice.fm': 'DICE',
    'shotgun.live': 'Shotgun',
};

export function deriveLinkLabel(url: string): string {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        for (const [domain, label] of Object.entries(DOMAIN_LABELS)) {
            if (hostname === domain || hostname.endsWith('.' + domain)) {
                return label;
            }
        }
        // Capitalize first segment of hostname
        const first = hostname.split('.')[0];
        return first.charAt(0).toUpperCase() + first.slice(1);
    } catch {
        return 'Link';
    }
}
