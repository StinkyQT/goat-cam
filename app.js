// Goat Cam - app.js
// Stable rollback build: keeps layout untouched (NO fullscreen CSS / no DOM moving).
// Improvements:
// - No flicker: only paints ✅/❌ + goat/ban/earliest once we LOCK a stable match.
// - Less guessing: exact match first; fuzzy only if strong.
// - Auto scanning starts after camera; Scan button clears lock for next card.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js", { scope: "./" }); } catch {}
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

function dbg(msg) { if (debugEl) debugEl.textContent = msg || ""; 
function compactUiForCamera() {
  // Goal: avoid scrolling on iPhone by shrinking the big title/header area ONLY after camera is active.
  try {
    // Shrink any H1/H2 that contains "Goat Cam"
    const headers = Array.from(document.querySelectorAll("h1,h2"));
    for (const h of headers) {
      if ((h.textContent || "").toLowerCase().includes("goat cam")) {
        h.style.fontSize = "28px";
        h.style.lineHeight = "1.05";
        h.style.margin = "10px 0 6px 0";
      }
    }

    // Reduce extra top padding/margins on body/main if present
    document.body.style.marginTop = "0px";
    document.body.style.paddingTop = "0px";

    // If still overflowing, hide the title entirely (camera mode only)
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow > 6) {
      for (const h of headers) {
        if ((h.textContent || "").toLowerCase().includes("goat cam")) {
          h.style.display = "none";
        }
      }
    }
  } catch (e) {}
}

function ensureNoScrollIfPossible() {
  // Re-run a few times after camera start because Safari reflows after permission + video play.
  let tries = 0;
  const tick = () => {
    tries++;
    compactUiForCamera();
    if (tries < 8) setTimeout(tick, 180);
  };
  tick();
}
}

