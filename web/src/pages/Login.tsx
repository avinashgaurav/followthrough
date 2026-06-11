import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn, Field } from "../components/ui";

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const mail = email.trim();
    const c = code.trim();
    if (!mail || !c) {
      setError("Enter your work email and login code.");
      return;
    }
    if (!mail.toLowerCase().endsWith("@xyz.com")) {
      setError("Use your @xyz.com email. Only @xyz.com accounts can sign in.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.login(mail, c);
      if (r && typeof r === "object" && r.user) {
        setUser(r.user);
      } else {
        await refresh();
      }
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Wait a few minutes, then try again.");
      } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError("That email and code did not match. Check the code your admin gave you.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Only @xyz.com emails can sign in here.");
      } else {
        setError(err instanceof Error ? err.message : "Sign in failed. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card corner">
        <div className="brand" style={{ padding: "0 0 18px" }}>
          <span className="sq" />
          <b style={{ fontSize: 14 }}>Insights Engine</b>
        </div>
        <h1 style={{ fontSize: 18, marginBottom: 4 }}>Sign in</h1>
        <p className="muted small" style={{ margin: "0 0 22px" }}>
          Use the login code your admin issued.
        </p>
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Alert severity="warning" title="Couldn't sign in." onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}
        <form onSubmit={onSubmit} className="stack">
          <Field label="Work email" htmlFor="login-email" hint="Must be a @xyz.com address.">
            <input
              id="login-email"
              className="ctrl"
              type="email"
              autoComplete="email"
              placeholder="you@xyz.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Login code" htmlFor="login-code" hint="Issued and rotated by your admin.">
            <input
              id="login-code"
              className="ctrl mono"
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Btn variant="primary" type="submit" disabled={busy}>
              {busy ? "Signing in" : "Sign in"}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}
