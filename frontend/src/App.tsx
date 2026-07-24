import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import CalendarPage from './pages/Calendar';
import Settings from './pages/Settings';
import Setup from './pages/Setup';
import { AdminPage } from './pages/AdminPage';
import './index.css';

const isSetupComplete = (user: any): boolean => {
  if (!user) return false;
  return !!(user.geminiApiKey && user.phone && user.dayStartTime && user.dayEndTime);
};

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { token, user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // Setup tamamlanmadıysa setup'a yönlendir
  if (!isSetupComplete(user)) {
    return <Navigate to="/setup" replace />;
  }

  return <>{children}</>;
};

const SetupRoute = ({ children }: { children: React.ReactNode }) => {
  const { token, user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // Setup zaten tamamlandıysa dashboard'a yönlendir
  if (isSetupComplete(user)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

const PublicRoute = ({ children }: { children: React.ReactNode }) => {
  const { token, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-page">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (token) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

const AppLayout = ({ children }: { children: React.ReactNode }) => (
  <div className="app-layout">
    <Sidebar />
    <main className="main-content">
      {children}
    </main>
  </div>
);

const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
    <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
    <Route path="/setup" element={<SetupRoute><Setup /></SetupRoute>} />
    <Route path="/admin" element={<AdminPage />} />
    <Route path="/" element={
      <ProtectedRoute>
        <AppLayout><Dashboard /></AppLayout>
      </ProtectedRoute>
    } />
    <Route path="/tasks" element={
      <ProtectedRoute>
        <AppLayout><Tasks /></AppLayout>
      </ProtectedRoute>
    } />
    <Route path="/calendar" element={
      <ProtectedRoute>
        <AppLayout><CalendarPage /></AppLayout>
      </ProtectedRoute>
    } />
    <Route path="/settings" element={
      <ProtectedRoute>
        <AppLayout><Settings /></AppLayout>
      </ProtectedRoute>
    } />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  </BrowserRouter>
);

export default App;
