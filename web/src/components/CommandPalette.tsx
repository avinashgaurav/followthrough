import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Client, SearchInsightHit } from "../api";
import { useAuth } from "../auth";
import { isPaletteChord } from "./shortcuts";
import { useToast } from "./ui";

interface Command {
  id: string;
  kind: "nav" | "action" | "insight" | "client";
  label: string;
  sub?: string;
  kindLabel: string;
  run: () => void;
}

function fuzzy(haystack: string, q: string): boolean {
  if (!q) return true;
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [insights, setInsights] = useState<SearchInsightHit[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setActive(0);
    setInsights([]);
    setClients([]);
  }, []);

  // global open chord
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isPaletteChord(e)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // debounced live results from /api/search + /api/clients
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setInsights([]);
      setClients([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const [s, cs] = await Promise.all([
          api.search(term).catch(() => ({ insights: [], transcripts: [] })),
          api.listClients().catch(() => [] as Client[]),
        ]);
        if (cancelled) return;
        setInsights(s.insights.slice(0, 5));
        const ql = term.toLowerCase();
        setClients(cs.filter((c) => (c.name ?? "").toLowerCase().includes(ql)).slice(0, 5));
      } catch {
        if (!cancelled) {
          setInsights([]);
          setClients([]);
        }
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, open]);

  const navCommands = useMemo<Command[]>(() => {
    const items: Array<{ id: string; label: string; path: string; admin?: boolean }> = [
      { id: "nav-capture", label: "Go to Capture", path: "/capture" },
      { id: "nav-review", label: "Go to Review", path: "/" },
      { id: "nav-insights", label: "Go to Insights", path: "/insights" },
      { id: "nav-clients", label: "Go to Clients", path: "/clients" },
      { id: "nav-proof", label: "Go to Shipped?", path: "/proof" },
      { id: "nav-numbers", label: "Go to Numbers", path: "/numbers", admin: true },
      { id: "nav-settings", label: "Go to Settings", path: "/settings", admin: true },
    ];
    return items
      .filter((i) => !i.admin || isAdmin)
      .map((i) => ({
        id: i.id,
        kind: "nav" as const,
        kindLabel: "Go to",
        label: i.label,
        run: () => {
          navigate(i.path);
          close();
        },
      }));
  }, [isAdmin, navigate, close]);

  const actionCommands = useMemo<Command[]>(() => {
    const items: Command[] = [
      {
        id: "act-new-meeting",
        kind: "action",
        kindLabel: "Action",
        label: "New meeting",
        sub: "Add a transcript to the system",
        run: () => {
          navigate("/capture");
          close();
        },
      },
      {
        id: "act-rebuild-search",
        kind: "action",
        kindLabel: "Action",
        label: "Rebuild search",
        sub: "Re-index everything for search",
        run: () => {
          void api
            .rebuildSearch()
            .then(() => toast.push("Search rebuild started.", "success"))
            .catch(() => toast.push("Could not rebuild search right now.", "warning"));
          close();
        },
      },
    ];
    if (isAdmin) {
      items.push({
        id: "act-poll-releases",
        kind: "action",
        kindLabel: "Admin",
        label: "Poll releases",
        sub: "Check GitHub for new releases now",
        run: () => {
          void api
            .pollReleases()
            .then(() => toast.push("Release poll started.", "success"))
            .catch(() => toast.push("Could not poll releases right now.", "warning"));
          close();
        },
      });
    }
    return items;
  }, [isAdmin, navigate, close, toast]);

  const resultCommands = useMemo<Command[]>(() => {
    const ins: Command[] = insights.map((it, i) => ({
      id: `ins-${it.id ?? i}`,
      kind: "insight",
      kindLabel: "Insight",
      label: it.title ?? it.handle ?? "Insight",
      sub: it.client_name ?? it.handle ?? "",
      run: () => {
        if (it.id) navigate(`/insights/${it.id}`);
        close();
      },
    }));
    const cls: Command[] = clients.map((c) => ({
      id: `cli-${c.id}`,
      kind: "client",
      kindLabel: "Client",
      label: c.name,
      sub: c.domain ?? "",
      run: () => {
        navigate(`/clients/${c.id}`);
        close();
      },
    }));
    return [...ins, ...cls];
  }, [insights, clients, navigate, close]);

  // static commands filtered by fuzzy query; live results always shown
  const filteredStatic = useMemo(() => {
    const all = [...navCommands, ...actionCommands];
    if (!q.trim()) return all;
    return all.filter((c) => fuzzy(`${c.label} ${c.sub ?? ""}`, q.trim()));
  }, [navCommands, actionCommands, q]);

  const ordered = useMemo(() => [...filteredStatic, ...resultCommands], [filteredStatic, resultCommands]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(ordered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      ordered[active]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  if (!open) return null;

  // group ordered list for rendering with section labels but keep a flat index
  const groups: Array<{ label: string; items: Command[]; startIndex: number }> = [];
  let idx = 0;
  function pushGroup(label: string, kinds: Command["kind"][]) {
    const items = ordered.filter((c) => kinds.includes(c.kind));
    if (items.length) {
      groups.push({ label, items, startIndex: idx });
      idx += items.length;
    }
  }
  pushGroup("Navigate", ["nav"]);
  pushGroup("Actions", ["action"]);
  pushGroup("Insights", ["insight"]);
  pushGroup("Clients", ["client"]);

  return (
    <div className="palette-backdrop" onClick={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pinput">
          <span className="subtle" aria-hidden="true">
            &#8981;
          </span>
          <input
            ref={inputRef}
            value={q}
            placeholder="Search, navigate, or run an action"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            aria-label="Command palette search"
          />
        </div>
        <div className="plist">
          {ordered.length === 0 ? (
            <div className="pempty">
              {q.trim().length >= 2 ? "Nothing matched." : "Type to search insights and clients."}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="pgroup">{g.label}</div>
                {g.items.map((c, i) => {
                  const flat = g.startIndex + i;
                  return (
                    <div
                      key={c.id}
                      className={`prow${flat === active ? " active" : ""}`}
                      role="option"
                      aria-selected={flat === active}
                      onMouseEnter={() => setActive(flat)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        c.run();
                      }}
                    >
                      <span className="pkind">{c.kindLabel}</span>
                      <span>{c.label}</span>
                      {c.sub && <span className="psub">{c.sub}</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="pfoot">
          <span>
            <span className="mono">&#8593;&#8595;</span> navigate
          </span>
          <span>
            <span className="mono">&#8629;</span> open
          </span>
          <span>
            <span className="mono">esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}
