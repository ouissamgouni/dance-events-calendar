const FACEBOOK_EVENT_LINE = /^\s*(?:facebook\s+)?event\s*:\s*https?:\/\/(?:www\.)?facebook\.com\/events(?:\/s)?\/\S+\s*$/i;

export function cleanEventDescription(description: string): string {
    return description
        .split(/\r?\n/)
        .filter((line) => !FACEBOOK_EVENT_LINE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
