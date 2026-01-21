// Goat Cam - app.js (RECOVERY BUILD)
// Goal: If you are seeing a full black screen with NO UI/debug, this build
// 1) Forces a visible on-screen banner immediately (before any camera logic)
// 2) Unregisters any service worker + clears caches (common cause: stuck old broken JS)
// 3) Disables the template overlay mask entirely until you explicitly re-enable later
// 4) Adds global error handlers to show an alert even if the page is black

// --- GLOBAL PANIC ERROR HANDLERS ---
window.addEventListener("error", (e) => {
  try { alert("JS error: " + (e?.message || e)); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  try { alert("Promise error: " + (e?.reason?.message || e?.reason || e)); } catch {}
});

// --- FORCE A VISIBLE BANNER IMMEDIATELY ---
(function ensureRecoveryBanner(){
  try {
    // Make page not-black even if CSS is weird
    document.documentElement.style.background = "#fff";
    document.body.style.background = "#fff";
    document.body.style.color = "#000";

    const banner = document.createElement("div");
    banner.id = "recoveryBanner";
    banner.style.position = "fixed";
    banner.style.left = "8px";
    banner.style.top = "8px";
    banner.style.zIndex = "2147483647";
    banner.style.padding = "10px 12px";
    banner.style.borderRadius = "14px";
    banner.style.background = "rgba(255,255,255,0.92)";
    banner.style.border = "1px solid rgba(0,0,0,0.15)";
    banner.style.boxShadow = "0 6px 20px rgba(0,0,0,0.15)";
    banner.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    banner.style.fontSize = "14px";
    banner.style.lineHeight = "1.2";
    banner.textContent = "RECOVERY BUILD LOADED ✅ (tap)";
    banner.addEventListener("click", () => {
      try { alert("Recovery banner is active. If the rest is black, it's likely cached old files / SW / CSS overlay."); } catch {}
    });

    // Append as early as possible
    document.addEventListener("DOMContentLoaded", () => {
      try { document.body.appendChild(banner); } catch {}
    });
    // Also append immediately if body already exists
    if (document.body) document.body.appendChild(banner);
  } catch {}
})();

// --- NUKE SERVICE WORKER + CACHES (very common cause of "still black") ---
(async function nukeSWAndCaches(){
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
  } catch {}
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  } catch {}
})();

// ----------------- ORIGINAL APP STARTS HERE -----------------
// (This build disables the template overlay canvas entirely to avoid screen-dimming bugs.)

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;

const startBtn = document.getElementById("startBtn");
const toggleScanBtn = document.getElementById("toggleScanBtn");
const scanRateSel = document.getElementById("scanRate");

const bigMark = document.getElementById("bigMark");
const cardNameEl = document.getElementById("cardName");
const goatPoolEl = document.getElementById("goatPool");
const banStatusEl = document.getElementById("banStatus");
const earliestEl = document.getElementById("earliest");
const ocrTextEl = document.getElementById("ocrText");
const debugEl = document.getElementById("debug");

function dbg(msg) {
  try { if (debugEl) debugEl.textContent = msg || ""; } catch {}
  try {
    const b = document.getElementById("recoveryBanner");
    if (b && msg) b.textContent = msg;
  } catch {}
}

function setOverlay(state, markText) {
  try {
    bigMark?.classList?.remove("ok", "no", "unknown");
    bigMark?.classList?.add(state);
    bigMark.textContent = markText;
  } catch {}
}

function setBanBadge(status) {
  if (!banStatusEl) return;
  banStatusEl.classList.remove("ok", "warn", "bad");
  if (!status || status === "—") { banStatusEl.textContent = "—"; return; }
  if (status === "BANNED") { banStatusEl.classList.add("bad"); banStatusEl.textContent = "🚫 BANNED"; return; }
  if (status === "LIMITED") { banStatusEl.classList.add("warn"); banStatusEl.textContent = "① LIMITED"; return; }
  if (status === "SEMI") { banStatusEl.classList.add("warn"); banStatusEl.textContent = "② SEMI-LIMITED"; return; }
  banStatusEl.classList.add("ok");
  banStatusEl.textContent = "✓ OK";
}

function resetUI(reason) {
  setOverlay("unknown", "…");
  if (cardNameEl) cardNameEl.textContent = "Not sure";
  if (goatPoolEl) goatPoolEl.textContent = "—";
  if (earliestEl) earliestEl.textContent = "—";
  setBanBadge("—");
  if (ocrTextEl) ocrTextEl.textContent = "";
  dbg(reason || "Ready.");
}

async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  return await r.json();
}

let scanning = false;
let scanTimer = null;
let scanBusy = false;

let setsRelease = {};
let goatBanlist = {};
let goatPoolCfg = null;