function setOverlay(state, markText) {
  bigMark.classList.remove("ok", "no", "unknown");
  bigMark.classList.add(state);
  bigMark.textContent = markText;
}
function setBanBadge(status) {
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
  cardNameEl.textContent = "Not sure";
  goatPoolEl.textContent = "—";
  earliestEl.textContent = "—";
  setBanBadge("—");
  if (reason) dbg(reason);
}

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}`);
  return await r.json();
}

let setsRelease = {};
let goatBanlist = {};
let goatPoolCfg = null;

function dateStrToNum(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(x => parseInt(x, 10));
  if (!y || !m || !day) return null;
  return y * 10000 + m * 100 + day;
}

// ---------- YGOPRO ----------
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
  if (!m) return n;
  if (!n) return m;
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
  return dist / denom; // lower better
}
function pickSearchFragment(ocrText) {
  const cleaned = (ocrText || "").toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").replace(/\s+/g, " ").trim();
  const stop = new Set(["the", "of", "and", "a", "an"]);
  const words = cleaned.split(" ").filter(w => w.length >= 4 && !stop.has(w));
  if (words.length) { words.sort((a, b) => b.length - a.length); return words[0]; }
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
  // strict to avoid guessing
  if (best && best.score <= 0.38) return { card: best.card, method: `fname:${fragment}`, score: best.score, exact: false };
  return { card: null, method: `fname:${fragment} no-good`, score: best ? best.score : 1.0, exact: false };
}

// ---------- Goat checks ----------
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
  if (!cutoffDate || !earliest?.date) return { inPool: null };
  const cutoff = dateStrToNum(cutoffDate);
  const dn = dateStrToNum(earliest.date);
  if (!cutoff || !dn) return { inPool: null };
  return { inPool: dn <= cutoff, cutoffDate };
}
function banStatus(cardId) { return goatBanlist[String(cardId)] || "OK"; }

function applyCardToUI(card, methodText, ocrText) {
  cardNameEl.textContent = card?.name || "Not sure";
  const earliest = card ? computeEarliestSet(card) : null;
  const pool = earliest ? goatPoolCheck(earliest) : { inPool: null };
  const b = card ? banStatus(card.id) : "—";

  if (pool.inPool === true) setOverlay("ok", "✅");
  else if (pool.inPool === false) setOverlay("no", "❌");
  else setOverlay("unknown", "…");

  goatPoolEl.textContent = pool.inPool == null ? "— Unknown"
    : (pool.inPool ? "✅ Included (Goat era)" : "❌ Out of Goat era");

  setBanBadge(b);
  earliestEl.textContent = earliest ? `${earliest.set_name} (${earliest.date})` : "Unknown";
  if (ocrTextEl) ocrTextEl.textContent = ocrText || "";
  if (methodText) dbg(methodText);
}

// ---------- OCR cleanup ----------
function basicNormalize(t) {
  return (t || "").replace(/\n/g, " ").replace(/[^\w'\-: ]/g, " ").replace(/\s+/g, " ").trim();
}
function stripJunkPrefixes(t) {
  let s = (t || "").trim();
  s = s.replace(/^(?:I{1,3}|IV|V|VI{0,3}|1|l|L)\s+/i, "");
  s = s.replace(/^[\-\:\;\'\"\.,]+/, "").trim();
  s = s.replace(/[:;,.\-]+$/, "").trim();
  return s;
}
function cleanFromWords(words) {
  const good = [];
  for (const w of (words || [])) {
    const txt = (w.text || "").trim();
    const conf = Number.isFinite(w.confidence) ? w.confidence : 0;
    if (/[A-Za-z]/.test(txt) && txt.length >= 2 && conf >= 50) good.push(txt);
  }
  return stripJunkPrefixes(basicNormalize(good.join(" ")));
}
function cleanOCR(rawText, words) {
  const byWords = cleanFromWords(words);
  let s = (byWords && byWords.length >= 5) ? byWords : stripJunkPrefixes(basicNormalize(rawText || ""));
  if (s.includes(":")) {
    const left = s.split(":")[0].trim();
    if (left.length >= 5) s = left;
  }
  s = s.replace(/\bFLEMENTAL\b/gi, "ELEMENTAL");
  return stripJunkPrefixes(s).trim();
}
function looksTooPartial(cleaned) {
  if (!cleaned) return true;
  if (!/[A-Za-z]/.test(cleaned)) return true;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return true;
  if (cleaned.length < 7) return true;
  return !words.some(w => w.length >= 4);
}

// ---------- Preprocess ----------
function preprocessBW(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const scale = 2.6;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = octx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
  const mean = sum / (d.length / 4);
  const threshold = Math.max(80, Math.min(180, mean * 0.90));

  for (let i = 0; i < d.length; i += 4) {
    let gray = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    gray = (gray - 128) * 1.10 + 128;
    const v = gray > threshold ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
    d[i+3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}
function preprocessGray(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const scale = 2.6;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(srcCanvas, 0, 0, out.width, out.height);

  const img = octx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let gray = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    gray = (gray - 128) * 1.18 + 128;
    gray = Math.max(0, Math.min(255, gray));
    d[i] = d[i+1] = d[i+2] = gray;
    d[i+3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ---------- Tesseract ----------
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
  const w = await getWorker();
  const { data } = await w.recognize(canvasToRead);
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

// ---------- Template overlay ----------
let guideCanvas = null;
let guideCtx = null;
const GUIDE = {
  card: { x: 0.10, y: 0.14, w: 0.80, h: 0.74 },
  name: { x: 0.13, y: 0.17, w: 0.74, h: 0.11 },
  art:  { x: 0.13, y: 0.30, w: 0.74, h: 0.36 },
  set:  { x: 0.13, y: 0.67, w: 0.74, h: 0.08 },
  text: { x: 0.13, y: 0.76, w: 0.74, h: 0.12 }
};
const CROP = GUIDE.name;

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
  setInterval(() => { if (scanning && !locked) redrawGuide(); }, 200);
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
  c.strokeStyle = stroke; c.lineWidth = 2; roundRect(c, x, y, w, h, 12); c.stroke();
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

// ---------- object-fit aware crop mapping ----------
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

// ---------- Scan loop + stable lock ----------
let scanning = false;
let scanTimer = null;
let scanBusy = false;
let locked = null;
let lastCandidate = null;

function lockResult(card, method, ocrText) {
  // Safety: don't lock if we can't compute earliest+pool (avoids "LOCKED" with Unknown fields)
  const earliestCheck = computeEarliestSet(card);
  const poolCheck = earliestCheck ? goatPoolCheck(earliestCheck) : { inPool: null };
  if (!earliestCheck || poolCheck.inPool == null) {
    dbg("Not locking yet — need full info. Hold steady.");
    return;
  }
  locked = { card, method, ocr: ocrText, permanent: true };
  applyCardToUI(card, `LOCKED (${method})`, ocrText);
  scanning = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

function updateCandidateStability(cardId, score) {
  const now = Date.now();
  if (!lastCandidate || lastCandidate.id !== cardId || now - lastCandidate.lastSeenAt > 2500) {
    lastCandidate = { id: cardId, seenCount: 1, bestScore: score, lastSeenAt: now };
  } else {
    lastCandidate.seenCount += 1;
    lastCandidate.bestScore = Math.min(lastCandidate.bestScore, score);
    lastCandidate.lastSeenAt = now;
  }
  return lastCandidate;
}

async function scanOnce() {
  if (scanBusy || locked) return;
  scanBusy = true;
  try {
    const yOffsets = [0.00, 0.03, -0.03];
    let bestPick = null;

    for (const yo of yOffsets) {
      const strip = grabNameStripCanvas(yo);
      if (!strip) continue;

      dbg("Reading name…");
      setOverlay("unknown", "…");

      const dataBW = await ocrWithWorker(preprocessBW(strip));
      const dataG  = await ocrWithWorker(preprocessGray(strip));
      const picked = pickBetterOcr(dataBW, dataG);

      if (!bestPick || picked.cleaned.length > bestPick.cleaned.length) bestPick = picked;
      if (bestPick && !looksTooPartial(bestPick.cleaned) && bestPick.cleaned.length >= 18) break;
    }

    if (!bestPick) { dbg("Camera not ready yet…"); return; }

    const cleaned = bestPick.cleaned;
    if (ocrTextEl) ocrTextEl.textContent = cleaned || "";

    if (looksTooPartial(cleaned)) { dbg("Too little title text — reduce glare + hold steady."); return; }

    const resolved = await resolveCardFromOCR(cleaned);
    if (!resolved.card) { dbg("No confident match yet."); return; }

    if (resolved.exact) { lockResult(resolved.card, "exact", cleaned); return; }

    const st = updateCandidateStability(resolved.card.id, resolved.score ?? 1.0);
    const stableEnough = (st.seenCount >= 2 && st.bestScore <= 0.34);
    if (stableEnough) { lockResult(resolved.card, `fuzzy ${st.bestScore.toFixed(2)}`, cleaned); return; }

    dbg("Matching… hold steady (waiting to lock)");
  } catch (e) {
    console.error(e);
    dbg(`ERROR: ${e.message || e}`);
  } finally {
    scanBusy = false;
  }
}

function startAutoScanning() {
  if (scanning) return;
  scanning = true;
  toggleScanBtn.textContent = "Scan New Card";
  const rate = parseInt(scanRateSel?.value, 10) || 900;
  dbg("Auto-scanning… (locks when stable)");
  scanTimer = setInterval(scanOnce, rate);
  scanOnce();
}

// ---------- Camera ----------
async function startCamera() {
  dbg("Requesting camera…");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await new Promise(resolve => (video.onloadedmetadata = () => resolve()));
  await video.play();

  ensureGuideOverlay();
  redrawGuide();
  ensureNoScrollIfPossible();
  dbg("Camera OK. Scanning…");}

// ---------- Boot / controls ----------
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Loading…";
  try {
    resetUI("Loading data…");
    setsRelease = await loadJSON("data/sets_release_dates.json");
    goatBanlist = await loadJSON("data/goat_banlist_2005_04.json");
    goatPoolCfg = await loadJSON("data/goat_pool_cutoff.json");

    await startCamera();
    startBtn.textContent = "Camera Ready";
    resetUI("Line up card; name in green box. Hold steady.");
    startAutoScanning();
  } catch (e) {
    console.error(e);
    alert("Failed to start. Open in Safari and allow Camera.");
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
    resetUI(e.message || String(e));
  }
});

toggleScanBtn.addEventListener("click", async () => {
  // Always: clear lock + restart scanning for next card
  locked = null;
  lastCandidate = null;
  resetUI("Scan new card…");
  if (!scanning) startAutoScanning();
  await scanOnce();
});
