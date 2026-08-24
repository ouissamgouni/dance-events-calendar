export interface InclusiveDateRange {
    startDate: string;
    endDate: string;
}

export function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function toInclusiveCalendarRange(start: Date, endExclusive: Date): InclusiveDateRange {
    const endInclusive = new Date(endExclusive);
    endInclusive.setDate(endInclusive.getDate() - 1);
    return {
        startDate: formatLocalDate(start),
        endDate: formatLocalDate(endInclusive),
    };
}
