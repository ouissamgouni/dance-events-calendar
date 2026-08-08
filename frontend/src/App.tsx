import { Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import { AuthProvider } from './context/AuthContext';
import { ConsentProvider } from './context/ConsentContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SavedEventsProvider } from './context/SavedEventsContext';
import { PreferencesProvider } from './context/PreferencesContext';
import { AttendingEventsProvider } from './context/AttendingEventsContext';
import { AttendanceSummariesProvider } from './context/AttendanceSummariesContext';
import { RatingAggregatesProvider } from './context/RatingAggregatesContext';
import { MyRatingsProvider } from './context/MyRatingsContext';
import { PwaInstallProvider } from './context/PwaInstallContext';
import { QaTestPlanProvider, useQaPinnedWidth } from './components/QaTestPlanPanel';
import { StatusBar } from './components/StatusBar';
import NotificationBell from './components/NotificationBell';
import HeaderUserMenu from './components/HeaderUserMenu';
import DesktopNav from './components/DesktopNav';
import BottomNav from './components/BottomNav';
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
const SeriesPage = lazy(() => import('./pages/SeriesPage'));
const MyCalendar = lazy(() => import('./pages/MyCalendar'));
const PassportPage = lazy(() => import('./pages/PassportPage'));
const Notifications = lazy(() => import('./pages/Notifications'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const DiscoverPage = lazy(() => import('./pages/DiscoverPage'));
const SharedCalendarPage = lazy(() => import('./pages/SharedCalendarPage'));
const SharedPassportPage = lazy(() => import('./pages/SharedPassportPage'));
const Privacy = lazy(() => import('./pages/Privacy'));
const OnboardingPreferences = lazy(() => import('./pages/OnboardingPreferences'));
const OnboardingLocal = lazy(() => import('./pages/OnboardingLocal'));
const OnboardingFollow = lazy(() => import('./pages/OnboardingFollow'));
const ReferralLanding = lazy(() => import('./pages/ReferralLanding'));
const ForYouPage = lazy(() => import('./pages/ForYouPage'));
const InstallPage = lazy(() => import('./pages/InstallPage'));
const InvitePage = lazy(() => import('./pages/InvitePage'));
const MineHub = lazy(() => import('./pages/MineHub'));
const NetworkPage = lazy(() => import('./pages/NetworkPage'));
const FollowingReviewsPage = lazy(() => import('./pages/FollowingReviewsPage'));
const MyReviewsPage = lazy(() => import('./pages/MyReviewsPage'));
const DiscoveryProfilesPage = lazy(() => import('./pages/DiscoveryProfilesPage'));
const SectionLayout = lazy(() => import('./components/SectionTabs'));
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
                      <PwaInstallProvider>
                        <QaTestPlanProvider>
                          <AppShell />
                        </QaTestPlanProvider>
                      </PwaInstallProvider>
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
  const location = useLocation();
  const navigate = useNavigate();
  const qaPinnedWidth = useQaPinnedWidth();
  const mainRef = useRef<HTMLElement | null>(null);

  // Full-screen flows (auth, onboarding) and leaf detail pages (event/series,
  // admin, notifications, shared views) suppress the primary bottom nav.
  const hideBottomNav =
    location.pathname === '/login' ||
    location.pathname.startsWith('/onboarding/') ||
    location.pathname.startsWith('/event/') ||
    location.pathname.startsWith('/series/') ||
    location.pathname.startsWith('/admin') ||
    location.pathname.startsWith('/notifications') ||
    location.pathname.startsWith('/shared/') ||
    location.pathname === '/account';

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
          className="flex flex-col h-full"
          style={qaPinnedWidth ? { marginRight: qaPinnedWidth, transition: 'margin-right 0.2s ease' } : { transition: 'margin-right 0.2s ease' }}
        >
          <div
            className="flex items-center justify-between bg-slate-900 px-4 py-1.5"
            style={{ paddingTop: 'calc(0.375rem + env(safe-area-inset-top))' }}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Link to="/" reloadDocument>
                  <img src="/movida.png" alt="Movida" className="h-6 w-6" />
                </Link>
                <Link to="/" reloadDocument className="text-sm font-bold text-white tracking-tight hover:text-gray-200 transition">Movida</Link>
              </div>
              <DesktopNav />
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              {/* Desktop: inline event search, mirroring the people search box */}
              <ExplorerEventSearch
                className="hidden sm:block w-64"
                pastToggle
                headerInline
                onSelectEvent={(eventId) => navigate(`/event/${eventId}`)}
                triggerLabel="Search events"
              />
              {/* Mobile: compact icon trigger opening a panel */}
              <ExplorerEventSearch
                className="sm:hidden"
                compact
                onDark
                pastToggle
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
                <Route path="/event/:eventId/review" element={<EventDetailPage />} />
                <Route path="/series/:seriesId" element={<SeriesPage />} />
                <Route path="/tribe" element={<SectionLayout section="tribe" />}>
                  <Route index element={<Navigate to="/tribe/calendars" replace />} />
                  <Route path="calendars" element={<MyCalendar />} />
                  <Route
                    path="activity"
                    element={
                      <ProtectedRoute>
                        <Notifications socialOnly />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="discover" element={<DiscoverPage />} />
                  <Route path="network" element={<NetworkPage />} />
                  <Route path="reviews" element={<FollowingReviewsPage />} />
                </Route>
                <Route path="/mine" element={<SectionLayout section="mine" />}>
                  <Route index element={<MineHub />} />
                  <Route path="calendar" element={<MyCalendar />} />
                  <Route
                    path="passport"
                    element={
                      <ProtectedRoute>
                        <PassportPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="reviews" element={<MyReviewsPage />} />
                  <Route path="profiles" element={<DiscoveryProfilesPage />} />
                </Route>
                <Route path="/shared/:token" element={<SharedCalendarPage />} />
                <Route path="/shared/passport/:token" element={<SharedPassportPage />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/install" element={<InstallPage />} />
                <Route path="/invite" element={<InvitePage />} />
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
          {!hideBottomNav && <BottomNav />}
          <StatusBar />
        </div>
        <InstallPrompt />
      </>
    </NotificationsProvider>
  );
}
