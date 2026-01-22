// Goat Cam - app.js (CACHE/SW RESET BUILD - no banner)
// Purpose: fix "different behavior in Private vs Normal" by nuking any old Service Worker + caches,
// then proceed with normal camera flow. After one successful load, you can keep this build or swap back.

window.addEventListener("error", (e) => {
  try { console.error(e); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  try { console.error(e); } catch {}
});

async function resetServiceWorkerAndCaches() {
  // Unregister all SW + clear CacheStorage for this origin.
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
}

// (Dev convenience) Attempt to unregister any existing Service Worker + clear CacheStorage.
// This prevents Safari from "holding onto" older builds while you iterate.
resetServiceWorkerAndCaches();
// ----------------- APP -----------------
const video = document.getElementById("video");
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
  if (debugEl) debugEl.textContent = msg || "";
}

function setOverlay(state, markText) {
  bigMark?.classList?.remove("ok", "no", "unknown");
  bigMark?.classList?.add(state);
  bigMark.textContent = markText;
}

function setBanBadge(status) {
  if (!banStatusEl) return;
  banStatusEl.classList.remove("ok", "warn", "bad");
  if (!status || status === "—") { banStatusEl.textContent = "—"; return; }
  if (status === "BANNED") { banStatusEl.classList.add("bad"); banStatusEl.textContent = "🚫 BANNED"; return; }
  if (status === "LIMITED") { banStatusEl.classList.add("warn"); banStatusEl.textContent = "① LIMITED"; return; }
  if (status === "SEMI") { banStatusEl.classList.add("warn"); banStatusEl.textContent = "② SEMI-LIMITED"; return; }
  banStatusEl.classList.add("ok"); banStatusEl.textContent = "✓ OK";
}

function resetUI(reason) {
  setOverlay("unknown", "…");
  if (cardNameEl) cardNameEl.textContent = "Not sure";
  if (goatPoolEl) goatPoolEl.textContent = "—";
  if (earliestEl) earliestEl.textContent = "—";
  if (ocrTextEl) ocrTextEl.textContent = "";
  setBanBadge("—");
  dbg(reason || "");
}

function removeTopBars() {
  // Hide any legacy "Goat Cam" headers/banners that might exist in older builds.
  try {
    const candidates = Array.from(document.querySelectorAll("header, h1, h2, div, span"));
    for (const el of candidates) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (!t) continue;
      if (t === "goat cam" || t.startsWith("goat cam")) {
        el.style.display = "none";
        const h = el.closest("header");
        if (h) h.style.display = "none";
      }
    }
  } catch {}
}

function injectPrettyStyles() {
  if (document.getElementById("prettyStyles")) return;
  const style = document.createElement("style");
  style.id = "prettyStyles";
  style.textContent = `
    :root {
      --gc-border: rgba(0,0,0,.12);
      --gc-shadow: 0 10px 25px rgba(0,0,0,.14);
    }

    /* Treat this like an app shell: no page scrolling */
    html, body {
      height: 100%;
      margin: 0 !important;
      overflow: hidden !important;
      overscroll-behavior: none !important;
    }
    * { box-sizing: border-box; }

    /* Layout hardening */
    #app { height: 100vh; height: 100dvh; display: flex; flex-direction: column; }
    #videoWrap { flex: 1 1 auto; min-height: 0; position: relative; background:#000; }
    #video { width: 100%; height: 100%; object-fit: cover; background:#000; display:block; }

    /* Button + select styling (safe overrides) */
    #startBtn, #toggleScanBtn {
      appearance: none !important;
      -webkit-appearance: none !important;
      border: 1px solid var(--gc-border) !important;
      border-radius: 999px !important;
      padding: clamp(10px, 1.5vh, 14px) clamp(12px, 2vw, 16px) !important;
      font-weight: 800 !important;
      font-size: clamp(14px, 1.9vh, 16px) !important;
      line-height: 1 !important;
      box-shadow: 0 6px 18px rgba(0,0,0,.10) !important;
      background: #ffffff !important;
      color: #111 !important;
      min-height: 44px !important;
    }
    #startBtn:disabled { opacity: .65 !important; box-shadow: none !important; }

    #scanRate {
      border: 1px solid var(--gc-border) !important;
      border-radius: 999px !important;
      padding: clamp(9px, 1.3vh, 12px) clamp(10px, 1.6vw, 14px) !important;
      font-weight: 700 !important;
      font-size: clamp(13px, 1.7vh, 14px) !important;
      background: #ffffff !important;
      color: #111 !important;
      min-height: 44px !important;
    }

    /* Make the controls area a dense responsive grid (works with your index.html) */
    #controls {
      display: grid !important;
      grid-template-columns: 1fr 1fr !important;
      gap: 10px !important;
      align-items: center !important;
      padding: 10px !important;
      max-height: 32dvh !important;
      overflow: hidden !important;
    }
    #controls .chk {
      grid-column: 1 / -1 !important;
      display: inline-flex !important;
      gap: 8px !important;
      justify-content: center !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      white-space: nowrap !important;
    }
    #debug {
      grid-column: 1 / -1 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    @media (min-width: 520px) {
      #controls { grid-template-columns: 1fr 1fr auto !important; }
      #controls .chk { grid-column: auto !important; justify-self: end !important; }
    }

    /* Ensure the video is actually visible and fills its container */
    #video {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      background: #000 !important;
    }
  `;
  document.head.appendChild(style);
}

