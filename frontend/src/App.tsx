import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { QaTestPlanProvider } from './components/QaTestPlanPanel';
import { StatusBar } from './components/StatusBar';
import InstagramBadge from './components/InstagramBadge';
import ProtectedRoute from './components/ProtectedRoute';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Login from './pages/Login';
import EventDetailPage from './pages/EventDetailPage';

export default function App() {
  return (
    <AuthProvider>
      <FeatureFlagsProvider>
        <QaTestPlanProvider>
          <div className="flex flex-col h-screen">
            <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5">
              <span className="text-sm font-bold text-white tracking-tight">🔥 Salsa Events</span>
              <InstagramBadge />
            </div>
            <main className="flex-1 overflow-auto">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/event/:eventId" element={<EventDetailPage />} />
                <Route path="/login" element={<Login />} />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </main>
            <StatusBar />
          </div>
        </QaTestPlanProvider>
      </FeatureFlagsProvider>
    </AuthProvider>
  );
}
