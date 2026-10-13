import { parseHar, filterRequests, groupHosts, compareTraces, redactHar, exportCsv, formatBytes, formatMs } from "./core.mjs";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const state = { traces: [], current: null, rows: [], toastTimer: 0 };
const palette = { ok: "#5fd2a4", warn: "#f4b75d", bad: "#ff7d87", blue: "#7da7ff" };

function toast(message, error = false) {
  const el = $("toast"); el.textContent = message; el.classList.toggle("toast-error", error); el.classList.add("shown");
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove("shown"), 3600);
}
function requestWord(count) {
  const n = Math.abs(count) % 100; const last = n % 10;
  if (n > 10 && n < 20) return "запросов";
  if (last === 1) return "запрос";
  if (last >= 2 && last <= 4) return "запроса";
  return "запросов";
}
function hostWord(count) {
  if (count % 10 === 1 && count % 100 !== 11) return "домен";
  if ([2,3,4].includes(count % 10) && !(count % 100 >= 12 && count % 100 <= 14)) return "домена";
  return "доменов";
}
function setTrace(trace) {
  state.current = trace; $("welcome").hidden = true; $("workspace").hidden = false;
  $("traceName").textContent = trace.name; $("traceMeta").textContent = `HAR ${trace.version} · ${trace.stats.count.toLocaleString()} ${requestWord(trace.stats.count)}${trace.creator ? ` · ${trace.creator}` : ""}`;
  $("compareButton").disabled = state.traces.length < 2; $("secondTraceNote").hidden = state.traces.length < 2;
  renderSummary(); renderRequests(); renderHosts();
}
function renderSummary() {
  const s = state.current.stats;
  const cards = [
    ["Всего запросов", s.count.toLocaleString(), `${s.hosts} ${hostWord(s.hosts)}`, "↗", "blue"],
    ["Ошибки", s.failures.toLocaleString(), s.count ? `${Math.round(s.failures / s.count * 100)}% всех запросов` : "нет запросов", "!", s.failures ? "bad" : "ok"],
    ["Передано", formatBytes(s.bytes), `суммарно ${formatMs(s.totalMs)}`, "⇅", "blue"],
    ["Медленные", s.slow.toLocaleString(), "дольше 1 секунды", "◷", s.slow ? "warn" : "ok"],
    ["Средний ответ", formatMs(s.averageMs), `в окне ${formatMs(s.wallMs)}`, "⌁", "blue"]
  ];
  $("summaryGrid").innerHTML = cards.map(([label,value,sub,icon,color]) => `<article class="metric-card"><span class="metric-icon ${color}">${icon}</span><div><span class="metric-label">${label}</span><strong>${value}</strong><small>${sub}</small></div></article>`).join("");
}
function statusClass(r) { return r.status >= 500 || r.status === 0 ? "bad" : r.status >= 400 ? "warn" : r.status >= 200 ? "ok" : "neutral"; }
function renderRequests() {
  const rows = filterRequests(state.current, { query: $("searchInput").value, status: $("statusFilter").value, sort: $("sortSelect").value });
  state.rows = rows; $("requestCount").textContent = rows.length.toLocaleString(); $("visibleCount").textContent = rows.length.toLocaleString(); $("totalCount").textContent = state.current.requests.length.toLocaleString();
  $("emptyFiltered").hidden = rows.length > 0;
  const maxDuration = Math.max(1, state.current.requests.reduce((max, r) => Math.max(max, r.duration), 0));
  const minStart = state.current.requests.reduce((min, r) => Math.min(min, r.startedAt ?? 0), Infinity);
  $("requestList").innerHTML = rows.slice(0, 2500).map((r, index) => {
    const start = r.startedAt === null ? 0 : Math.max(0, r.startedAt - minStart);
    const maxStart = Math.max(1, state.current.stats.wallMs - maxDuration);
    const left = Math.min(92, start / maxStart * 100);
    const width = Math.max(1.2, Math.min(100 - left, r.duration / maxDuration * 100));
    const status = r.status || "ERR"; const cls = statusClass(r); const methodClass = r.method === "GET" ? "get" : r.method === "POST" ? "post" : "other";
    return `<button class="request-row" data-row="${r.index}" aria-label="Подробности ${esc(r.method)} ${esc(r.path)}, статус ${status}, ${formatMs(r.duration)}"><span class="request-primary"><span class="method ${methodClass}">${esc(r.method)}</span><span class="request-route"><strong>${esc(r.path || "/")}</strong><small>${esc(r.host)}</small></span></span><span><b class="status-pill ${cls}">${esc(status)}</b></span><span class="waterfall-track"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${r.error ? palette.bad : r.duration >= 1000 ? palette.warn : palette.blue}"></i></span><span class="numeric">${formatMs(r.duration)}</span><span class="numeric">${formatBytes(r.transferred)}</span></button>`;
  }).join("");
  if (rows.length > 2500) $("requestList").insertAdjacentHTML("beforeend", `<p class="list-cap">Показаны первые 2 500 результатов. Уточни фильтр для остальной части списка.</p>`);
  $("requestList").querySelectorAll(".request-row").forEach(button => button.addEventListener("click", () => showDetails(state.current.requests[Number(button.dataset.row)])));
}
function renderHosts() {
  const hosts = groupHosts(state.current); const maxBytes = Math.max(1, hosts.reduce((max, h) => Math.max(max, h.bytes), 0));
  $("hostList").innerHTML = hosts.slice(0, 14).map((h, i) => `<div class="host-row"><div class="host-top"><span class="host-index">${String(i+1).padStart(2,"0")}</span><strong title="${esc(h.host)}">${esc(h.host)}</strong><span>${h.count}</span></div><div class="host-meter"><i style="width:${Math.max(2,h.bytes/maxBytes*100).toFixed(1)}%"></i></div><div class="host-meta"><span>${formatBytes(h.bytes)}</span><span>${h.failures ? `<b class="host-errors">${h.failures} errors</b>` : `${formatMs(h.ms)} total`}</span></div></div>`).join("") || `<p class="muted">Нет доменов в трассе.</p>`;
}
function showDetails(r) {
  const entry = r.raw; const req = entry.request || {}; const res = entry.response || {};
  const headers = (list, type) => `<div class="detail-section"><h3>${type}</h3>${(Array.isArray(list) ? list : []).map(h => `<div class="detail-pair"><span>${esc(h.name)}</span><code>${esc(h.value)}</code></div>`).join("") || `<p class="muted">Нет заголовков</p>`}</div>`;
  $("detailTitle").textContent = `${r.method} ${r.path}`;
  $("detailBody").innerHTML = `<p class="detail-url">${esc(r.url)}</p><div class="detail-chips"><span class="status-pill ${statusClass(r)}">${r.status || "ERR"} ${esc(r.statusText)}</span><span>${formatMs(r.duration)}</span><span>${formatBytes(r.transferred)}</span><span>${esc(r.mime || "unknown type")}</span></div><div class="timing-grid">${[["Queue/block","blocked"],["DNS","dns"],["Connect","connect"],["Send","send"],["Wait / TTFB","wait"],["Receive","receive"]].map(([label,key]) => `<div><small>${label}</small><strong>${formatMs(Number(entry.timings?.[key]) > 0 ? entry.timings[key] : 0)}</strong></div>`).join("")}</div><div class="detail-columns">${headers(req.headers,"Request headers")}${headers(res.headers,"Response headers")}</div><details class="raw-entry"><summary>Исходная запись HAR</summary><pre>${esc(JSON.stringify(entry,null,2))}</pre></details>`;
  $("detailDialog").showModal();
}
function compare() {
  const [base, next] = state.traces.slice(-2); if (!base || !next) return;
  const diff = compareTraces(base,next); const regressions = diff.filter(r => r.regression).length;
  $("compareSummary").innerHTML = `<span>${esc(base.name)} <b>→</b> ${esc(next.name)}</span><strong>${regressions} <small>${regressions === 1 ? "изменение требует внимания" : "изменений требуют внимания"}</small></strong><span>${diff.length} endpoint-групп</span>`;
  $("compareRows").innerHTML = diff.slice(0,100).map(row => `<tr class="${row.regression ? "regression" : ""}"><td><code>${esc(row.key)}</code>${row.after.errors > row.before.errors ? `<small>Ошибок: ${row.before.errors} → ${row.after.errors}</small>` : ""}</td><td>${row.before.count ? `${formatMs(row.avgBefore)} <small>· ${row.before.count} шт.</small>` : row.added ? "—" : "Удалён"}</td><td>${row.after.count ? `${formatMs(row.avgAfter)} <small>· ${row.after.count} шт.</small>` : row.removed ? "—" : "Добавлен"}</td><td class="delta ${row.regression ? "negative" : row.deltaPct < 0 ? "positive" : ""}">${row.added ? "Добавлен" : row.removed ? "Удалён" : `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%`}</td></tr>`).join("") || `<tr><td colspan="4">Нет запросов для сравнения.</td></tr>`;
  $("comparePanel").hidden = false; $("comparePanel").scrollIntoView({ behavior:"smooth", block:"start" });
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeName(name, suffix) { return `${name.replace(/\.[^.]+$/,"").replace(/[^a-z0-9-_]+/gi,"-").replace(/^-|-$/g,"").slice(0,60) || "har-trace"}-${suffix}`; }
async function importFiles(files) {
  const list = [...files]; if (!list.length) return;
  for (const file of list) {
    if (file.size > 100 * 1024 * 1024) { toast(`${file.name}: файл больше 100 MB.`,true); continue; }
    try {
      const text = await file.text(); const trace = parseHar(text,{name:file.name});
      if (state.current && state.current !== trace) state.traces = [...state.traces.slice(-1), state.current];
      else if (!state.current) state.traces = [];
      state.traces = [...state.traces.filter(t => t.name !== trace.name),trace].slice(-2);
      setTrace(trace); toast(`Загружено ${trace.stats.count.toLocaleString()} запросов из ${file.name}.`);
    } catch (error) { toast(`${file.name}: ${error.message}`,true); }
  }
}
function loadSample() {
  const entries = [
    ["GET","https://shop.example.test/",200,46,0,"text/html"], ["GET","https://shop.example.test/assets/app.js",200,845,315000,"application/javascript"],
    ["GET","https://shop.example.test/assets/app.css",200,172,48000,"text/css"], ["GET","https://api.example.test/v1/products",200,1250,84000,"application/json"],
    ["GET","https://images.example-cdn.test/hero.webp",200,620,420000,"image/webp"], ["GET","https://api.example.test/v1/recommendations",503,1800,900,"application/json"],
    ["GET","https://fonts.example-cdn.test/inter.woff2",200,340,78000,"font/woff2"], ["POST","https://analytics.example.test/collect",204,90,300,"application/json"],
    ["GET","https://api.example.test/v1/cart",200,680,4200,"application/json"], ["GET","https://images.example-cdn.test/item-01.webp",200,410,124000,"image/webp"]
  ];
  const data={log:{version:"1.2",creator:{name:"HarborTrace demo"},entries:entries.map(([method,url,status,time,bytes,mime],i)=>({startedDateTime:new Date(Date.now()+i*90).toISOString(),time,request:{method,url,headers:[],cookies:[],bodySize:0},response:{status,statusText:status===503?"Service Unavailable":"OK",headers:[{name:"content-type",value:mime}],cookies:[],bodySize:bytes,_transferSize:bytes+180,content:{mimeType:mime,size:bytes}},timings:{blocked:12,dns:i===0?8:0,connect:i===0?20:0,send:3,wait:Math.round(time*.65),receive:Math.round(time*.35)}}))}};
  const trace=parseHar(data,{name:"Sample · shop-home.har"}); state.traces=[]; setTrace(trace); toast("Пример загружен. Попробуй поискать ошибки или медленные запросы.");
}

$("openFiles").addEventListener("click",()=>$ ("fileInput").click());
$("chooseFiles").addEventListener("click",()=>$ ("fileInput").click());
$("fileInput").addEventListener("change",e=>{ importFiles(e.target.files); e.target.value=""; });
$("loadSample").addEventListener("click",loadSample);
$("searchInput").addEventListener("input",renderRequests); $("statusFilter").addEventListener("change",renderRequests); $("sortSelect").addEventListener("change",renderRequests);
$("compareButton").addEventListener("click",compare); $("closeCompare").addEventListener("click",()=>$("comparePanel").hidden=true);
$("clearTrace").addEventListener("click",()=>{state.traces=[];state.current=null;$("workspace").hidden=true;$("welcome").hidden=false;$("comparePanel").hidden=true;$("searchInput").value="";toast("Трассы удалены из памяти вкладки.");});
$("exportSafe").addEventListener("click",()=>{const safe=redactHar(state.current);download(new Blob([JSON.stringify(safe,null,2)],{type:"application/json"}),safeName(state.current.name,"redacted.har"));toast("Обезличенный HAR сохранён: скрыты токены, cookies и тела запросов/ответов.");});
$("exportCsv").addEventListener("click",()=>{download(new Blob([exportCsv(state.rows)],{type:"text/csv;charset=utf-8"}),safeName(state.current.name,"requests.csv"));toast(`Выгружено ${state.rows.length} строк CSV.`);});
$("closeDetail").addEventListener("click",()=>$("detailDialog").close()); $("detailDialog").addEventListener("click",e=>{if(e.target === $("detailDialog")) $("detailDialog").close();});
const overlay=$("dropOverlay"); let dragCount=0;
window.addEventListener("dragenter",e=>{e.preventDefault();dragCount++;$("welcome").classList.add("dragging");});
window.addEventListener("dragover",e=>e.preventDefault());
window.addEventListener("dragleave",()=>{dragCount=Math.max(0,dragCount-1);if(!dragCount)$("welcome").classList.remove("dragging");});
window.addEventListener("drop",e=>{e.preventDefault();dragCount=0;$("welcome").classList.remove("dragging");const files=[...e.dataTransfer.files].filter(f=>/\.har$|\.json$/i.test(f.name));if(files.length)importFiles(files);else toast("Перетащи файл .har или JSON.",true);});
