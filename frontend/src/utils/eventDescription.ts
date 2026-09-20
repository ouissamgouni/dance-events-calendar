import { parseLinks } from './parseLinks';

const EXTRACTED_LINK_LINE = /^\s*(?:[^:\r\n]{1,40}\s*:\s*)?https?:\/\/\S+\s*$/iu;

interface EventLink {
    url: string;
    label?: string | null;
}

export function cleanEventDescription(description: string): string {
    return description
        .split(/\r?\n/)
        .filter((line) => !EXTRACTED_LINK_LINE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function collectEventLinks(
    structuredLinks: readonly EventLink[] | null | undefined,
    description: string | null | undefined,
): EventLink[] {
    const links = (structuredLinks ?? [])
        .filter((link) => link.url?.trim())
        .map((link) => ({ ...link, url: link.url.trim() }));
    const seen = new Set(links.map((link) => link.url));

    for (const url of parseLinks(description ?? '')) {
        if (!seen.has(url)) {
            links.push({ url });
            seen.add(url);
        }
    }

    return links;
}
