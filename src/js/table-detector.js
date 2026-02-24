/**
 * BankShotAI - Table Detector using TensorFlow.js COCO-SSD
 * 
 * Uses a pre-trained object detection model to find the pool table,
 * then refines with OpenCV for exact bumper/pocket positions.
 */

let model = null;
let loading = false;

/**
 * Load COCO-SSD model. Call early so it's ready when needed.
 * @param {function} onProgress - callback for loading status
 */
export async function loadTableDetector(onProgress) {
  if (model) return;
  if (loading) return;
  loading = true;

  if (onProgress) onProgress('Loading table detector...');

  // cocoSsd is loaded as a global from the script tag
  if (typeof cocoSsd === 'undefined') {
    throw new Error('COCO-SSD script not loaded');
  }

  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  console.log('[TableDetector] COCO-SSD model loaded');
  loading = false;
}

export function isDetectorReady() {
  return model !== null;
}

/**
 * Detect pool table in an image.
 * COCO-SSD detects "dining table" which covers pool tables.
 * Returns { bbox: [x, y, w, h], confidence } or null.
 */
export async function detectTableRegion(imageElement) {
  if (!model) return null;

  const predictions = await model.detect(imageElement);
  console.log('[TableDetector] All predictions:', predictions.map(p => `${p.class}(${(p.score*100).toFixed(0)}%)`).join(', '));

  // Look for "dining table" — COCO's closest class to pool table
  // Also check "bench", "tv" as fallbacks that sometimes fire on pool tables
  const tableClasses = ['dining table', 'bench', 'sports ball'];
  
  let best = null;
  for (const pred of predictions) {
    if (pred.class === 'dining table' && pred.score > 0.3) {
      if (!best || pred.score > best.score) {
        best = pred;
      }
    }
  }

  if (!best) {
    // Try any large detection as fallback
    for (const pred of predictions) {
      const area = pred.bbox[2] * pred.bbox[3];
      const imgArea = imageElement.width * imageElement.height;
      if (area > imgArea * 0.15 && pred.score > 0.4) {
        if (!best || pred.score > best.score) best = pred;
      }
    }
  }

  if (!best) {
    console.log('[TableDetector] No table detected');
    return null;
  }

  console.log(`[TableDetector] Found: ${best.class} (${(best.score*100).toFixed(0)}%) bbox=${best.bbox.map(v=>v.toFixed(0)).join(',')}`);
  return {
    bbox: best.bbox,
    confidence: best.score,
    label: best.class
  };
}

/**
 * Given a COCO-SSD bounding box and the original image,
 * use OpenCV to find the exact felt region and pocket corners within that box.
 */
