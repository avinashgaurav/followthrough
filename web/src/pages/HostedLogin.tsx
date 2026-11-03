import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn, Field } from "../components/ui";

type Step = "email" | "code" | "invite" | "workspace";

/**
 * Hosted sign-in: email, then the code Supabase emails, then (first time
 * only) the company or product the AI should work for. One flow for sign-up
 * and sign-in; the server decides which it is after the code checks out.
 */
export function HostedLogin({ freeMeetings }: { freeMeetings: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useAuth();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [product, setProduct] = useState("");
  const [what, setWhat] = useState("");
  const [invite, setInvite] = useState<{ workspace: string; invited_by: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const done = async () => {
    await refresh();
    navigate(from, { replace: true });
  };

  return (
    <div className="login-wrap">
      <div className="login-card corner">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "10px 0 24px" }}>
          <span aria-hidden style={{ width: 22, height: 22, background: "var(--accent)", borderRadius: 1, marginBottom: 14 }} />
          <h1>Followthrough</h1>
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {step === "workspace"
              ? "One last thing: who does the AI work for?"
              : `Sign in or start free. Your first ${freeMeetings} meetings are on us.`}
          </p>
        </div>
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Alert severity="warning" title="That didn't work." onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

        {step === "email" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.sendCode(email.trim());
                setStep("code");
              });
            }}
          >
            <Field label="Work email" htmlFor="h-email">
              <input id="h-email" className="ctrl" type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <div className="form-actions">
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Sending" : "Email me a code"}
              </Btn>
            </div>
          </form>
        )}

        {step === "code" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.verifyCode(email.trim(), code.trim());
                if (r.needs_workspace && r.signup_token) {
                  setToken(r.signup_token);
                  setInvite(r.invite ?? null);
                  setStep(r.invite ? "invite" : "workspace");
                } else {
                  await done();
                }
              });
            }}
          >
            <p className="small muted" style={{ margin: 0 }}>
              We sent a code to <b>{email.trim()}</b>.
            </p>
            <Field label="Code" htmlFor="h-code">
              <input id="h-code" className="ctrl mono" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <div className="form-actions" style={{ display: "flex", gap: 8 }}>
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Checking" : "Continue"}
              </Btn>
              <Btn variant="ghost" type="button" disabled={busy} onClick={() => { setCode(""); setStep("email"); }}>
                Use another email
              </Btn>
            </div>
          </form>
        )}

        {step === "invite" && invite && (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>
              {invite.invited_by ? <b>{invite.invited_by}</b> : "Someone"} invited you to join <b>{invite.workspace}</b> on
              Followthrough. Only join if you know them: the workspace's admins will see the meetings you add.
            </p>
            <div className="form-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn
                variant="primary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.acceptInvite(token);
                    await done();
                  })
                }
              >
                {busy ? "Joining" : `Join ${invite.workspace}`}
              </Btn>
              <Btn variant="ghost" type="button" disabled={busy} onClick={() => setStep("workspace")}>
                Create my own workspace
              </Btn>
            </div>
          </div>
        )}

        {step === "workspace" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.createWorkspace(token, product.trim(), what.trim() || undefined);
                await done();
              });
            }}
          >
            <Field label="Company or product" htmlFor="h-product" hint="The AI frames every ask around it.">
              <input id="h-product" className="ctrl" required maxLength={80} placeholder="Acme" value={product} onChange={(e) => setProduct(e.target.value)} />
            </Field>
            <Field label="What you sell (optional)" htmlFor="h-what">
              <input id="h-what" className="ctrl" maxLength={160} placeholder="a payroll platform for small businesses" value={what} onChange={(e) => setWhat(e.target.value)} />
            </Field>
            <div className="form-actions">
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Creating" : "Create my workspace"}
              </Btn>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
