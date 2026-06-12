/**
 * Popup UI: login (email + code) then the recorder form.
 * Plain TS, no framework. The service worker owns recording state; the
 * popup renders it and polls while a recording or upload is in flight.
 */
import { BASE_URL, MEETINGS_PAGE_URL } from "./config.ts";
import type { Ack, RecState } from "./types.ts";

interface Client {
  id: string;
  name: string;
}

const root = document.getElementById("root") as HTMLElement;

let clients: Client[] = [];
let state: RecState = { phase: "idle" };
let lastEmail = "";
let formClientId = "";
let formTitle = "";
let formConsent = false;
let pollTimer: number | null = null;
let tickTimer: number | null = null;

// ─── helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function defaultTitle(): string {
  return `Client call ${todayIso()}`;
}

function elapsedLabel(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function send(msg: unknown): Promise<Ack> {
  return (await chrome.runtime.sendMessage(msg)) as Ack;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { ...init, credentials: "include" });
}

function stopTimers(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
}

function startPoll(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(async () => {
    try {
      const ack = await send({ target: "background", type: "GET_STATE" });
      if (ack.ok && ack.state) {
        const prevPhase = state.phase;
        state = ack.state;
        if (state.phase !== prevPhase) renderMain();
      }
    } catch {
      // SW briefly unavailable; keep polling
    }
  }, 600);
}

function startTick(): void {
  if (tickTimer !== null) return;
  tickTimer = window.setInterval(() => {
    const el = document.getElementById("elapsed");
    if (el && state.startedAt) el.textContent = elapsedLabel(state.startedAt);
  }, 250);
}

// ─── auth ──────────────────────────────────────────────────────────────────

async function isLoggedIn(): Promise<boolean> {
  const obj = await chrome.storage.local.get("auth");
  const auth = obj["auth"] as { loggedIn?: boolean; email?: string } | undefined;
  if (auth?.email) lastEmail = auth.email;
  return auth?.loggedIn === true;
}

async function doLogin(email: string, code: string): Promise<void> {
  let res: Response;
  try {
    res = await api("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
  } catch {
    throw new Error(`Cannot reach the server at ${BASE_URL}. Start it with: bun run dev`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Login failed (${res.status}).`);
  }
  const body = (await res.json()) as { userId: string; role: string };

  // Verify the session cookie actually sticks for extension-originated
  // requests before declaring success.
  const me = await api("/api/me");
  if (me.status === 401) {
    throw new Error(
      "Login succeeded but the session cookie was not accepted on the follow-up request. Check the server is on " +
        BASE_URL +
        " and try again.",
    );
  }
  // Login state flag only. The login code is never stored.
  await chrome.storage.local.set({
    auth: { loggedIn: true, userId: body.userId, role: body.role, email },
  });
  lastEmail = email;
}

async function doLogout(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // server unreachable; clear local state anyway
  }
  await chrome.storage.local.remove("auth");
}

/** Returns null when the session is gone (401). */
async function loadClients(): Promise<Client[] | null> {
  let res: Response;
  try {
    res = await api("/api/clients");
  } catch {
    throw new Error(`Cannot reach the server at ${BASE_URL}. Start it with: bun run dev`);
  }
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Failed to load clients (${res.status}).`);
  const body = (await res.json().catch(() => null)) as { clients?: Client[] } | null;
  return body?.clients ?? [];
}

// ─── views ─────────────────────────────────────────────────────────────────

function renderLoading(): void {
  stopTimers();
  root.innerHTML = `<div class="view"><p class="hint">Loading...</p></div>`;
}

function renderFatal(message: string): void {
  stopTimers();
  root.innerHTML = `
    <div class="view">
      <p class="error">${esc(message)}</p>
      <button id="fatal-retry" class="btn btn-ghost">Retry</button>
    </div>`;
  document.getElementById("fatal-retry")?.addEventListener("click", () => void init());
}

function renderLogin(error?: string): void {
  stopTimers();
  root.innerHTML = `
    <form id="login-form" class="view">
      <p class="hint">Log in with your Followthrough email and login code.</p>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" required value="${esc(lastEmail)}" placeholder="you@xyz.com" />
      <label for="code">Login code</label>
      <input id="code" type="password" required minlength="4" placeholder="code from your admin" />
      <p id="login-error" class="error${error ? "" : " hidden"}">${esc(error ?? "")}</p>
      <button id="login-btn" type="submit" class="btn btn-accent">Log in</button>
      <p class="hint dim">Server: ${esc(BASE_URL)}</p>
    </form>`;

  const form = document.getElementById("login-form") as HTMLFormElement;
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      const email = (document.getElementById("email") as HTMLInputElement).value.trim();
      const code = (document.getElementById("code") as HTMLInputElement).value;
      const btn = document.getElementById("login-btn") as HTMLButtonElement;
      const errEl = document.getElementById("login-error") as HTMLElement;
      btn.disabled = true;
      btn.textContent = "Checking...";
      try {
        await doLogin(email, code);
        await init();
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : String(err);
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Log in";
      }
    })();
  });
}

