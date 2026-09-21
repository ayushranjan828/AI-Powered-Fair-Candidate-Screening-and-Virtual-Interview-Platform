/* Thin fetch wrapper around the interviewer's FastAPI backend.
 *
 * Unlike the screening app this server has no shared-token gate, so there is
 * no retry-on-401 dance here - just JSON in, JSON out, with FastAPI's `detail`
 * unwrapped into the Error message.
 */

export async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
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

/** Excel downloads are plain navigations. */
export const download = (url) => {
  window.location.href = url;
};

/** URL-safe path segment. */
export const seg = (v) => encodeURIComponent(String(v ?? ""));
