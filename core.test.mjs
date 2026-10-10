import test from "node:test";
import assert from "node:assert/strict";
import { parseHar, HarError, filterRequests, groupHosts, compareTraces, redactHar, exportCsv, formatBytes, formatMs } from "./core.mjs";

const makeHar = () => ({ log: { version: "1.2", creator: { name: "test" }, entries: [
  { startedDateTime: "2026-01-01T00:00:00.000Z", time: 180, request: { method: "GET", url: "https://api.example.test/items?apiKey=secret&q=x", headers: [{ name: "Authorization", value: "Bearer topsecret" }, { name: "Accept", value: "application/json" }], cookies: [{ name: "sid", value: "cookie-secret" }], bodySize: 0 }, response: { status: 200, headers: [{ name: "Set-Cookie", value: "sid=private" }, { name: "Content-Type", value: "application/json" }], cookies: [{ name: "sid", value: "response-secret" }], bodySize: 25, content: { mimeType: "application/json", size: 25, text: "private body" } }, timings: { wait: 120, receive: 40, dns: 5, connect: 15 } },
  { startedDateTime: "2026-01-01T00:00:01.000Z", time: 1500, request: { method: "POST", url: "https://cdn.example.test/app.js", bodySize: 12 }, response: { status: 503, bodySize: 100, _transferSize: 160, content: { mimeType: "text/javascript", size: 100 } }, timings: {} },
  { startedDateTime: "2026-01-01T00:00:03.000Z", time: 45, request: { method: "GET", url: "https://api.example.test/health" }, response: { status: 204, bodySize: 0 }, timings: {}, cache: {} }
] } });

test("parses requests, sizes, timings, failures and trace totals", () => {
  const trace = parseHar(makeHar(), { name: "sample.har" });
  assert.equal(trace.name, "sample.har"); assert.equal(trace.stats.count, 3); assert.equal(trace.stats.failures, 1);
  assert.equal(trace.stats.slow, 1); assert.equal(trace.stats.hosts, 2); assert.equal(trace.stats.bytes, 185);
  assert.equal(trace.requests[0].wait, 120); assert.equal(trace.requests[1].status, 503);
});

test("rejects malformed JSON and documents without log.entries", () => {
  assert.throws(() => parseHar("{"), HarError);
  assert.throws(() => parseHar({ log: {} }), /log.entries/);
  assert.throws(() => parseHar(makeHar(), { maxEntries: 2 }), /лимит 2/);
});

test("filters by text/status and sorts slowest, largest or chronological", () => {
  const trace = parseHar(makeHar());
  assert.equal(filterRequests(trace, { query: "cdn" }).length, 1);
  assert.equal(filterRequests(trace, { status: "error" }).length, 1);
  assert.equal(filterRequests(trace, { status: "success" }).length, 2);
  assert.equal(filterRequests(trace, { status: "slow", sort: "slow" })[0].duration, 1500);
  assert.equal(filterRequests(trace, { sort: "size" })[0].transferred, 160);
});

test("groups host counts, traffic, time and failures", () => {
  const [cdn, api] = groupHosts(parseHar(makeHar()));
  assert.equal(cdn.host, "cdn.example.test"); assert.equal(cdn.bytes, 160); assert.equal(cdn.failures, 1);
  assert.equal(api.count, 2); assert.equal(api.ms, 225);
});

test("compares request endpoints and reports latency or error regressions", () => {
  const oldData = makeHar();
  oldData.log.entries[0].response.status = 200;
  const newData = makeHar(); newData.log.entries[0].time = 60; newData.log.entries[0].response.status = 503; newData.log.entries[1].response.status = 200;
  const result = compareTraces(parseHar(oldData), parseHar(newData));
  const api = result.find(row => row.key.includes("/items")); const cdn = result.find(row => row.key.includes("/app.js"));
  assert.equal(api.avgBefore, 180); assert.equal(api.avgAfter, 60); assert.equal(api.regression, true); assert.equal(cdn.regression, false);
});

test("labels added and removed endpoints instead of reporting fake latency percentages", () => {
  const before = parseHar({ log: { entries: [{ time: 20, request: { url: "https://gone.test/a" }, response: { status: 200 } }] } });
  const after = parseHar({ log: { entries: [{ time: 30, request: { url: "https://new.test/b" }, response: { status: 200 } }] } });
  const diff = compareTraces(before, after);
  assert.ok(diff.some(row => row.removed && row.deltaPct === null));
  assert.ok(diff.some(row => row.added && row.deltaPct === null));
});

test("redacts query secrets, auth headers, cookies and bodies without mutating source", () => {
  const trace = parseHar(makeHar());
  const raw = structuredClone(trace.raw);
  raw.log.entries[0].request.url += "#access_token=fragment-secret";
  raw.log.entries[0].request.headers.push({ name: "X-User-Session", value: "private-session" });
  raw.log.entries[0].request.postData = { mimeType: "application/json", text: "private post" };
  raw.log.entries[0].response.redirectURL = "https://auth.test/continue?token=redirect-secret";
  raw.log.entries[0]._webSocketMessages = [{ data: "private socket" }];
  const source = parseHar(raw); const redacted = redactHar(source);
  const req = redacted.log.entries[0].request; const res = redacted.log.entries[0].response;
  assert.match(req.url, /apiKey=%5BREDACTED%5D/); assert.equal(req.headers[0].value, "[REDACTED]");
  assert.equal(req.headers[1].value, "application/json"); assert.deepEqual(req.cookies, []); assert.deepEqual(res.cookies, []);
  assert.equal(req.headers[2].value, "[REDACTED]"); assert.match(req.url, /access_token=%5BREDACTED%5D/);
  assert.equal(res.headers[0].value, "[REDACTED]"); assert.equal(req.postData.text, "[REMOVED]");
  assert.equal(res.content.text, "[REMOVED]"); assert.match(res.redirectURL, /token=%5BREDACTED%5D/);
  assert.deepEqual(redacted.log.entries[0]._webSocketMessages, []); assert.match(source.requests[0].url, /secret/);
});

test("exports quoted UTF-8 CSV with stable columns", () => {
  const csv = exportCsv(parseHar(makeHar()).requests);
  assert.ok(csv.startsWith("\ufeff\"method\",\"status\"")); assert.ok(csv.includes("api.example.test")); assert.ok(csv.includes("\r\n"));
});

test("neutralizes spreadsheet formula cells in CSV exports", () => {
  const csv = exportCsv([{ method: "GET", status: 200, host: "example.test", path: "=HYPERLINK(\"https://bad.test\")", duration: 5, transferred: 0, mime: "text/plain", startedAt: null }]);
  assert.ok(csv.includes("'=HYPERLINK("));
});

test("formats byte sizes and elapsed times", () => {
  assert.equal(formatBytes(0), "0 B"); assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatMs(999), "999 ms"); assert.equal(formatMs(1200), "1.20 s");
});
