import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, RequireAdmin, RequireAuth } from "./auth";
import { Shell } from "./components/Shell";
import { EmptyState, ToastProvider } from "./components/ui";
import { Capture } from "./pages/Capture";
import { ClientDetail } from "./pages/ClientDetail";
import { Clients } from "./pages/Clients";
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
            Back to Review
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
              <Route index element={<Review />} />
              <Route path="/review" element={<Navigate to="/" replace />} />
              <Route path="/capture" element={<Capture />} />
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
