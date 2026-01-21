// Register Service Worker for PWA (caching can confuse updates)
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

let setsRelease = {};
let goatBanlist = {};
let goatPoolCfg = null;

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

function normalizeOCR(t) {
  return (t || "")
    .replace(/\n/g, " ")
    .replace(/[^a-zA-Z0-9' -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dateStrToNum(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(x => parseInt(x, 10));
  if (!y || !m || !day) return null;
  return y * 10000 + m * 100 + day;
}

// ---------- YGOPRODeck helpers ----------
async function ygoproLookupExactName(name) {
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return data.data?.[0] || null;
}

// "fname" = fuzzy/partial name search
async function ygoproLookupFuzzyName(fragment) {
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(fragment)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return data.data || [];
}

// Small Levenshtein to score best candidate name
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
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similarityScore(ocr, name) {
  // Lower is better
  const A = (ocr || "").toLowerCase();
  const B = (name || "").toLowerCase();
  const dist = levenshtein(A, B);
  const denom = Math.max(8, Math.max(A.length, B.length));
  return dist / denom;
}

function pickSearchFragment(ocrText) {
  const cleaned = (ocrText || "")
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(w => w.length >= 4);
  if (words.length) {
    words.sort((a, b) => b.length - a.length);
    return words[0];
  }

  return cleaned.slice(0, 10) || cleaned;
}

async function resolveCardFromOCR(ocrText) {
  // 1) try exact
  let card = await ygoproLookupExactName(ocrText);
  if (card) return { card, method: "exact" };

  // 2) fuzzy search with best fragment
  const fragment = pickSearchFragment(ocrText);
  if (!fragment || fragment.length < 3) return { card: null, method: "none" };

  const candidates = await ygoproLookupFuzzyName(fragment);
  if (!candidates.length) return { card: null, method: "fname-empty" };

  let best = null;
  for (const c of candidates.slice(0, 80)) {
    const score = similarityScore(ocrText, c.name);
    if (!best || score < best.score) best = { score, card: c };
  }

  // Require a reasonable score to avoid random wrong matches
  if (best && best.score <= 0.55) {
    return { card: best.card, method: `fname:${fragment} score=${best.score.toFixed(2)}` };
  }

  return { card: null, method: `fname:${fragment} no-good` };
}

// ---------- Goat checks ----------
function computeEarliestSet(card) {
  const sets = card?.card_sets || [];
  let best = null;

  for (const s of sets) {
    const d = setsRelease[s.set_name];
    const dn = dateStrToNum(d);
    if (!dn) continue;

    if (!best || dn < best.dn) {
      best = { dn, date: d, set_name: s.set_name, set_code: s.set_code };
    }
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

  return { inPool: dn <= cutoff };
}

function banStatus(cardId) {
  return goatBanlist[String(cardId)] || "OK";
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

// ---------- Camera + OCR ----------
async function initData() {
  dbg("Loading data…");
  setsRelease = await loadJSON("data/sets_release_dates.json");
  goatBanlist = await loadJSON("data/goat_banlist_2005_04.json");
  goatPoolCfg = await loadJSON("data/goat_pool_cutoff.json");
  dbg("Data loaded. Ready.");
}

async function startCamera() {
  dbg("Requesting camera…");

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });

  await video.play();
  dbg(`Camera OK. videoWidth=${video.videoWidth}, videoHeight=${video.videoHeight}`);
}

/**
 * Crop a forgiving title area near the top.
 * We keep it a bit taller so it still catches the full title bar on different phones.
 */
function grabTitleStripCanvas() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) {
    dbg(`Video not ready (w=${w}, h=${h}).`);
    return null;
  }

  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);

  // Forgiving crop: slightly lower + taller
  const crop = {
    x: Math.floor(w * 0.06),
    y: Math.floor(h * 0.05),
    cw: Math.floor(w * 0.88),
    ch: Math.floor(h * 0.22)
  };

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = crop.cw;
  cropCanvas.height = crop.ch;

  const cropCtx = cropCanvas.getContext("2d");
  cropCtx.drawImage(
    canvas,
    crop.x, crop.y, crop.cw, crop.ch,
    0, 0, crop.cw, crop.ch
  );

  return cropCanvas;
}

