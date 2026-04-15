/**
 * Parse URLs from text and return an array of unique links.
 */
export function parseLinks(text: string | null): string[] {
    if (!text) return [];
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
    const matches = text.match(urlRegex);
    if (!matches) return [];
    return [...new Set(matches)];
}
