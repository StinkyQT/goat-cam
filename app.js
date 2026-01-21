// Goat Cam - app.js
// "Safe" layout + behavior fix build (based on the last working auto-scan + permanent exact-lock build).
//
// Fixes:
// - Auto-scanning starts immediately after camera is ready (again).
// - The button is always "Scan New Card" and it actually works (clears lock + scans again).
// - Layout tweak is *gentle*: we do NOT rebuild the UI or force fullscreen/no-scroll.
//   Instead we slightly "lift" the existing button row and compact a few text areas so you don't have to scroll.
//
// Notes:
// - If your HTML changes, this file still tries to find the button-row parent safely.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (e) {
      console.warn("Service Worker registration failed:", e);
    }
  });
}

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const startBtn = document.getElementById("startBtn");
const toggleScanBtn = document.getElementById("toggleScanBtn"); // "Scan New Card"
const scanRateSel = document.getElementById("scanRate");

const bigMark = document.getElementById("bigMark");
const cardNameEl = document.getElementById("cardName");
const goatPoolEl = document.getElementById("goatPool");
const banStatusEl = document.getElementById("banStatus");
const earliestEl = document.getElementById("earliest");
const ocrTextEl = document.getElementById("ocrText");
const debugEl = document.getElementById("debug");

let scanning = false;
let scanTimer = null;
let scanBusy = false;

let setsRelease = {};
let goatBanlist = {};
let goatPoolCfg = null;

// Lock state
// locked = { card, method, lockedAt, unlockAt, ocr, permanent:boolean }
let locked = null;
let lastCandidate = null;

// Template overlay
let guideCanvas = null;
let guideCtx = null;

// Cooldowns
let matchCooldownUntil = 0;

// Guides (relative to VISIBLE video element)
const GUIDE = {
  card: { x: 0.10, y: 0.14, w: 0.80, h: 0.74 },
  name: { x: 0.13, y: 0.17, w: 0.74, h: 0.11 },
  art:  { x: 0.13, y: 0.30, w: 0.74, h: 0.36 },
  set:  { x: 0.13, y: 0.67, w: 0.74, h: 0.08 },
  text: { x: 0.13, y: 0.76, w: 0.74, h: 0.12 }
};
const CROP = GUIDE.name;

