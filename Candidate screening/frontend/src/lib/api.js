/* Thin fetch wrapper around the FastAPI backend.
 *
 * The server can be gated by APP_ACCESS_TOKEN (see backend/config.py). When it
 * is, every /api/* call must carry the token. We remember it in localStorage
 * and let the first 401 ask for it, then retry that one request.
 */

const TOKEN_KEY = "screeningAccessToken";

export function authToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // private mode / storage disabled
  }
}

export function setAuthToken(value) {
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* nothing we can do; the in-flight retry still works */
  }
}

/** Excel download links are plain navigations and cannot set headers. */
export function withToken(url) {
  const t = authToken();
  if (!t) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

/** Asks for the token once even if several 401s land at the same time. */
let pendingPrompt = null;

function promptForToken() {
  if (!pendingPrompt) {
    pendingPrompt = Promise.resolve().then(() => {
      const value = window.prompt(
        "This server requires an access token (APP_ACCESS_TOKEN in .env):",
      );
      const trimmed = (value || "").trim();
      if (trimmed) setAuthToken(trimmed);
      // Let concurrent callers share this answer, but ask again on a later 401.
      setTimeout(() => {
        pendingPrompt = null;
      }, 0);
      return trimmed;
    });
  }
  return pendingPrompt;
}

export async function api(path, opts = {}) {
  const send = () => {
    const headers = { ...(opts.headers || {}) };
    const t = authToken();
    if (t) headers["X-Access-Token"] = t;
    return fetch(path, { ...opts, headers });
  };

  let res = await send();
  if (res.status === 401) {
    const token = await promptForToken();
    if (token) res = await send();
  }

  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    // FastAPI's `detail` is sometimes a validation array, not a string.
    const detail = body && body.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : detail
          ? JSON.stringify(detail)
          : res.statusText || `HTTP ${res.status}`,
    );
  }
  return body;
}

export const getJson = (path) => api(path);

export const postJson = (path, payload) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

export const putJson = (path, payload) =>
  api(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

export const del = (path) => api(path, { method: "DELETE" });

/** Navigates the browser to a download URL with the token appended. */
export function download(url) {
  window.location.href = withToken(url);
}