export function refineTableWithCV(imageData, bbox) {
  if (typeof cv === 'undefined' || !cv.Mat) return null;

  const cleanup = [];
  const mat = (m) => { cleanup.push(m); return m; };

  try {
    const [bx, by, bw, bh] = bbox.map(Math.round);
    const src = mat(cv.matFromImageData(imageData));
    
    // Crop to bounding box (with some padding)
    const pad = Math.round(Math.max(bw, bh) * 0.05);
    const rx = Math.max(0, bx - pad);
    const ry = Math.max(0, by - pad);
    const rw = Math.min(imageData.width - rx, bw + pad * 2);
    const rh = Math.min(imageData.height - ry, bh + pad * 2);
    const roi = mat(src.roi(new cv.Rect(rx, ry, rw, rh)));

    // Convert to HSV and find dominant color (felt)
    const hsv = mat(new cv.Mat());
    cv.cvtColor(roi, hsv, cv.COLOR_RGBA2HSV);
    
    const centerRoi = hsv.roi(new cv.Rect(
      Math.round(rw * 0.25), Math.round(rh * 0.25),
      Math.round(rw * 0.5), Math.round(rh * 0.5)
    ));
    const mean = cv.mean(centerRoi);
    centerRoi.delete();
    
    const mH = mean[0], mS = mean[1], mV = mean[2];
    console.log(`[refineTableWithCV] Felt HSV in bbox: H=${mH.toFixed(0)}, S=${mS.toFixed(0)}, V=${mV.toFixed(0)}`);

    // Mask felt color
    const loH = Math.max(0, mH - 20), hiH = Math.min(180, mH + 20);
    const loS = Math.max(20, mS - 60), hiS = Math.min(255, mS + 60);
    const loV = Math.max(20, mV - 60), hiV = Math.min(255, mV + 60);

    const lo = mat(new cv.Mat(rh, rw, cv.CV_8UC3, new cv.Scalar(loH, loS, loV)));
    const hi = mat(new cv.Mat(rh, rw, cv.CV_8UC3, new cv.Scalar(hiH, hiS, hiV)));
    const mask = mat(new cv.Mat());
    cv.inRange(hsv, lo, hi, mask);

    const kernel = mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11)));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);

    // Find largest contour → approximate as quad
    const contours = mat(new cv.MatVector());
    const hierarchy = mat(new cv.Mat());
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestQuad = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < rw * rh * 0.1) continue;
      if (area <= bestArea) continue;

      const peri = cv.arcLength(contour, true);
      for (const eps of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]) {
        const approx = mat(new cv.Mat());
        cv.approxPolyDP(contour, approx, eps * peri, true);
        if (approx.rows === 4) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            // Offset back to full image coords
            pts.push([
              approx.data32S[j * 2] + rx,
              approx.data32S[j * 2 + 1] + ry
            ]);
          }
          bestArea = area;
          bestQuad = _orderCornersLocal(pts);
          break;
        }
      }
    }

    if (!bestQuad) {
      console.log('[refineTableWithCV] No quad found in bbox');
      return null;
    }

    // Now find pockets (dark blobs near corners) in full image
    const gray = mat(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blurred = mat(new cv.Mat());
    cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 0);

    const pocketCorners = [];
    const labels = ['BL', 'BR', 'TR', 'TL'];
    const diag = Math.hypot(imageData.width, imageData.height);
    const searchR = Math.round(diag * 0.06);

    for (let i = 0; i < 4; i++) {
      const [cx, cy] = bestQuad[i];
      const x0 = Math.max(0, Math.round(cx - searchR));
      const y0 = Math.max(0, Math.round(cy - searchR));
      const x1 = Math.min(imageData.width, Math.round(cx + searchR));
      const y1 = Math.min(imageData.height, Math.round(cy + searchR));
      const roiW = x1 - x0, roiH = y1 - y0;

      if (roiW < 10 || roiH < 10) { pocketCorners.push(bestQuad[i]); continue; }

      const searchRoi = blurred.roi(new cv.Rect(x0, y0, roiW, roiH));
      const thresh = mat(new cv.Mat());
      cv.threshold(searchRoi, thresh, 60, 255, cv.THRESH_BINARY_INV);
      searchRoi.delete();

      const pContours = mat(new cv.MatVector());
      const pHier = mat(new cv.Mat());
      cv.findContours(thresh, pContours, pHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let pBestArea = 0, pCx = cx, pCy = cy;
      for (let j = 0; j < pContours.size(); j++) {
        const cnt = pContours.get(j);
        const a = cv.contourArea(cnt);
        if (a > pBestArea) {
          const m = cv.moments(cnt);
          if (m.m00 > 0) {
            pBestArea = a;
            pCx = x0 + m.m10 / m.m00;
            pCy = y0 + m.m01 / m.m00;
          }
        }
      }

      console.log(`[refineTableWithCV] ${labels[i]}: felt=(${cx.toFixed(0)},${cy.toFixed(0)}) → pocket=(${pCx.toFixed(0)},${pCy.toFixed(0)})`);
      pocketCorners.push([pCx, pCy]);
    }

    return pocketCorners;
  } catch (e) {
    console.error('[refineTableWithCV] Error:', e);
    return null;
  } finally {
    for (const m of cleanup) {
      try { m.delete(); } catch (_) {}
    }
  }
}

function _orderCornersLocal(pts) {
  const byY = [...pts].sort((a, b) => a[1] - b[1]);
  const topTwo = byY.slice(0, 2).sort((a, b) => a[0] - b[0]);
  const botTwo = byY.slice(2, 4).sort((a, b) => a[0] - b[0]);
  return [botTwo[0], botTwo[1], topTwo[1], topTwo[0]]; // BL, BR, TR, TL
}
