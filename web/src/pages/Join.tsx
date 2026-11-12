import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn, Field } from "../components/ui";
import { RecoveryCodeCard } from "../components/RecoveryCode";

/**
 * Where an invite link lands: /join#<token>. The token is in the fragment so
 * it never reaches a server log, a Referer header or analytics; it is read
 * once and cleared from the address bar.
 */
export function Join() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const started = useRef(false);
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const t = window.location.hash.replace(/^#/, "");
    window.history.replaceState(null, "", window.location.pathname);
    if (!t) {
      setGone("This invite link is incomplete. Ask your teammate to send it again.");
      return;
    }
    setToken(t);
    api
      .joinInfo(t)
      .then((r) => setWorkspace(r.workspace))
      .catch((err) => setGone(err instanceof ApiError ? err.message : "Couldn't check this invite link. Try again."));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.join({ token, email: email.trim(), name: name.trim(), password });
      setCode(r.recovery_code);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) setGone(err.message);
      else setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    await refresh();
    navigate("/", { replace: true });
  }

  return (
    <div className="login-wrap">
      <div className="login-card corner">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "10px 0 24px" }}>
          <span aria-hidden className="logo-mark" style={{ width: 28, height: 28, marginBottom: 14 }} />
          <h1>Followthrough</h1>
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {code ? "You're in. One more thing before you start." : workspace ? `Join ${workspace}` : "Invite link"}
          </p>
        </div>

        {gone && (
          <Alert severity="warning" title="This link doesn't work.">
            <p style={{ margin: "0 0 8px" }}>{gone}</p>
            <Link to="/login">Go to sign in</Link>
          </Alert>
        )}

        {!gone && !workspace && !code && <p className="muted small">Checking the invite link</p>}

        {!gone && workspace && !code && (
          <form className="stack" onSubmit={submit}>
            {error && (
              <Alert severity="warning" title="That didn't work." onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}
            <Field label="Your name" htmlFor="j-name">
              <input id="j-name" className="ctrl" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" htmlFor="j-email" hint="Your sign-in name. Use an email you own.">
              <input id="j-email" className="ctrl" type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="j-password" hint="At least 10 characters.">
              <input id="j-password" className="ctrl" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm password" htmlFor="j-password2">
              <input id="j-password2" className="ctrl" type="password" autoComplete="new-password" required minLength={10} value={password2} onChange={(e) => setPassword2(e.target.value)} />
            </Field>
            <div className="form-actions">
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Joining" : `Join ${workspace}`}
              </Btn>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              This link works once.{" "}
              <a href="https://followthrough-eight.vercel.app/privacy.html" target="_blank" rel="noreferrer">
                Where your data goes
              </a>
            </p>
          </form>
        )}

        {code && <RecoveryCodeCard code={code} email={email.trim()} onDone={() => void finish()} doneLabel="Start using Followthrough" />}
      </div>
    </div>
  );
}
