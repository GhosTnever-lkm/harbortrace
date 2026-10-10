export class HarError extends Error {}

const SECRET_KEY = /(^|[-_])(authorization|proxy-authorization|cookie|set-cookie|token|api[-_]?key|apikey|secret|password|passwd|session|auth|signature|sig)([-_]|$)/i;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

function asArray(value) { return Array.isArray(value) ? value : []; }
function finite(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function urlParts(raw) {
  try { const u = new URL(raw); return { url: u, host: u.host, path: u.pathname || "/" }; }
  catch { return { url: null, host: "(invalid URL)", path: String(raw || "") }; }
}
function headerValue(headers, name) {
  return asArray(headers).find(h => String(h?.name || "").toLowerCase() === name)?.value || "";
}

export function parseHar(input, { name = "Trace", maxEntries = 200_000 } = {}) {
  let data;
  try { data = typeof input === "string" ? JSON.parse(input) : input; }
  catch (error) { throw new HarError(`Не удалось прочитать JSON: ${error.message}`); }
  const entries = data?.log?.entries;
  if (!Array.isArray(entries)) throw new HarError("Это не HAR: отсутствует массив log.entries.");
  if (entries.length > maxEntries) throw new HarError(`В HAR слишком много запросов (${entries.length}); лимит ${maxEntries}.`);
  const requests = entries.map((entry, index) => {
    const request = entry?.request || {};
    const response = entry?.response || {};
    const parts = urlParts(request.url);
    const started = Date.parse(entry?.startedDateTime);
    const timings = entry?.timings || {};
    const sizes = entry?._resourceSize || {};
    return {
      id: `${name}-${index}`,
      index,
      startedAt: Number.isFinite(started) ? started : null,
      method: String(request.method || "GET").toUpperCase(),
      url: String(request.url || ""),
      host: parts.host,
      path: parts.path,
      status: Math.max(0, Math.trunc(finite(response.status))),
      statusText: String(response.statusText || ""),
      mime: String(response.content?.mimeType || headerValue(response.headers, "content-type")).split(";")[0],
      duration: finite(entry?.time),
      wait: finite(timings.wait),
      receive: finite(timings.receive),
      dns: finite(timings.dns),
      connect: finite(timings.connect),
      send: finite(timings.send),
      transferred: finite(response._transferSize ?? response.bodySize ?? sizes.transferSize ?? entry?._transferSize),
      bodySize: finite(response.bodySize),
      requestSize: finite(request.bodySize),
      cache: Boolean(entry?.cache && Object.keys(entry.cache).length),
      redirectURL: String(response.redirectURL || ""),
      error: response.status === 0 || response.status >= 400,
      raw: entry
    };
  });
  const starts = requests.map(r => r.startedAt).filter(Number.isFinite);
  const totalTime = requests.reduce((sum, r) => sum + r.duration, 0);
  const totalBytes = requests.reduce((sum, r) => sum + r.transferred, 0);
  return {
    name: String(name),
    raw: data,
    version: String(data.log.version || "1.2"),
    creator: String(data.log.creator?.name || ""),
    requests,
    stats: {
      count: requests.length,
      failures: requests.filter(r => r.error).length,
      slow: requests.filter(r => r.duration >= 1000).length,
      totalMs: totalTime,
      wallMs: starts.length > 1 ? Math.max(...starts) - Math.min(...starts) + Math.max(...requests.map(r => r.duration)) : totalTime,
      bytes: totalBytes,
      hosts: new Set(requests.map(r => r.host)).size,
      cached: requests.filter(r => r.cache).length,
      averageMs: requests.length ? totalTime / requests.length : 0
    }
  };
}

export function filterRequests(trace, { query = "", status = "all", sort = "time" } = {}) {
  const q = query.trim().toLowerCase();
  const rows = trace.requests.filter(r => {
    const matches = !q || `${r.method} ${r.url} ${r.host} ${r.mime}`.toLowerCase().includes(q);
    const statusMatch = status === "all" || (status === "error" ? r.error : status === "slow" ? r.duration >= 1000 : status === "success" ? r.status >= 200 && r.status < 400 : String(r.status) === status);
    return matches && statusMatch;
  });
  const sorters = {
    time: (a, b) => (a.startedAt ?? a.index) - (b.startedAt ?? b.index),
    slow: (a, b) => b.duration - a.duration,
    size: (a, b) => b.transferred - a.transferred,
    status: (a, b) => a.status - b.status
  };
  return rows.sort(sorters[sort] || sorters.time);
}

export function groupHosts(trace) {
  const map = new Map();
  for (const r of trace.requests) {
    const row = map.get(r.host) || { host: r.host, count: 0, bytes: 0, ms: 0, failures: 0 };
    row.count++; row.bytes += r.transferred; row.ms += r.duration; row.failures += Number(r.error);
    map.set(r.host, row);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

export function compareTraces(base, next, { thresholdPct = 20 } = {}) {
  const key = r => `${r.method} ${r.host}${r.path}`;
  const aggregate = trace => {
    const map = new Map();
    for (const r of trace.requests) {
      const k = key(r); const v = map.get(k) || { key: k, count: 0, ms: 0, bytes: 0, errors: 0 };
      v.count++; v.ms += r.duration; v.bytes += r.transferred; v.errors += Number(r.error); map.set(k, v);
    }
    return map;
  };
  const a = aggregate(base); const b = aggregate(next);
  return [...new Set([...a.keys(), ...b.keys()])].map(key => {
    const before = a.get(key) || { key, count: 0, ms: 0, bytes: 0, errors: 0 };
    const after = b.get(key) || { key, count: 0, ms: 0, bytes: 0, errors: 0 };
    const avgBefore = before.count ? before.ms / before.count : 0;
    const avgAfter = after.count ? after.ms / after.count : 0;
    const added = !before.count && !!after.count;
    const removed = !!before.count && !after.count;
    const deltaPct = added || removed ? null : avgBefore ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;
    return { key, before, after, avgBefore, avgAfter, deltaPct, added, removed, regression: (!added && !removed && deltaPct >= thresholdPct) || after.errors > before.errors };
  }).sort((x, y) => (y.deltaPct ?? -Infinity) - (x.deltaPct ?? -Infinity));
}

export function redactHar(trace, { maskQuery = true, removeSensitiveHeaders = true, removeCookies = true, removePostData = true } = {}) {
  const clone = structuredClone(trace.raw);
  const maskHeaders = headers => asArray(headers).map(h => {
    const out = { ...h };
    if (removeSensitiveHeaders && SENSITIVE_HEADER.test(String(h?.name || ""))) out.value = "[REDACTED]";
    return out;
  });
  for (const entry of asArray(clone.log?.entries)) {
    const req = entry.request || {}; const res = entry.response || {};
    if (maskQuery && typeof req.url === "string") {
      try {
        const url = new URL(req.url);
        for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
        req.url = url.toString();
      } catch {}
    }
    if (removeSensitiveHeaders) { req.headers = maskHeaders(req.headers); res.headers = maskHeaders(res.headers); }
    if (removeCookies) { req.cookies = []; res.cookies = []; }
    if (removePostData && req.postData) { req.postData = { mimeType: req.postData.mimeType || "", text: "[REMOVED]" }; }
    if (res.content?.text) res.content = { ...res.content, text: "[REMOVED]" };
  }
  return clone;
}

export function exportCsv(requests) {
  const quote = value => {
    const cell = String(value ?? "");
    const safe = /^[\s\t]*[=+@-]/.test(cell) ? `'${cell}` : cell;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = [["method","status","host","path","duration_ms","transferred_bytes","mime","started_at"], ...requests.map(r => [r.method,r.status,r.host,r.path,Math.round(r.duration),Math.round(r.transferred),r.mime,r.startedAt ? new Date(r.startedAt).toISOString() : ""])];
  return "\ufeff" + rows.map(row => row.map(quote).join(",")).join("\r\n");
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
export function formatMs(ms) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`; }