function renderMain(): void {
  stopTimers();
  switch (state.phase) {
    case "idle":
      renderIdle();
      break;
    case "recording":
      renderRecording();
      startTick();
      startPoll();
      break;
    case "uploading":
      renderUploading();
      startPoll();
      break;
    case "done":
      renderDone();
      break;
    case "error":
      renderRecError();
      break;
  }
}

function renderIdle(): void {
  if (clients.length === 0) {
    root.innerHTML = `
      <div class="view">
        <p class="hint">No clients yet. Create one in the web app first.</p>
        <a class="link" href="${esc(BASE_URL)}" target="_blank" rel="noreferrer">Open Followthrough</a>
        <button id="logout" class="btn btn-ghost">Log out</button>
      </div>`;
    wireLogout();
    return;
  }

  const options = clients
    .map(
      (c) =>
        `<option value="${esc(c.id)}"${c.id === formClientId ? " selected" : ""}>${esc(c.name)}</option>`,
    )
    .join("");

  root.innerHTML = `
    <div class="view">
      <label for="client">Client</label>
      <select id="client">${options}</select>
      <label for="title">Meeting title</label>
      <input id="title" type="text" maxlength="200" value="${esc(formTitle || defaultTitle())}" />
      <label class="consent">
        <input id="consent" type="checkbox"${formConsent ? " checked" : ""} />
        <span>Everyone on this call has been informed it is recorded</span>
      </label>
      <p id="start-error" class="error hidden"></p>
      <button id="record" class="btn btn-record" disabled>
        <span class="rec-dot"></span>Start recording
      </button>
      <p class="hint dim">Records the audio of the current tab.</p>
      <button id="logout" class="btn btn-ghost">Log out</button>
    </div>`;

  const clientSel = document.getElementById("client") as HTMLSelectElement;
  const titleInput = document.getElementById("title") as HTMLInputElement;
  const consentBox = document.getElementById("consent") as HTMLInputElement;
  const recordBtn = document.getElementById("record") as HTMLButtonElement;
  const startError = document.getElementById("start-error") as HTMLElement;

  if (!formClientId && clients[0]) formClientId = clients[0].id;
  clientSel.value = formClientId;

  const sync = (): void => {
    formClientId = clientSel.value;
    formTitle = titleInput.value;
    formConsent = consentBox.checked;
    recordBtn.disabled = !(formConsent && formClientId);
  };
  clientSel.addEventListener("change", sync);
  titleInput.addEventListener("input", sync);
  consentBox.addEventListener("change", sync);
  sync();

  recordBtn.addEventListener("click", () => {
    void (async () => {
      sync();
      const clientName = clients.find((c) => c.id === formClientId)?.name ?? formClientId;
      recordBtn.disabled = true;
      recordBtn.textContent = "Starting...";
      try {
        const ack = await send({
          target: "background",
          type: "START_RECORDING",
          payload: { clientId: formClientId, clientName, title: formTitle.trim() || defaultTitle() },
        });
        if (ack.ok && ack.state) {
          state = ack.state;
          renderMain();
        } else {
          throw new Error(ack.error ?? "Could not start recording.");
        }
      } catch (err) {
        startError.textContent = err instanceof Error ? err.message : String(err);
        startError.classList.remove("hidden");
        renderIdleButtonReset(recordBtn);
      }
    })();
  });

  wireLogout();
}

