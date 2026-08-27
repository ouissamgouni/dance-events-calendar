import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchSettings } from '../api';

export const DEFAULT_EVENT_COLOR_BAR_COLOR = '#64748b';

interface FeatureFlags {
    showPrices: boolean;
    showPopularity: boolean;
    showRatings: boolean;
    popularityThreshold: number;
    // Adoption-boost tracks (mirror the server-side site settings).
    followingBadgeEnabled: boolean;
    unseenStateEnabled: boolean;
    trendingEnabled: boolean;
    trendingBannerEnabled: boolean;
    trendingFloorGoing: number;
    /** Absolute upper bound on number of events that get a Trending
     * decoration in the visible list/map. */
    trendingTopN: number;
    /** Relative ceiling (1-100). Effective cap is
     * ``min(trendingTopN, ceil(visibleCount * trendingTopPercent / 100))``. */
    trendingTopPercent: number;
    eventColorBarColor: string;
    tagSortMode: 'group' | 'event_count';
    goingButtonIconVariant: 'hand' | 'person';
    promoCodesEnabled: boolean;
    organizerClaimsEnabled: boolean;
    forYouRailEnabled: boolean;
    yourNextEventsRailEnabled: boolean;
    /** Tribe > Calendars "Your Network" snapshot of upcoming events people
     * you follow are going to. When false, the snapshot is hidden. */
    networkGoingSnapshotEnabled: boolean;
    /** Show Route controls and journey arrows on My Events maps. */
    myEventsRouteEnabled: boolean;
    /** Show 'My Events' as a top-level navigation entry (admin feature). */
    myEventsNavEnabled: boolean;
    /** Show the optional event-size question in the review wizard. */
    eventReviewSizeStepEnabled: boolean;
    /** When true, tags on event cards render as colored badges (legacy
     * look). When false (default), tags render as inline "Practice · Indoor"
     * text so cards stay quieter. */
    tagAsBadge: boolean;
    /** Only meaningful when `tagAsBadge` is true. When true, badges use
     * each tag's defined color; when false (default) badges render on a
     * neutral light-grey background. */
    tagBadgeColored: boolean;
    /** When true, Trending trail cards keep their compact chrome but
     * additionally show tags and the attendee avatar stack. */
    trendingTrailRichEnabled: boolean;
    /** Number of tags to render inline per event card. */
    tagsPerCard: number;
    /** When true, the event card's RSVP action moves onto the attendee
     * avatar row (right-aligned) instead of the top-right cluster. */
    eventCardRsvpActionInAvatarRowEnabled: boolean;
    /** When true, save/going counts render next to their action buttons
     * on event cards. */
    eventCardRsvpAndSaveStatsNextToActionEnabled: boolean;
    /** When true, the "You might like" and "New" For-you trails use the
     * new date-first event card layout. */
    forYouEventCardsDateFirstLayoutEnabled: boolean;
}

const defaultFlags: FeatureFlags = {
    showPrices: false,
    showPopularity: false,
    showRatings: false,
    popularityThreshold: 10,
    followingBadgeEnabled: false,
    unseenStateEnabled: false,
    trendingEnabled: false,
    trendingBannerEnabled: false,
    trendingFloorGoing: 3,
    trendingTopN: 3,
    trendingTopPercent: 100,
    eventColorBarColor: DEFAULT_EVENT_COLOR_BAR_COLOR,
    tagSortMode: 'group',
    goingButtonIconVariant: 'hand',
    promoCodesEnabled: false,
    organizerClaimsEnabled: false,
    forYouRailEnabled: false,
    yourNextEventsRailEnabled: false,
    networkGoingSnapshotEnabled: false,
    myEventsRouteEnabled: false,
    myEventsNavEnabled: true,
    eventReviewSizeStepEnabled: true,
    tagAsBadge: false,
    tagBadgeColored: false,
    trendingTrailRichEnabled: false,
    tagsPerCard: 3,
    eventCardRsvpActionInAvatarRowEnabled: false,
    eventCardRsvpAndSaveStatsNextToActionEnabled: false,
    forYouEventCardsDateFirstLayoutEnabled: false,
};

