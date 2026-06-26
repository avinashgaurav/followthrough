import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, RequireAdmin, RequireAuth } from "./auth";
import { Shell } from "./components/Shell";
import { EmptyState, ToastProvider } from "./components/ui";
import { Ask } from "./pages/Ask";
import { Capture } from "./pages/Capture";
import { ClientDetail } from "./pages/ClientDetail";
import { Clients } from "./pages/Clients";
import { Home } from "./pages/Home";
import { Meeting } from "./pages/Meeting";
import { InsightDetail } from "./pages/InsightDetail";
import { Insights } from "./pages/Insights";
import { Login } from "./pages/Login";
import { Numbers } from "./pages/Numbers";
import { Proof } from "./pages/Proof";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="page-body">
      <EmptyState
        title="Page not found."
        body="That address doesn't match anything here."
        action={
          <button className="btn primary" onClick={() => navigate("/")}>
            Back to Home
          </button>
        }
      />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            >
              <Route index element={<Home />} />
              <Route path="/review" element={<Review />} />
              <Route path="/capture" element={<Capture />} />
              <Route path="/meetings/:id" element={<Meeting />} />
              {/* nav-label aliases so spoken/bookmarked names always land */}
              <Route path="/library" element={<Navigate to="/insights" replace />} />
              <Route path="/confirm-shipped" element={<Navigate to="/proof" replace />} />
              <Route path="/shipped" element={<Navigate to="/proof" replace />} />
              <Route path="/speed" element={<Navigate to="/numbers" replace />} />
              <Route path="/home" element={<Navigate to="/" replace />} />
              <Route path="/ask" element={<Ask />} />
              <Route path="/insights" element={<Insights />} />
              <Route path="/insights/:id" element={<InsightDetail />} />
              <Route path="/clients" element={<Clients />} />
              <Route path="/clients/:id" element={<ClientDetail />} />
              <Route path="/proof" element={<Proof />} />
              <Route
                path="/numbers"
                element={
                  <RequireAdmin>
                    <Numbers />
                  </RequireAdmin>
                }
              />
              <Route
                path="/settings"
                element={
                  <RequireAdmin>
                    <Settings />
                  </RequireAdmin>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
