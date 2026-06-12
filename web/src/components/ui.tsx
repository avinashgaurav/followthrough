import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { itemTypeLabel, stateLabel, stateTooltipFor, titleCase } from "../format";

// ================================================================ Tooltip

export function Tooltip({
  content,
  title,
  side = "top",
  children,
}: {
  content: ReactNode;
  title?: string;
  side?: "top" | "bottom";
  children: ReactNode;
}) {
  // The bubble renders in a body portal with fixed positioning so it can never
  // be clipped by overflow:hidden/auto ancestors (scroll panes, cards, tables).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  if (!content && !title) return <>{children}</>;
  const show = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.min(Math.max(r.left + r.width / 2, 16), window.innerWidth - 16);
    setPos({ x, y: side === "top" ? r.top : r.bottom });
  };
  const hide = () => setPos(null);
  return (
    <span
      ref={wrapRef}
      className="tt-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={pos ? id : undefined}
    >
      {children}
      {pos &&
        createPortal(
          <span
            className={`tt-bubble ${side}`}
            role="tooltip"
            id={id}
            style={
              side === "top"
                ? { left: pos.x, bottom: window.innerHeight - pos.y + 6 }
                : { left: pos.x, top: pos.y + 6 }
            }
          >
            {title && <span className="tt-title">{title}</span>}
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Small "?" help marker with a tooltip. Used on metrics and non-obvious controls. */
export function Help({ content, title }: { content: ReactNode; title?: string }) {
  return (
    <Tooltip content={content} title={title}>
      <span className="help" aria-label="Help" tabIndex={0}>
        ?
      </span>
    </Tooltip>
  );
}

// ================================================================ Buttons

type BtnVariant = "default" | "primary" | "ghost" | "danger";

export function Btn({
  variant = "default",
  size,
  tooltip,
  tooltipTitle,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: "sm";
  tooltip?: ReactNode;
  tooltipTitle?: string;
}) {
  const cls = [
    "btn",
    variant !== "default" ? variant : "",
    size === "sm" ? "sm" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const btn = (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
  if (tooltip || tooltipTitle) {
    return (
      <Tooltip content={tooltip} title={tooltipTitle}>
        {btn}
      </Tooltip>
    );
  }
  return btn;
}

// ================================================================ Pills + state pills

type PillKind = "neutral" | "feat" | "ins";

export function Pill({ label, kind = "neutral" }: { label: string; kind?: PillKind }) {
  const cls = kind === "neutral" ? "pill" : `pill ${kind}`;
  return <span className={cls}>{label}</span>;
}

/** Visual class per the design spec:
 *  extracted/triaged/closed/merged -> muted, finalized/ticketed -> white,
 *  shipped/client_notified -> green, rejected -> red. */
const stateClass: Record<string, string> = {
  extracted: "muted",
  triaged: "muted",
  finalized: "white",
  ticketed: "white",
  shipped: "green",
  client_notified: "green",
  closed: "green",
  rejected: "red",
  merged: "muted",
};

export function StatePill({ state }: { state: string | undefined | null }) {
  if (!state) return null;
  const cls = stateClass[state] ?? "muted";
  return (
    <Tooltip title={stateLabel(state)} content={stateTooltipFor(state)}>
      <span className={`st ${cls}`}>{stateLabel(state)}</span>
    </Tooltip>
  );
}

export function ItemTypePill({ type }: { type: string | undefined | null }) {
  if (!type) return null;
  const kind: PillKind = type === "feature_request" || type === "action_item_ours" ? "feat" : "ins";
  return <Pill label={itemTypeLabel(type)} kind={kind} />;
}

// ================================================================ Field

export function Field({
  label,
  htmlFor,
  hint,
  error,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {help && (
          <>
            {" "}
            <Help content={help} />
          </>
        )}
      </label>
      {children}
      {error ? (
        <p className="helper error">{error}</p>
      ) : hint ? (
        <p className="helper">{hint}</p>
      ) : null}
    </div>
  );
}

// ================================================================ Combobox (generic type-ahead)

export function Combobox<T>({
  items,
  value,
  onChange,
  getKey,
  getLabel,
  renderItem,
  onCreateNew,
  placeholder = "Type to search",
  id,
  disabled,
}: {
  items: T[];
  value: T | null;
  onChange: (item: T) => void;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  renderItem?: (item: T) => ReactNode;
  onCreateNew?: (query: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => getLabel(it).toLowerCase().includes(q));
  }, [items, query, getLabel]);

  const canCreate = !!onCreateNew && query.trim().length > 0;
  const rowCount = filtered.length + (canCreate ? 1 : 0);

  function pick(idx: number) {
    if (canCreate && idx === filtered.length) {
      onCreateNew?.(query.trim());
      setQuery("");
      setOpen(false);
      return;
    }
    const it = filtered[idx];
    if (it) {
      onChange(it);
      setQuery("");
      setOpen(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(rowCount - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) pick(active);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="combobox" ref={wrapRef}>
      <input
        id={id}
        className="ctrl"
        disabled={disabled}
        value={open ? query : value ? getLabel(value) : query}
        placeholder={value ? getLabel(value) : placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
      />
      {open && rowCount > 0 && (
        <div className="pop" role="listbox">
          {filtered.map((it, i) => (
            <div
              key={getKey(it)}
              role="option"
              aria-selected={i === active}
              className={`opt${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              {renderItem ? renderItem(it) : getLabel(it)}
            </div>
          ))}
          {canCreate && (
            <div
              role="option"
              aria-selected={active === filtered.length}
              className={`opt create${active === filtered.length ? " active" : ""}`}
              onMouseEnter={() => setActive(filtered.length)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(filtered.length);
              }}
            >
              + Create new "{query.trim()}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ================================================================ Toast

type Severity = "info" | "success" | "warning" | "critical";

interface ToastItem {
  id: number;
  message: string;
  severity: Severity;
}

interface ToastApi {
  push: (message: string, severity?: Severity) => void;
}

const ToastCtx = createContext<ToastApi>({ push: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, severity: Severity = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, message, severity }]);
    if (severity !== "critical") {
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    }
  }, []);

  const apiValue = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={apiValue}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.severity}`}>
              {t.message}
              <button
                className="dismiss"
                aria-label="Dismiss"
                onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ================================================================ Alerts

export function Alert({
  severity,
  title,
  children,
  onDismiss,
}: {
  severity: Severity;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`alert ${severity}`} role={severity === "critical" ? "alert" : "status"}>
      {title && <h4>{title}</h4>}
      {children && <div className="alert-body">{children}</div>}
      {onDismiss && (
        <button className="dismiss" aria-label="Dismiss" onClick={onDismiss}>
          &times;
        </button>
      )}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something did not load.";
  return (
    <Alert severity="warning" title="Couldn't load this.">
      <p style={{ marginBottom: onRetry ? 8 : 0 }}>{msg}</p>
      {onRetry && (
        <Btn size="sm" onClick={onRetry}>
          Retry
        </Btn>
      )}
    </Alert>
  );
}

// ================================================================ Modal + focus trap

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button, [href], input, select, textarea")?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        style={width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="dismiss" aria-label="Close" onClick={onClose} style={{ position: "static" }}>
            &times;
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Destructive confirm. Calls onConfirm and closes; surfaces busy state. */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger = true,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working" : confirmLabel}
          </Btn>
        </>
      }
    >
      {body}
    </Modal>
  );
}

// ================================================================ Skeleton (no shimmer)

export function Skeleton({ rows = 4 }: { rows?: number }) {
  const widths = useMemo(() => {
    const w: string[] = [];
    for (let i = 0; i < rows; i++) w.push(`${55 + ((i * 17) % 40)}%`);
    return w;
  }, [rows]);
  return (
    <div aria-hidden="true">
      {widths.map((w, i) => (
        <div key={i} className="skeleton" style={{ width: w }} />
      ))}
    </div>
  );
}

// ================================================================ EmptyState

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="icon" />
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

// ================================================================ SectionHead (page title + JTBD job statement)

export function SectionHead({
  title,
  job,
  actions,
}: {
  title: string;
  job: string;
  actions?: ReactNode;
}) {
  return (
    <div className="head">
      <div className="row-between">
        <div>
          <h1>{title}</h1>
          <p>{job}</p>
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
    </div>
  );
}

// ================================================================ Markdown (tiny, dependency-free, no raw HTML injection)

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Minimal markdown to HTML. Input is escaped first; only our own tags are emitted. */
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md.replaceAll("\r\n", "\n")).split("\n");
  const out: string[] = [];
  let i = 0;
  let listMode: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listMode) {
      out.push(`</${listMode}>`);
      listMode = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h && h[1] && h[2] !== undefined) {
      closeList();
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push("<hr/>");
      i++;
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (line.startsWith("|") && (lines[i + 1] ?? "").match(/^\|[\s\-:|]+\|?\s*$/)) {
      closeList();
      const headCells = line.split("|").slice(1, -1).map((c) => c.trim());
      out.push("<table><thead><tr>");
      for (const c of headCells) out.push(`<th>${inline(c)}</th>`);
      out.push("</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        const cells = (lines[i] ?? "").split("|").slice(1, -1).map((c) => c.trim());
        out.push("<tr>");
        for (const c of cells) out.push(`<td>${inline(c)}</td>`);
        out.push("</tr>");
        i++;
      }
      out.push("</tbody></table>");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul && ul[1] !== undefined) {
      if (listMode !== "ul") {
        closeList();
        out.push("<ul>");
        listMode = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }
    if (ol && ol[1] !== undefined) {
      if (listMode !== "ol") {
        closeList();
        out.push("<ol>");
        listMode = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }
    closeList();
    if (line.trim() === "") {
      i++;
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join("\n");
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ================================================================ generic table helpers (used by Numbers etc.)

export function AutoTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = useMemo(() => {
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    return cols;
  }, [rows]);

  const numeric = useMemo(() => {
    const set = new Set<string>();
    for (const c of columns) {
      const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== "");
      if (vals.length > 0 && vals.every((v) => typeof v === "number")) set.add(c);
    }
    return set;
  }, [columns, rows]);

  if (rows.length === 0) return <p className="muted small">No data yet.</p>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className={numeric.has(c) ? "num" : undefined}>
                {titleCase(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {columns.map((c) => {
                const v = r[c];
                const cell =
                  v === null || v === undefined
                    ? ""
                    : typeof v === "object"
                      ? JSON.stringify(v)
                      : String(v);
                return (
                  <td key={c} className={numeric.has(c) ? "num" : undefined}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ================================================================ Spine (the time-axis)
// The product's truth is an append-only event log, so every surface is organized
// around a vertical time-spine. See design-reference/SPINE.md.

export function Spine({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={"spine" + (className ? " " + className : "")}>{children}</div>;
}

/** One stop on the spine. state: done (amber tick) | live (glowing playhead) | future (faint tick). */
export function SpineItem({
  timecode,
  state = "future",
  children,
}: {
  timecode?: string;
  state?: "done" | "live" | "future";
  children: ReactNode;
}) {
  const cls = state === "live" ? "spine-row live" : `spine-row ${state}`;
  return (
    <div className={cls}>
      {timecode && <span className="spine-tc num">{timecode}</span>}
      <span className="spine-tick" aria-hidden="true" />
      {children}
    </div>
  );
}

// ================================================================ Waveform-as-data
// One bar language for audio (Capture) and trend sparklines (Numbers).

/** amplitudes are 0..1; liveIndex (optional) highlights the current/most-recent bar in amber. */
export function Waveform({
  amplitudes,
  liveIndex,
}: {
  amplitudes: number[];
  liveIndex?: number;
}) {
  return (
    <div className="waveform" aria-hidden="true">
      {amplitudes.map((a, i) => {
        const h = Math.max(6, Math.min(100, a * 100));
        const cls = i === liveIndex ? "bar live" : a > 0.18 ? "bar voiced" : "bar";
        return <span key={i} className={cls} style={{ height: `${h}%` }} />;
      })}
    </div>
  );
}

/** Compact vertical-bar trend. Last bucket renders amber (the live present) by default. */
export function Sparkline({
  values,
  highlightLast = true,
  title,
}: {
  values: number[];
  highlightLast?: boolean;
  title?: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <span className="sparkline" role="img" aria-label={title}>
      {values.map((v, i) => {
        const h = Math.max(8, (v / max) * 100);
        const live = highlightLast && i === values.length - 1;
        return <span key={i} className={live ? "bar live" : "bar"} style={{ height: `${h}%` }} />;
      })}
    </span>
  );
}

// ================================================================ Testimony quote (move C)
// The citation gate is the emotional core: verbatim quote on warm paper, editorial
// serif, with timecode + speaker attribution.

export function TestimonyQuote({
  quote,
  speaker,
  role,
  timecode,
}: {
  quote: string;
  speaker?: string | null;
  role?: string | null;
  timecode?: string | null;
}) {
  const who = [speaker, role].filter(Boolean).join(", ");
  return (
    <blockquote className="quote">
      {quote}
      {(who || timecode) && (
        <span className="by">
          {who && `— ${who}`}
          {who && timecode ? " · " : ""}
          {timecode}
        </span>
      )}
    </blockquote>
  );
}

// ================================================================ Paper reading band (move D)
// Warm paper surface for long-form reading inset into the dark chrome.

export function PaperBand({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={"paper" + (className ? " " + className : "")}>{children}</div>;
}
