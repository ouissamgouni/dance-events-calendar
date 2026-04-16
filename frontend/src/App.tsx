import { useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { SavedEventsProvider } from './context/SavedEventsContext';
import { QaTestPlanProvider } from './components/QaTestPlanPanel';
import { StatusBar } from './components/StatusBar';
import InstagramBadge from './components/InstagramBadge';
import SavedEventsFab from './components/SavedEventsFab';
import SuggestEventModal from './components/SuggestEventModal';
import ProtectedRoute from './components/ProtectedRoute';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Login from './pages/Login';
import EventDetailPage from './pages/EventDetailPage';
import MyCalendar from './pages/MyCalendar';

export default function App() {
  const [showSuggestModal, setShowSuggestModal] = useState(false);

  return (
    <AuthProvider>
      <FeatureFlagsProvider>
        <SavedEventsProvider>
          <QaTestPlanProvider>
            <div className="flex flex-col h-screen">
              <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5">
                <span className="text-sm font-bold text-white tracking-tight">🔥 Salsa Events</span>
                <div className="flex items-center gap-3">
                  <SavedEventsFab />
                  <button
                    onClick={() => setShowSuggestModal(true)}
                    className="bg-gray-700 px-2.5 py-1 text-xs font-medium text-white rounded hover:bg-gray-600 transition"
                  >
                    <span className="sm:hidden">Suggest</span>
                    <span className="hidden sm:inline">Suggest an Event</span>
                  </button>
                  <InstagramBadge />
                </div>
              </div>
              <main className="flex-1 overflow-auto">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/event/:eventId" element={<EventDetailPage />} />
                  <Route path="/my-calendar" element={<MyCalendar />} />
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
            {showSuggestModal && (
              <SuggestEventModal onClose={() => setShowSuggestModal(false)} />
            )}
          </QaTestPlanProvider>
        </SavedEventsProvider>
      </FeatureFlagsProvider>
    </AuthProvider>
  );
}
