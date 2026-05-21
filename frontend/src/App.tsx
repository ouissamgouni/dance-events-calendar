import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
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
import { AdminPrefsProvider } from './context/AdminPrefsContext';
import { QaTestPlanProvider, useQaPinnedWidth } from './components/QaTestPlanPanel';
import { StatusBar } from './components/StatusBar';
import InstagramBadge from './components/InstagramBadge';
import NotificationBell from './components/NotificationBell';
import HeaderUserMenu from './components/HeaderUserMenu';
import ProtectedRoute from './components/ProtectedRoute';
import SignUpBanner from './components/SignUpBanner';
import ShareReferralBanner from './components/ShareReferralBanner';
import FloatingMineButton from './components/FloatingMineButton';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Login from './pages/Login';
import Account from './pages/Account';
import EventDetailPage from './pages/EventDetailPage';
import MyCalendar from './pages/MyCalendar';
import Notifications from './pages/Notifications';
import ProfilePage from './pages/ProfilePage';
import DiscoverPage from './pages/DiscoverPage';
import SharedCalendarPage from './pages/SharedCalendarPage';
import Privacy from './pages/Privacy';
import OnboardingPreferences from './pages/OnboardingPreferences';
import OnboardingFollow from './pages/OnboardingFollow';
import ReferralLanding from './pages/ReferralLanding';
import OnboardingGate from './components/OnboardingGate';
import UserSearchBox from './components/UserSearchBox';
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
                        <QaTestPlanProvider>
                          <AppShell />
                        </QaTestPlanProvider>
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
  const location = useLocation();
  const qaPinnedWidth = useQaPinnedWidth();

  useEffect(() => {
    if (analyticsConsent) umamiPageView();
  }, [location.pathname, analyticsConsent]);

  return (
    <NotificationsProvider>
      <>
        <div
          className="flex flex-col h-screen"
          style={qaPinnedWidth ? { marginRight: qaPinnedWidth, transition: 'margin-right 0.2s ease' } : { transition: 'margin-right 0.2s ease' }}
        >
          <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5">
            <div className="flex items-center gap-1.5">
              <Link to="/">
                <img src="/movida.png" alt="Movida" className="h-6 w-6" />
              </Link>
              <Link to="/" className="text-sm font-bold text-white tracking-tight hover:text-gray-200 transition">Movida</Link>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <Link
                to="/?submit=1"
                className="sm:hidden text-xs font-medium text-white hover:text-gray-200 transition"
              >
                + Submit
              </Link>
              <NotificationBell />
              <UserSearchBox />
              <HeaderUserMenu />
              <InstagramBadge />
            </div>
          </div>
          <SignUpBanner />
          <ShareReferralBanner />
          <OnboardingGate />
          <main className="flex-1 overflow-auto">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/onboarding/preferences" element={<OnboardingPreferences />} />
              <Route path="/onboarding/follow" element={<OnboardingFollow />} />
              <Route path="/r/:code" element={<ReferralLanding />} />
              <Route path="/calendar" element={<Home />} />
              <Route path="/event/:eventId" element={<EventDetailPage />} />
              <Route path="/my-calendar" element={<MyCalendar />} />
              <Route path="/my-calendar/subscriptions" element={<MyCalendar />} />
              <Route path="/shared/:token" element={<SharedCalendarPage />} />
              <Route path="/privacy" element={<Privacy />} />
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
          <FloatingMineButton />
        </div>
      </>
    </NotificationsProvider>
  );
}
