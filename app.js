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

// Run reset ASAP (normal tabs are often stuck on old SW assets)
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


function injectPrettyStyles() {
  if (document.getElementById("prettyStyles")) return;
  const style = document.createElement("style");
  style.id = "prettyStyles";
  style.textContent = `
    :root { --gc-border: rgba(0,0,0,.12); --gc-shadow: 0 10px 25px rgba(0,0,0,.14); }
    /* Force-clean button style (override any existing CSS) */
    #startBtn, #toggleScanBtn {
      appearance: none !important;
      -webkit-appearance: none !important;
      border: 1px solid var(--gc-border) !important;
      border-radius: 999px !important;
      padding: 12px 14px !important;
      font-weight: 800 !important;
      font-size: 16px !important;
      line-height: 1 !important;
      box-shadow: 0 6px 18px rgba(0,0,0,.10) !important;
      background: #ffffff !important;
      color: #111 !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    #startBtn:disabled {
      opacity: .65 !important;
      box-shadow: none !important;
    }
    #scanRate {
      border: 1px solid var(--gc-border) !important;
      border-radius: 999px !important;
      padding: 10px 12px !important;
      font-weight: 700 !important;
      font-size: 14px !important;
      background: #ffffff !important;
      color: #111 !important;
    }

    /* Fixed bottom tray that always fits on iPhone */
    #gcTray {
      position: fixed !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      z-index: 9998 !important; /* below overlay canvas (9999) */
      padding: 10px 12px calc(10px + env(safe-area-inset-bottom)) !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
      background: rgba(255,255,255,.90) !important;
      border-top: 1px solid rgba(0,0,0,.08) !important;
    }
    #gcTrayRow {
      display: flex !important;
      gap: 10px !important;
      align-items: center !important;
    }
    #gcTrayRow > * { flex: 1 1 auto !important; }
    #gcTrayRow #scanRate { flex: 0.9 1 auto !important; }

    /* Prevent accidental body padding from causing extra scroll */
    body { overflow-x: hidden !important; }
  `;
  document.head.appendChild(style);
}

