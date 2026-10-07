import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, domainRule, emailAllowed } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn, Field } from "../components/ui";

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser, refresh, allowedDomains } = useAuth();
  const rule = domainRule(allowedDomains);
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
      setError("Enter your work email and password.");
      return;
    }
    if (!emailAllowed(mail, allowedDomains)) {
      setError(`Use your ${rule} email. Only ${rule} accounts can sign in.`);
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
        setError("That didn't match. Check your email and the team password (or your personal login code).");
      } else if (err instanceof ApiError && err.status === 400) {
        setError(rule ? `Only ${rule} emails can sign in here.` : "That email can't sign in here.");
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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            padding: "10px 0 28px",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 22,
              height: 22,
              background: "var(--accent)",
              borderRadius: 1,
              marginBottom: 14,
            }}
          />
          <h1>Followthrough</h1>
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            Client meetings in. Tracked commitments out.
          </p>
        </div>
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Alert severity="warning" title="Couldn't sign in." onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}
        <form onSubmit={onSubmit} className="stack">
          <Field label="Work email" htmlFor="login-email" hint={rule ? `Must be a ${rule} address.` : undefined}>
            <input
              id="login-email"
              className="ctrl"
              type="email"
              autoComplete="email"
              placeholder={allowedDomains[0] ? `you@${allowedDomains[0]}` : "you@company.com"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="login-code" hint="Your team password — or your personal login code.">
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
