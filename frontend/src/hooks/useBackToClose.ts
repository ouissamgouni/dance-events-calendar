import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

// Back closes the topmost overlay: each open overlay owns a same-URL history entry tagged ``__overlay``.

interface Entry {
    id: number;
    href: string;
    close: () => void;
    removal?: ReturnType<typeof setTimeout>;
}

type OverlayState = { __overlay?: number } | null;

const stack: Entry[] = [];
// Seeded from the clock so ids stay increasing across page reloads.
let seq = Date.now();
// Hrefs to restore on the entries we land on after our own history.back() calls.
const ownPops: string[] = [];
let installed = false;
let nativeReplace: History['replaceState'];

function currentMarker(): number | undefined {
    return (window.history.state as OverlayState)?.__overlay;
}

function pushEntry(entry: Entry) {
    entry.id = ++seq;
    entry.href = window.location.href;
    // Keep react-router's state (idx/key/usr) so it still sees the same location.
    window.history.pushState({ ...(window.history.state ?? {}), __overlay: entry.id }, '');
}

function goBack(carryHref: string) {
    ownPops.push(carryHref);
    window.history.back();
}

// URL replaced while an overlay was open (e.g. filters synced to the query)
// must survive leaving the overlay entry, so copy it onto the entry below.
function carryUrl(href: string) {
    if (window.location.href === href) return;
    nativeReplace(window.history.state, '', href);
    const marker = currentMarker();
    const entry = stack.find((e) => e.id === marker);
    if (entry) entry.href = href;
}

function onPopState() {
    const marker = currentMarker();
    const own = ownPops.shift();
    if (own !== undefined) {
        carryUrl(own);
    } else {
        const top = stack[stack.length - 1];
        if (top && (marker === undefined || marker < top.id)) {
            carryUrl(top.href);
            // Re-push before closing so a refused close (e.g. a discard-confirm
            // dialog) keeps its entry, and anything it opens stacks above it.
            pushEntry(top);
            flushSync(() => top.close());
            return;
        }
    }
    // Stale entry left behind by an overlay that unmounted on navigation.
    if (marker !== undefined && !stack.some((e) => e.id === marker)) {
        goBack(window.location.href);
    }
}

function install() {
    if (installed) return;
    installed = true;
    // Capture so this runs before react-router's popstate listener reads the URL.
    window.addEventListener('popstate', onPopState, true);
    nativeReplace = window.history.replaceState.bind(window.history);
    window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
        const marker = currentMarker();
        const keep = marker !== undefined && data !== null && typeof data === 'object' && !('__overlay' in data);
        nativeReplace(keep ? { ...data, __overlay: marker } : data, unused, url);
        const entry = stack.find((e) => e.id === marker);
        if (entry) entry.href = window.location.href;
    };
}

function remove(entry: Entry) {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    // Only unwind our entry if it's still current — otherwise the user navigated.
    if (currentMarker() === entry.id) goBack(window.location.href);
}

export default function useBackToClose(onClose: () => void, enabled = true) {
    const closeRef = useRef(onClose);
    const entryRef = useRef<Entry | null>(null);

    useEffect(() => {
        closeRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!enabled) return;
        let entry = entryRef.current;
        if (entry?.removal !== undefined) {
            // StrictMode remount: keep the existing history entry.
            clearTimeout(entry.removal);
            entry.removal = undefined;
        } else {
            entry = { id: 0, href: '', close: () => closeRef.current() };
            entryRef.current = entry;
            install();
            pushEntry(entry);
            stack.push(entry);
        }
        const current = entry;
        return () => {
            current.removal = setTimeout(() => {
                current.removal = undefined;
                if (entryRef.current === current) entryRef.current = null;
                remove(current);
            }, 0);
        };
    }, [enabled]);
}
