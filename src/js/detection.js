/**
 * BankShotAI - Detection Module
 *
 * Table detection: dominant color region → largest quadrilateral (any felt color).
 * Ball detection: perspective warp → HoughCircles → felt-color rejection → color classification.
 */

import {
  BALL_COLORS, BALL_DIAMETER, BALL_RADIUS,
  TABLE_WIDTH, TABLE_LENGTH
} from './table-config.js?v=1771961872';

const TABLE_ASPECT = TABLE_LENGTH / TABLE_WIDTH; // ~2.0
const ASPECT_TOLERANCE = 0.6;

let cvReady = false;
let cvLoadPromise = null;

export function loadOpenCV(onProgress) {
  if (cvReady && typeof cv !== 'undefined') return Promise.resolve();
  if (cvLoadPromise) return cvLoadPromise;

  cvLoadPromise = new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv.Mat) {
      cvReady = true;
      resolve();
      return;
    }

    if (onProgress) onProgress('Loading OpenCV.js...');

    window.Module = window.Module || {};
    const origInit = window.Module.onRuntimeInitialized;
    window.Module.onRuntimeInitialized = () => {
      if (origInit) origInit();
      cvReady = true;
      if (onProgress) onProgress('OpenCV ready');
      resolve();
    };

    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    script.onload = () => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        cvReady = true;
        if (onProgress) onProgress('OpenCV ready');
        resolve();
      }
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(script);
  });
  return cvLoadPromise;
}

export function isOpenCVReady() { return cvReady; }

/**
 * Auto-detect the pool table from a camera frame.
 * Strategy: find the dominant uniform color region (the felt),
 * then approximate it as a quadrilateral.
 * Works with any felt color (green, blue, red, etc.)
 */
export function detectTable(imageData) {
  if (!cvReady) return null;

  const cleanup = [];
  const mat = (m) => { cleanup.push(m); return m; };

  try {
    const src = mat(cv.matFromImageData(imageData));
    const bgr = mat(new cv.Mat());
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    const hsv = mat(new cv.Mat());
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);

    // Sample center region to find dominant felt color
    const w = imageData.width, h = imageData.height;
    const roi = hsv.roi(new cv.Rect(
      Math.round(w * 0.25), Math.round(h * 0.25),
      Math.round(w * 0.5), Math.round(h * 0.5)
    ));
    const mean = cv.mean(roi);
    roi.delete();
    const mH = mean[0], mS = mean[1], mV = mean[2];

    console.log(`[detectTable] Center HSV: H=${mH.toFixed(0)}, S=${mS.toFixed(0)}, V=${mV.toFixed(0)}`);

    // Create felt mask using the dominant color
    // Use matFromArray for reliable inRange in OpenCV.js
    const loH = Math.round(Math.max(0, mH - 20));
    const loS = Math.round(Math.max(20, mS - 60));
    const loV = Math.round(Math.max(20, mV - 60));
    const hiH = Math.round(Math.min(180, mH + 20));
    const hiS = Math.round(Math.min(255, mS + 60));
    const hiV = Math.round(Math.min(255, mV + 60));
    console.log(`[detectTable] Mask range: [${loH},${loS},${loV}] - [${hiH},${hiS},${hiV}]`);

    const lo = mat(new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(loH, loS, loV)));
    const hi = mat(new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(hiH, hiS, hiV)));
    const mask = mat(new cv.Mat());
    cv.inRange(hsv, lo, hi, mask);

    // Debug: count non-zero pixels in mask
    const maskPixels = cv.countNonZero(mask);
    console.log(`[detectTable] Mask pixels: ${maskPixels} / ${w*h} (${(maskPixels/(w*h)*100).toFixed(1)}%)`);

    // Morphological cleanup
    const kernel = mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15)));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);

    // Find contours
    const contours = mat(new cv.MatVector());
    const hierarchy = mat(new cv.Mat());
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const totalArea = w * h;
    let bestQuad = null;
    let bestArea = 0;

    console.log(`[detectTable] Found ${contours.size()} contours`);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      console.log(`[detectTable] Contour ${i}: area=${area.toFixed(0)} (${(area/totalArea*100).toFixed(1)}%)`);
      if (area < totalArea * 0.1) continue;
      if (area <= bestArea) continue;

      const peri = cv.arcLength(contour, true);
      for (const eps of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]) {
        const approx = mat(new cv.Mat());
        cv.approxPolyDP(contour, approx, eps * peri, true);
        console.log(`[detectTable]   eps=${eps}: ${approx.rows} points`);

        if (approx.rows === 4) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
          }

          // Check aspect ratio
          const ordered = _orderCorners(pts);
          const aspect = _quadAspect(ordered);
          console.log(`[detectTable]   4-point quad: aspect=${aspect.toFixed(2)}, target=${TABLE_ASPECT.toFixed(2)}±${ASPECT_TOLERANCE}, corners=`, pts);
          if (Math.abs(aspect - TABLE_ASPECT) > ASPECT_TOLERANCE) {
            console.log(`[detectTable]   Rejected: aspect ${aspect.toFixed(2)} outside tolerance`);
            break;
          }

          bestArea = area;
          bestQuad = ordered;
          break;
        }
      }
    }

    if (!bestQuad) {
      console.log('[detectTable] No valid table quadrilateral found');
      return null;
    }

    console.log(`[detectTable] Found table: ${(bestArea/totalArea*100).toFixed(1)}% of frame, corners:`, bestQuad);
    const confidence = Math.min(1, (bestArea / totalArea) / 0.3);

    // Shrink quadrilateral inward so corners land inside pockets
    // The felt contour is at the outer rail edge; bumper cushion nose is significantly inward
    const inset = _insetQuad(bestQuad, 0.14);
    console.log(`[detectTable] Inset corners:`, inset);

    return { corners: inset, confidence };
  } catch (e) {
    console.error('Table detection error:', e);
    return null;
  } finally {
    for (const m of cleanup) {
      try { m.delete(); } catch (_) {}
    }
  }
}

