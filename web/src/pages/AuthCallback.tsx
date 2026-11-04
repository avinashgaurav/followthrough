import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn } from "../components/ui";
import { HostedLogin, type SignInResume } from "./HostedLogin";

/**
 * Where the emailed sign-in link lands. The link carries a one-time token hash
 * in the query (?token_hash=...&type=email); older template links put a
 * short-lived access token in the fragment. The server checks either with
 * Supabase and either signs the person in or asks them to name their workspace
 * (or accept an invite). The URL is cleared at once so no token is left in
 * history.
 * Error text shown here is fixed: the fragment is attacker-editable, so its
 * free-text description is never displayed.
 */
const LINK_ERRORS: Record<string, string> = {
  otp_expired: "That sign-in link has expired or was already used.",
  access_denied: "That sign-in link is no longer valid.",
};
export function AuthCallback() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState<SignInResume | null>(null);
  const [free, setFree] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    // Run once: the fragment (and its token) is cleared below.
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    const tokenHash = query.get("token_hash");
    const token = params.get("access_token");
    const link = tokenHash ? { token_hash: tokenHash, type: query.get("type") ?? "email" } : token ? { access_token: token } : null;
    if (!link) {
      const code = params.get("error_code") ?? query.get("error_code") ?? "";
      const known = LINK_ERRORS[code] ?? LINK_ERRORS[params.get("error") ?? query.get("error") ?? ""];
      setError(`${known ?? "That sign-in link didn't work."} Request a new one.`);
      return;
    }
    api.hostedConfig().then((c) => setFree(c.free_meetings ?? 0)).catch(() => {});
    api
      .linkVerify(link)
      .then(async (r) => {
        if (r.needs_workspace && r.signup_token) {
          setResume({ token: r.signup_token, invite: r.invite ?? null });
        } else {
          await refresh();
          navigate("/", { replace: true });
        }
      })
      .catch((err) => setError(err instanceof ApiError || err instanceof Error ? err.message : "Sign-in failed. Try again."));
  }, [navigate, refresh]);

  if (resume) return <HostedLogin freeMeetings={free} resume={resume} />;

  return (
    <div className="login-wrap">
      <div className="login-card corner">
        {error ? (
          <div className="stack">
            <Alert severity="warning" title="Couldn't sign you in.">
              {error}
            </Alert>
            <Btn variant="primary" type="button" onClick={() => navigate("/login", { replace: true })}>
              Back to sign in
            </Btn>
          </div>
        ) : (
          <p className="muted small" style={{ margin: 0, textAlign: "center" }}>
            Signing you in...
          </p>
        )}
      </div>
    </div>
  );
}
