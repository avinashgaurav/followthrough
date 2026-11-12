import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Btn, Field } from "../components/ui";
import { RecoveryCodeCard } from "../components/RecoveryCode";

// "signup" / "signin": email + password (open sign-up while no email sender is
// connected, issue #24). "recover": a new password with the recovery code.
// "saved": the recovery code, shown once after sign-up or a reset.
// "email" / "code" / "invite" / "workspace": the emailed link flow, reached
// from /auth/callback.
type Step = "signup" | "signin" | "recover" | "saved" | "email" | "code" | "invite" | "workspace";

/**
 * Hosted sign-in: email, then the code Supabase emails, then (first time
 * only) the company or product the AI should work for. One flow for sign-up
 * and sign-in; the server decides which it is after the code checks out.
 */
export interface SignInResume {
  token: string;
  invite: { workspace: string; invited_by: string | null } | null;
}

export function HostedLogin({ freeMeetings, resume }: { freeMeetings: number; resume?: SignInResume }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useAuth();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  // Arriving from the emailed link: the email is already proven, go straight on.
  const [step, setStep] = useState<Step>(resume ? (resume.invite ? "invite" : "workspace") : "signup");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState(resume?.token ?? "");
  const [product, setProduct] = useState("");
  const [what, setWhat] = useState("");
  const [invite, setInvite] = useState<{ workspace: string; invited_by: string | null } | null>(resume?.invite ?? null);
  const [recovery, setRecovery] = useState("");
  const [shownCode, setShownCode] = useState<string | null>(null);
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
          <span aria-hidden className="logo-mark" style={{ width: 28, height: 28, marginBottom: 14 }} />
          <h1>Followthrough</h1>
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {step === "workspace"
              ? "One last thing: who does the AI work for?"
              : step === "signin"
                ? "Welcome back."
                : step === "recover"
                  ? "Set a new password with your recovery code."
                  : step === "saved"
                    ? "You're in. One more thing before you start."
                    : `Start free. Your first ${freeMeetings} meetings are on us.`}
          </p>
        </div>
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Alert severity="warning" title="That didn't work." onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

        {step === "signup" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (password !== password2) throw new Error("The two passwords don't match.");
                const r = await api.passwordSignup(email.trim(), password, product.trim(), what.trim() || undefined);
                if (r.recovery_code) {
                  setShownCode(r.recovery_code);
                  setStep("saved");
                } else {
                  await done();
                }
              });
            }}
          >
            <Alert severity="info" title="You'll get a recovery code.">
              After you sign up, save the code we show you. If you forget your password, it's how you set a new one.
            </Alert>
            <Field label="Email" htmlFor="s-email" hint="Use an email you own: if its real owner signs in later, they get this account and its workspace, and the password stops working.">
              <input id="s-email" className="ctrl" type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="s-password" hint="At least 10 characters.">
              <input id="s-password" className="ctrl" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm password" htmlFor="s-password2">
              <input id="s-password2" className="ctrl" type="password" autoComplete="new-password" required minLength={10} value={password2} onChange={(e) => setPassword2(e.target.value)} />
            </Field>
            <Field label="Company or product" htmlFor="s-product" hint="The AI frames every ask around it.">
              <input id="s-product" className="ctrl" required maxLength={80} placeholder="Acme" value={product} onChange={(e) => setProduct(e.target.value)} />
            </Field>
            <Field label="What you sell (optional)" htmlFor="s-what">
              <input id="s-what" className="ctrl" maxLength={160} placeholder="a payroll platform for small businesses" value={what} onChange={(e) => setWhat(e.target.value)} />
            </Field>
            <div className="form-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Creating" : "Create my workspace"}
              </Btn>
              <Btn variant="ghost" type="button" disabled={busy} onClick={() => { setError(null); setStep("signin"); }}>
                I have an account
              </Btn>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Your calls are read by Google Gemini to find the asks.{" "}
              <a href="https://followthrough-eight.vercel.app/privacy.html" target="_blank" rel="noreferrer">
                Where your data goes
              </a>
            </p>
          </form>
        )}

        {step === "signin" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.passwordLogin(email.trim(), password);
                await done();
              });
            }}
          >
            <Field label="Email" htmlFor="i-email">
              <input id="i-email" className="ctrl" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="i-password">
              <input id="i-password" className="ctrl" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <div className="form-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Signing in" : "Sign in"}
              </Btn>
              <Btn variant="ghost" type="button" disabled={busy} onClick={() => { setError(null); setStep("signup"); }}>
                Create an account
              </Btn>
            </div>
            <p className="small" style={{ margin: 0 }}>
              <button type="button" className="linklike" onClick={() => { setError(null); setPassword(""); setStep("recover"); }}>
                Forgot your password?
              </button>
            </p>
          </form>
        )}

        {step === "recover" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (password !== password2) throw new Error("The two passwords don't match.");
                const r = await api.passwordReset(email.trim(), recovery.trim(), password);
                setShownCode(r.recovery_code);
                setRecovery("");
                setStep("saved");
              });
            }}
          >
            <Field label="Email" htmlFor="r-email">
              <input id="r-email" className="ctrl" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Recovery code" htmlFor="r-code" hint="The code you saved when you signed up, like K7QX-29MF-H3TD.">
              <input id="r-code" className="ctrl mono" autoComplete="off" spellCheck={false} required placeholder="XXXX-XXXX-XXXX" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
            </Field>
            <Field label="New password" htmlFor="r-password" hint="At least 10 characters.">
              <input id="r-password" className="ctrl" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm new password" htmlFor="r-password2">
              <input id="r-password2" className="ctrl" type="password" autoComplete="new-password" required minLength={10} value={password2} onChange={(e) => setPassword2(e.target.value)} />
            </Field>
            <div className="form-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn variant="primary" type="submit" disabled={busy}>
                {busy ? "Saving" : "Set new password"}
              </Btn>
              <Btn variant="ghost" type="button" disabled={busy} onClick={() => { setError(null); setStep("signin"); }}>
                Back to sign in
              </Btn>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              No recovery code? Admins can make a new one in Settings while signed in. Without one, a lost password can't be reset yet.
            </p>
          </form>
        )}

        {step === "saved" && shownCode && (
          <RecoveryCodeCard code={shownCode} email={email.trim()} onDone={() => void done()} doneLabel="Start using Followthrough" />
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
                {busy ? "Sending" : "Email me a sign-in link"}
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
            <p className="small" style={{ margin: 0 }}>
              We sent an email to <b>{email.trim()}</b>. <b>Click the link in it</b> to sign in. You can close this tab.
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              If the email shows a code instead, type it here.
            </p>
            <Field label="Code (optional)" htmlFor="h-code">
              <input id="h-code" className="ctrl mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
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