function _quadAspect(corners) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const bottom = d(corners[0], corners[1]);
  const right  = d(corners[1], corners[2]);
  const top    = d(corners[2], corners[3]);
  const left   = d(corners[3], corners[0]);
  const avgW = (bottom + top) / 2;
  const avgH = (left + right) / 2;
  return Math.max(avgW, avgH) / Math.min(avgW, avgH);
}

function _orderCorners(pts) {
  // Sort corners clockwise from centroid, then assign BL/BR/TR/TL
  // based on the table being a landscape rectangle (wider than tall in real life)
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  
  // Sort by angle from centroid (clockwise from top = -PI/2)
  const withAngle = pts.map(p => ({
    pt: p,
    angle: Math.atan2(p[1] - cy, p[0] - cx)
  }));
  withAngle.sort((a, b) => a.angle - b.angle);
  // Now sorted counter-clockwise from right (angle -PI to PI)
  // Rearrange: we have 4 points in CCW order starting from ~rightmost
  
  // Split into top two (lower y) and bottom two (higher y)
  const byY = [...pts].sort((a, b) => a[1] - b[1]);
  const topTwo = byY.slice(0, 2);   // smaller y = higher in image
  const botTwo = byY.slice(2, 4);   // larger y = lower in image
  
  // Within each pair, sort by x
  topTwo.sort((a, b) => a[0] - b[0]);
  botTwo.sort((a, b) => a[0] - b[0]);
  
  const tl = topTwo[0];
  const tr = topTwo[1];
  const bl = botTwo[0];
  const br = botTwo[1];

  console.log(`[_orderCorners] TL=${tl}, TR=${tr}, BL=${bl}, BR=${br}`);
  return [bl, br, tr, tl]; // BL, BR, TR, TL
}

