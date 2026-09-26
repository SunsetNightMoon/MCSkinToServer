import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './store/auth';
import { useSiteStore } from './store/site';
import { AppLayout } from './components/AppLayout';
import { LandingPage } from './pages/Landing';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { ProfilesPage } from './pages/Profiles';
import { WardrobePage } from './pages/Wardrobe';
import { LibraryPage } from './pages/Library';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (token) return <Navigate to="/wardrobe" replace />;
  return <>{children}</>;
}

export function App() {
  const theme = useSiteStore((s) => s.theme);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/login"
          element={
            <GuestOnly>
              <LoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/register"
          element={
            <GuestOnly>
              <RegisterPage />
            </GuestOnly>
          }
        />
        <Route element={<AppLayout />}>
          <Route path="/library" element={<LibraryPage />} />
          <Route
            path="/wardrobe"
            element={
              <RequireAuth>
                <WardrobePage />
              </RequireAuth>
            }
          />
          <Route
            path="/profiles"
            element={
              <RequireAuth>
                <ProfilesPage />
              </RequireAuth>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
