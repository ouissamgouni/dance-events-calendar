import { useState } from 'react';
import { useQaContext } from './QaTestPlanPanel';
import { useConsent } from '../context/ConsentContext';

const STATUS_BAR_HEIGHT = 22;
const STATUS_BAR_COLLAPSED_HEIGHT = 14;

const envDotColors: Record<string, string> = {
  dev: '#3b82f6',
  test: '#dd6b20',
  staging: '#dd6b20',
  prod: '#a0aec0',
};

function getEnvDotColor(env: string): string {
  if (envDotColors[env]) return envDotColors[env];
  if (env.startsWith('scenario')) return '#8b5cf6';
  return envDotColors.prod;
}

export const STATUS_BAR_HEIGHT_PX = STATUS_BAR_HEIGHT;

export function StatusBar() {
  const { appInfo, isOpen: qaIsOpen, setIsOpen: setQaIsOpen, doneCount, totalSteps } = useQaContext();
  const { showPreferences } = useConsent();
  const [collapsed, setCollapsed] = useState(false);

  const env = appInfo?.environment ?? 'prod';
  const isProd = env === 'prod';
  const dotColor = getEnvDotColor(env);
  const hasQa = (appInfo?.qa_scenarios?.length ?? 0) > 0 && !isProd;

  return (
    <div
      className="shrink-0 bg-gray-100 text-gray-600 border-t border-gray-200 relative flex items-center select-none"
      style={{ height: collapsed ? STATUS_BAR_COLLAPSED_HEIGHT : STATUS_BAR_HEIGHT, fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      {/* Toggle chevron */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center justify-center px-1.5 h-full text-[9px] cursor-pointer hover:bg-black/[0.06] transition-colors text-gray-400 hover:text-gray-600"
        aria-label={collapsed ? 'Expand status bar' : 'Collapse status bar'}
      >
        {collapsed ? '▲' : '▼'}
      </button>

      {!collapsed && (
        <>
          <div className="flex-1" />

          {/* QA segment */}
          {hasQa && (
            <>
              <button
                onClick={() => setQaIsOpen(!qaIsOpen)}
                className="flex items-center gap-1 px-1.5 h-full text-[11px] cursor-pointer hover:bg-black/[0.06] transition-colors"
              >
                <svg className="w-[11px] h-[11px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span>QA</span>
                {totalSteps > 0 && (
                  <span className="font-semibold opacity-85">
                    {doneCount}/{totalSteps}
                  </span>
                )}
              </button>
              <div className="w-px h-3 bg-black/10 mx-1 shrink-0" />
            </>
          )}

          {/* Cookie settings */}
          <button
            onClick={showPreferences}
            className="flex items-center gap-1 px-1.5 h-full text-[11px] cursor-pointer hover:bg-black/[0.06] transition-colors"
            aria-label="Cookie settings"
          >
            <svg className="w-[11px] h-[11px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span>Cookies</span>
          </button>
          <div className="w-px h-3 bg-black/10 mx-1 shrink-0" />

          {/* Env + version segment */}
          <div className="flex items-center gap-1 px-1.5 h-full text-[11px] shrink-0">
            {!isProd && (
              <>
                <span
                  className="w-[7px] h-[7px] rounded-full shrink-0"
                  style={{ backgroundColor: dotColor }}
                />
                <span className="font-bold">{env.toUpperCase()}</span>
              </>
            )}
            {appInfo?.backend_version && (
              <span className="opacity-60">{appInfo.backend_version}</span>
            )}
            {appInfo?.db_schema_version && (
              <span className="opacity-50">DB {appInfo.db_schema_version}</span>
            )}
          </div>
          <div className="w-1 shrink-0" />
        </>
      )}
    </div>
  );
}