/**
 * Shrink a quadrilateral inward by a fraction of its size.
 * Each corner moves toward the centroid by `frac` of its distance.
 * This makes corners land inside the pockets where cushion lines would intersect.
 */
function _insetQuad(corners, frac) {
  const cx = corners.reduce((s, c) => s + c[0], 0) / 4;
  const cy = corners.reduce((s, c) => s + c[1], 0) / 4;
  return corners.map(c => [
    c[0] + (cx - c[0]) * frac,
    c[1] + (cy - c[1]) * frac,
  ]);
}


export class BallDetector {
  constructor() {
    this.transformMatrix = null;
    this.inverseMatrix = null;
    this.warpWidth = 0;
    this.warpHeight = 0;
    this._feltH = 0;
    this._feltS = 0;
    this._feltV = 0;
  }

  detect(imageData, tableCorners = null) {
    if (!cvReady) throw new Error('OpenCV not loaded');

    let src = cv.matFromImageData(imageData);
    let bgr = new cv.Mat();
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    src.delete();

    let warped;
    if (tableCorners) {
      warped = this._warpToTable(bgr, tableCorners);
      bgr.delete();
    } else {
      warped = bgr;
    }

    // Detect felt color from warped image center
    this._detectFeltColor(warped);

    const circles = this._findCircles(warped);
    const balls = [];

    console.log(`[BallDetector] ${circles.length} circle candidates after filtering`);

    for (const [cx, cy, r] of circles) {
      const result = this._classifyBall(warped, cx, cy, r);
      if (!result) continue;

      const [color, isStriped, confidence] = result;
      const [tx, ty] = this._pixelToTable(cx, cy, warped.rows, warped.cols);
      const number = this._colorToNumber(color, isStriped);

      balls.push({ x: tx, y: ty, color, number, isStriped, confidence, pixelX: cx, pixelY: cy, pixelRadius: r });
    }

    console.log(`[BallDetector] ${balls.length} classified balls:`, balls.map(b => `${b.color}(${b.number})`).join(', '));

    warped.delete();
    return this._resolveDuplicates(balls);
  }

