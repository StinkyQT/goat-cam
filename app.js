// Goat Cam — TAP-TO-FREEZE BUILD
// Purpose: Maximum reliability. Mimics Neuron/YGO behavior.
// Flow:
// 1. Live camera preview (no OCR spam)
// 2. User taps "Scan Card"
// 3. Freeze single frame
// 4. OCR ONCE
// 5. Lock result permanently until "Scan New Card"

let frozen = false;
let frozenFrame = null;

// Reuse existing camera + OCR helpers from your last stable build
// (This file assumes all previous OCR + DB logic exists unchanged)

async function freezeFrame() {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  frozenFrame = c;
  frozen = true;
}

async function scanFrozenFrame() {
  if (!frozenFrame) return;
  dbg("Scanning frozen frame…");

  const strip = grabNameStripCanvas(0, frozenFrame);
  if (!strip) {
    resetUI("Couldn't isolate name");
    return;
  }

  const bw = preprocessBW(strip);
  const data = await ocrWithWorker(bw);
  const cleaned = cleanOCR(data.text, data.words);

  if (looksTooPartial(cleaned)) {
    resetUI("Hold steadier / reduce glare");
    return;
  }

  const resolved = await resolveCardFromOCR(cleaned);
  if (!resolved.card) {
    resetUI("No match");
    return;
  }

  locked = {
    card: resolved.card,
    ocr: cleaned,
    permanent: true
  };

  applyCardToUI(resolved.card, "LOCKED (freeze scan)", cleaned);
}

toggleScanBtn.addEventListener("click", async () => {
  if (!frozen) {
    await freezeFrame();
    await scanFrozenFrame();
  } else {
    frozen = false;
    frozenFrame = null;
    locked = null;
    resetUI("Scan new card");
  }
});
