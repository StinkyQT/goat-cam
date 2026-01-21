// Goat Cam - app.js
// This build focuses on scan reliability + simpler template.
//
// Changes:
// - Template: no labels; single bottom text box; cleaner Yu-Gi-Oh layout.
// - OCR robustness: multi-pass OCR (BW + grayscale) and auto vertical "micro-scan" (tries a few Y offsets).
// - Better handling of unknown fields: UI shows matched card even if earliest/pool can't be computed; locking only occurs when fields are known.
// - Less strict gating so more cards can resolve, while still blocking single-word junk.

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
const toggleScanBtn = document.getElementById("toggleScanBtn");
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
let locked = null; // { card, method, lockedAt, unlockAt, ocr }
let lastCandidate = null;

// Template overlay
let guideCanvas = null;
let guideCtx = null;

// Cooldowns
let matchCooldownUntil = 0;

// Guides (relative to VISIBLE video element)
const GUIDE = {
  // Whole card rectangle
  card: { x: 0.10, y: 0.14, w: 0.80, h: 0.74 },

  // Title/name band (OCR)
  name: { x: 0.13, y: 0.17, w: 0.74, h: 0.11 },

  // Art window (for alignment only)
  art:  { x: 0.13, y: 0.30, w: 0.74, h: 0.36 },

  // Set / 1st ed zone (for alignment only)
  set:  { x: 0.13, y: 0.67, w: 0.74, h: 0.08 },

  // Single text box at bottom (for alignment only)
  text: { x: 0.13, y: 0.76, w: 0.74, h: 0.12 }
};

// OCR reads ONLY the name box:
const CROP = GUIDE.name;