function renderIdleButtonReset(btn: HTMLButtonElement): void {
  btn.disabled = !(formConsent && formClientId);
  btn.innerHTML = `<span class="rec-dot"></span>Start recording`;
}

function wireLogout(): void {
  document.getElementById("logout")?.addEventListener("click", () => {
    void (async () => {
      await doLogout();
      renderLogin();
    })();
  });
}

function renderRecording(): void {
  const started = state.startedAt ?? Date.now();
  root.innerHTML = `
    <div class="view">
      <div class="status-panel recording">
        <div class="rec-row">
          <span class="rec-dot live"></span>
          <span class="status-label">Recording</span>
          <span id="elapsed" class="elapsed">${elapsedLabel(started)}</span>
        </div>
        <p class="meta">${esc(state.clientName ?? "")} / ${esc(state.title ?? "")}</p>
      </div>
      <button id="stop" class="btn btn-accent">Stop and upload</button>
      <p class="hint dim">You can close this popup; the recording continues.</p>
    </div>`;

  document.getElementById("stop")?.addEventListener("click", () => {
    void (async () => {
      const btn = document.getElementById("stop") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Stopping...";
      await send({ target: "background", type: "STOP_RECORDING" }).catch(() => undefined);
      state = { ...state, phase: "uploading" };
      renderMain();
    })();
  });
}

function renderUploading(): void {
  root.innerHTML = `
    <div class="view">
      <div class="status-panel">
        <span class="status-label">Uploading</span>
        <p class="meta">Sending the recording to Followthrough...</p>
      </div>
    </div>`;
}

function renderDone(): void {
  const dupNote = state.duplicate
    ? `<p class="hint">This exact recording was uploaded before. It is linked to the existing meeting, nothing was duplicated.</p>`
    : "";
  root.innerHTML = `
    <div class="view">
      <div class="status-panel done">
        <span class="status-label ok">Uploaded</span>
        <p class="meta">Meeting <span class="mono">${esc(state.meetingId ?? "unknown")}</span></p>
        ${dupNote}
      </div>
      <a class="btn btn-accent center" href="${esc(MEETINGS_PAGE_URL)}" target="_blank" rel="noreferrer">Open Followthrough</a>
      <button id="again" class="btn btn-ghost">Record another</button>
    </div>`;

  document.getElementById("again")?.addEventListener("click", () => {
    void (async () => {
      await send({ target: "background", type: "RESET" }).catch(() => undefined);
      state = { phase: "idle" };
      formConsent = false;
      formTitle = "";
      renderMain();
    })();
  });
}

function renderRecError(): void {
  const retryBtn = state.canRetry
    ? `<button id="retry" class="btn btn-accent">Retry upload</button>`
    : "";
  root.innerHTML = `
    <div class="view">
      <div class="status-panel">
        <span class="status-label err">Error</span>
        <p class="error">${esc(state.error ?? "Something went wrong.")}</p>
      </div>
      ${retryBtn}
      <button id="discard" class="btn btn-ghost">Discard</button>
    </div>`;

  document.getElementById("retry")?.addEventListener("click", () => {
    void (async () => {
      await send({ target: "background", type: "RETRY_UPLOAD" }).catch(() => undefined);
      state = { ...state, phase: "uploading" };
      renderMain();
    })();
  });
  document.getElementById("discard")?.addEventListener("click", () => {
    void (async () => {
      await send({ target: "background", type: "RESET" }).catch(() => undefined);
      state = { phase: "idle" };
      renderMain();
    })();
  });
}

// ─── init ──────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  renderLoading();

  try {
    const ack = await send({ target: "background", type: "GET_STATE" });
    if (ack.ok && ack.state) state = ack.state;
  } catch {
    // SW not ready yet; assume idle
  }

  if (!(await isLoggedIn())) {
    renderLogin();
    return;
  }

  try {
    const list = await loadClients();
    if (list === null) {
      await chrome.storage.local.remove("auth");
      renderLogin("Session expired. Log in again.");
      return;
    }
    clients = list;
  } catch (err) {
    // Server unreachable. A live recording can still be controlled.
    if (state.phase === "idle") {
      renderFatal(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (!formClientId && clients[0]) formClientId = clients[0].id;
  renderMain();
}

void init();