function beautifyControlsAndFit() {
  try { injectPrettyStyles(); } catch {}
  try { removeTopBars(); } catch {}

  // On some browsers, layout settles after permission prompt. Nudge a few reflows.
  const nudge = () => {
    try {
      // Ensure we never keep a stale scroll position.
      if (document.documentElement.scrollTop || document.body.scrollTop) window.scrollTo(0, 0);

      // Force guide overlay to re-measure once the video has real dimensions.
      if (guideCanvas) redrawGuide();
    } catch {}
  };

  nudge();
  window.addEventListener("resize", nudge, { passive: true });
  window.visualViewport?.addEventListener?.("resize", nudge, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(nudge, 250), { passive: true });
  setTimeout(nudge, 200);
  setTimeout(nudge, 600);
}

// Keep behavior stable: clean up banners/tray as soon as DOM exists,
// and again shortly after in case the page injects/rehydrates elements.
document.addEventListener("DOMContentLoaded", () => {
  try { removeTopBars(); } catch {}
  try { beautifyControlsAndFit(); } catch {}
  setTimeout(() => { try { removeTopBars(); } catch {} try { beautifyControlsAndFit(); } catch {} }, 250);
});
// Data
async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  return await r.json();
}
let setsRelease = {};
let goatBanlist = {};
let goatPoolCfg = {};