let locked = null;
let lastCandidate = null;
let ocrBuffer = [];

function dateStrToNum(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(x => parseInt(x, 10));
  if (!y || !m || !day) return null;
  return y * 10000 + m * 100 + day;
}

async function ygoproLookupExactName(name) {
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return data.data?.[0] || null;
}
async function ygoproLookupFuzzyName(fragment) {
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(fragment)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return data.data || [];
}
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
  }
  return dp[m][n];
}
function similarityScore(ocr, name) {
  const dist = levenshtein(ocr || "", name || "");
  const denom = Math.max(8, Math.max((ocr || "").length, (name || "").length));
  return dist / denom;
}
function pickSearchFragment(ocrText) {
  const cleaned = (ocrText || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(w => w.length >= 4);
  words.sort((a, b) => b.length - a.length);
  return words[0] || cleaned.slice(0, 10) || cleaned;
}

async function resolveCardFromOCR(ocrText) {
  const exact = await ygoproLookupExactName(ocrText);
  if (exact) return { card: exact, exact: true, score: 0, method: "exact" };

  const frag = pickSearchFragment(ocrText);
  if (!frag || frag.length < 3) return { card: null, exact: false, score: 1, method: "none" };

  const candidates = await ygoproLookupFuzzyName(frag);
  let best = null;
  for (const c of candidates.slice(0, 200)) {
    const score = similarityScore(ocrText, c.name);
    if (!best || score < best.score) best = { card: c, score };
  }
  if (best && best.score <= 0.35) return { card: best.card, exact: false, score: best.score, method: "fuzzy" };
  return { card: null, exact: false, score: best ? best.score : 1, method: "fuzzy-no" };
}

function computeEarliestSet(card) {
  const sets = card?.card_sets || [];
  let best = null;
  for (const s of sets) {
    const d = setsRelease[s.set_name];
    const dn = dateStrToNum(d);
    if (!dn) continue;
    if (!best || dn < best.dn) best = { dn, date: d, set_name: s.set_name };
  }
  return best;
}
function goatPoolCheck(earliest) {
  const cutoffDate = goatPoolCfg?.cutoff_date;
  if (!cutoffDate || !earliest?.date) return { inPool: null };
  const cutoff = dateStrToNum(cutoffDate);
  const dn = dateStrToNum(earliest.date);
  if (!cutoff || !dn) return { inPool: null };
  return { inPool: dn <= cutoff, cutoffDate };
}
function banStatus(cardId) {
  return goatBanlist[String(cardId)] || "OK";
}

function applyCardToUI(card, methodText, ocrText) {
  if (cardNameEl) cardNameEl.textContent = card?.name || "Not sure";
  const earliest = computeEarliestSet(card);
  const pool = goatPoolCheck(earliest);
  const b = banStatus(card.id);

  if (pool.inPool === true) setOverlay("ok", "✅");
  else if (pool.inPool === false) setOverlay("no", "❌");
  else setOverlay("unknown", "…");

  if (goatPoolEl) goatPoolEl.textContent =
    pool.inPool == null ? "— Unknown" : (pool.inPool ? "✅ Included (Goat era)" : "❌ Out of Goat era");

  setBanBadge(b);
  if (earliestEl) earliestEl.textContent = earliest ? `${earliest.set_name} (${earliest.date})` : "Unknown";
  if (ocrTextEl) ocrTextEl.textContent = ocrText || "";
  dbg(methodText || "");
}

function cleanOCR(t) {
  return (t || "").replace(/\n/g, " ").replace(/[^\w'\-: ]/g, " ").replace(/\s+/g, " ").trim();
}
function looksTooPartial(t) {
  if (!t) return true;
  if (!/[A-Za-z]/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length < 2 || t.length < 7;
}

let workerPromise = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await Tesseract.createWorker("eng");
      await w.setParameters({
        tessedit_pageseg_mode: "7",
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'-: "
      });
      return w;
    })();
  }
  return workerPromise;
}
async function ocrWithWorker(canvasToRead) {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvasToRead);
  return data;
}

function getVisibleSourceRect() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const r = video.getBoundingClientRect();
  const dw = r.width, dh = r.height;
  if (!vw || !vh || dw < 2 || dh < 2) return null;

  const cs = window.getComputedStyle(video);
  const fit = (cs.objectFit || "contain").toLowerCase();
  if (fit === "fill") return { offsetX: 0, offsetY: 0, visibleW: vw, visibleH: vh, vw, vh };

  const scale = (fit === "cover") ? Math.max(dw / vw, dh / vh) : Math.min(dw / vw, dh / vh);
  const visibleW = dw / scale;
  const visibleH = dh / scale;
  const offsetX = (vw - visibleW) / 2;
  const offsetY = (vh - visibleH) / 2;
  return { offsetX, offsetY, visibleW, visibleH, vw, vh };
}

