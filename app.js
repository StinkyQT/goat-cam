// Goat Cam — ARTWORK-FIRST BUILD
// Purpose: Mimic YGO fast-scan feel using lightweight visual fingerprinting.
// Flow:
// 1. Extract artwork region
// 2. Compute average-hash (aHash)
// 3. Narrow DB candidates
// 4. OCR only as confirmation

function computeAHash(canvas, size=8) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.drawImage(canvas, 0, 0, size, size);
  const data = ctx.getImageData(0,0,size,size).data;
  let sum = 0, gray = [];
  for (let i=0;i<data.length;i+=4) {
    const g = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    gray.push(g);
    sum += g;
  }
  const avg = sum / gray.length;
  return gray.map(v => v > avg ? 1 : 0).join("");
}

function hamming(a,b) {
  let d=0;
  for (let i=0;i<a.length;i++) if (a[i]!==b[i]) d++;
  return d;
}

// Example precomputed mini-hash DB (extend later)
const artworkDB = {
  "Mystical Space Typhoon": "1010100011100101",
  "Elemental HERO Burstinatrix": "1101010100101011"
};

async function fastArtworkScan() {
  dbg("Artwork scan…");

  const art = grabArtRegionCanvas(); // uses GUIDE.art
  if (!art) return;

  const hash = computeAHash(art);

  let best = null;
  for (const [name,h] of Object.entries(artworkDB)) {
    const d = hamming(hash,h);
    if (!best || d < best.d) best = { name, d };
  }

  if (best && best.d <= 10) {
    dbg(`Visual match: ${best.name}`);
    const exact = await ygoproLookupExactName(best.name);
    if (exact) {
      locked = { card: exact, ocr: best.name, permanent: true };
      applyCardToUI(exact, "LOCKED (artwork match)", best.name);
    }
  }
}
