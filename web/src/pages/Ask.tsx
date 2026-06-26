import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AskResponse } from "../api";
import { Alert, Btn, SectionHead } from "../components/ui";

export function Ask() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.ask(q));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get an answer. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHead
        title="Ask"
        job="Ask a question; get an answer pulled only from your meetings, with sources to verify it."
      />
      <div className="page-body">
        <form onSubmit={onSubmit} style={{ display: "flex", gap: 10, maxWidth: 760, marginBottom: 18 }}>
          <input
            className="ctrl"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. What are clients asking about most?"
            aria-label="Your question"
            style={{ flex: 1 }}
          />
          <Btn variant="primary" type="submit" disabled={busy || question.trim().length < 3}>
            {busy ? "Asking" : "Ask"}
          </Btn>
        </form>

        {error && (
          <div style={{ maxWidth: 760, marginBottom: 16 }}>
            <Alert severity="warning" title="Couldn't answer." onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

        {busy && <p className="muted small">Reading the meetings…</p>}

        {result && !busy && (
          <div className="maxw-760">
            <div
              className="card"
              style={{ padding: 16, marginBottom: 16, lineHeight: 1.6, whiteSpace: "pre-wrap" }}
            >
              {result.answer}
            </div>
            {result.sources.length > 0 && (
              <>
                <div className="dlbl">Sources</div>
                <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                  {result.sources.map((s) => (
                    <li key={s.n} className="mb-10">
                      {s.kind === "insight" && s.insight_id ? (
                        <Link to={`/insights/${s.insight_id}`}>
                          {s.handle} — {s.title}
                        </Link>
                      ) : s.meeting_id ? (
                        <Link to={`/meetings/${s.meeting_id}`}>{s.title}</Link>
                      ) : (
                        <span>{s.title}</span>
                      )}
                      <span className="subtle"> · {s.client_name}</span>
                      <div className="muted small" style={{ marginTop: 2 }}>
                        {s.excerpt}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
