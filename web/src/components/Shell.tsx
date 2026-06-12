import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { CommandPalette } from "./CommandPalette";
import { SHORTCUTS, useShortcuts } from "./shortcuts";
import { Modal, Tooltip } from "./ui";

interface NavEntry {
  to: string;
  label: string;
  admin?: boolean;
  end?: boolean;
}

const PIPELINE: NavEntry[] = [
  { to: "/capture", label: "Capture" },
  { to: "/", label: "Review", end: true },
  { to: "/insights", label: "Insights" },
  { to: "/clients", label: "Clients" },
  { to: "/proof", label: "Shipped?" },
];

const ADMIN: NavEntry[] = [
  { to: "/numbers", label: "Numbers", admin: true },
  { to: "/settings", label: "Settings", admin: true },
];

function NavRow({ entry, onNavigate }: { entry: NavEntry; onNavigate: () => void }) {
  return (
    <NavLink
      to={entry.to}
      end={entry.end}
      onClick={onNavigate}
      className={({ isActive }) => (isActive ? "nav active" : "nav")}
    >
      <span className="dot" />
      {entry.label}
    </NavLink>
  );
}

function UserMenu() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  async function logout() {
    try {
      await api.logout();
    } catch {
      // session may already be gone; clear locally regardless
    }
    setUser(null);
    navigate("/login");
  }

  if (!user) return null;
  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="avatar"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Account menu"
        title={user.email}
      >
        {initial}
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <div className="menu-item" aria-disabled="true">
            <span className="mono small">{user.email}</span>
          </div>
          <div className="menu-item" aria-disabled="true">
            <span className="lbl">role {user.role}</span>
          </div>
          <div className="menu-divider" />
          <button className="menu-item" role="menuitem" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function Kbd({ k }: { k: string }) {
  return <span className="kbd">{k}</span>;
}

export function Shell() {
  const { user, isGuest } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const isAdmin = user?.role === "admin";

  useShortcuts({ onHelp: () => setHelpOpen(true) });

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  function openPalette() {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
  }

  return (
    <div className="app">
      <aside className={sidebarOpen ? "side open" : "side"}>
        <div className="brand">
          <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="15" y="4" width="2" height="24" fill="var(--line)" />
            <circle cx="16" cy="16" r="4" fill="var(--signal)" />
          </svg>
          <b>Followthrough</b>
        </div>
        <div className="navlbl">Pipeline</div>
        {PIPELINE.map((e) => (
          <NavRow key={e.to} entry={e} onNavigate={() => setSidebarOpen(false)} />
        ))}
        {isAdmin && (
          <>
            <div className="navlbl">Admin</div>
            {ADMIN.map((e) => (
              <NavRow key={e.to} entry={e} onNavigate={() => setSidebarOpen(false)} />
            ))}
          </>
        )}
        <div className="side-spacer" />
        <button className="nav" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts">
          <span className="dot" />
          Shortcuts
        </button>
      </aside>

      {sidebarOpen && <div className="side-backdrop show" onClick={() => setSidebarOpen(false)} />}

      <div className="main">
        <div className="top">
          <button
            className="hamburger"
            aria-label="Toggle navigation"
            onClick={() => setSidebarOpen((o) => !o)}
          >
            menu
          </button>
          <button
            type="button"
            className="search"
            onClick={openPalette}
            aria-label="Open command palette"
          >
            <span aria-hidden="true">&#8981;</span>
            <span>Search asks, clients, meetings</span>
            <span className="kbd">Cmd K</span>
          </button>
          <div className="right">
            {isGuest ? (
              <>
                <Tooltip content="No login required. Turn login on in Settings to add accounts.">
                  <span className="lbl">Open access</span>
                </Tooltip>
                <button className="btn ghost sm" onClick={() => navigate("/login")}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                <span className="small">{user?.name || user?.email}</span>
                <UserMenu />
              </>
            )}
          </div>
        </div>
        <div className="page-scroll">
          <Outlet />
        </div>
      </div>

      <CommandPalette />

      <Modal
        open={helpOpen}
        title="Keyboard shortcuts"
        onClose={() => setHelpOpen(false)}
        width={620}
        footer={
          <button className="btn ghost" onClick={() => setHelpOpen(false)}>
            Close
          </button>
        }
      >
        <div className="shortcut-grid">
          {SHORTCUTS.map((s) => (
            <div className="shortcut-row" key={s.description}>
              <span className="desc">{s.description}</span>
              <span className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <Kbd key={i} k={k} />
                ))}
              </span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
