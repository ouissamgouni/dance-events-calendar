import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/AuthContext';
import { ConsentProvider } from './context/ConsentContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SavedEventsProvider } from './context/SavedEventsContext';
import { PreferencesProvider } from './context/PreferencesContext';
import { AttendingEventsProvider } from './context/AttendingEventsContext';
import { AttendanceSummariesProvider } from './context/AttendanceSummariesContext';
import { RatingAggregatesProvider } from './context/RatingAggregatesContext';
import { MyRatingsProvider } from './context/MyRatingsContext';
import { AdminPrefsProvider } from './context/AdminPrefsContext';
import { PwaInstallProvider } from './context/PwaInstallContext';
import { QaTestPlanProvider, useQaPinnedWidth } from './components/QaTestPlanPanel';
import { StatusBar } from './components/StatusBar';
import NotificationBell from './components/NotificationBell';
import HeaderUserMenu from './components/HeaderUserMenu';
import ProtectedRoute from './components/ProtectedRoute';
import SignUpBanner from './components/SignUpBanner';
import ShareReferralBanner from './components/ShareReferralBanner';
import InstallPrompt from './components/InstallPrompt';
import Home from './pages/Home';
// Route-level code-splitting: only Home (the landing / LCP route) is loaded
// eagerly. Every other route is lazy so its JS (Admin tooling, FullCalendar,
// account/profile bundles, etc.) is fetched on demand instead of bloating the
// initial bundle downloaded on first paint.
const Admin = lazy(() => import('./pages/Admin'));
const Login = lazy(() => import('./pages/Login'));
const Account = lazy(() => import('./pages/Account'));
const EventDetailPage = lazy(() => import('./pages/EventDetailPage'));
const MyCalendar = lazy(() => import('./pages/MyCalendar'));
const Notifications = lazy(() => import('./pages/Notifications'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const DiscoverPage = lazy(() => import('./pages/DiscoverPage'));
const SharedCalendarPage = lazy(() => import('./pages/SharedCalendarPage'));
const Privacy = lazy(() => import('./pages/Privacy'));
const OnboardingPreferences = lazy(() => import('./pages/OnboardingPreferences'));
const OnboardingLocal = lazy(() => import('./pages/OnboardingLocal'));
const OnboardingFollow = lazy(() => import('./pages/OnboardingFollow'));
const ReferralLanding = lazy(() => import('./pages/ReferralLanding'));
const ForYouPage = lazy(() => import('./pages/ForYouPage'));
const InstallPage = lazy(() => import('./pages/InstallPage'));
import OnboardingGate from './components/OnboardingGate';
import UserSearchBox from './components/UserSearchBox';
import ExplorerEventSearch from './components/ExplorerEventSearch';
import { useConsent } from './context/ConsentContext';
import { umamiPageView } from './utils/umami';

export default function App() {
  return (
    <AuthProvider>
      <ConsentProvider>
        <FeatureFlagsProvider>
          <AttendanceSummariesProvider>
            <SavedEventsProvider>
              <PreferencesProvider>
                <RatingAggregatesProvider>
                  <MyRatingsProvider>
                    <AttendingEventsProvider>
                      <AdminPrefsProvider>
                        <PwaInstallProvider>
                          <QaTestPlanProvider>
                            <AppShell />
                          </QaTestPlanProvider>
                        </PwaInstallProvider>
                      </AdminPrefsProvider>
                    </AttendingEventsProvider>
                  </MyRatingsProvider>
                </RatingAggregatesProvider>
              </PreferencesProvider>
            </SavedEventsProvider>
          </AttendanceSummariesProvider>
        </FeatureFlagsProvider>
      </ConsentProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { analyticsConsent } = useConsent();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const qaPinnedWidth = useQaPinnedWidth();
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (analyticsConsent) umamiPageView();
  }, [location.pathname, analyticsConsent]);

  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  return (
    <NotificationsProvider>
      <>
        <div
          className="flex flex-col h-screen"
          style={qaPinnedWidth ? { marginRight: qaPinnedWidth, transition: 'margin-right 0.2s ease' } : { transition: 'margin-right 0.2s ease' }}
        >
          <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5">
            <div className="flex items-center gap-1.5">
              <Link to="/" reloadDocument>
                <img src="/movida.png" alt="Movida" className="h-6 w-6" />
              </Link>
              <Link to="/" reloadDocument className="text-sm font-bold text-white tracking-tight hover:text-gray-200 transition">Movida</Link>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              {!user && (
                <Link
                  to="/?submit=1"
                  className="text-xs font-medium text-white hover:text-gray-200 transition"
                >
                  <span className="sm:hidden">+ Submit</span>
                  <span className="hidden sm:inline">Submit event</span>
                </Link>
              )}
              <ExplorerEventSearch
                compact
                onDark
                onSelectEvent={(eventId) => navigate(`/event/${eventId}`)}
                triggerLabel="Search events"
              />
              <UserSearchBox />
              <NotificationBell />
              <HeaderUserMenu />
            </div>
          </div>
          <SignUpBanner />
          <ShareReferralBanner />
          <OnboardingGate />
          <main ref={mainRef} className="flex-1 overflow-auto">
            <Suspense fallback={null}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/onboarding/preferences" element={<OnboardingPreferences />} />
                <Route path="/onboarding/local" element={<OnboardingLocal />} />
                <Route path="/onboarding/follow" element={<OnboardingFollow />} />
                <Route path="/r/:code" element={<ReferralLanding />} />
                <Route path="/calendar" element={<Home />} />
                <Route path="/for-you" element={<ForYouPage />} />
                <Route path="/event/:eventId" element={<EventDetailPage />} />
                <Route path="/my-calendar" element={<MyCalendar />} />
                <Route path="/my-calendar/subscriptions" element={<MyCalendar />} />
                <Route path="/shared/:token" element={<SharedCalendarPage />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/install" element={<InstallPage />} />
                <Route path="/login" element={<Login />} />
                <Route path="/account" element={<Account />} />
                <Route
                  path="/notifications"
                  element={
                    <ProtectedRoute>
                      <Notifications />
                    </ProtectedRoute>
                  }
                />
                <Route path="/u/:handle" element={<ProfilePage />} />
                <Route path="/discover" element={<DiscoverPage />} />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/admin/:tab"
                  element={
                    <ProtectedRoute>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </Suspense>
            <footer className="py-3 text-center flex items-center justify-center gap-3">
              <Link to="/privacy" className="text-[11px] text-gray-400 hover:text-gray-600 transition">
                Privacy Policy
              </Link>
              <span className="text-[11px] text-gray-300" aria-hidden="true">·</span>
              <a
                href="mailto:support@joinmovida.com?subject=Movida%20feedback"
                className="text-[11px] text-gray-400 hover:text-gray-600 transition"
              >
                Send feedback
              </a>
            </footer>
          </main>
          <StatusBar />
        </div>
        <InstallPrompt />
      </>
    </NotificationsProvider>
  );
}
