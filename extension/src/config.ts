/**
 * Followthrough server location. Defaults to a local dev server; the user can
 * point the extension at a hosted instance from the popup's login screen. The
 * choice lives in chrome.storage.local, and the popup asks Chrome for host
 * permission on that origin when it is saved (manifest optional_host_permissions).
 */
export const DEFAULT_BASE_URL = "http://localhost:4500";

const KEY = "serverUrl";

/** Validates and normalizes user input to a bare origin, e.g. "https://ft.acme.com". */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("Enter a valid server URL, e.g. https://followthrough.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Server URL must start with http:// or https://");
  }
  return url.origin;
}

export async function getBaseUrl(): Promise<string> {
  const obj = await chrome.storage.local.get(KEY);
  const saved = obj[KEY];
  return typeof saved === "string" && saved ? saved : DEFAULT_BASE_URL;
}

export async function setBaseUrl(origin: string): Promise<void> {
  await chrome.storage.local.set({ [KEY]: origin });
}
