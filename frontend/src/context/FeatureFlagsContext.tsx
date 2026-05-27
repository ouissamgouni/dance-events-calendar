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
    promoCodesEnabled: boolean;
    organizerClaimsEnabled: boolean;
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
    promoCodesEnabled: false,
    organizerClaimsEnabled: false,
};

const FeatureFlagsContext = createContext<FeatureFlags>(defaultFlags);

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
    const [flags, setFlags] = useState<FeatureFlags>(defaultFlags);

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
                    promoCodesEnabled: s.promo_codes_enabled ?? false,
                    organizerClaimsEnabled: s.organizer_claims_enabled ?? false,
                });
            })
            .catch(() => {
                // Keep defaults on error
            });
    }, []);

    return (
        <FeatureFlagsContext.Provider value={flags}>
            {children}
        </FeatureFlagsContext.Provider>
    );
}

export function useFeatureFlags(): FeatureFlags {
    return useContext(FeatureFlagsContext);
}
