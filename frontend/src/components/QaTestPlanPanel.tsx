import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppInfo, TestPlan } from '../types';
import { fetchAppInfo, fetchTestPlan } from '../api';

const QA_PANEL_WIDTH = 380;

interface QaContextValue {
    appInfo: AppInfo | null;
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    doneCount: number;
    totalSteps: number;
    pinnedWidth: number;
}

const QaCtx = createContext<QaContextValue>({
    appInfo: null,
    isOpen: false,
    setIsOpen: () => { },
    doneCount: 0,
    totalSteps: 0,
    pinnedWidth: 0,
});

export const useQaContext = () => useContext(QaCtx);
export const useQaPinnedWidth = () => useContext(QaCtx).pinnedWidth;

export function QaTestPlanProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
    const [doneCount, setDoneCount] = useState(0);
    const [totalSteps, setTotalSteps] = useState(0);
    const [pinnedWidth, setPinnedWidth] = useState(0);

    useEffect(() => {
        fetchAppInfo()
            .then(setAppInfo)
            .catch(() => { });
    }, []);

    return (
        <QaCtx.Provider value={{ appInfo, isOpen, setIsOpen, doneCount, totalSteps, pinnedWidth }}>
            {children}
            <QaTestPlanPanelInner
                appInfo={appInfo}
                isOpen={isOpen}
                setIsOpen={setIsOpen}
                onPinnedWidthChange={setPinnedWidth}
                onProgressChange={(done, total) => {
                    setDoneCount(done);
                    setTotalSteps(total);
                }}
            />
        </QaCtx.Provider>
    );
}

