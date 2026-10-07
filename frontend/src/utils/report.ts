export const SUPPORT_EMAIL = 'support@joinmovida.com';

export type ReportKind = 'event' | 'review' | 'profile' | 'photo';

const SUBJECTS: Record<ReportKind, string> = {
    event: 'Report or removal request: event',
    review: 'Report: review',
    profile: 'Report: profile',
    photo: 'Report: photo',
};

/** Pre-filled email carrying the details a notice needs under the EU Digital Services Act (Art. 16). */
export function reportMailto(kind: ReportKind, url: string, reference?: string): string {
    const body = [
        `Link: ${url}`,
        ...(reference ? [`Reference: ${reference}`] : []),
        '',
        'Why should this be removed or corrected? (e.g. wrong info, copyright, harassment, illegal content)',
        '',
        '',
        'Your name:',
        '',
        'I confirm this report is accurate and made in good faith.',
    ].join('\n');
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUBJECTS[kind])}&body=${encodeURIComponent(body)}`;
}
