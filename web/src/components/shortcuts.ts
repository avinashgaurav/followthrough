import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// Global keyboard shortcuts. Vim-style g-prefix jumps to each section,
// '?' opens the cheatsheet, ctrl/cmd-K opens the command palette (handled there).

export interface ShortcutDef {
  keys: string[];
  description: string;
}

/** g-then-<key> destinations, in nav order. */
export const GO_TARGETS: Record<string, string> = {
  c: "/capture",
  r: "/",
  i: "/insights",
  l: "/clients",
  p: "/proof",
  n: "/numbers",
  s: "/settings",
};

/** Everything shown in the '?' cheatsheet. */
export const SHORTCUTS: ShortcutDef[] = [
  { keys: ["Cmd/Ctrl", "K"], description: "Open the command palette" },
  { keys: ["?"], description: "Show this shortcuts list" },
  { keys: ["Esc"], description: "Close any open panel" },
  { keys: ["g", "c"], description: "Go to Capture" },
  { keys: ["g", "r"], description: "Go to Review" },
  { keys: ["g", "i"], description: "Go to Insights" },
  { keys: ["g", "l"], description: "Go to Clients" },
  { keys: ["g", "p"], description: "Go to Proof" },
  { keys: ["g", "n"], description: "Go to Numbers" },
  { keys: ["g", "s"], description: "Go to Settings" },
  { keys: ["j"], description: "In a list: move selection down" },
  { keys: ["k"], description: "In a list: move selection up" },
  { keys: ["Enter"], description: "In a list: open the selected item" },
];

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** True when the cmd/ctrl-K palette chord is pressed. */
export function isPaletteChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
}

/**
 * Mounts the global handlers: '?' opens the cheatsheet, g-prefix navigation.
 * Skips all of it while typing in a field. Palette chord is handled in CommandPalette.
 */
export function useShortcuts(opts: { onHelp: () => void; enabled?: boolean }): void {
  const navigate = useNavigate();
  const lastG = useRef(0);
  const onHelp = opts.onHelp;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        onHelp();
        return;
      }

      const now = Date.now();
      if (e.key === "g") {
        lastG.current = now;
        return;
      }
      if (now - lastG.current < 800 && GO_TARGETS[e.key]) {
        lastG.current = 0;
        navigate(GO_TARGETS[e.key]!);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, onHelp, enabled]);
}

/**
 * List-selection helper for Review/Insights. j/k move within [0, count), Enter opens.
 * Disabled while typing. Returns the current index and a setter for click-driven selection.
 */
export function useListSelection(
  count: number,
  onOpen: (index: number) => void,
  enabled = true,
): { index: number; setIndex: (i: number) => void } {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index > count - 1) setIndex(Math.max(0, count - 1));
  }, [count, index]);

  const open = useCallback(() => onOpen(index), [onOpen, index]);

  useEffect(() => {
    if (!enabled || count === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "j") {
        e.preventDefault();
        setIndex((i) => Math.min(count - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, enabled, open]);

  return { index, setIndex };
}