/**
 * Preprocess for OCR:
 * - upscale 2x
 * - grayscale + mild contrast
 * - gentle threshold
 */
function preprocessForOCR(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;

  const scale = 2;
  const out = document.createElement("canvas");
  out.width = w * scale;
  out.height = h * scale;

  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = outCtx.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;

    gray = (gray - 128) * 1.15 + 128;
    const v = gray > 120 ? 255 : 0;

    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }

  outCtx.putImageData(img, 0, 0);
  return out;
}

// Create a persistent OCR worker (faster and lets us set PSM)
let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await Tesseract.createWorker("eng");
      // Single line (title bar) improves accuracy
      await w.setParameters({ tessedit_pageseg_mode: "7" });
      return w;
    })();
  }
  return workerPromise;
}

async function ocrCardName(canvasToRead) {
  if (typeof Tesseract === "undefined") {
    throw new Error("Tesseract did not load (CDN blocked/offline).");
  }

  dbg("OCR running…");

  const worker = await getWorker();
  const { data } = await worker.recognize(canvasToRead);
  return normalizeOCR(data.text);
}

async function scanOnce() {
  try {
    const titleStrip = grabTitleStripCanvas();
    if (!titleStrip) return;

    const processed = preprocessForOCR(titleStrip);

    setOverlay("unknown", "…");

    const ocrText = await ocrCardName(processed);
    ocrTextEl.textContent = ocrText || "(no text)";

    if (!ocrText || ocrText.length < 3) {
      dbg("OCR found too little text. Tilt to remove glare from the title bar.");
      cardNameEl.textContent = "Not sure";
      goatPoolEl.textContent = "—";
      earliestEl.textContent = "—";
      setBanBadge("OK");
      return;
    }

    dbg(`Resolving card from OCR: "${ocrText}"…`);
    const resolved = await resolveCardFromOCR(ocrText);

    if (!resolved.card) {
      dbg(`No match yet (${resolved.method}). Hold steadier / reduce glare on the title bar.`);
      cardNameEl.textContent = "Not sure";
      goatPoolEl.textContent = "—";
      earliestEl.textContent = "—";
      setBanBadge("OK");
      setOverlay("unknown", "…");
      return;
    }

    const card = resolved.card;

    cardNameEl.textContent = card.name;

    const earliest = computeEarliestSet(card);
    const pool = goatPoolCheck(earliest);
    const b = banStatus(card.id);

    // ✅/❌ = Goat-era existence ONLY
    if (pool.inPool === true) setOverlay("ok", "✅");
    else if (pool.inPool === false) setOverlay("no", "❌");
    else setOverlay("unknown", "…");

    goatPoolEl.textContent =
      pool.inPool == null ? "— Unknown" : (pool.inPool ? "✅ Included (Goat era)" : "❌ Out of Goat era");

    setBanBadge(b);

    earliestEl.textContent = earliest
      ? `${earliest.set_name} (${earliest.date})`
      : "Unknown (missing set dates)";

    dbg(`Scan OK (${resolved.method}).`);

  } catch (e) {
    console.error(e);
    dbg(`ERROR: ${e.message || e}`);
    setOverlay("unknown", "…");
  }
}

function startScanning() {
  if (scanning) return;
  scanning = true;
  toggleScanBtn.textContent = "Scan New Card";

  const rate = parseInt(scanRateSel.value, 10) || 900;
  dbg(`Scanning every ${rate}ms…`);
  scanTimer = setInterval(scanOnce, rate);
  scanOnce();
}

function stopScanning() {
  scanning = false;
  toggleScanBtn.textContent = "Scan New Card";
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  dbg("Scanning stopped.");
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Loading…";
  try {
    await initData();
    await startCamera();
    startBtn.textContent = "Camera Ready";
    dbg("Tap Start Scanning.");
  } catch (e) {
    console.error(e);
    dbg(`START ERROR: ${e.message || e}`);
    alert("Failed to start. Open in Safari, and allow Camera.");
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
  }
});

toggleScanBtn.addEventListener("click", () => {
  if (!scanning) startScanning();
  else stopScanning();
});