const FeatureFlagsContext = createContext<{
    flags: FeatureFlags;
    updateFlag: (key: keyof FeatureFlags, value: any) => void;
} | null>(null);

export { FeatureFlagsContext };

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
    const [flags, setFlags] = useState<FeatureFlags>(defaultFlags);

    const updateFlag = (key: keyof FeatureFlags, value: any) => {
        setFlags((prev) => ({ ...prev, [key]: value }));
    };

    useEffect(() => {
        fetchSettings()
            .then((s) => {
                setFlags({
                    showPrices: s.show_prices,
                    showPopularity: s.show_popularity,
                    showRatings: s.show_ratings,
                    popularityThreshold: s.popularity_threshold,
                    followingBadgeEnabled: s.following_badge_enabled ?? false,
                    unseenStateEnabled: s.unseen_state_enabled ?? false,
                    trendingEnabled: s.trending_enabled ?? false,
                    trendingBannerEnabled: s.trending_banner_enabled ?? false,
                    trendingFloorGoing: s.trending_floor_going ?? 3,
                    trendingTopN: s.trending_top_n ?? 3,
                    trendingTopPercent: s.trending_top_percent ?? 100,
                    eventColorBarColor: s.event_color_bar_color || DEFAULT_EVENT_COLOR_BAR_COLOR,
                    tagSortMode: s.tag_sort_mode === 'event_count' ? 'event_count' : 'group',
                    goingButtonIconVariant: s.going_button_icon_variant === 'person' ? 'person' : 'hand',
                    promoCodesEnabled: s.promo_codes_enabled ?? false,
                    organizerClaimsEnabled: s.organizer_claims_enabled ?? false,
                    forYouRailEnabled: s.for_you_rail_enabled ?? false,
                    yourNextEventsRailEnabled: s.your_next_events_rail_enabled ?? false,
                    networkGoingSnapshotEnabled: s.network_going_snapshot_enabled ?? false,
                    myEventsRouteEnabled: s.my_events_route_enabled ?? false,
                    myEventsNavEnabled: s.my_events_nav_enabled ?? true,
                    eventReviewSizeStepEnabled: s.event_review_size_step_enabled ?? true,
                    tagAsBadge: s.tag_as_badge_enabled ?? false,
                    tagBadgeColored: s.tag_badge_colored ?? false,
                    trendingTrailRichEnabled: s.trending_trail_rich_enabled ?? false,
                    tagsPerCard: s.tags_per_card ?? 3,
                    eventCardRsvpActionInAvatarRowEnabled: s.event_card_rsvp_action_in_avatar_row_enabled ?? false,
                    eventCardRsvpAndSaveStatsNextToActionEnabled: s.event_card_rsvp_and_save_stats_next_to_action_enabled ?? false,
                    forYouEventCardsDateFirstLayoutEnabled: s.for_you_event_cards_date_first_layout_enabled ?? false,
                });
            })
            .catch(() => {
                // Keep defaults on error
            });
    }, []);

    return (
        <FeatureFlagsContext.Provider value={{ flags, updateFlag }}>
            {children}
        </FeatureFlagsContext.Provider>
    );
}

export function useFeatureFlags(): FeatureFlags {
    const context = useContext(FeatureFlagsContext);
    if (!context) throw new Error('useFeatureFlags must be used within FeatureFlagsProvider');
    return context.flags;
}

/**
 * Like {@link useFeatureFlags} but returns the built-in defaults instead of
 * throwing when rendered outside a provider. Use in widely-reused low-level
 * components (e.g. buttons) that may be mounted in isolation.
 */
export function useOptionalFeatureFlags(): FeatureFlags {
    const context = useContext(FeatureFlagsContext);
    return context?.flags ?? defaultFlags;
}

export function useUpdateFeatureFlag() {
    const context = useContext(FeatureFlagsContext);
    if (!context) throw new Error('useUpdateFeatureFlag must be used within FeatureFlagsProvider');
    return context.updateFlag;
}