function dateStrToNum(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(x => parseInt(x, 10));
  if (!y || !m || !day) return null;
  return y * 10000 + m * 100 + day;
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
function canLockCard(card) {
  const earliest = computeEarliestSet(card);
  const pool = goatPoolCheck(earliest);
  return !!(earliest && earliest.date && pool.inPool != null);
}

// Safe overlay (dims only inside video rect)
let guideCanvas = null, guideCtx = null;
const GUIDE = {
  card: { x: 0.10, y: 0.14, w: 0.80, h: 0.74 },
  name: { x: 0.13, y: 0.17, w: 0.74, h: 0.11 },
  art:  { x: 0.13, y: 0.30, w: 0.74, h: 0.36 },
  set:  { x: 0.13, y: 0.67, w: 0.74, h: 0.08 },
  text: { x: 0.13, y: 0.76, w: 0.74, h: 0.12 }
};
function ensureGuideOverlay() {
  if (guideCanvas) return;
  guideCanvas = document.createElement("canvas");
  guideCanvas.style.position = "fixed";
  guideCanvas.style.left = "0";
  guideCanvas.style.top = "0";
  guideCanvas.style.zIndex = "9999";
  guideCanvas.style.pointerEvents = "none";
  guideCanvas.style.display = "none";
  document.body.appendChild(guideCanvas);
  guideCtx = guideCanvas.getContext("2d");
  window.addEventListener("resize", redrawGuide);
  window.addEventListener("scroll", redrawGuide, true);
}
function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}
function strokeBox(c, x, y, w, h, stroke, fill) {
  if (fill) { c.fillStyle = fill; roundRect(c, x, y, w, h, 12); c.fill(); }
  c.strokeStyle = stroke; c.lineWidth = 2;
  roundRect(c, x, y, w, h, 12); c.stroke();
}
function redrawGuide() {
  if (!guideCanvas || !guideCtx) return;
  guideCanvas.width = Math.max(1, window.innerWidth);
  guideCanvas.height = Math.max(1, window.innerHeight);
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);

  const r = video.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) { guideCanvas.style.display = "none"; return; }
  guideCanvas.style.display = "block";

  const abs = (b) => ({
    x: r.left + r.width * b.x,
    y: r.top + r.height * b.y,
    w: r.width * b.w,
    h: r.height * b.h
  });

  const card = abs(GUIDE.card), name = abs(GUIDE.name), art = abs(GUIDE.art), set = abs(GUIDE.set), text = abs(GUIDE.text);

  guideCtx.fillStyle = "rgba(0,0,0,0.33)";
  guideCtx.fillRect(r.left, r.top, r.width, r.height);
  guideCtx.clearRect(card.x, card.y, card.w, card.h);

  strokeBox(guideCtx, card.x, card.y, card.w, card.h, "rgba(255,255,255,0.92)", null);
  strokeBox(guideCtx, name.x, name.y, name.w, name.h, "rgba(0,255,170,0.98)", "rgba(0,255,170,0.10)");
  strokeBox(guideCtx, art.x, art.y, art.w, art.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
  strokeBox(guideCtx, set.x, set.y, set.w, set.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
  strokeBox(guideCtx, text.x, text.y, text.w, text.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
}

// OCR + lookup
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
function cleanOCR(t) {
  return (t || "").replace(/\n/g, " ").replace(/[^\w'\-: ]/g, " ").replace(/\s+/g, " ").trim();
}
function looksTooPartial(t) {
  if (!t) return true;
  if (!/[A-Za-z]/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length < 2 || t.length < 7;
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
  a = (a||"").toLowerCase(); b = (b||"").toLowerCase();
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
  const dist = levenshtein(ocr, name);
  const denom = Math.max(8, Math.max((ocr||"").length, (name||"").length));
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
  // strict
  if (best && best.score <= 0.35) return { card: best.card, exact: false, score: best.score, method: "fuzzy" };
  return { card: null, exact: false, score: best ? best.score : 1, method: "fuzzy-no" };
}

// Crop title strip (kept same guide proportions)
const CROP = { x: 0.13, y: 0.17, w: 0.74, h: 0.11 };
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

// UI apply + locking
function applyCardToUI(card, methodText, ocrText) {
  if (cardNameEl) cardNameEl.textContent = card?.name || "Not sure";
  const earliest = computeEarliestSet(card);
  const pool = goatPoolCheck(earliest);
  const b = banStatus(card.id);

  if (pool.inPool === true) setOverlay("ok", "✅");
  else if (pool.inPool === false) setOverlay("no", "❌");
  else setOverlay("unknown", "…");

  if (goatPoolEl) goatPoolEl.textContent = pool.inPool == null ? "— Unknown" : (pool.inPool ? "✅ Included (Goat era)" : "❌ Out of Goat era");
  setBanBadge(b);
  if (earliestEl) earliestEl.textContent = earliest ? `${earliest.set_name} (${earliest.date})` : "Unknown";
  if (ocrTextEl) ocrTextEl.textContent = ocrText || "";
  dbg(methodText || "");
}

let scanning = false, scanTimer = null, scanBusy = false;
let locked = null;
let lastCandidate = null;

function lockResult(card, method, ocrText) {
  if (!canLockCard(card)) { dbg("Matched name, waiting for full info…"); return; }
  locked = { card, method, ocr: ocrText };
  applyCardToUI(card, `LOCKED (${method})`, ocrText);
  scanning = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
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
    if (!resolved.card) { dbg("No confident match."); return; }

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
  } finally { scanBusy = false; }
}

function startAutoScanning() {
  if (scanning) return;
  scanning = true;
  const rate = parseInt(scanRateSel?.value, 10) || 900;
  if (toggleScanBtn) toggleScanBtn.textContent = "Scan New Card";
  dbg("Auto-scanning… (locks when stable)");
  scanTimer = setInterval(scanOnce, rate);
  scanOnce();
  ensureGuideOverlay();
  setInterval(() => { if (scanning) redrawGuide(); }, 250);
}

async function startCamera() {
  dbg("Requesting camera…");

  // Ensure iOS plays inline and doesn't force fullscreen
  try {
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
  } catch {}

  const constraints = {
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;

  // Wait for real dimensions (metadata can be racy on iOS)
  await new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Camera metadata timeout"));
    };
    const cleanup = () => {
      clearTimeout(to);
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("loadeddata", done);
    };

    // If already ready, resolve immediately
    if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) return resolve();

    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("loadeddata", done, { once: true });

    const to = setTimeout(fail, 3500);
  });

  // Try to play (retry a couple times)
  for (let i = 0; i < 3; i++) {
    try {
      await video.play();
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Make sure video always has visible size
  try {
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    video.style.background = "#000";
  } catch {}

  try { removeTopBars(); } catch {}
  try { beautifyControlsAndFit(); } catch {}
  try { ensureGuideOverlay(); redrawGuide(); } catch {}

  dbg(`Camera OK (${video.videoWidth || "?"}x${video.videoHeight || "?"}).`);
}

// Controls
startBtn?.addEventListener("click", async () => {
  // iOS Safari can be picky: start the camera ASAP (within the tap gesture),
  // then load JSON in parallel.
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  try {
    resetUI("Starting camera…");

    const dataPromise = (async () => {
      // Load data (no-store) while camera spins up
      setsRelease = await loadJSON("data/sets_release_dates.json");
      goatBanlist = await loadJSON("data/goat_banlist_2005_04.json");
      goatPoolCfg = await loadJSON("data/goat_pool_cutoff.json");
    })();

    await startCamera();

    // Wait for data (if still loading)
    resetUI("Loading data…");
    await dataPromise;

    startBtn.textContent = "Camera Ready";
    resetUI("Line up card title and hold steady.");
    startAutoScanning();
  } catch (e) {
    console.error(e);
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
    alert("Failed to start camera: " + (e?.message || e));
    dbg("Failed to start camera.");
  }
});
toggleScanBtn?.addEventListener("click", async () => {
  locked = null;
  lastCandidate = null;
  resetUI("Scan new card…");
  if (!scanning) startAutoScanning();
  await scanOnce();
});
