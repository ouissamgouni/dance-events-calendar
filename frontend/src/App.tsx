import { Routes, Route, Link, Navigate, useLocation, useNavigate, useParams, type Location } from 'react-router-dom';
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
import { MessageCountsProvider } from './context/MessageCountsContext';
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
const AdminEventSchedulePage = lazy(() => import('./pages/AdminEventSchedulePage'));
const Login = lazy(() => import('./pages/Login'));
const Account = lazy(() => import('./pages/Account'));
const EventDetailPage = lazy(() => import('./pages/EventDetailPage'));
const EventProgramPage = lazy(() => import('./pages/EventProgramPage'));
const EventProgramExportPage = lazy(() => import('./pages/EventProgramExportPage'));
const SeriesPage = lazy(() => import('./pages/SeriesPage'));
const MyCalendar = lazy(() => import('./pages/MyCalendar'));
const PassportPage = lazy(() => import('./pages/PassportPage'));
const Notifications = lazy(() => import('./pages/Notifications'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SharedCalendarPage = lazy(() => import('./pages/SharedCalendarPage'));
const SharedPassportPage = lazy(() => import('./pages/SharedPassportPage'));
const Privacy = lazy(() => import('./pages/Privacy'));
const OnboardingWizard = lazy(() => import('./pages/OnboardingWizard'));
const ReferralLanding = lazy(() => import('./pages/ReferralLanding'));
const ForYouPage = lazy(() => import('./pages/ForYouPage'));
const TextSearchPage = lazy(() => import('./pages/TextSearchPage'));
const InstallPage = lazy(() => import('./pages/InstallPage'));
const InvitePage = lazy(() => import('./pages/InvitePage'));
const NetworkPage = lazy(() => import('./pages/NetworkPage'));
const FollowingReviewsPage = lazy(() => import('./pages/FollowingReviewsPage'));
const MyReviewsPage = lazy(() => import('./pages/MyReviewsPage'));
const DiscoveryProfilesPage = lazy(() => import('./pages/DiscoveryProfilesPage'));
const SearchProfileEditorPage = lazy(() => import('./pages/SearchProfileEditorPage'));
const SectionLayout = lazy(() => import('./components/SectionTabs'));
const SuggestEventWizard = lazy(() => import('./components/suggest/SuggestEventWizard'));
import OnboardingGate from './components/OnboardingGate';
import UserSearchBox from './components/UserSearchBox';
import { useConsent } from './context/ConsentContext';
import { umamiPageView } from './utils/umami';

/** Location state used to keep the origin page mounted behind `/suggest`. */
interface ModalLocationState {
  backgroundLocation?: Location;
}

/**
 * `/suggest` is a real URL rendered over whatever page opened it, so the
 * browser back button closes the wizard and the page underneath keeps its
 * scroll position and data. Opened directly (deep link, refresh) there is no
 * background location, so closing returns to the calendar.
 */
function SuggestEventRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const hasBackground = Boolean((location.state as ModalLocationState | null)?.backgroundLocation);
  return (
    <SuggestEventWizard
      onClose={() => (hasBackground ? navigate(-1) : navigate('/', { replace: true }))}
    />
  );
}

function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}${location.hash}`} replace />;
}

function LegacySavedSearchEditRedirect() {
  const { profileId } = useParams();
  return <LegacyRedirect to={`/saved-searches/${profileId}/edit`} />;
}

export default function App() {
  return (
    <AuthProvider>
      <ConsentProvider>
        <FeatureFlagsProvider>
          <AttendanceSummariesProvider>
            <SavedEventsProvider>
              <PreferencesProvider>
                <RatingAggregatesProvider>
                  <MessageCountsProvider>
                    <MyRatingsProvider>
                      <AttendingEventsProvider>
                        <PwaInstallProvider>
                          <QaTestPlanProvider>
                            <AppShell />
                          </QaTestPlanProvider>
                        </PwaInstallProvider>
                      </AttendingEventsProvider>
                    </MyRatingsProvider>
                  </MessageCountsProvider>
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
  const backgroundLocation = (location.state as ModalLocationState | null)?.backgroundLocation;
  const isMyEvents = location.pathname === '/my-events' || location.pathname === '/mine/calendar';
  const isProgram = /^\/event\/[^/]+\/program/.test(location.pathname);

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
    // An overlay route leaves the page behind it mounted — resetting its scroll
    // would silently lose the user's place when they close the overlay.
    if (backgroundLocation) return;
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname, backgroundLocation]);

  return (
    <NotificationsProvider>
      <>
        <div
          className="flex flex-col h-full"
          style={qaPinnedWidth ? { marginRight: qaPinnedWidth, transition: 'margin-right 0.2s ease' } : { transition: 'margin-right 0.2s ease' }}
        >
          <header
            className="flex items-center justify-between gap-2 bg-surface border-b border-line px-3 sm:px-4"
            style={{ height: 'calc(64px + env(safe-area-inset-top))', paddingTop: 'env(safe-area-inset-top)' }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <Link to="/" reloadDocument className="flex items-center gap-2 shrink-0">
                <img src="/movida.png" alt="Movida" className="h-9 w-9 object-contain shrink-0" />
                <span className="text-[21px] font-bold leading-none tracking-tight">Movida</span>
              </Link>
              <DesktopNav />
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <button
                type="button"
                onClick={() => navigate('/search', { state: { returnTo: `${location.pathname}${location.search}` } })}
                aria-label="Search events"
                title="Search events"
                className="inline-flex h-11 w-11 items-center justify-center text-ink-soft transition hover:text-ink"
              >
                <img src="/search.png" alt="" aria-hidden="true" className="h-6 w-6" />
              </button>
              <UserSearchBox />
              <NotificationBell />
              <HeaderUserMenu />
            </div>
          </header>
          <SignUpBanner />
          <ShareReferralBanner />
          <OnboardingGate />
          <main ref={mainRef} className={`flex-1 ${isMyEvents || isProgram ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-auto'}`}>
            <Suspense fallback={null}>
              <Routes location={backgroundLocation ?? location}>
                <Route path="/" element={<ForYouPage />} />
                <Route path="/onboarding" element={<OnboardingWizard />} />
                <Route path="/onboarding/preferences" element={<OnboardingWizard />} />
                <Route path="/onboarding/local" element={<OnboardingWizard />} />
                <Route path="/onboarding/follow" element={<OnboardingWizard />} />
                <Route path="/r/:code" element={<ReferralLanding />} />
                <Route path="/calendar" element={<Home />} />
                <Route path="/browse" element={<Home />} />
                <Route path="/search" element={<TextSearchPage />} />
                <Route path="/search/results" element={<TextSearchPage />} />
                <Route path="/explore" element={<LegacyRedirect to="/" />} />
                <Route path="/for-you" element={<LegacyRedirect to="/" />} />
                <Route path="/event/:eventId" element={<EventDetailPage />} />
                <Route path="/event/:eventId/program" element={<EventProgramPage />} />
                <Route path="/event/:eventId/program/plan" element={<EventProgramPage />} />
                <Route path="/event/:eventId/program/edit" element={<ProtectedRoute><AdminEventSchedulePage /></ProtectedRoute>} />
                <Route path="/event/:eventId/program/export" element={<ProtectedRoute><EventProgramExportPage /></ProtectedRoute>} />
                <Route path="/event/:eventId/review" element={<EventDetailPage />} />
                <Route path="/event/:eventId/ask" element={<EventDetailPage />} />
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
                  <Route path="discover" element={<Navigate to="/tribe/network" replace />} />
                  <Route path="network" element={<NetworkPage />} />
                  <Route path="reviews" element={<FollowingReviewsPage />} />
                </Route>
                <Route path="/my-events" element={<MyCalendar />} />
                <Route path="/passport" element={<ProtectedRoute><PassportPage /></ProtectedRoute>} />
                <Route path="/reviews" element={<MyReviewsPage />} />
                <Route path="/saved-searches" element={<DiscoveryProfilesPage />} />
                <Route path="/saved-searches/new" element={<SearchProfileEditorPage />} />
                <Route path="/saved-searches/:profileId/edit" element={<SearchProfileEditorPage />} />
                <Route path="/mine" element={<LegacyRedirect to="/" />} />
                <Route path="/mine/calendar" element={<LegacyRedirect to="/my-events" />} />
                <Route path="/mine/passport" element={<LegacyRedirect to="/passport" />} />
                <Route path="/mine/reviews" element={<LegacyRedirect to="/reviews" />} />
                <Route path="/mine/profiles" element={<LegacyRedirect to="/saved-searches" />} />
                <Route path="/mine/profiles/new" element={<LegacyRedirect to="/saved-searches/new" />} />
                <Route path="/mine/profiles/:profileId/edit" element={<LegacySavedSearchEditRedirect />} />
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
                <Route path="/suggest" element={<SuggestEventRoute />} />
                <Route
                  path="/admin/events/:eventId/schedule"
                  element={
                    <ProtectedRoute requireAdmin>
                      <AdminEventSchedulePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute requireAdmin>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/admin/:tab"
                  element={
                    <ProtectedRoute requireAdmin>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
              </Routes>
              {backgroundLocation ? (
                <Routes>
                  <Route path="/suggest" element={<SuggestEventRoute />} />
                </Routes>
              ) : null}
            </Suspense>
            {!isMyEvents && (
              <footer className="py-3 text-center flex items-center justify-center gap-3">
                <Link to="/privacy" className="text-[11px] text-muted hover:text-ink-soft transition">
                  Privacy Policy
                </Link>
                <span className="text-[11px] text-gray-300" aria-hidden="true">·</span>
                <a
                  href="mailto:support@joinmovida.com?subject=Movida%20feedback"
                  className="text-[11px] text-muted hover:text-ink-soft transition"
                >
                  Send feedback
                </a>
              </footer>
            )}
          </main>
          {!hideBottomNav && <BottomNav />}
          <StatusBar />
        </div>
        <InstallPrompt />
      </>
    </NotificationsProvider>
  );
}
