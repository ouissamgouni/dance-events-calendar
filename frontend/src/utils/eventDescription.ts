const EXTRACTED_LINK_LINE = /^\s*(?:[^:\r\n]{1,40}\s*:\s*)?https?:\/\/\S+\s*$/iu;

export function cleanEventDescription(description: string): string {
    return description
        .split(/\r?\n/)
    .filter((line) => !EXTRACTED_LINK_LINE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