function QaTestPlanPanelInner({
    appInfo,
    isOpen,
    setIsOpen,
    onPinnedWidthChange,
    onProgressChange,
}: {
    appInfo: AppInfo | null;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
    onPinnedWidthChange: (w: number) => void;
    onProgressChange: (done: number, total: number) => void;
}) {
    const [pinned, setPinned] = useState(false);
    const [activeScenario, setActiveScenario] = useState<string | null>(null);
    const [testPlan, setTestPlan] = useState<TestPlan | null>(null);
    const [loading, setLoading] = useState(false);
    const [checkedSteps, setCheckedSteps] = useState<Record<string, Set<number>>>({});

    const scenarios = appInfo?.qa_scenarios ?? [];

    // Notify parent of pinned width changes
    useEffect(() => {
        onPinnedWidthChange(pinned && isOpen ? QA_PANEL_WIDTH : 0);
    }, [pinned, isOpen, onPinnedWidthChange]);

    // Auto-select if only one scenario
    useEffect(() => {
        if (scenarios.length === 1 && !activeScenario) {
            setActiveScenario(scenarios[0]);
        }
    }, [scenarios, activeScenario]);

    // Fetch test plan when scenario changes
    useEffect(() => {
        if (!activeScenario) {
            setTestPlan(null);
            return;
        }
        setLoading(true);
        fetchTestPlan(activeScenario)
            .then(setTestPlan)
            .catch(() => { })
            .finally(() => setLoading(false));
    }, [activeScenario]);

    const doneSet = activeScenario
        ? checkedSteps[activeScenario] ?? new Set<number>()
        : new Set<number>();
    const total = testPlan?.steps?.length ?? 0;
    const done = doneSet.size;
    const hasMultiple = scenarios.length > 1;

    useEffect(() => {
        onProgressChange(done, total);
    }, [done, total, onProgressChange]);

    if (scenarios.length === 0) return null;

    const toggleStep = (stepId: number) => {
        if (!activeScenario) return;
        setCheckedSteps((prev) => {
            const s = new Set(prev[activeScenario] ?? []);
            if (s.has(stepId)) s.delete(stepId);
            else s.add(stepId);
            return { ...prev, [activeScenario]: s };
        });
    };

    const handleClose = () => {
        setIsOpen(false);
        if (pinned) setPinned(false);
    };
    const togglePin = () => setPinned((p) => !p);

    const panelContent = (
        <>
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50 sticky top-0 z-10">
                <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <span className="font-semibold text-sm text-gray-800">
                        {activeScenario ? `QA: ${activeScenario}` : 'QA Test Plans'}
                    </span>
                </div>
                <div className="flex items-center gap-0.5">
                    <button
                        onClick={togglePin}
                        className={`p-1 rounded transition-colors ${pinned ? 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100' : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'}`}
                        title={pinned ? 'Unpin panel (overlay mode)' : 'Pin panel (side-by-side)'}
                    >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="17" x2="12" y2="22" />
                            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                            {!pinned && <line x1="2" y1="2" x2="22" y2="22" />}
                        </svg>
                    </button>
                    <button
                        onClick={handleClose}
                        className="p-1 rounded hover:bg-gray-200 transition-colors text-gray-500"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="p-3 overflow-y-auto flex-1">
                {/* Scenario selector */}
                {(!activeScenario || (hasMultiple && !testPlan)) && (
                    <div className="mb-4">
                        <p className="text-xs text-gray-500 mb-2">Select a scenario:</p>
                        <div className="flex flex-col gap-2">
                            {scenarios.map((s) => {
                                const sDone = checkedSteps[s]?.size ?? 0;
                                return (
                                    <div
                                        key={s}
                                        onClick={() => setActiveScenario(s)}
                                        className="p-3 border border-gray-200 rounded-md cursor-pointer hover:bg-indigo-50 hover:border-indigo-300 transition-colors"
                                    >
                                        <div className="flex justify-between items-center">
                                            <span className="text-sm font-bold">{s}</span>
                                            {sDone > 0 && (
                                                <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                                                    {sDone} done
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Back button */}
                {hasMultiple && activeScenario && testPlan && (
                    <button
                        onClick={() => {
                            setActiveScenario(null);
                            setTestPlan(null);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-700 mb-3 flex items-center gap-1"
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                        All scenarios
                    </button>
                )}

                {/* Loading */}
                {loading && (
                    <div className="flex justify-center py-8">
                        <div className="w-6 h-6 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
                    </div>
                )}

                {/* Test plan steps */}
                {testPlan && (
                    <div>
                        <h3 className="font-semibold text-sm mb-1">{testPlan.name}</h3>
                        <p className="text-xs text-gray-500 mb-4">{testPlan.description}</p>
                        <span
                            className={`text-xs px-2 py-0.5 rounded mb-3 inline-block ${done === total
                                ? 'bg-green-100 text-green-700'
                                : 'bg-indigo-100 text-indigo-700'
                                }`}
                        >
                            {done} / {total} completed
                        </span>

                        {testPlan.steps.map((step) => {
                            const isDone = doneSet.has(step.id);
                            return (
                                <div
                                    key={step.id}
                                    onClick={() => toggleStep(step.id)}
                                    className={`mb-2 p-2 rounded-md border cursor-pointer transition-all hover:border-indigo-300 ${isDone
                                        ? 'border-green-200 bg-green-50 opacity-70'
                                        : 'border-gray-200 bg-white'
                                        }`}
                                >
                                    <div className="flex items-start gap-2">
                                        <div className={`mt-0.5 flex-shrink-0 ${isDone ? 'text-green-500' : 'text-gray-400'}`}>
                                            {isDone ? (
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                            ) : (
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                    <rect x="3" y="3" width="18" height="18" rx="2" />
                                                </svg>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold mb-0.5">
                                                {step.id}. {step.title}
                                            </p>
                                            <p className="text-xs text-gray-600 mb-1">{step.description}</p>
                                            <div className="bg-blue-50 px-2 py-1 rounded-sm mb-1">
                                                <p className="text-xs text-blue-700">
                                                    <strong>Expected:</strong> {step.expected}
                                                </p>
                                            </div>
                                            <p className="text-xs text-gray-500 italic">✓ {step.verification}</p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );

    if (!isOpen) return null;

    if (pinned) {
        return (
            <div
                className="fixed right-0 top-0 bottom-[22px] bg-white z-10 flex flex-col border-l border-gray-200"
                style={{ width: QA_PANEL_WIDTH, boxShadow: '-2px 0 8px rgba(0,0,0,0.08)' }}
            >
                {panelContent}
            </div>
        );
    }

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 bottom-[22px] bg-black/40 z-[199]" onClick={handleClose} />
            {/* Panel */}
            <div
                className="fixed right-0 top-0 bottom-[22px] bg-white shadow-xl z-[200] flex flex-col border-l border-gray-200"
                style={{ width: QA_PANEL_WIDTH, maxWidth: '90vw' }}
            >
                {panelContent}
            </div>
        </>
    );
}
