/**
 * Lightweight OS/browser/device detection from a raw ``User-Agent`` string.
 * Used by AdminUsersTab to render the "Last login" device icons. Only
 * covers the icon assets that already exist in ``frontend/public/``
 * (windows, mac, ios, android, chrome, edge, safari) — anything else falls
 * back to a `null` icon with a best-effort text label.
 */

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export interface ParsedUserAgent {
    osIcon: string | null;
    osLabel: string;
    browserIcon: string | null;
    browserLabel: string;
    device: DeviceType;
}

export function parseUserAgent(ua: string | null): ParsedUserAgent {
    const s = ua || '';

    let osIcon: string | null = null;
    let osLabel = 'Unknown OS';
    if (/iphone|ipad|ipod/i.test(s)) {
        osIcon = '/ios.png';
        osLabel = 'iOS';
    } else if (/android/i.test(s)) {
        osIcon = '/android.png';
        osLabel = 'Android';
    } else if (/windows/i.test(s)) {
        osIcon = '/windows.png';
        osLabel = 'Windows';
    } else if (/macintosh|mac os x/i.test(s)) {
        osIcon = '/mac.png';
        osLabel = 'macOS';
    } else if (/linux/i.test(s)) {
        osLabel = 'Linux';
    }

    let browserIcon: string | null = null;
    let browserLabel = 'Unknown browser';
    if (/edg\//i.test(s)) {
        browserIcon = '/edge.png';
        browserLabel = 'Edge';
    } else if (/chrome\//i.test(s) && !/opr\//i.test(s)) {
        browserIcon = '/chrome.png';
        browserLabel = 'Chrome';
    } else if (/safari\//i.test(s) && !/chrome\//i.test(s)) {
        browserIcon = '/safari.png';
        browserLabel = 'Safari';
    } else if (/firefox\//i.test(s)) {
        browserLabel = 'Firefox';
    }

    let device: DeviceType = 'desktop';
    if (/ipad/i.test(s) || (/android/i.test(s) && !/mobile/i.test(s))) {
        device = 'tablet';
    } else if (/mobi|iphone|ipod/i.test(s)) {
        device = 'mobile';
    }

    return { osIcon, osLabel, browserIcon, browserLabel, device };
}
