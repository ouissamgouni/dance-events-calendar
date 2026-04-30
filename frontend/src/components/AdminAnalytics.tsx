import type { MostViewedEvent, MostSavedEvent, MostAttendedEvent, SourceBreakdown, CountryBreakdown, TopLink, ExportStat } from '../api';

interface Props {
    mostViewed: MostViewedEvent[];
    mostSaved: MostSavedEvent[];
    mostAttended: MostAttendedEvent[];
    sourceBreakdown: SourceBreakdown[];
    topCountries: CountryBreakdown[];
    topLinks: TopLink[];
    exportStats: ExportStat[];
}

export default function AdminAnalytics({ mostViewed, mostSaved, mostAttended, sourceBreakdown, topCountries, topLinks, exportStats }: Props) {
    const hasAnyData = mostViewed.length > 0 || mostSaved.length > 0 || mostAttended.length > 0
        || sourceBreakdown.length > 0 || topCountries.length > 0 || topLinks.length > 0 || exportStats.length > 0;

    if (!hasAnyData) {
        return (
            <div className="mt-6 flex items-center justify-center py-16 text-gray-400 text-sm">
                No analytics data yet.
            </div>
        );
    }

    return (
        <div className="mt-6 space-y-4">
            {/* Top Events: 3-column grid */}
            {(mostViewed.length > 0 || mostSaved.length > 0 || mostAttended.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {/* Most Viewed Events */}
                    {mostViewed.length > 0 && (
                        <div className="bg-white border border-gray-200 p-4">
                            <h2 className="text-sm font-bold text-gray-800 mb-3">👁 Most Viewed Events</h2>
                            <div className="space-y-2">
                                {mostViewed.map((item, i) => {
                                    const maxViews = mostViewed[0]?.view_count || 1;
                                    return (
                                        <div key={item.event_id} className="text-xs">
                                            <div className="flex items-center justify-between mb-0.5">
                                                <span className="text-gray-700 truncate flex-1">
                                                    <span className="text-gray-400 mr-2">#{i + 1}</span>
                                                    {item.title || item.event_id}
                                                </span>
                                                <span className="text-blue-600 font-medium ml-2">{item.view_count} view{item.view_count !== 1 ? 's' : ''}</span>
                                                <span className="text-gray-400 font-medium ml-2">{item.unique_viewers} unique</span>
                                            </div>
                                            <div className="w-full bg-gray-100 h-1 rounded">
                                                <div className="bg-blue-400 h-1 rounded" style={{ width: `${Math.round((item.view_count / maxViews) * 100)}%` }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Most Saved Events */}
                    {mostSaved.length > 0 && (
                        <div className="bg-white border border-gray-200 p-4">
                            <h2 className="text-sm font-bold text-gray-800 mb-3">📌 Most Saved Events</h2>
                            <div className="space-y-2">
                                {mostSaved.map((item, i) => (
                                    <div key={item.event_id} className="flex items-center justify-between text-xs">
                                        <span className="text-gray-700 truncate flex-1">
                                            <span className="text-gray-400 mr-2">#{i + 1}</span>
                                            {item.title || item.event_id}
                                        </span>
                                        <span className="text-rose-600 font-medium ml-2">{item.save_count} save{item.save_count !== 1 ? 's' : ''}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Most Going Events */}
                    {mostAttended.length > 0 && (
                        <div className="bg-white border border-gray-200 p-4">
                            <h2 className="text-sm font-bold text-gray-800 mb-3">🎟 Most Going Events</h2>
                            <div className="space-y-2">
                                {mostAttended.map((item, i) => {
                                    const maxGoing = mostAttended[0]?.going_count || 1;
                                    return (
                                        <div key={item.event_id} className="text-xs">
                                            <div className="flex items-center justify-between mb-0.5">
                                                <span className="text-gray-700 truncate flex-1">
                                                    <span className="text-gray-400 mr-2">#{i + 1}</span>
                                                    {item.title || item.event_id}
                                                </span>
                                                <span className="text-emerald-600 font-medium ml-2">{item.going_count} going</span>
                                            </div>
                                            <div className="w-full bg-gray-100 h-1 rounded">
                                                <div className="bg-emerald-400 h-1 rounded" style={{ width: `${Math.round((item.going_count / maxGoing) * 100)}%` }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Source Breakdown + Top Countries side-by-side */}
            {(sourceBreakdown.length > 0 || topCountries.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {sourceBreakdown.length > 0 && (
                        <div className="bg-white border border-gray-200 p-4">
                            <h2 className="text-sm font-bold text-gray-800 mb-3">📊 Views by Source</h2>
                            <div className="space-y-2">
                                {sourceBreakdown.map((row) => {
                                    const maxCount = sourceBreakdown[0]?.view_count || 1;
                                    return (
                                        <div key={row.source} className="text-xs">
                                            <div className="flex items-center justify-between mb-0.5">
                                                <span className="text-gray-700 capitalize">{row.source}</span>
                                                <span className="text-gray-500 font-medium">{row.view_count}</span>
                                            </div>
                                            <div className="w-full bg-gray-100 h-1.5 rounded">
                                                <div className="bg-indigo-400 h-1.5 rounded" style={{ width: `${Math.round((row.view_count / maxCount) * 100)}%` }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {topCountries.length > 0 && (
                        <div className="bg-white border border-gray-200 p-4">
                            <h2 className="text-sm font-bold text-gray-800 mb-3">🌍 Top Countries</h2>
                            <div className="space-y-2">
                                {topCountries.map((row) => {
                                    const maxCount = topCountries[0]?.view_count || 1;
                                    return (
                                        <div key={row.country} className="text-xs">
                                            <div className="flex items-center justify-between mb-0.5">
                                                <span className="text-gray-700">{row.country}</span>
                                                <span className="text-gray-500 font-medium">{row.view_count}</span>
                                            </div>
                                            <div className="w-full bg-gray-100 h-1.5 rounded">
                                                <div className="bg-teal-400 h-1.5 rounded" style={{ width: `${Math.round((row.view_count / maxCount) * 100)}%` }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Top Clicked Links */}
            {topLinks.length > 0 && (
                <div className="bg-white border border-gray-200 p-4">
                    <h2 className="text-sm font-bold text-gray-800 mb-3">🔗 Top Clicked Links</h2>
                    <div className="space-y-1.5">
                        {topLinks.map((row, i) => (
                            <div key={`${row.event_id}-${row.url}`} className="flex items-start justify-between text-xs gap-2">
                                <span className="text-gray-400 shrink-0">#{i + 1}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-gray-700 font-medium truncate">{row.event_title}</div>
                                    <a
                                        href={row.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-500 hover:underline truncate block"
                                    >
                                        {row.url}
                                    </a>
                                </div>
                                <span className="text-gray-500 font-medium shrink-0">{row.click_count} click{row.click_count !== 1 ? 's' : ''}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Export Stats */}
            {exportStats.length > 0 && (
                <div className="bg-white border border-gray-200 p-4">
                    <h2 className="text-sm font-bold text-gray-800 mb-3">📥 Exports</h2>
                    <div className="flex gap-6">
                        {exportStats.map((row) => (
                            <div key={row.format} className="text-xs">
                                <div className="text-gray-500 uppercase tracking-wide">{row.format}</div>
                                <div className="text-lg font-bold text-gray-800">{row.export_count}</div>
                                <div className="text-gray-400">{row.total_events_exported} events exported</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