  _warpToTable(bgr, corners) {
    const scale = 1.0;
    const dstW = Math.round(TABLE_WIDTH * scale);
    const dstH = Math.round(TABLE_LENGTH * scale);
    this.warpWidth = dstW;
    this.warpHeight = dstH;

    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, dstH, dstW, dstH, dstW, 0, 0, 0,
    ]);

    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    this.transformMatrix = M.clone();
    const Minv = cv.getPerspectiveTransform(dstPts, srcPts);
    this.inverseMatrix = Minv.clone();

    const warped = new cv.Mat();
    cv.warpPerspective(bgr, warped, M, new cv.Size(dstW, dstH));

    srcPts.delete(); dstPts.delete(); M.delete(); Minv.delete();
    return warped;
  }

  _detectFeltColor(bgr) {
    const hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    const w = bgr.cols, h = bgr.rows;
    const roi = hsv.roi(new cv.Rect(
      Math.round(w * 0.3), Math.round(h * 0.3),
      Math.round(w * 0.4), Math.round(h * 0.4)
    ));
    const mean = cv.mean(roi);
    roi.delete(); hsv.delete();
    this._feltH = mean[0];
    this._feltS = mean[1];
    this._feltV = mean[2];
    console.log(`[BallDetector] Felt HSV: H=${this._feltH.toFixed(0)}, S=${this._feltS.toFixed(0)}, V=${this._feltV.toFixed(0)}`);
  }

  _isFeltColor(h, s, v) {
    // Check if a pixel's HSV is close to the felt color
    return Math.abs(h - this._feltH) < 20 &&
           Math.abs(s - this._feltS) < 50 &&
           Math.abs(v - this._feltV) < 50;
  }

  _findCircles(bgr) {
    const gray = new cv.Mat();
    cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);

    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 2);
    gray.delete();

    const w = bgr.cols, h = bgr.rows;
    const pxPerMm = w / TABLE_WIDTH;
    const expectedR = Math.round(BALL_RADIUS * pxPerMm);
    const minR = Math.max(8, Math.round(expectedR * 0.6));
    const maxR = Math.max(15, Math.round(expectedR * 1.5));
    const minDist = Math.max(20, Math.round(expectedR * 2.0));

    console.log(`[BallDetector] Image: ${w}x${h}, expectedR=${expectedR}, range=[${minR},${maxR}]`);

    // Detect circles — param2=25 is a good balance for warped images
    const circles = new cv.Mat();
    cv.HoughCircles(blurred, circles, cv.HOUGH_GRADIENT, 1.2, minDist, 50, 25, minR, maxR);
    blurred.delete();

    console.log(`[BallDetector] HoughCircles raw: ${circles.cols} circles`);

    // Get HSV for felt filtering
    const hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);

    const result = [];
    for (let i = 0; i < circles.cols; i++) {
      const cx = Math.round(circles.data32F[i * 3]);
      const cy = Math.round(circles.data32F[i * 3 + 1]);
      const r = Math.round(circles.data32F[i * 3 + 2]);

      if (cx < r || cx >= w - r || cy < r || cy >= h - r) continue;

      // Check if center pixel is felt-colored → skip (it's not a ball)
      const ch = hsv.ucharAt(cy, cx * 3);
      const cs = hsv.ucharAt(cy, cx * 3 + 1);
      const cv_ = hsv.ucharAt(cy, cx * 3 + 2);

      if (this._isFeltColor(ch, cs, cv_)) {
        // Sample a few more points inside the circle to be sure
        let feltCount = 0;
        const samples = [[0,0], [-r/2,0], [r/2,0], [0,-r/2], [0,r/2]];
        for (const [dx, dy] of samples) {
          const sx = Math.round(cx + dx), sy = Math.round(cy + dy);
          if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
            const sh = hsv.ucharAt(sy, sx * 3);
            const ss = hsv.ucharAt(sy, sx * 3 + 1);
            const sv = hsv.ucharAt(sy, sx * 3 + 2);
            if (this._isFeltColor(sh, ss, sv)) feltCount++;
          }
        }
        // If most samples are felt, skip this circle
        if (feltCount >= 3) continue;
      }

      result.push([cx, cy, r]);
    }

    circles.delete(); hsv.delete();
    console.log(`[BallDetector] After felt filter: ${result.length} circles`);
    return result;
  }

  _classifyBall(bgr, cx, cy, r) {
    const h = bgr.rows, w = bgr.cols;
    const y1 = Math.max(0, cy - r), y2 = Math.min(h, cy + r);
    const x1 = Math.max(0, cx - r), x2 = Math.min(w, cx + r);
    if (x2 - x1 < 4 || y2 - y1 < 4) return null;

    const roi = bgr.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));
    const mask = new cv.Mat.zeros(roi.rows, roi.cols, cv.CV_8UC1);
    const cr = Math.min(r, Math.floor(roi.rows / 2), Math.floor(roi.cols / 2));
    cv.circle(mask, new cv.Point(Math.floor(roi.cols / 2), Math.floor(roi.rows / 2)), cr, new cv.Scalar(255), -1);

    const hsvRoi = new cv.Mat();
    cv.cvtColor(roi, hsvRoi, cv.COLOR_BGR2HSV);

    // Check white ratio
    const whiteMask = new cv.Mat();
    const wlo = new cv.Mat(hsvRoi.rows, hsvRoi.cols, cv.CV_8UC3, new cv.Scalar(0, 0, 170));
    const whi = new cv.Mat(hsvRoi.rows, hsvRoi.cols, cv.CV_8UC3, new cv.Scalar(180, 50, 255));
    cv.inRange(hsvRoi, wlo, whi, whiteMask);
    wlo.delete(); whi.delete();
    const whiteInBall = new cv.Mat();
    cv.bitwise_and(whiteMask, mask, whiteInBall);
    const maskCount = cv.countNonZero(mask);
    const whiteRatio = maskCount > 0 ? cv.countNonZero(whiteInBall) / maskCount : 0;
    whiteMask.delete(); whiteInBall.delete();

    // Score each color
    let bestColor = null, bestScore = 0;
    for (const [colorName, info] of Object.entries(BALL_COLORS)) {
      const colorMask = new cv.Mat();
      const clo = new cv.Mat(hsvRoi.rows, hsvRoi.cols, cv.CV_8UC3, new cv.Scalar(...info.hsvLow));
      const chi = new cv.Mat(hsvRoi.rows, hsvRoi.cols, cv.CV_8UC3, new cv.Scalar(...info.hsvHigh));
      cv.inRange(hsvRoi, clo, chi, colorMask);
      clo.delete(); chi.delete();
      const colorInBall = new cv.Mat();
      cv.bitwise_and(colorMask, mask, colorInBall);
      const score = maskCount > 0 ? cv.countNonZero(colorInBall) / maskCount : 0;
      if (score > bestScore) { bestScore = score; bestColor = colorName; }
      colorMask.delete(); colorInBall.delete();
    }

    roi.delete(); mask.delete(); hsvRoi.delete();

    if (!bestColor || bestScore < 0.05) return null;
    if (bestColor === 'white' && whiteRatio > 0.5) return ['white', false, Math.min(1, whiteRatio)];
    if (bestColor === 'black') return ['black', false, Math.min(1, bestScore)];

    const isStriped = whiteRatio > 0.12 && whiteRatio < 0.65;
    const confidence = bestScore > 0.1 ? Math.min(1, bestScore + 0.2) : bestScore;
    return [bestColor, isStriped, confidence];
  }

  _colorToNumber(color, isStriped) {
    if (color === 'white') return 0;
    if (color === 'black') return 8;
    const base = BALL_COLORS[color]?.number ?? -1;
    if (base < 0) return -1;
    return isStriped ? base + 8 : base;
  }

  _pixelToTable(px, py, imgH, imgW) {
    const tx = (px / imgW) * TABLE_WIDTH;
    const ty = ((imgH - py) / imgH) * TABLE_LENGTH;
    return [tx, ty];
  }

  _resolveDuplicates(balls) {
    balls.sort((a, b) => b.confidence - a.confidence);
    const kept = [];
    for (const ball of balls) {
      const tooClose = kept.some(e => Math.hypot(ball.x - e.x, ball.y - e.y) < BALL_DIAMETER * 1.5);
      if (!tooClose) kept.push(ball);
    }
    return kept;
  }

  /**
   * Convert table coordinates to photo pixel coordinates.
   */
  tableToPhoto(tx, ty) {
    if (!this.inverseMatrix) return [tx, ty];
    const px = (tx / TABLE_WIDTH) * this.warpWidth;
    const py = (1 - ty / TABLE_LENGTH) * this.warpHeight;
    // Apply inverse perspective transform
    const d = this.inverseMatrix.data64F;
    const denom = d[6] * px + d[7] * py + d[8];
    const ox = (d[0] * px + d[1] * py + d[2]) / denom;
    const oy = (d[3] * px + d[4] * py + d[5]) / denom;
    return [ox, oy];
  }

  /**
   * Convert photo pixel coordinates to table coordinates.
   */
  photoToTable(ox, oy) {
    if (!this.transformMatrix) return [ox, oy];
    const d = this.transformMatrix.data64F;
    const denom = d[6] * ox + d[7] * oy + d[8];
    const px = (d[0] * ox + d[1] * oy + d[2]) / denom;
    const py = (d[3] * ox + d[4] * oy + d[5]) / denom;
    const tx = (px / this.warpWidth) * TABLE_WIDTH;
    const ty = (1 - py / this.warpHeight) * TABLE_LENGTH;
    return [tx, ty];
  }
}
