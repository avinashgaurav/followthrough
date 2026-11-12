import { useState } from "react";
import { Alert, Btn, useToast } from "./ui";

/**
 * A recovery code, shown once. The person copies or downloads it and ticks
 * that they saved it before going on: it is the only way back in if they
 * forget their password (no email sender yet).
 */
export function RecoveryCodeCard({ code, email, onDone, doneLabel = "Continue" }: {
  code: string;
  email?: string;
  onDone?: () => void;
  doneLabel?: string;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);

  function copy() {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => toast.push("Recovery code copied.", "success"))
      .catch(() => toast.push("Copy failed. Select the code and copy it by hand.", "warning"));
  }

  function download() {
    const text =
      `Followthrough recovery code${email ? ` for ${email}` : ""}\n\n${code}\n\n` +
      "Use it on the sign-in page (Forgot your password?) to set a new password. It works once; you get a new one each time.\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "followthrough-recovery-code.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Alert severity="success" title="Save your recovery code">
      <p style={{ margin: "0 0 10px" }}>
        If you forget your password, this code lets you set a new one. It is shown only now, so put it in a password
        manager or download it.
      </p>
      <div className="row gap-8" style={{ flexWrap: "wrap", marginBottom: 10 }}>
        <code
          className="mono"
          aria-label="Recovery code"
          style={{
            background: "var(--p2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r)",
            padding: "6px 10px",
            fontSize: 16,
            letterSpacing: "0.08em",
            userSelect: "all",
          }}
        >
          {code}
        </code>
        <Btn size="sm" onClick={copy}>
          Copy
        </Btn>
        <Btn size="sm" onClick={download}>
          Download
        </Btn>
      </div>
      {onDone && (
        <>
          <label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I saved my recovery code
          </label>
          <Btn variant="primary" disabled={!saved} onClick={onDone}>
            {doneLabel}
          </Btn>
        </>
      )}
    </Alert>
  );
}
