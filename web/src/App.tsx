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
import { ProfilePage } from './pages/Profile';
import { SkinDetail } from './pages/SkinDetail';
import { CapeDetail } from './pages/CapeDetail';
import { UploadPage } from './pages/Upload';
import MySkins from './pages/MySkins';
import MyCapes from './pages/MyCapes';
import AdminPage from './pages/Admin';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const role = useAuthStore((s) => s.user?.role);
  if (!token) return <Navigate to="/login" replace />;
  if (role !== 'admin' && role !== 'super_admin') return <Navigate to="/" replace />;
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
          <Route path="/skin/:id" element={<SkinDetail />} />
          <Route path="/cape/:id" element={<CapeDetail />} />
          <Route
            path="/upload"
            element={
              <RequireAuth>
                <UploadPage />
              </RequireAuth>
            }
          />
          <Route
            path="/wardrobe"
            element={
              <RequireAuth>
                <WardrobePage />
              </RequireAuth>
            }
          />
          <Route
            path="/my-skins"
            element={
              <RequireAuth>
                <MySkins />
              </RequireAuth>
            }
          />
          <Route
            path="/my-capes"
            element={
              <RequireAuth>
                <MyCapes />
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
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <ProfilePage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
