import { Component, type ErrorInfo, type ReactNode } from 'react';

const RECOVERY_FLAG = 'movida:error-recovery-attempted';

interface Props {
    children: ReactNode;
}

interface State {
    failed: boolean;
    recovering: boolean;
}

/**
 * Top-level safety net. Without this an uncaught render error unmounts the app
 * and leaves a blank white page — the classic "PWA opens blank" symptom, most
 * often from stale cached assets or incompatible persisted storage after a
 * deploy. On the first error this session it self-heals once (unregister SW +
 * clear caches, then reload); a second error shows a manual reload screen so it
 * can never loop.
 */
export default class ErrorBoundary extends Component<Props, State> {
    state: State = { failed: false, recovering: false };

    componentDidMount() {
        // Clear the recovery guard on a clean start so a future one-off error
        // can self-heal again (getDerivedStateFromError sets `failed` before
        // this fires, so a boot that crashed keeps the guard set).
        if (!this.state.failed) {
            try {
                sessionStorage.removeItem(RECOVERY_FLAG);
            } catch {
                /* ignore */
            }
        }
    }

    static getDerivedStateFromError(): Partial<State> {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Keep a breadcrumb for remote debugging of blank-page reports.
        console.error('Uncaught render error:', error, info.componentStack);

        let alreadyTried = false;
        try {
            alreadyTried = sessionStorage.getItem(RECOVERY_FLAG) === '1';
            sessionStorage.setItem(RECOVERY_FLAG, '1');
        } catch {
            /* storage unavailable — fall through to manual reload UI */
        }
        if (alreadyTried) return;

        this.setState({ recovering: true });
        void this.selfHeal();
    }

    private async selfHeal() {
        try {
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
            }
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            }
        } catch {
            /* best-effort — reload regardless */
        } finally {
            window.location.reload();
        }
    }

    private reloadNow = () => {
        try {
            sessionStorage.removeItem(RECOVERY_FLAG);
        } catch {
            /* ignore */
        }
        window.location.reload();
    };

    render() {
        if (!this.state.failed) return this.props.children;

        if (this.state.recovering) {
            return (
                <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-6 text-center">
                    <p className="text-sm text-slate-600" role="status" aria-live="polite">
                        Updating the app…
                    </p>
                </div>
            );
        }

        return (
            <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
                <div>
                    <p className="text-base font-semibold text-slate-800">Something went wrong</p>
                    <p className="mt-1 text-sm text-slate-600">Please reload to continue.</p>
                </div>
                <button
                    type="button"
                    onClick={this.reloadNow}
                    className="bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition"
                >
                    Reload
                </button>
            </div>
        );
    }
}