function beautifyControlsAndFit() {
  try { injectPrettyStyles(); } catch {}
  try { removeTopBars(); } catch {}

  const btnA = document.getElementById("startBtn");
  const btnB = document.getElementById("toggleScanBtn");
  const rate = document.getElementById("scanRate");
  if (!btnA || !btnB || !video) return;

  // Create a fixed tray once, then move controls into it.
  let tray = document.getElementById("gcTray");
  let row = document.getElementById("gcTrayRow");
  if (!tray) {
    tray = document.createElement("div");
    tray.id = "gcTray";
    row = document.createElement("div");
    row.id = "gcTrayRow";
    tray.appendChild(row);
    document.body.appendChild(tray);
  }
  if (!row) {
    row = document.createElement("div");
    row.id = "gcTrayRow";
    tray.appendChild(row);
  }

  // Move controls into tray row (preserve order)
  const toMove = [btnA, btnB, rate].filter(Boolean);
  for (const el of toMove) {
    try {
      if (el && el.parentElement !== row) row.appendChild(el);
    } catch {}
  }

  // Fit video so NO scroll is needed: max-height = viewport - tray height - small margin.
  const doFit = () => {
    try {
      const trayH = tray.getBoundingClientRect().height || 0;
      const margin = 14;
      const maxH = Math.max(220, Math.floor(window.innerHeight - trayH - margin));
      video.style.maxHeight = maxH + "px";
      video.style.width = "100%";
      video.style.height = "auto";
      // If still overflowing, jump back to top
      if (document.documentElement.scrollHeight - window.innerHeight > 6) {
        window.scrollTo(0, 0);
      }
    } catch {}
  };

  doFit();
  window.addEventListener("resize", doFit);
  window.addEventListener("orientationchange", () => setTimeout(doFit, 250));
  setTimeout(doFit, 200);
  setTimeout(doFit, 600);
}

    }
  } catch {}
}
document.addEventListener("DOMContentLoaded", () => { removeTopBars();
  try { beautifyControlsAndFit(); } catch (e) {} setTimeout(removeTopBars, 250); try { beautifyControlsAndFit(); } catch (e) {} });
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
  const o = (ocr || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();
  const n = (name || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();

  const dist = levenshtein(o, n);
  const denom = Math.max(8, Math.max(o.length, n.length));
  let score = dist / denom;

  // Heuristics to be more forgiving when OCR misses the last word (common on some title bars).
  // If the OCR string is a substantial substring/prefix of the real name, lower the score.
  if (o.length >= 10 && (n.startsWith(o) || n.includes(o))) score = Math.min(score, 0.22);
  if (n.length >= 10 && (o.startsWith(n) || o.includes(n))) score = Math.min(score, 0.22);

  // Token coverage bonus: if OCR tokens are all present in the candidate name, lower score a bit.
  const ot = o.split(" ").filter(Boolean);
  if (ot.length >= 2) {
    const allIn = ot.every(t => n.includes(t));
    if (allIn) score = Math.min(score, 0.25);
  }

  return score;
}
function pickSearchFragment(ocrText) {
  const cleaned = (ocrText || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(w => w.length >= 4);
  words.sort((a, b) => b.length - a.length);
  return words[0] || cleaned.slice(0, 10) || cleaned;
}
async function resolveCardFromOCR(ocrText) {
  // Try multiple OCR variants: original, then progressively dropping a trailing fragment/word.
  const base = cleanOCR(ocrText);
  const words = base.split(/\s+/).filter(Boolean);

  const attempts = [];
  if (base) attempts.push(base);

  // If last token is short/fragmented (e.g., 'TYPH'), try without it.
  if (words.length >= 3 && words[words.length - 1].length <= 5) {
    attempts.push(words.slice(0, -1).join(" "));
  }

  // Also try just the first 2–3 words (helps when the last word is consistently missed)
  if (words.length >= 3) attempts.push(words.slice(0, 3).join(" "));
  if (words.length >= 2) attempts.push(words.slice(0, 2).join(" "));

  // De-dupe attempts
  const seen = new Set();
  const uniq = [];
  for (const a of attempts) {
    const k = a.toLowerCase();
    if (!seen.has(k) && a.length >= 6) { seen.add(k); uniq.push(a); }
  }

  let globalBest = null;

  for (const attempt of uniq) {
    const exact = await ygoproLookupExactName(attempt);
    if (exact) return { card: exact, exact: true, score: 0, method: "exact" };

    const frag = pickSearchFragment(attempt);
    if (!frag || frag.length < 3) continue;

    const candidates = await ygoproLookupFuzzyName(frag);
    let best = null;
    for (const c of candidates.slice(0, 200)) {
      const score = similarityScore(attempt, c.name);
      if (!best || score < best.score) best = { card: c, score, attempt };
    }

    if (best && (!globalBest || best.score < globalBest.score)) globalBest = best;

    // Early accept if we get a very strong match on any attempt
    if (best && best.score <= 0.28) return { card: best.card, exact: false, score: best.score, method: "fuzzy", attempt: best.attempt };
  }

  if (globalBest && globalBest.score <= 0.35) {
    return { card: globalBest.card, exact: false, score: globalBest.score, method: "fuzzy", attempt: globalBest.attempt };
  }

  return { card: null, exact: false, score: globalBest ? globalBest.score : 1, method: globalBest ? "fuzzy-no" : "none" };
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

function invertCanvas(srcCanvas) {
  const out = document.createElement("canvas");
  out.width = srcCanvas.width;
  out.height = srcCanvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function preprocessGrayContrast(srcCanvas) {
  // Grayscale + contrast stretch (keeps anti-aliased edges; sometimes reads better than hard B/W)
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

  // Find min/max gray (ignore extreme outliers lightly)
  let gMin = 255, gMax = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
  }
  // Prevent divide-by-zero
  const span = Math.max(1, gMax - gMin);
  const boost = 255 / span;

  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const ng = Math.max(0, Math.min(255, (g - gMin) * boost));
    d[i] = d[i + 1] = d[i + 2] = ng;
    d[i + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return out;
}

function preprocessBWOtsu(srcCanvas, invert = false) {
  // Otsu thresholding often handles light-on-dark title bars better than a single mean-based threshold.
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

  // Histogram
  const hist = new Array(256).fill(0);
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    hist[g]++;
  }

  // Otsu
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0, wB = 0, wF = 0;
  let varMax = 0, threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = n - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }

  for (let i = 0; i < d.length; i += 4) {
    const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    let v = g > threshold ? 255 : 0;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return out;
}

function grabNameStripCanvasVariant(dy = 0, dh = 0) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vis = getVisibleSourceRect();
  if (!vis) return null;

  let sx = Math.floor(vis.offsetX + vis.visibleW * CROP.x);
  let sy = Math.floor(vis.offsetY + vis.visibleH * (CROP.y + dy));
  let sw = Math.floor(vis.visibleW * CROP.w);
  let sh = Math.floor(vis.visibleH * (CROP.h + dh));

  sx = Math.max(0, Math.min(vw - 1, sx));
  sy = Math.max(0, Math.min(vh - 1, sy));
  sw = Math.max(1, Math.min(vw - sx, sw));
  sh = Math.max(1, Math.min(vh - sy, sh));

  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
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
    // Base crop
    const strip = grabNameStripCanvas();
    if (!strip) { dbg("Camera not ready…"); return; }

    const tryOCR = async (canvas, label) => {
      const data = await ocrWithWorker(canvas);
      const cleaned = cleanOCR(data.text);
      return { cleaned, label };
    };

    // Pass 1: original mean-threshold BW (best for most monster titles)
    const bw1 = preprocessBW(strip);
    let { cleaned, label } = await tryOCR(bw1, "bw");
    if (ocrTextEl) ocrTextEl.textContent = cleaned || "";

    if (!looksTooPartial(cleaned)) {
      const resolved = await resolveCardFromOCR(cleaned);
      if (resolved.card) {
        if (resolved.exact) { lockResult(resolved.card, "exact", cleaned); return; }

        if (!lastCandidate || lastCandidate.id !== resolved.card.id) {
          lastCandidate = { id: resolved.card.id, seen: 1, best: resolved.score };
          dbg("Matching… hold steady");
          return;
        }
        lastCandidate.seen += 1;
        lastCandidate.best = Math.min(lastCandidate.best, resolved.score);
        if (lastCandidate.seen >= 2 && lastCandidate.best <= 0.35) {
          lockResult(resolved.card, `fuzzy ${lastCandidate.best.toFixed(2)}`, cleaned);
          return;
        }
        dbg("Matching… hold steady");
        return;
      }
    }

    // Only fall back if we couldn't get a confident match.
    // This keeps Burstinatrix/UFO Turtle performance the same.
    const attempts = [];

    // Pass 2: Otsu BW (often better on gradients / non-uniform title bars)
    attempts.push(async () => {
      const bw = preprocessBWOtsu(strip, false);
      return await tryOCR(bw, "otsu");
    });

    // Pass 3: Otsu inverted BW (helps white lettering on dark title bars like many Spell/Trap names)
    attempts.push(async () => {
      const bw = preprocessBWOtsu(strip, true);
      return await tryOCR(bw, "otsu-inv");
    });

    // Pass 4: slightly taller/shifted crop (some spell/trap frames sit a hair different)
    attempts.push(async () => {
      const strip2 = grabNameStripCanvasVariant(-0.02, 0.05);
      if (!strip2) return { cleaned: "", label: "shift" };
      const bw = preprocessBWOtsu(strip2, true);
      return await tryOCR(bw, "shift-otsu-inv");
    });

    // Pass 5: grayscale + contrast (sometimes Tesseract likes anti-aliased edges)
    attempts.push(async () => {
      const g = preprocessGrayContrast(strip);
      return await tryOCR(g, "gray");
    });

    for (const fn of attempts) {
      const out = await fn();
      const cleaned2 = out.cleaned || "";
      if (ocrTextEl) ocrTextEl.textContent = cleaned2;

      if (looksTooPartial(cleaned2)) continue;

      const resolved2 = await resolveCardFromOCR(cleaned2);
      if (!resolved2.card) continue;

      if (resolved2.exact) { lockResult(resolved2.card, `exact (${out.label})`, cleaned2); return; }

      if (!lastCandidate || lastCandidate.id !== resolved2.card.id) {
        lastCandidate = { id: resolved2.card.id, seen: 1, best: resolved2.score };
        dbg("Matching… hold steady");
        return;
      }
      lastCandidate.seen += 1;
      lastCandidate.best = Math.min(lastCandidate.best, resolved2.score);
      if (lastCandidate.seen >= 2 && lastCandidate.best <= 0.35) {
        lockResult(resolved2.card, `fuzzy ${lastCandidate.best.toFixed(2)} (${out.label})`, cleaned2);
        return;
      }
      dbg("Matching… hold steady");
      return;
    }

    // If we reach here, nothing worked
    dbg("No confident match — try less glare + hold steady.");
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
  try {
    await video.play();
  } catch {
    await new Promise(r => setTimeout(r, 200));
    await video.play();
  }
  removeTopBars();
  try { beautifyControlsAndFit(); } catch (e) {}
  ensureGuideOverlay();
  redrawGuide();
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