// ---------------- helpers ----------------
function dbg(msg) {
  if (debugEl) debugEl.textContent = msg;
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
  setBanBadge("OK");
  if (reason) dbg(reason);
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

  // Strip roman numeral / stray leading glyphs like "II ", "I ", "1 ", "l "
  s = s.replace(/^(?:I{1,3}|IV|V|VI{0,3}|1|l|L)\s+/i, "");

  // Strip single-letter prefix like "K ELEMENTAL..."
  s = s.replace(/^[A-Za-z]\s+(?=[A-Za-z])/, "");

  // Remove leading punctuation
  s = s.replace(/^[\-\:\;\'\"\.\,]+/, "").trim();

  // Remove trailing punctuation
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

  // If OCR appends ":" then junk after it, keep left
  if (s.includes(":")) {
    const left = s.split(":")[0].trim();
    if (left.length >= 5) s = left;
  }

  s = stripJunkPrefixes(s);

  // Common specific fix: "FLEMENTAL" => "ELEMENTAL"
  s = s.replace(/\bFLEMENTAL\b/gi, "ELEMENTAL");

  return s.trim();
}

function looksTooPartial(cleaned) {
  if (!cleaned) return true;
  if (!/[A-Za-z]/.test(cleaned)) return true;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return true; // blocks single-word junk like "ELEMENTAL"
  if (cleaned.length < 7) return true;

  // allow short names, but need at least one word length >= 4
  return !words.some(w => w.length >= 4);
}

// ---------------- 2-frame OCR merge ----------------
let ocrBuffer = []; // [{ cleaned, words:[{text,confidence}], ts }]

function pushOcrBuffer(cleaned, words) {
  ocrBuffer.push({ cleaned, words: (words || []), ts: Date.now() });
  if (ocrBuffer.length > 2) ocrBuffer.shift();
}

function mergeTwoOcrReads() {
  if (ocrBuffer.length < 2) return ocrBuffer[0]?.cleaned || "";

  const a = ocrBuffer[0];
  const b = ocrBuffer[1];

  const toTok = (t) => (t || "").replace(/[^A-Za-z0-9'\-]/g, "").toLowerCase();

  const best = new Map(); // tok -> {text,confidence}
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

  if (best.size < 2) {
    return (b.cleaned && b.cleaned.length >= a.cleaned.length) ? b.cleaned : a.cleaned;
  }

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
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
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
  const cleaned = (ocrText || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stop = new Set(["the", "of", "and", "a", "an", "hero", "elemental"]);
  const words = cleaned.split(" ").filter(w => w.length >= 4 && !stop.has(w));
  if (words.length) {
    words.sort((a, b) => b.length - a.length);
    return words[0];
  }
  const fallback = cleaned.split(" ").filter(w => w.length >= 4);
  if (fallback.length) return fallback[0];
  return cleaned.slice(0, 10) || cleaned;
}

async function resolveCardFromOCR(ocrText) {
  // Try exact first
  const exact = await ygoproLookupExactName(ocrText);
  if (exact) return { card: exact, method: "exact", score: 0.0 };

  // Fuzzy by a strong fragment
  const fragment = pickSearchFragment(ocrText);
  if (!fragment || fragment.length < 3) return { card: null, method: "none", score: 1.0 };

  const candidates = await ygoproLookupFuzzyName(fragment);
  if (!candidates.length) return { card: null, method: "fname-empty", score: 1.0 };

  let best = null;
  for (const c of candidates.slice(0, 200)) {
    const score = similarityScore(ocrText, c.name);
    if (!best || score < best.score) best = { score, card: c };
  }

  if (best && best.score <= 0.62) {
    return { card: best.card, method: `fname:${fragment}`, score: best.score };
  }
  return { card: null, method: `fname:${fragment} no-good`, score: best ? best.score : 1.0 };
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

  dbg(`Camera OK. videoWidth=${video.videoWidth}, videoHeight=${video.videoHeight}`);
  ensureGuideOverlay();
  redrawGuide();
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

  // Dim outside card
  guideCtx.fillStyle = "rgba(0,0,0,0.33)";
  guideCtx.fillRect(0, 0, guideCanvas.width, guideCanvas.height);
  guideCtx.clearRect(card.x, card.y, card.w, card.h);

  // Card outline
  strokeBox(guideCtx, card.x, card.y, card.w, card.h, "rgba(255,255,255,0.92)", null);

  // Name region (scan) - green
  strokeBox(guideCtx, name.x, name.y, name.w, name.h, "rgba(0,255,170,0.98)", "rgba(0,255,170,0.10)");

  // Other regions - subtle white
  strokeBox(guideCtx, art.x, art.y, art.w, art.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
  strokeBox(guideCtx, set.x, set.y, set.w, set.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");
  strokeBox(guideCtx, text.x, text.y, text.w, text.h, "rgba(255,255,255,0.45)", "rgba(255,255,255,0.03)");

  // Lock badge
  if (isLockedActive()) {
    const badge = "LOCKED";
    const pad = 10;
    guideCtx.font = "12px -apple-system, system-ui, Segoe UI, Roboto, sans-serif";
    const w = guideCtx.measureText(badge).width + pad * 2;
    const h = 24;
    const bx = name.x + name.w - w;
    const by = name.y + name.h + 10;

    guideCtx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(guideCtx, bx, by, w, h, 12);
    guideCtx.fill();

    guideCtx.fillStyle = "rgba(0,255,170,0.98)";
    guideCtx.fillText(badge, bx + pad, by + 16);
  }
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
  const dw = r.width;
  const dh = r.height;
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
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const vis = getVisibleSourceRect();
  if (!vis) return null;

  // apply micro y-offset in visible coords (helps if title band is slightly off)
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
  const w = srcCanvas.width;
  const h = srcCanvas.height;
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
  for (let i = 0; i < d.length; i += 4) {
    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
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
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const scale = 2.6;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));

  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = outCtx.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  // Contrast-only grayscale (no binarize)
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
  // Prefer the one that looks less partial; else longer
  const ca = cleanOCR(a?.text || "", a?.words || []);
  const cb = cleanOCR(b?.text || "", b?.words || []);
  const aBad = looksTooPartial(ca);
  const bBad = looksTooPartial(cb);

  if (aBad && !bBad) return { data: b, cleaned: cb };
  if (!aBad && bBad) return { data: a, cleaned: ca };
  if (cb.length > ca.length) return { data: b, cleaned: cb };
  return { data: a, cleaned: ca };
}

// ---------------- Lock-in ----------------
function isLockedActive() {
  return locked && Date.now() < locked.unlockAt;
}

function canComputeAllFields(card) {
  if (!card) return false;
  const earliest = computeEarliestSet(card);
  const pool = goatPoolCheck(earliest);
  return Boolean(earliest && pool.inPool != null);
}

function maybeLockIn(resolved, textForUse, ocrConf) {
  if (!resolved || !resolved.card) return false;
  const now = Date.now();

  // Don't lock (or even "believe") matches when OCR confidence is weak.
  // This prevents "guessy" matches when the read isn't solid.
  if ((ocrConf ?? 0) < 55) return false;

  // PERMANENT lock for exact DB match
  if (resolved.exact === true) {
    locked = { card: resolved.card, method: resolved.method, lockedAt: now, unlockAt: now, ocr: textForUse, permanent: true };
    matchCooldownUntil = now + 900;
    stopAutoScanning(); // save CPU + stop flicker
    return true;
  }

  // Require we can compute all fields (earliest + goat era) before locking
  if (!canComputeAllFields(resolved.card)) return false;
  if (looksTooPartial(textForUse)) return false;

  const id = resolved.card.id;
  const score = resolved.score ?? 1.0;

  // Track stability across consecutive scans
  if (!lastCandidate || lastCandidate.id !== id || now - lastCandidate.lastSeenAt > 2500) {
    lastCandidate = { id, seenCount: 1, bestScore: score, lastSeenAt: now };
  } else {
    lastCandidate.seenCount += 1;
    lastCandidate.bestScore = Math.min(lastCandidate.bestScore, score);
    lastCandidate.lastSeenAt = now;
  }

  // Lock rules:
  // - VERY strong match once => permanent lock
  // - Strong match twice in a row => permanent lock
  const veryStrongOnce = score <= 0.18;
  const strongTwice = lastCandidate.seenCount >= 2 && lastCandidate.bestScore <= 0.40;

  if (veryStrongOnce || strongTwice) {
    locked = { card: resolved.card, method: resolved.method, lockedAt: now, unlockAt: now, ocr: textForUse, permanent: true };
    matchCooldownUntil = now + 900;
    stopAutoScanning();
    return true;
  }

  // Otherwise, do a short temporary lock (helps reduce flicker while you hold steady)
  const tempLock = score <= 0.55;
  if (tempLock) {
    locked = { card: resolved.card, method: resolved.method, lockedAt: now, unlockAt: now + 2000, ocr: textForUse, permanent: false };
    matchCooldownUntil = now + 600;
    return true;
  }

  return false;
}


// ---------------- UI apply ----------------
function applyCardToUI(card, methodText, mergedOcrForUi) {
  cardNameEl.textContent = card?.name || "Not sure";

  const earliest = card ? computeEarliestSet(card) : null;
  const pool = earliest ? goatPoolCheck(earliest) : { inPool: null };
  const b = card ? banStatus(card.id) : "OK";

  if (pool.inPool === true) setOverlay("ok", "✅");
  else if (pool.inPool === false) setOverlay("no", "❌");
  else setOverlay("unknown", "…");

  // IMPORTANT: if we matched a card but earliest/pool is unknown, we still show "Matched" rather than looking stuck.
  goatPoolEl.textContent =
    pool.inPool == null ? "— Unknown (matched card, missing cutoff/date info)" :
    (pool.inPool ? "✅ Included (Goat era)" : "❌ Out of Goat era");

  setBanBadge(b);

  earliestEl.textContent = earliest ? `${earliest.set_name} (${earliest.date})` : "Unknown (missing set dates)";
  if (mergedOcrForUi != null) ocrTextEl.textContent = mergedOcrForUi;

  if (methodText) dbg(methodText);
}

// ---------------- Scan ----------------
async function scanOnce() {
  if (scanBusy) return;
  scanBusy = true;

  try {
    const now = Date.now();
    if (now < matchCooldownUntil) return;

    if (isLockedActive()) {
      applyCardToUI(locked.card, `Locked (${locked.method})`, locked.ocr || ocrTextEl.textContent);
      return;
    }

    // Micro-scan Y offsets (helps when you "have to move the card up/down" to trigger scans)
    const yOffsets = [0.00, 0.03, -0.03];

    // We'll pick the best OCR from: (best Y strip) x (BW vs Gray)
    let bestPick = null; // { cleaned, data }
    let bestStripInfo = "";

    for (let i = 0; i < yOffsets.length; i++) {
      const strip = grabNameStripCanvas(yOffsets[i]);
      if (!strip) continue;

      const bw = preprocessBW(strip);
      const gray = preprocessGray(strip);

      dbg("OCR…");
      setOverlay("unknown", "…");

      const dataBW = await ocrWithWorker(bw);
      const dataG  = await ocrWithWorker(gray);

      const picked = pickBetterOcr(dataBW, dataG);
      if (!bestPick || picked.cleaned.length > bestPick.cleaned.length) {
        bestPick = picked;
        bestStripInfo = `yOffset=${yOffsets[i].toFixed(2)}`;
      }

      // Early exit: if we already got something that looks good, don't waste time
      if (bestPick && !looksTooPartial(bestPick.cleaned) && bestPick.cleaned.length >= 18) break;
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

    // Resolve only after merged OCR is plausible
    const resolved = await resolveCardFromOCR(textForUse);
    if (!resolved.card) {
      resetUI(`No match (${resolved.method}). (${bestStripInfo})`);
      return;
    }

    const lockedNow = maybeLockIn(resolved, textForUse);
    const method = lockedNow
      ? `LOCKED (${resolved.method}, score ${resolved.score.toFixed(2)})`
      : `Matched (${resolved.method}, score ${resolved.score.toFixed(2)})`;

    applyCardToUI(resolved.card, method, textForUse);

  } catch (e) {
    console.error(e);
    resetUI(`ERROR: ${e.message || e}`);
  } finally {
    scanBusy = false;
  }
}

function startScanning() {
  if (scanning) return;
  scanning = true;
  toggleScanBtn.textContent = "Stop Scanning";

  const rate = parseInt(scanRateSel.value, 10) || 900;
  dbg(`Scanning every ${rate}ms…`);

  scanTimer = setInterval(() => {
    if (isLockedActive()) return;
    scanOnce();
  }, rate);

  // Prime buffer
  ocrBuffer = [];
  scanOnce();
  setTimeout(() => { if (scanning) scanOnce(); }, 220);
}

function stopScanning() {
  scanning = false;
  toggleScanBtn.textContent = "Start Scanning";
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  dbg("Scanning stopped.");
}

// ---------------- Boot ----------------
async function initAll() {
  dbg("Loading data…");
  setsRelease = await loadJSON("data/sets_release_dates.json");
  goatBanlist = await loadJSON("data/goat_banlist_2005_04.json");
  goatPoolCfg = await loadJSON("data/goat_pool_cutoff.json");

  await startCamera();

  startBtn.textContent = "Camera Ready";
  dbg("Tap Start Scanning. Put the full card in the big rectangle; put the NAME in the green box.");
  redrawGuide();
}

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

toggleScanBtn.addEventListener("click", () => {
  if (!scanning) startScanning();
  else stopScanning();
});
