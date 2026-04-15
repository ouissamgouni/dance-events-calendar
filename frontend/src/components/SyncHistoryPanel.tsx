import type { SyncLogEntry } from '../api';

interface SyncHistoryPanelProps {
    isOpen: boolean;
    onClose: () => void;
    syncLogs: SyncLogEntry[];
}

export default function SyncHistoryPanel({ isOpen, onClose, syncLogs }: SyncHistoryPanelProps) {
    return (
        <>
            {isOpen && (
                <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
            )}

            <div
                className={`fixed top-0 right-0 h-full w-[420px] bg-white shadow-lg border-l border-gray-200 z-50 transform transition-transform duration-200 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50">
                    <h2 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">Sync History</h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="overflow-y-auto h-[calc(100%-41px)] divide-y divide-gray-100">
                    {syncLogs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                            <p className="text-xs">No sync logs yet</p>
                        </div>
                    ) : (
                        syncLogs.map((log) => {
                            const duration = log.finished_at
                                ? `${((new Date(log.finished_at).getTime() - new Date(log.started_at).getTime()) / 1000).toFixed(1)}s`
                                : '—';
                            return (
                                <div key={log.id} className="px-4 py-2.5 hover:bg-gray-50/50 transition">
                                    <div className="flex items-center justify-between mb-0.5">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`inline-block w-1.5 h-1.5 ${log.status === 'success' ? 'bg-emerald-500' : log.status === 'error' ? 'bg-red-500' : 'bg-amber-500'}`}
                                            />
                                            <span className="text-xs font-medium text-gray-700 capitalize">{log.trigger}</span>
                                            <span className={`text-[10px] font-medium px-1.5 py-0.5 ${log.status === 'success' ? 'bg-emerald-50 text-emerald-700' : log.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                                                {log.status}
                                            </span>
                                        </div>
                                        <span className="text-[10px] text-gray-400">{duration}</span>
                                    </div>
                                    <div className="text-[11px] text-gray-500 ml-3.5">
                                        {log.calendars_synced} cal · {log.events_upserted} upserted · {log.events_deleted} deleted
                                    </div>
                                    <div className="text-[10px] text-gray-400 ml-3.5 mt-0.5">
                                        {new Date(log.started_at).toLocaleString()}
                                    </div>
                                    {log.error_message && (
                                        <div className="mt-1 ml-3.5 text-[10px] text-red-600 break-words">
                                            {log.error_message}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </>
    );
}