// ---------------- Gentle layout tweaks ----------------
function injectGentleCSS() {
  const css = `
    /* Keep changes minimal and non-destructive */
    #debug {
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.2;
    }
    /* Make long fields a little more compact */
    #ocrText, #earliest, #goatPool {
      line-height: 1.15;
    }
    /* Give iPhone safe-area some breathing room without forcing no-scroll */
    body {
      padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function findControlsRow() {
  // Find the closest common parent that contains BOTH buttons and (ideally) the scan rate.
  if (!startBtn || !toggleScanBtn) return null;

  const ancestors = new Set();
  let p = startBtn.parentElement;
  while (p) { ancestors.add(p); p = p.parentElement; }

  let q = toggleScanBtn.parentElement;
  while (q && !ancestors.has(q)) q = q.parentElement;
  let common = q;

  if (!common) return null;

  // Prefer a slightly higher-level row that also contains the rate selector
  if (scanRateSel) {
    let up = common;
    for (let i = 0; i < 3 && up; i++) {
      if (up.contains(scanRateSel)) return up;
      up = up.parentElement;
    }
  }
  return common;
}

function nudgeControlsUp(px = 14) {
  const row = findControlsRow();
  if (!row) return;

  // If row is already positioned (fixed/sticky), just adjust margin/translate slightly.
  const cs = window.getComputedStyle(row);
  const pos = (cs.position || "").toLowerCase();

  // A gentle lift without altering flow too much.
  row.style.transform = `translateY(-${px}px)`;
  row.style.willChange = "transform";

  // If it was at the very bottom with margins, this helps on some iPhones.
  row.style.marginBottom = "0";
}

// ---------------- helpers ----------------
function dbg(msg) {
  if (debugEl) debugEl.textContent = msg || "";
}

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  return await r.json();
}

function setOverlay(state, markText) {
  bigMark.classList.remove("ok", "no", "unknown");
  bigMark.classList.add(state);
  bigMark.textContent = markText;
}

function setBanBadge(status) {
  banStatusEl.classList.remove("ok", "warn", "bad");
  if (!status || status === "—") {
    banStatusEl.textContent = "—";
    return;
  }
  if (status === "BANNED") {
    banStatusEl.classList.add("bad");
    banStatusEl.textContent = "🚫 BANNED";
    return;
  }
  if (status === "LIMITED") {
    banStatusEl.classList.add("warn");
    banStatusEl.textContent = "① LIMITED";
    return;
  }
  if (status === "SEMI") {
    banStatusEl.classList.add("warn");
    banStatusEl.textContent = "② SEMI-LIMITED";
    return;
  }
  banStatusEl.classList.add("ok");
  banStatusEl.textContent = "✓ OK";
}

function resetUI(reason) {
  setOverlay("unknown", "…");
  cardNameEl.textContent = "Not sure";
  goatPoolEl.textContent = "—";
  earliestEl.textContent = "—";
  setBanBadge("—");
  if (reason) dbg(reason);
}

function clearLockAndBuffers() {
  locked = null;
  lastCandidate = null;
  ocrBuffer = [];
  matchCooldownUntil = 0;
}

// ---------------- OCR cleanup ----------------
function basicNormalize(t) {
  return (t || "")
    .replace(/\n/g, " ")
    .replace(/[^\w'\-: ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function stripJunkPrefixes(t) {
  let s = (t || "").trim();
  s = s.replace(/^(?:I{1,3}|IV|V|VI{0,3}|1|l|L)\s+/i, "");
  s = s.replace(/^[A-Za-z]\s+(?=[A-Za-z])/, "");
  s = s.replace(/^[\-\:\;\'\"\.\,]+/, "").trim();
  s = s.replace(/[:;,\.\-]+$/, "").trim();
  return s;
}
function cleanFromWords(words) {
  const good = [];
  for (const w of (words || [])) {
    const txt = (w.text || "").trim();
    const conf = Number.isFinite(w.confidence) ? w.confidence : 0;
    const hasLetter = /[A-Za-z]/.test(txt);
    const plausibleLen = txt.length >= 2 || /['-]/.test(txt);
    if (hasLetter && plausibleLen && conf >= 50) good.push(txt);
  }
  const joined = good.join(" ").replace(/\s+/g, " ").trim();
  return stripJunkPrefixes(basicNormalize(joined));
}
function cleanOCR(rawText, words) {
  const byWords = cleanFromWords(words);
  let s = (byWords && byWords.length >= 5) ? byWords : stripJunkPrefixes(basicNormalize(rawText || ""));
  if (s.includes(":")) {
    const left = s.split(":")[0].trim();
    if (left.length >= 5) s = left;
  }
  s = stripJunkPrefixes(s);
  s = s.replace(/\bFLEMENTAL\b/gi, "ELEMENTAL");
  return s.trim();
}
function looksTooPartial(cleaned) {
  if (!cleaned) return true;
  if (!/[A-Za-z]/.test(cleaned)) return true;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return true;
  if (cleaned.length < 7) return true;
  return !words.some(w => w.length >= 4);
}

// ---------------- 2-frame OCR merge ----------------
let ocrBuffer = [];
function pushOcrBuffer(cleaned, words) {
  ocrBuffer.push({ cleaned, words: (words || []), ts: Date.now() });
  if (ocrBuffer.length > 2) ocrBuffer.shift();
}
function mergeTwoOcrReads() {
  if (ocrBuffer.length < 2) return ocrBuffer[0]?.cleaned || "";
  const a = ocrBuffer[0], b = ocrBuffer[1];
  const toTok = (t) => (t || "").replace(/[^A-Za-z0-9'\-]/g, "").toLowerCase();

  const best = new Map();
  for (const src of [a, b]) {
    for (const w of (src.words || [])) {
      const text = (w.text || "").trim();
      const tok = toTok(text);
      if (!tok) continue;
      const conf = Number.isFinite(w.confidence) ? w.confidence : 0;
      const prev = best.get(tok);
      if (!prev || conf > prev.confidence) best.set(tok, { text, confidence: conf });
    }
  }
  if (best.size < 2) return (b.cleaned && b.cleaned.length >= a.cleaned.length) ? b.cleaned : a.cleaned;

  const order = [];
  for (const w of (b.words || [])) {
    const tok = toTok(w.text);
    if (tok && best.has(tok) && !order.includes(tok)) order.push(tok);
  }
  for (const w of (a.words || [])) {
    const tok = toTok(w.text);
    if (tok && best.has(tok) && !order.includes(tok)) order.push(tok);
  }
  const mergedWords = order.map(tok => best.get(tok)).filter(Boolean);
  const joined = mergedWords
    .filter(w => (w.text || "").trim().length >= 1 && (Number.isFinite(w.confidence) ? w.confidence : 0) >= 40)
    .map(w => w.text.trim())
    .join(" ");
  return cleanOCR(joined, mergedWords);
}

// ---------------- Date helpers ----------------
function dateStrToNum(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(x => parseInt(x, 10));
  if (!y || !m || !day) return null;
  return y * 10000 + m * 100 + day;
}

// ---------------- YGOPRODeck helpers ----------------
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
  if (m === 0) return n;
  if (n === 0) return m;
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
  const A = (ocr || "").toLowerCase();
  const B = (name || "").toLowerCase();
  const dist = levenshtein(A, B);
  const denom = Math.max(8, Math.max(A.length, B.length));
  return dist / denom;
}
function pickSearchFragment(ocrText) {
  const cleaned = (ocrText || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();
  const stop = new Set(["the", "of", "and", "a", "an", "hero", "elemental"]);
  const words = cleaned.split(" ").filter(w => w.length >= 4 && !stop.has(w));
  if (words.length) { words.sort((a, b) => b.length - a.length); return words[0]; }
  const fallback = cleaned.split(" ").filter(w => w.length >= 4);
  if (fallback.length) return fallback[0];
  return cleaned.slice(0, 10) || cleaned;
}
async function resolveCardFromOCR(ocrText) {
  const exact = await ygoproLookupExactName(ocrText);
  if (exact) return { card: exact, method: "exact", score: 0.0, exact: true };

  const fragment = pickSearchFragment(ocrText);
  if (!fragment || fragment.length < 3) return { card: null, method: "none", score: 1.0, exact: false };

  const candidates = await ygoproLookupFuzzyName(fragment);
  if (!candidates.length) return { card: null, method: "fname-empty", score: 1.0, exact: false };

  let best = null;
  for (const c of candidates.slice(0, 220)) {
    const score = similarityScore(ocrText, c.name);
    if (!best || score < best.score) best = { score, card: c };
  }
  if (best && best.score <= 0.62) return { card: best.card, method: `fname:${fragment}`, score: best.score, exact: false };
  return { card: null, method: `fname:${fragment} no-good`, score: best ? best.score : 1.0, exact: false };
}

// ---------------- Goat checks ----------------
function computeEarliestSet(card) {
  const sets = card?.card_sets || [];
  let best = null;
  for (const s of sets) {
    const d = setsRelease[s.set_name];
    const dn = dateStrToNum(d);
    if (!dn) continue;
    if (!best || dn < best.dn) best = { dn, date: d, set_name: s.set_name, set_code: s.set_code };
  }
  return best;
}
function goatPoolCheck(earliest) {
  const cutoffDate = goatPoolCfg?.cutoff_date;
  if (!cutoffDate) return { inPool: null };
  if (!earliest?.date) return { inPool: null };
  const cutoff = dateStrToNum(cutoffDate);
  const dn = dateStrToNum(earliest.date);
  if (!cutoff || !dn) return { inPool: null };
  return { inPool: dn <= cutoff, cutoffDate };
}
function banStatus(cardId) {
  return goatBanlist[String(cardId)] || "OK";
}

// ---------------- Camera + overlay ----------------
async function startCamera() {
  dbg("Requesting camera…");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = () => resolve()));
  await video.play();

  ensureGuideOverlay();
  redrawGuide();
  dbg("Camera OK. Scanning…");
}

function ensureGuideOverlay() {
  if (guideCanvas) return;
  guideCanvas = document.createElement("canvas");
  guideCanvas.style.position = "fixed";
  guideCanvas.style.left = "0";
  guideCanvas.style.top = "0";
  guideCanvas.style.zIndex = "9999";
  guideCanvas.style.pointerEvents = "none";
  document.body.appendChild(guideCanvas);

  guideCtx = guideCanvas.getContext("2d");
  window.addEventListener("resize", redrawGuide);
  window.addEventListener("scroll", redrawGuide, true);

  setInterval(() => { if (scanning) redrawGuide(); }, 200);
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
  if (fill) {
    c.fillStyle = fill;
    roundRect(c, x, y, w, h, 12);
    c.fill();
  }
  c.strokeStyle = stroke;
  c.lineWidth = 2;
  roundRect(c, x, y, w, h, 12);
  c.stroke();
}
function redrawGuide() {
  if (!guideCanvas || !guideCtx) return;

  guideCanvas.width = Math.max(1, window.innerWidth);
  guideCanvas.height = Math.max(1, window.innerHeight);
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);

  const r = video.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;

  const abs = (b) => ({
    x: r.left + r.width * b.x,
    y: r.top + r.height * b.y,
    w: r.width * b.w,
    h: r.height * b.h
  });

  const card = abs(GUIDE.card);
  const name = abs(GUIDE.name);
  const art  = abs(GUIDE.art);
  const set  = abs(GUIDE.set);
  const text = abs(GUIDE.text);

  guideCtx.fillStyle = "rgba(0,0,0,0.33)";
  guideCtx.fillRect(0, 0, guideCanvas.width, guideCanvas.height);
  guideCtx.clearRect(card.x, card.y, card.w, card.h);

  strokeBox(guideCtx, card.x, card.y, card.w, card.h, "rgba(255,255,255,0.92)", null);
  strokeBox(guideCtx, name.x, name.y, name.w, name.h, "rgba(0,255,170,0.98)", "rgba(0,255,170,0.10)");
  strokeBox(guideCtx, art.x, art.y, art.w, art.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
  strokeBox(guideCtx, set.x, set.y, set.w, set.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
  strokeBox(guideCtx, text.x, text.y, text.w, text.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
}

// ---------------- object-fit aware crop mapping ----------------
function getObjectFit() {
  const cs = window.getComputedStyle(video);
  return (cs.objectFit || "contain").toLowerCase();
}
function getVisibleSourceRect() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const r = video.getBoundingClientRect();
  const dw = r.width, dh = r.height;
  if (!vw || !vh || dw < 2 || dh < 2) return null;

  const fit = getObjectFit();
  if (fit === "fill") return { offsetX: 0, offsetY: 0, visibleW: vw, visibleH: vh, vw, vh };

  const scaleCover = Math.max(dw / vw, dh / vh);
  const scaleContain = Math.min(dw / vw, dh / vh);
  const scale = (fit === "cover") ? scaleCover : scaleContain;

  const visibleW = dw / scale;
  const visibleH = dh / scale;
  const offsetX = (vw - visibleW) / 2;
  const offsetY = (vh - visibleH) / 2;

  return { offsetX, offsetY, visibleW, visibleH, vw, vh, fit };
}
function grabNameStripCanvas(yOffsetFrac = 0) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  const vis = getVisibleSourceRect();
  if (!vis) return null;

  const y = Math.min(0.95, Math.max(0.0, CROP.y + yOffsetFrac));
  let sx = Math.floor(vis.offsetX + vis.visibleW * CROP.x);
  let sy = Math.floor(vis.offsetY + vis.visibleH * y);
  let sw = Math.floor(vis.visibleW * CROP.w);
  let sh = Math.floor(vis.visibleH * CROP.h);

  sx = Math.max(0, Math.min(vw - 1, sx));
  sy = Math.max(0, Math.min(vh - 1, sy));
  sw = Math.max(1, Math.min(vw - sx, sw));
  sh = Math.max(1, Math.min(vh - sy, sh));
  if (sw < 10 || sh < 10) return null;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  cropCanvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropCanvas;
}

// ---------------- preprocess variants ----------------
function preprocessBW(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const scale = 2.6;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));

  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = outCtx.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const mean = sum / (d.length / 4);
  const threshold = Math.max(80, Math.min(180, mean * 0.90));

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    gray = (gray - 128) * 1.10 + 128;
    const v = gray > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  outCtx.putImageData(img, 0, 0);
  return out;
}
function preprocessGray(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const scale = 2.6;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));

  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = outCtx.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray = (gray - 128) * 1.18 + 128;
    gray = Math.max(0, Math.min(255, gray));
    d[i] = d[i + 1] = d[i + 2] = gray;
    d[i + 3] = 255;
  }
  outCtx.putImageData(img, 0, 0);
  return out;
}

// ---------------- Tesseract worker ----------------
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
function pickBetterOcr(a, b) {
  const ca = cleanOCR(a?.text || "", a?.words || []);
  const cb = cleanOCR(b?.text || "", b?.words || []);
  const aBad = looksTooPartial(ca);
  const bBad = looksTooPartial(cb);

  if (aBad && !bBad) return { data: b, cleaned: cb };
  if (!aBad && bBad) return { data: a, cleaned: ca };
  if (cb.length > ca.length) return { data: b, cleaned: cb };
  return { data: a, cleaned: ca };
}

// ---------------- Locking ----------------
function isLockedActive() {
  if (!locked) return false;
  if (locked.permanent) return true;
  return Date.now() < locked.unlockAt;
}
function canComputeAllFields(card) {
  if (!card) return false;
  const earliest = computeEarliestSet(card);
  const pool = goatPoolCheck(earliest);
  return Boolean(earliest && pool.inPool != null);
}
function maybeLockIn(resolved, textForUse) {
  if (!resolved || !resolved.card) return false;
  const now = Date.now();

  // PERMANENT lock for exact DB match
  if (resolved.exact === true) {
    locked = { card: resolved.card, method: resolved.method, lockedAt: now, unlockAt: now, ocr: textForUse, permanent: true };
    return true;
  }

  // Temporary lock only when we can compute goat/earliest
  if (!canComputeAllFields(resolved.card)) return false;
  if (looksTooPartial(textForUse)) return false;

  const id = resolved.card.id;
  const score = resolved.score ?? 1.0;

  if (!lastCandidate || lastCandidate.id !== id || now - lastCandidate.lastSeenAt > 2200) {
    lastCandidate = { id, seenCount: 1, bestScore: score, lastSeenAt: now };
  } else {
    lastCandidate.seenCount += 1;
    lastCandidate.bestScore = Math.min(lastCandidate.bestScore, score);
    lastCandidate.lastSeenAt = now;
  }

  const goodOnce = score <= 0.15;
  const stableTwice = lastCandidate.seenCount >= 2 && lastCandidate.bestScore <= 0.48;

  if (goodOnce || stableTwice) {
    locked = { card: resolved.card, method: resolved.method, lockedAt: now, unlockAt: now + 2600, ocr: textForUse, permanent: false };
    matchCooldownUntil = now + 700;
    return true;
  }
  return false;
}

// ---------------- UI apply ----------------
function applyCardToUI(card, methodText, textForUse) {
  cardNameEl.textContent = card?.name || "Not sure";

  const earliest = card ? computeEarliestSet(card) : null;
  const pool = earliest ? goatPoolCheck(earliest) : { inPool: null };
  const b = card ? banStatus(card.id) : "—";

  if (pool.inPool === true) setOverlay("ok", "✅");
  else if (pool.inPool === false) setOverlay("no", "❌");
  else setOverlay("unknown", "…");

  goatPoolEl.textContent =
    pool.inPool == null ? "— Unknown (matched card, missing cutoff/date info)" :
    (pool.inPool ? "✅ Included (Goat era)" : "❌ Out of Goat era");

  setBanBadge(b);

  earliestEl.textContent = earliest ? `${earliest.set_name} (${earliest.date})` : "Unknown (missing set dates)";
  if (textForUse != null) ocrTextEl.textContent = textForUse;

  if (methodText) dbg(methodText);
}

// ---------------- Scan loop ----------------
async function scanOnce() {
  if (scanBusy) return;
  scanBusy = true;

  try {
    const now = Date.now();
    if (now < matchCooldownUntil) return;

    if (isLockedActive()) {
      applyCardToUI(locked.card, locked.permanent ? "Locked (exact match)" : `Locked (${locked.method})`, locked.ocr || ocrTextEl.textContent);
      return;
    }

    const attempts = 3;
    const yOffsets = [0.00, 0.03, -0.03];

    let bestPick = null; // { cleaned, data }
    for (let a = 0; a < attempts; a++) {
      for (let i = 0; i < yOffsets.length; i++) {
        const strip = grabNameStripCanvas(yOffsets[i]);
        if (!strip) continue;

        const bw = preprocessBW(strip);
        const gray = preprocessGray(strip);

        dbg("Reading name…");
        setOverlay("unknown", "…");

        const dataBW = await ocrWithWorker(bw);
        const dataG  = await ocrWithWorker(gray);

        const picked = pickBetterOcr(dataBW, dataG);
        if (!bestPick || picked.cleaned.length > bestPick.cleaned.length) {
          bestPick = picked;
        }

        if (bestPick && !looksTooPartial(bestPick.cleaned) && bestPick.cleaned.length >= 18) break;
      }
      if (bestPick && !looksTooPartial(bestPick.cleaned) && bestPick.cleaned.length >= 18) break;
      await new Promise(r => setTimeout(r, 120));
    }

    if (!bestPick) {
      resetUI("Camera not ready yet…");
      return;
    }

    const cleaned = bestPick.cleaned;
    pushOcrBuffer(cleaned, bestPick.data.words);

    const merged = mergeTwoOcrReads();
    const textForUse = merged || cleaned;

    ocrTextEl.textContent = textForUse || "(no text)";

    if (looksTooPartial(textForUse)) {
      resetUI("Need more title text (avoid glare; fill the green name box).");
      return;
    }

    const resolved = await resolveCardFromOCR(textForUse);
    if (!resolved.card) {
      resetUI(`No match (${resolved.method}).`);
      return;
    }

    const lockedNow = maybeLockIn(resolved, textForUse);
    const method = lockedNow
      ? (resolved.exact ? "LOCKED (exact match)" : `LOCKED (${resolved.method}, score ${resolved.score.toFixed(2)})`)
      : `Matched (${resolved.method}, score ${resolved.score.toFixed(2)})`;

    applyCardToUI(resolved.card, method, textForUse);

  } catch (e) {
    console.error(e);
    resetUI(`ERROR: ${e.message || e}`);
  } finally {
    scanBusy = false;
  }
}

function startAutoScanning() {
  if (scanning) return;
  scanning = true;

  const rate = parseInt(scanRateSel?.value, 10) || 900;

  // Ensure correct UX text
  if (toggleScanBtn) toggleScanBtn.textContent = "Scan New Card";

  dbg(`Auto-scanning every ${rate}ms… (locks on exact match)`);

  scanTimer = setInterval(() => {
    if (isLockedActive()) return;
    scanOnce();
  }, rate);

  ocrBuffer = [];
  scanOnce();
  setTimeout(() => { if (scanning && !isLockedActive()) scanOnce(); }, 220);
}

function stopAutoScanning() {
  scanning = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

// ---------------- Boot ----------------
async function initAll() {
  // Gentle layout changes (no DOM moving / no fullscreen forcing)
  injectGentleCSS();

  dbg("Loading data…");
  setsRelease = await loadJSON("data/sets_release_dates.json");
  goatBanlist = await loadJSON("data/goat_banlist_2005_04.json");
  goatPoolCfg = await loadJSON("data/goat_pool_cutoff.json");

  await startCamera();

  // After camera is running, nudge controls slightly so you don't need to scroll
  // (Do it now and again shortly after, since iOS can change layout after permission prompts)
  nudgeControlsUp(14);
  setTimeout(() => nudgeControlsUp(14), 250);

  startBtn.textContent = "Camera Ready";
  resetUI("Align card in rectangle; name in green box. Scanning…");

  // IMPORTANT: auto-scan starts immediately
  startAutoScanning();
  redrawGuide();
}

// Start camera button
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Loading…";
  try {
    await initAll();
  } catch (e) {
    console.error(e);
    resetUI(`START ERROR: ${e.message || e}`);
    alert("Failed to start. Open in Safari, and allow Camera.");
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
  }
});

// Scan New Card button (clears lock + immediately scans)
toggleScanBtn.addEventListener("click", async () => {
  clearLockAndBuffers();
  resetUI("Scan new card…");
  if (!scanning) startAutoScanning();
  await scanOnce();
});
