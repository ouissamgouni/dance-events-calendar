import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ConsentProvider } from './context/ConsentContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { SavedEventsProvider } from './context/SavedEventsContext';
import { AttendingEventsProvider } from './context/AttendingEventsContext';
import { AttendanceSummariesProvider } from './context/AttendanceSummariesContext';
import { RatingAggregatesProvider } from './context/RatingAggregatesContext';
import { MyRatingsProvider } from './context/MyRatingsContext';
import { QaTestPlanProvider, useQaPinnedWidth } from './components/QaTestPlanPanel';
import { StatusBar } from './components/StatusBar';
import InstagramBadge from './components/InstagramBadge';
import ProtectedRoute from './components/ProtectedRoute';
import SignUpBanner from './components/SignUpBanner';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Login from './pages/Login';
import Account from './pages/Account';
import EventDetailPage from './pages/EventDetailPage';
import MyCalendar from './pages/MyCalendar';
import SharedCalendarPage from './pages/SharedCalendarPage';
import Privacy from './pages/Privacy';
import { useConsent } from './context/ConsentContext';
import { umamiPageView } from './utils/umami';

export default function App() {
  return (
    <AuthProvider>
      <ConsentProvider>
        <FeatureFlagsProvider>
          <AttendanceSummariesProvider>
            <SavedEventsProvider>
              <RatingAggregatesProvider>
                <MyRatingsProvider>
                  <AttendingEventsProvider>
                    <QaTestPlanProvider>
                      <AppShell />
                    </QaTestPlanProvider>
                  </AttendingEventsProvider>
                </MyRatingsProvider>
              </RatingAggregatesProvider>
            </SavedEventsProvider>
          </AttendanceSummariesProvider>
        </FeatureFlagsProvider>
      </ConsentProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { user } = useAuth();
  const { analyticsConsent } = useConsent();
  const location = useLocation();
  const isAdminPage = location.pathname.startsWith('/admin');
  const qaPinnedWidth = useQaPinnedWidth();

  useEffect(() => {
    if (analyticsConsent) umamiPageView();
  }, [location.pathname, analyticsConsent]);

  return (
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
          <div className="flex items-center gap-3">
            {user ? (
              <>
                {user.is_admin && (
                  <Link
                    to={isAdminPage ? '/' : '/admin'}
                    className="bg-gray-700 px-2.5 py-1 text-xs font-medium text-white rounded hover:bg-gray-600 transition"
                  >
                    {isAdminPage ? 'Explorer' : 'Admin'}
                  </Link>
                )}
                <Link
                  to="/account"
                  className="text-xs font-medium text-white hover:text-gray-200 transition"
                >
                  {user.name?.split(' ')[0] ?? 'Account'}
                </Link>
              </>
            ) : (
              <Link
                to="/login"
                className="text-xs font-medium text-white hover:text-gray-200 transition"
              >
                Sign in
              </Link>
            )}
            <InstagramBadge />
          </div>
        </div>
        <SignUpBanner />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/calendar" element={<Home />} />
            <Route path="/event/:eventId" element={<EventDetailPage />} />
            <Route path="/my-calendar" element={<MyCalendar />} />
            <Route path="/shared/:token" element={<SharedCalendarPage />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/login" element={<Login />} />
            <Route path="/account" element={<Account />} />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <Admin />
                </ProtectedRoute>
              }
            />
          </Routes>
          <footer className="py-3 text-center">
            <Link to="/privacy" className="text-[11px] text-gray-400 hover:text-gray-600 transition">
              Privacy Policy
            </Link>
          </footer>
        </main>
        <StatusBar />
      </div>
    </>
  );
}
