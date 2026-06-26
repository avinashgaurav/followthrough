import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Meeting, QueueResponse } from "../api";
import { useAuth } from "../auth";
import { Btn, EmptyState, ErrorAlert, Skeleton, StatePill } from "../components/ui";
import { formatDate, meetingStatusLabel } from "../format";

// Job: answer "what needs me right now" with zero pipeline knowledge.
// One look tells the founder where to click: action cards on top (from the
// review queue buckets), the latest meetings underneath. Two api calls, no polling.

interface HomeCounts {
  toReview: number;
  toFinish: number;
  toConfirm: number;
  toTell: number;
}

function countsFrom(q: QueueResponse): HomeCounts {
  return {
    toReview: (q.to_review ?? []).length,
    // wording + ticket are both "you started this, finish it" work
    toFinish: (q.to_finalize ?? []).length + (q.to_ticket ?? []).length,
    toConfirm: (q.to_confirm ?? []).length,
    toTell: (q.to_email ?? []).length,
  };
}

export function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [counts, setCounts] = useState<HomeCounts | null>(null);
  const [queueError, setQueueError] = useState<unknown>(null);

  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [meetingsError, setMeetingsError] = useState<unknown>(null);

  const loadQueue = useCallback(() => {
    setQueueError(null);
    setCounts(null);
    api
      .queue()
      .then((q) => setCounts(countsFrom(q)))
      .catch((e) => setQueueError(e));
  }, []);

  const loadMeetings = useCallback(() => {
    setMeetingsError(null);
    setMeetings(null);
    api
      .listMeetings()
      .then((ms) =>
        setMeetings(
          [...ms]
            .sort((a, b) => {
              const ta = new Date(a.created_at ?? a.meeting_date ?? 0).getTime();
              const tb = new Date(b.created_at ?? b.meeting_date ?? 0).getTime();
              return tb - ta;
            })
            .slice(0, 8),
        ),
      )
      .catch((e) => setMeetingsError(e));
  }, []);

  useEffect(() => {
    loadQueue();
    loadMeetings();
  }, [loadQueue, loadMeetings]);

  return (
    <>
      <div className="head">
        <div className="row-between">
          <div>
            <h1>Home</h1>
            <p>What needs you right now.</p>
          </div>
        </div>
      </div>

      <div className="page-body">
        {/* ---- what needs you: one card per kind of waiting work */}
        {queueError ? (
          <div className="mb-28">
            <ErrorAlert error={queueError} onRetry={loadQueue} />
          </div>
        ) : !counts ? (
          <div className="mb-28 maxw-980">
            <Skeleton rows={3} />
          </div>
        ) : (
          <div className="home-cards">
            <ActionCard
              stage="1 · Found"
              count={counts.toReview}
              what={
                counts.toReview === 1
                  ? "1 new insight from meetings"
                  : `${counts.toReview} new insights from meetings`
              }
              go="Review them"
              hot
              onGo={() => navigate("/review")}
            />
            <ActionCard
              stage="2 · Routed & Locked"
              count={counts.toFinish}
              what={`${counts.toFinish} waiting on wording or a ticket`}
              go="Finish them"
              onGo={() => navigate("/review")}
            />
            <ActionCard
              stage="3 · Shipped"
              count={counts.toConfirm}
              what={
                counts.toConfirm === 1
                  ? "1 looks shipped"
                  : `${counts.toConfirm} look shipped`
              }
              go="Confirm them"
              onGo={() => navigate("/proof")}
            />
            <ActionCard
              stage="4 · Client told"
              count={counts.toTell}
              what={
                counts.toTell === 1
                  ? "1 client to tell"
                  : `${counts.toTell} clients to tell`
              }
              go="Send the note"
              onGo={() => navigate("/review")}
            />
          </div>
        )}

        {/* ---- recent meetings */}
        <div className="row-between mb-8 maxw-980">
          <span className="lbl">Recent meetings</span>
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => navigate("/capture")}
            tooltip="Open Capture to add a meeting and pull insights from it."
          >
            Add a meeting
          </Btn>
        </div>

        {meetingsError ? (
          <ErrorAlert error={meetingsError} onRetry={loadMeetings} />
        ) : meetings === null ? (
          <div className="card maxw-980">
            <Skeleton rows={4} />
          </div>
        ) : meetings.length === 0 ? (
          <div className="card maxw-980">
            <EmptyState
              title="No meetings yet."
              body="Add a meeting and the AI pulls the insights out for you to review."
              action={
                <Btn variant="primary" onClick={() => navigate("/capture")}>
                  Add a meeting
                </Btn>
              }
            />
          </div>
        ) : (
          <div className="table-wrap card recent-meetings p-0 maxw-980">
            <table className="table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Client</th>
                  <th>When</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => {
                  const open = () => navigate(`/meetings/${encodeURIComponent(m.id)}`);
                  return (
                    <tr
                      key={m.id}
                      className="clickable"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      title="Open this meeting: its transcript, insights, and next step."
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
                      <td data-label="Meeting">{m.title?.trim() || "Untitled meeting"}</td>
                      <td data-label="Client">{m.client_name ?? "-"}</td>
                      <td data-label="When">{m.meeting_date ? formatDate(m.meeting_date) : "-"}</td>
                      <td data-label="State">
                        {m.status ? (
                          <StatePill state={m.status} label={meetingStatusLabel(m.status)} />
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ---- admins get the one pointer to the numbers */}
        {user?.role === "admin" && (
          <p className="tiny muted" style={{ marginTop: 20 }}>
            Turnaround and per-person pace live in{" "}
            <a
              href="/numbers"
              onClick={(e) => {
                e.preventDefault();
                navigate("/numbers");
              }}
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              Speed
            </a>
            .
          </p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- action card

/**
 * One kind of waiting work. The big number says how much, the sentence says
 * what it is, the uppercase verb says what clicking does. Zero items dims the
 * card; the only red on the page is the count of brand-new insights.
 */
function ActionCard({
  stage,
  count,
  what,
  go,
  hot,
  onGo,
}: {
  stage: string;
  count: number;
  what: string;
  go: string;
  hot?: boolean;
  onGo: () => void;
}) {
  const zero = count === 0;
  return (
    <button
      type="button"
      className={`action-card${zero ? " zero" : ""}`}
      onClick={onGo}
    >
      {/* the pipeline stage this card sits at, so the four cards read as the
          loop (Found -> Routed/Locked -> Shipped -> Client told) in order */}
      <div className="stage">{stage}</div>
      <div className={`count${hot && !zero ? " hot" : ""}`}>{count}</div>
      <div className="what">{what}</div>
      <div className="go">{zero ? "Nothing waiting" : go}</div>
    </button>
  );
}
