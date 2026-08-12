import type { ReactNode } from 'react';
import type { PreferredAreaPayload } from '../api';
import type { TagGroup } from '../types';
import { DEFAULT_AREA_BBOX, isWideArea } from '../constants/area';
import { useAreaEventPreview } from '../hooks/useAreaEventPreview';
import AreaMapPicker from './AreaMapPicker';
import RailEventCard from './RailEventCard';
import TagsPicker, { type TagsPickerValue } from './TagsPicker';

const GUARDRAIL_MESSAGE =
    'Large area: alerts and explorer results will include all local events. Narrow the Reach to focus.';
const AREA_SAMPLE_CARDS = 5;

interface Props {
    danceGroup: TagGroup | null;
    reachGroup: TagGroup | null;
    /** Reach tag id used to detect the wide-area guardrail condition. */
    localTagId: number | null;

    danceValue: TagsPickerValue;
    reachValue: TagsPickerValue;
    onDanceChange: (v: TagsPickerValue) => void;
    onReachChange: (v: TagsPickerValue) => void;

    area: PreferredAreaPayload | null;
    onAreaChange: (a: PreferredAreaPayload) => void;
    onUseCurrentView?: () => void;
    /** Optional control rendered below the map (e.g. an area-name input). */
    areaNameControl?: ReactNode;
    mapHeightClass?: string;
    /** Shown as "Saving…" beneath the map while an area edit commits. */
    saving?: boolean;

    matchesEnabled?: boolean;
    onMatchesEnabledChange?: (v: boolean) => void;
    matchesLabel?: string;
    matchesHint?: string;
    /** Render the "Alert me about matches" card. Off for anon (no email). */
    showMatchesToggle?: boolean;

    /** When true, render the Dance/Event-scale pickers; otherwise render
     * ``stylesSlot`` (e.g. the onboarding "edit styles" summary button). */
    showTagPickers?: boolean;
    stylesSlot?: ReactNode;
    tagsLoading?: boolean;

    /** Gate the worldwide preview fetch (e.g. only when visible). */
    previewEnabled?: boolean;
}

/**
 * Shared "search profile" editor: dance/reach tags, a bounding-box map with
 * live worldwide event pins, an "In your area" samples rail, and a friendly
 * "Alert me about matches" toggle. Used by the onboarding area step, the
 * interest-profile cards, and the anonymous Preferences editor so all three
 * share the same wording, map experience, and event samples.
 */
export default function ProfileEditor({
    danceGroup,
    reachGroup,
    localTagId,
    danceValue,
    reachValue,
    onDanceChange,
    onReachChange,
    area,
    onAreaChange,
    onUseCurrentView,
    areaNameControl,
    mapHeightClass = 'h-52',
    saving = false,
    matchesEnabled = false,
    onMatchesEnabledChange,
    matchesLabel = 'Alert me about matches',
    matchesHint = 'Get an email when a new event matches this profile.',
    showMatchesToggle = true,
    showTagPickers = true,
    stylesSlot,
    tagsLoading = false,
    previewEnabled = true,
}: Props) {
    const danceIds = danceValue.selectedTagIds;
    const reachIds = reachValue.selectedTagIds;

    const { previewEvents, previewMarkers, areaTrail } = useAreaEventPreview({
        danceGroup,
        reachGroup,
        danceIds,
        reachIds,
        area,
        enabled: previewEnabled,
    });

    const currentArea = area ?? DEFAULT_AREA_BBOX;
    const draftIsWide = isWideArea(currentArea);
    const draftReachIncludesLocalOrEmpty =
        reachIds.length === 0 || (localTagId != null && reachIds.includes(localTagId));
    const showGuardrailHint = draftIsWide && draftReachIncludesLocalOrEmpty;

    return (
        <div className="space-y-3">
            {showTagPickers ? (
                <>
                    <section>
                        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                            Dance styles
                        </label>
                        {tagsLoading ? (
                            <p className="text-sm text-slate-400">Loading tags…</p>
                        ) : !danceGroup ? (
                            <p className="text-sm text-slate-500">No dance-style tags are available yet.</p>
                        ) : (
                            <TagsPicker
                                tagGroups={[danceGroup]}
                                value={danceValue}
                                onChange={onDanceChange}
                                allowFreeText={false}
                                searchable={false}
                                hideGroupLabels
                            />
                        )}
                    </section>
                    <section>
                        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                            Event scale
                        </label>
                        {tagsLoading ? (
                            <p className="text-sm text-slate-400">Loading…</p>
                        ) : !reachGroup ? (
                            <p className="text-sm text-slate-500">No reach tags are available yet.</p>
                        ) : (
                            <TagsPicker
                                tagGroups={[reachGroup]}
                                value={reachValue}
                                onChange={onReachChange}
                                allowFreeText={false}
                                searchable={false}
                                hideGroupLabels
                            />
                        )}
                    </section>
                </>
            ) : (
                stylesSlot
            )}

            <section>
                <AreaMapPicker
                    value={area}
                    onChange={onAreaChange}
                    onUseCurrentView={onUseCurrentView}
                    mapHeightClass={mapHeightClass}
                    markers={previewMarkers}
                    controlsStart={areaNameControl}
                />
                {saving && <p className="mt-1 text-[11px] text-slate-400">Saving…</p>}
            </section>

            {showGuardrailHint && (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {GUARDRAIL_MESSAGE}
                </p>
            )}

            <section>
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    In your area
                </span>
                {previewEvents === null ? (
                    danceIds.length > 0 ? <p className="text-xs text-slate-400">Finding events…</p> : null
                ) : areaTrail.length === 0 ? (
                    <p className="border border-slate-200 bg-slate-50 px-3 py-4 text-xs text-slate-600">
                        No upcoming events in this area yet — turn on alerts below and we'll email you the moment one appears.
                    </p>
                ) : (
                    <div className="-mx-1 flex snap-x gap-2 overflow-x-auto scrollbar-hide px-1 pb-1">
                        {areaTrail.slice(0, AREA_SAMPLE_CARDS).map((ev) => (
                            <RailEventCard
                                key={ev.event_id}
                                event={ev}
                                onClick={() => { /* preview only */ }}
                                variant="compact"
                                compactShowExtras
                                widthClass="w-[168px]"
                                accent
                                maxTags={3}
                                forceTagBadge
                                forceTagColored
                                tagSingleLine
                                tagPriorityGroups={['dance-style', 'reach']}
                            />
                        ))}
                    </div>
                )}
            </section>

            {showMatchesToggle && (
                <section className="border border-slate-200 bg-slate-50 p-3">
                    <label className="flex items-start gap-2 text-sm text-slate-800">
                        <input
                            type="checkbox"
                            checked={matchesEnabled}
                            onChange={(e) => onMatchesEnabledChange?.(e.target.checked)}
                            className="mt-0.5 h-4 w-4"
                        />
                        <span>
                            <span className="block font-medium text-sm">{matchesLabel}</span>
                            <span className="mt-0.5 block text-xs text-slate-500">{matchesHint}</span>
                        </span>
                    </label>
                </section>
            )}
        </div>
    );
}
