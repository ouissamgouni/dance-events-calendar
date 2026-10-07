import { describe, expect, it } from 'vitest'

// Readable text floor is text-xs (12px); text-2xs (11px) is for count bubbles/eyebrows.
const SOURCES = import.meta.glob<string>(['./**/*.tsx', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true })
const TOO_SMALL = /(?<![\w-])text-\[(8|9|10)px\]/
// Admin console, print/share-image renders, and avatar-initial components are exempt.
const EXEMPT = [
    /(^|\/)Admin[^/]*\.tsx$/,
    /^components\/admin-events\//,
    /^components\/(CalendarCurationRulesPanel|CalendarDetailDrawer|CalendarFilterPills|CalendarRunPanel|DuplicateGroupCard|DuplicatesPanel|EventsPanel|FeedbackPanel|InlineTagsPicker|JobDetailDrawer|MergeEventsDialog|OverlappingEventsSection|PassportShareCard|PromoCodesAdminPanel|RatingReviewModal|ReviewPanel|SeriesDetailPanel|SeriesGroupCard|SeriesPanel|StatusBar|SubmissionDetails|SyncJobPanel|SyncJobsHistoryTable|SyncProgressCard|TagSuggestionReviewModal|TagSuggestionsPanel|TagSynonymsEditor|UnsyncedSuggestionsPanel|SubscribedEventsPanel|UserInterestPicker|GoingWedge|AttendeeList|AttendeeAvatarStack|PeopleAvatarTrack)\.tsx$/,
    /^components\/program\/(PrintableSchedule|SessionAttendeeStack)\.tsx$/,
]
const AVATAR_INITIALS = /rounded-full|AVATAR_SIZE|h-[4-7] w-[4-7]/

describe('mobile type scale', () => {
    it('user-facing components use no text below 11px', () => {
        const offenders: string[] = []
        for (const [path, source] of Object.entries(SOURCES)) {
            const rel = path.replace(/^\.\//, '')
            if (EXEMPT.some((re) => re.test(rel))) continue
            source.split('\n').forEach((line, i) => {
                if (TOO_SMALL.test(line) && !AVATAR_INITIALS.test(line)) offenders.push(`${rel}:${i + 1}`)
            })
        }
        expect(Object.keys(SOURCES).length).toBeGreaterThan(50)
        expect(offenders).toEqual([])
    })
})