const CROP = { x: 0.13, y: 0.17, w: 0.74, h: 0.11 };
function grabNameStripCanvas() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vis = getVisibleSourceRect();
  if (!vis) return null;

  let sx = Math.floor(vis.offsetX + vis.visibleW * CROP.x);
  let sy = Math.floor(vis.offsetY + vis.visibleH * CROP.y);
  let sw = Math.floor(vis.visibleW * CROP.w);
  let sh = Math.floor(vis.visibleH * CROP.h);

  sx = Math.max(0, Math.min(vw - 1, sx));
  sy = Math.max(0, Math.min(vh - 1, sy));
  sw = Math.max(1, Math.min(vw - sx, sw));
  sh = Math.max(1, Math.min(vh - sy, sh));

  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

function preprocessBW(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const scale = 2.4;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const o = out.getContext("2d");
  o.imageSmoothingEnabled = true;
  o.drawImage(srcCanvas, 0, 0, out.width, out.height);
  const img = o.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const mean = sum / (d.length / 4);
  const thr = Math.max(80, Math.min(180, mean * 0.90));

  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = gray > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return out;
}

function canLockCard(card) {
  const earliest = computeEarliestSet(card);
  const pool = goatPoolCheck(earliest);
  return !!(earliest && earliest.date && pool.inPool != null);
}

function lockResult(card, method, ocrText) {
  if (!canLockCard(card)) {
    dbg("Matched name, waiting for full info…");
    return;
  }
  locked = { card, method, ocr: ocrText };
  applyCardToUI(card, `LOCKED (${method})`, ocrText);
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  scanning = false;
}

async function scanOnce() {
  if (scanBusy || locked) return;
  scanBusy = true;
  try {
    const strip = grabNameStripCanvas();
    if (!strip) { dbg("Camera not ready…"); return; }

    const bw = preprocessBW(strip);
    const data = await ocrWithWorker(bw);
    const cleaned = cleanOCR(data.text);

    if (ocrTextEl) ocrTextEl.textContent = cleaned || "";
    if (looksTooPartial(cleaned)) { dbg("Too little title text — reduce glare."); return; }

    const resolved = await resolveCardFromOCR(cleaned);
    if (!resolved.card) { dbg("No match (confident)."); return; }

    // Lock rules: exact locks immediately; fuzzy needs two consistent reads
    if (resolved.exact) { lockResult(resolved.card, "exact", cleaned); return; }

    if (!lastCandidate || lastCandidate.id !== resolved.card.id) {
      lastCandidate = { id: resolved.card.id, seen: 1, best: resolved.score };
      dbg("Matching… hold steady");
      return;
    }
    lastCandidate.seen += 1;
    lastCandidate.best = Math.min(lastCandidate.best, resolved.score);
    if (lastCandidate.seen >= 2 && lastCandidate.best <= 0.33) {
      lockResult(resolved.card, `fuzzy ${lastCandidate.best.toFixed(2)}`, cleaned);
      return;
    }
    dbg("Matching… hold steady");
  } finally {
    scanBusy = false;
  }
}

function startAutoScanning() {
  if (scanning) return;
  scanning = true;
  const rate = parseInt(scanRateSel?.value, 10) || 900;
  if (toggleScanBtn) toggleScanBtn.textContent = "Scan New Card";
  dbg("Auto-scanning… (locks when stable)");
  scanTimer = setInterval(scanOnce, rate);
  scanOnce();
}

async function startCamera() {
  dbg("Requesting camera…");
  try {
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
  } catch {}

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await new Promise(resolve => (video.onloadedmetadata = () => resolve()));
  await video.play();
  dbg(`Camera OK (${video.videoWidth}x${video.videoHeight}).`);
}

// Controls
startBtn?.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Loading…";
  try {
    resetUI("Loading data…");
    setsRelease = await loadJSON("data/sets_release_dates.json");
    goatBanlist = await loadJSON("data/goat_banlist_2005_04.json");
    goatPoolCfg = await loadJSON("data/goat_pool_cutoff.json");

    await startCamera();
    startBtn.textContent = "Camera Ready";
    resetUI("Line up card title and hold steady.");
    startAutoScanning();
  } catch (e) {
    console.error(e);
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
    try { alert("Failed to start camera: " + (e?.message || e)); } catch {}
    dbg("Failed to start camera.");
  }
});

toggleScanBtn?.addEventListener("click", async () => {
  locked = null;
  lastCandidate = null;
  ocrBuffer = [];
  resetUI("Scan new card…");
  if (!scanning) startAutoScanning();
  await scanOnce();
});
