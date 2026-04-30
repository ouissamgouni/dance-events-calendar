export interface Tag {
    id: number;
    slug: string;
    label: string;
    color: string | null;
    ordinal: number;
    group_slug: string;
    group_label: string;
    group_color: string | null;
    event_count?: number;
    enabled: boolean;
    is_hero_filter: boolean;
    hero_ordinal: number | null;
}

export interface TagGroup {
    id: number;
    slug: string;
    label: string;
    color: string | null;
    ordinal: number;
    allow_multiple: boolean;
    enabled: boolean;
    tags: Tag[];
}

export interface TagSuggestionCreate {
    event_id: string;
    tag_id?: number;
    free_text?: string;
    group_slug?: string;
    device_id: string;
    website?: string; // honeypot
}

export interface TagSuggestionResponse {
    id: number;
    event_id: string;
    event_title: string | null;
    tag: Tag | null;
    free_text: string | null;
    group_slug: string | null;
    status: string;
    submitter_device_id: string | null;
    admin_notes: string | null;
    reviewed_at: string | null;
    created_at: string;
}

export interface LinkItem {
    url: string;
    label: string | null;
}

export interface CalendarEvent {
    event_id: string;
    calendar_id: string;
    title: string;
    description: string | null;
    location: string | null;
    latitude: number | null;
    longitude: number | null;
    start: string;
    end: string;
    all_day: boolean;
    color: string | null;
    view_count: number;
    price_min: number | null;
    price_max: number | null;
    price_currency: string | null;
    price_is_free: boolean;
    review_status?: string;
    links: LinkItem[] | null;
    tags: Tag[];
}

export interface CalendarSetting {
    calendar_id: string;
    name: string;
    enabled: boolean;
    color: string | null;
}

export interface AppInfo {
    environment: string;
    backend_version: string;
    frontend_version?: string | null;
    db_schema_version?: string | null;
    qa_scenarios?: string[];
}

export interface TestStep {
    id: number;
    title: string;
    description: string;
    expected: string;
    verification: string;
}

export interface TestPlan {
    name: string;
    description: string;
    scenario: string;
    steps: TestStep[];
}

export interface EventSuggestionCreate {
    title: string;
    description?: string;
    location?: string;
    links?: LinkItem[];
    latitude?: number;
    longitude?: number;
    start: string;
    end: string;
    all_day?: boolean;
    submitter_name?: string;
    submitter_email?: string;
    suggested_tag_ids?: number[];
    website?: string; // honeypot
    screen_size?: string;
    timezone?: string;
}

export interface EventSuggestion {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    links: LinkItem[] | null;
    latitude: number | null;
    longitude: number | null;
    start: string;
    end: string;
    all_day: boolean;
    submitter_name: string | null;
    submitter_email: string | null;
    submitter_ip: string | null;
    submitter_user_agent: string | null;
    submitter_language: string | null;
    submitter_referrer: string | null;
    submitter_screen_size: string | null;
    submitter_timezone: string | null;
    submitter_city: string | null;
    submitter_country: string | null;
    submitter_lat: number | null;
    submitter_lng: number | null;
    status: string;
    admin_notes: string | null;
    assigned_calendar_id: string | null;
    created_event_id: string | null;
    synced_to_google: boolean;
    google_event_id: string | null;
    created_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
}
