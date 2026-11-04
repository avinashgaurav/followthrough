import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn } from "../components/ui";
import { HostedLogin, type SignInResume } from "./HostedLogin";

/**
 * Where the emailed sign-in link lands. Supabase puts a short-lived access
 * token in the URL fragment; the server checks it with Supabase and either
 * signs the person in or asks them to name their workspace (or accept an
 * invite). The fragment is cleared at once so the token is not left in history.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState<SignInResume | null>(null);
  const [free, setFree] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    // Run once: the token is single-use and the fragment is cleared below.
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    window.history.replaceState(null, "", window.location.pathname);
    const token = params.get("access_token");
    if (!token) {
      const reason = params.get("error_description");
      setError(reason ? `${reason.replace(/\+/g, " ")}. Request a new sign-in link.` : "That sign-in link is incomplete. Request a new one.");
      return;
    }
    api.hostedConfig().then((c) => setFree(c.free_meetings ?? 0)).catch(() => {});
    api
      .linkVerify(token)
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
