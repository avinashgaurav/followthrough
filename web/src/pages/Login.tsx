import { useEffect, useState } from "react";
import { HostedLogin } from "./HostedLogin";
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
  // Hosted deployments sign in with an emailed code instead of a team password.
  const [hostedFree, setHostedFree] = useState<number | null>(null);
  // Nothing is drawn until we know which sign-in this is, so the hosted app
  // never flashes the team-password form first.
  const [configKnown, setConfigKnown] = useState(false);
  const [configStuck, setConfigStuck] = useState(false);
  const [configTry, setConfigTry] = useState(0);
  useEffect(() => {
    let live = true;
    setConfigStuck(false);
    // A stalled request must not leave a blank page: after 4s, offer a retry.
    const timer = setTimeout(() => live && setConfigStuck(true), 4000);
    api
      .hostedConfig()
      .then((c) => live && c.hosted && setHostedFree(c.free_meetings ?? 0))
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        if (live) {
          setConfigStuck(false);
          setConfigKnown(true);
        }
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [configTry]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const mail = email.trim();
    const c = code.trim();
    if (!mail || !c) {
      setError("Enter your work email and password.");
      return;
    }
    // The server refuses anything shorter (a 400 that would read as an email problem).
    if (c.length < 4) {
      setError("That password or code is too short. It is at least 4 characters.");
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

  if (!configKnown) {
    return (
      <div className="login-wrap" aria-busy={!configStuck}>
        <div className="login-card corner" role="status">
          {configStuck ? (
            <>
              <p style={{ margin: "0 0 12px" }}>Couldn't reach the server.</p>
              <Btn variant="primary" onClick={() => setConfigTry((n) => n + 1)}>
                Retry
              </Btn>
            </>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              Loading sign-in
            </p>
          )}
        </div>
      </div>
    );
  }
  if (hostedFree !== null) return <HostedLogin freeMeetings={hostedFree} />;

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
          <span aria-hidden className="logo-mark" style={{ width: 28, height: 28, marginBottom: 14 }} />
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
