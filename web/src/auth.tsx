import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, ApiError } from "./api";
import type { User } from "./api";
import { Skeleton } from "./components/ui";

interface AuthState {
  user: User | null;
  loading: boolean;
  isGuest: boolean;
  requireLogin: boolean;
  setUser: (u: User | null) => void;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  isGuest: false,
  requireLogin: false,
  setUser: () => undefined,
  refresh: async () => undefined,
});

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  const [requireLogin, setRequireLogin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.me();
      setUser(r.user ?? null);
      setIsGuest(!!r.is_guest);
      setRequireLogin(!!r.require_login);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setUser(null);
        setIsGuest(false);
        setRequireLogin(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, loading, isGuest, requireLogin, setUser, refresh }),
    [user, loading, isGuest, requireLogin, refresh],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div style={{ padding: 48, maxWidth: 600 }}>
        <Skeleton rows={5} />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user && user.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
