/**
 * BankShotAI - Detection Module
 *
 * Auto-detects pool table via edge/geometry detection (color-agnostic).
 * Uses Canny + contour finding to locate the largest ~2:1 rectangle.
 * Then detects balls via HoughCircles + color classification.
 */

import {
  BALL_COLORS, BALL_DIAMETER, BALL_RADIUS,
  TABLE_WIDTH, TABLE_LENGTH
} from './table-config.js';

// Expected table aspect ratio (long/short ≈ 2:1)
const TABLE_ASPECT = TABLE_LENGTH / TABLE_WIDTH; // ~2.0
const ASPECT_TOLERANCE = 0.4; // allow 1.6 to 2.4

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
 * @typedef {Object} DetectedBall
 * @property {number} x - table x (mm)
 * @property {number} y - table y (mm)
 * @property {string} color
 * @property {number} number
 * @property {boolean} isStriped
 * @property {number} confidence
 * @property {number} pixelX
 * @property {number} pixelY
 * @property {number} pixelRadius
 */

/**
 * Auto-detect the pool table from a camera frame.
 * Color-agnostic: uses Canny edge detection → contour finding → largest
 * quadrilateral with ~2:1 aspect ratio (pool table proportions).
 *
 * @param {ImageData} imageData
 * @returns {{ corners: number[][], confidence: number } | null}
 *   corners in order: bottom-left, bottom-right, top-right, top-left (video pixel coords)
 */
export function detectTable(imageData) {
  if (!cvReady) return null;

  const cleanup = [];
  const mat = (m) => { cleanup.push(m); return m; };

  try {
    const src = mat(cv.matFromImageData(imageData));
    const gray = mat(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Bilateral filter preserves edges while smoothing
    const filtered = mat(new cv.Mat());
    cv.bilateralFilter(gray, filtered, 9, 75, 75);

    // Canny edge detection
    const edges = mat(new cv.Mat());
    cv.Canny(filtered, edges, 30, 100);

    // Dilate edges to close small gaps
    const kernel = mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const dilated = mat(new cv.Mat());
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 2);

    // Find contours
    const contours = mat(new cv.MatVector());
    const hierarchy = mat(new cv.Mat());
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const totalArea = imageData.width * imageData.height;
    let bestQuad = null;
    let bestScore = 0; // higher = better

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);

      // Table should be at least 5% of frame
      if (area < totalArea * 0.05) continue;

      const peri = cv.arcLength(contour, true);

      // Try multiple epsilon values to find a 4-point approximation
      for (const epsFactor of [0.015, 0.02, 0.03, 0.04, 0.05]) {
        const approx = mat(new cv.Mat());
        cv.approxPolyDP(contour, approx, epsFactor * peri, true);

        if (approx.rows !== 4) continue;
        if (!cv.isContourConvex(approx)) continue;

        // Extract points
        const pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
        }

        // Check aspect ratio ≈ 2:1
        const ordered = _orderCorners(pts);
        const aspect = _quadAspect(ordered);
        if (Math.abs(aspect - TABLE_ASPECT) > ASPECT_TOLERANCE) continue;

        // Check all interior angles are roughly 90° (between 60° and 120°)
        if (!_anglesNearRight(ordered)) continue;

        // Score: prefer larger area, better aspect match
        const areaRatio = area / totalArea;
        const aspectPenalty = Math.abs(aspect - TABLE_ASPECT) / ASPECT_TOLERANCE;
        const score = areaRatio * (1 - aspectPenalty * 0.5);

        if (score > bestScore) {
          bestScore = score;
          bestQuad = ordered;
        }
        break; // found a valid quad at this epsilon, move on
      }
    }

    if (!bestQuad) return null;

    const confidence = Math.min(1, bestScore / 0.15);
    return { corners: bestQuad, confidence };
  } catch (e) {
    console.error('Table detection error:', e);
    return null;
  } finally {
    for (const m of cleanup) {
      try { m.delete(); } catch (_) {}
    }
  }
}

/** Compute aspect ratio (long side / short side) of an ordered quadrilateral. */
function _quadAspect(corners) {
  // corners: BL, BR, TR, TL
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const bottom = d(corners[0], corners[1]);
  const right  = d(corners[1], corners[2]);
  const top    = d(corners[2], corners[3]);
  const left   = d(corners[3], corners[0]);

  const avgShort = (bottom + top) / 2;
  const avgLong  = (left + right) / 2;

  // Return long/short regardless of orientation
  return avgLong > avgShort ? avgLong / avgShort : avgShort / avgLong;
}

/** Check that all 4 interior angles are between 60° and 120°. */
function _anglesNearRight(corners) {
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const ba = [a[0] - b[0], a[1] - b[1]];
    const bc = [c[0] - b[0], c[1] - b[1]];
    const dot = ba[0] * bc[0] + ba[1] * bc[1];
    const mag = Math.hypot(...ba) * Math.hypot(...bc);
    if (mag < 1e-6) return false;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot / mag))) * (180 / Math.PI);
    if (angle < 60 || angle > 120) return false;
  }
  return true;
}

/**
 * Order 4 points as: bottom-left, bottom-right, top-right, top-left.
 * "Bottom" = higher Y value in image coords (lower on table).
 */
function _orderCorners(pts) {
  // Sort by sum (x+y) and difference (x-y)
  const sorted = [...pts];

  // Centroid
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;

  const topLeft = sorted.find(p => p[0] < cx && p[1] < cy) || sorted[0];
  const topRight = sorted.find(p => p[0] >= cx && p[1] < cy) || sorted[1];
  const bottomRight = sorted.find(p => p[0] >= cx && p[1] >= cy) || sorted[2];
  const bottomLeft = sorted.find(p => p[0] < cx && p[1] >= cy) || sorted[3];

  // Return: bottom-left, bottom-right, top-right, top-left
  return [bottomLeft, bottomRight, topRight, topLeft];
}


export class BallDetector {
  constructor() {
    this.transformMatrix = null;
  }

  /**
   * Detect balls from an ImageData with table corners.
   * @param {ImageData} imageData
   * @param {number[][]} tableCorners - 4 corners [BL, BR, TR, TL] in pixel coords
   * @returns {DetectedBall[]}
   */
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

    const circles = this._findCircles(warped);
    const balls = [];

    for (const [cx, cy, r] of circles) {
      const result = this._classifyBall(warped, cx, cy, r);
      if (!result) continue;

      const [color, isStriped, confidence] = result;
      const [tx, ty] = this._pixelToTable(cx, cy, warped.rows, warped.cols);
      const number = this._colorToNumber(color, isStriped);

      balls.push({ x: tx, y: ty, color, number, isStriped, confidence, pixelX: cx, pixelY: cy, pixelRadius: r });
    }

    warped.delete();
    return this._resolveDuplicates(balls);
  }

  _warpToTable(bgr, corners) {
    const scale = 0.5;
    const dstW = Math.round(TABLE_WIDTH * scale);
    const dstH = Math.round(TABLE_LENGTH * scale);

    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, dstH, dstW, dstH, dstW, 0, 0, 0,
    ]);

    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    this.transformMatrix = M;

    const warped = new cv.Mat();
    cv.warpPerspective(bgr, warped, M, new cv.Size(dstW, dstH));

    srcPts.delete(); dstPts.delete(); M.delete();
    return warped;
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
    const minR = Math.max(5, Math.round(expectedR * 0.6));
    const maxR = Math.max(10, Math.round(expectedR * 1.5));
    const minDist = Math.max(10, Math.round(expectedR * 1.8));

    // Auto-detect felt color: sample center region of warped table image,
    // find the dominant HSV hue, then mask out felt (any color).
    const hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    const feltMask = this._autoFeltMask(hsv, w, h);
    const notFelt = new cv.Mat();
    cv.bitwise_not(feltMask, notFelt);
    hsv.delete(); feltMask.delete();

    const circles = new cv.Mat();
    cv.HoughCircles(blurred, circles, cv.HOUGH_GRADIENT, 1.2, minDist, 50, 30, minR, maxR);
    blurred.delete();

    const result = [];
    for (let i = 0; i < circles.cols; i++) {
      const cx = Math.round(circles.data32F[i * 3]);
      const cy = Math.round(circles.data32F[i * 3 + 1]);
      const r = Math.round(circles.data32F[i * 3 + 2]);

      if (cx >= 0 && cx < w && cy >= 0 && cy < h) {
        const y1 = Math.max(0, cy - 3), y2 = Math.min(h, cy + 3);
        const x1 = Math.max(0, cx - 3), x2 = Math.min(w, cx + 3);
        let sum = 0, count = 0;
        for (let yy = y1; yy < y2; yy++) {
          for (let xx = x1; xx < x2; xx++) {
            sum += notFelt.ucharAt(yy, xx);
            count++;
          }
        }
        if (count > 0 && sum / count > 100) {
          result.push([cx, cy, r]);
        }
      }
    }

    circles.delete(); notFelt.delete();
    return result;
  }

  /**
   * Auto-detect felt color by sampling the center of the (warped) table image.
   * Returns a mask where felt pixels = 255.
   */
  _autoFeltMask(hsv, w, h) {
    // Sample center 40% of image (most likely pure felt, no rails)
    const cx1 = Math.round(w * 0.3), cx2 = Math.round(w * 0.7);
    const cy1 = Math.round(h * 0.3), cy2 = Math.round(h * 0.7);
    const roi = hsv.roi(new cv.Rect(cx1, cy1, cx2 - cx1, cy2 - cy1));

    // Compute mean H, S, V of the center region
    const mean = cv.mean(roi);
    roi.delete();
    const meanH = mean[0], meanS = mean[1], meanV = mean[2];

    // Build an HSV range around the dominant felt color
    const hRange = 20, sRange = 60, vRange = 60;
    const lo = new cv.Mat(1, 1, cv.CV_8UC3, new cv.Scalar(
      Math.max(0, meanH - hRange),
      Math.max(0, meanS - sRange),
      Math.max(0, meanV - vRange)
    ));
    const hi = new cv.Mat(1, 1, cv.CV_8UC3, new cv.Scalar(
      Math.min(180, meanH + hRange),
      Math.min(255, meanS + sRange),
      Math.min(255, meanV + vRange)
    ));

    const mask = new cv.Mat();
    cv.inRange(hsv, lo, hi, mask);
    lo.delete(); hi.delete();
    return mask;
  }

  _classifyBall(bgr, cx, cy, r) {
    const h = bgr.rows, w = bgr.cols;
    const y1 = Math.max(0, cy - r), y2 = Math.min(h, cy + r);
    const x1 = Math.max(0, cx - r), x2 = Math.min(w, cx + r);

    const roi = bgr.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));
    if (roi.rows === 0 || roi.cols === 0) { roi.delete(); return null; }

    const mask = new cv.Mat.zeros(roi.rows, roi.cols, cv.CV_8UC1);
    const cr = Math.min(r, Math.floor(roi.rows / 2), Math.floor(roi.cols / 2));
    cv.circle(mask, new cv.Point(Math.floor(roi.cols / 2), Math.floor(roi.rows / 2)), cr, new cv.Scalar(255), -1);

    const hsvRoi = new cv.Mat();
    cv.cvtColor(roi, hsvRoi, cv.COLOR_BGR2HSV);

    const whiteMask = new cv.Mat();
    const wlo = new cv.Mat(1, 1, cv.CV_8UC3, new cv.Scalar(0, 0, 200));
    const whi = new cv.Mat(1, 1, cv.CV_8UC3, new cv.Scalar(180, 40, 255));
    cv.inRange(hsvRoi, wlo, whi, whiteMask);
    wlo.delete(); whi.delete();
    const whiteInBall = new cv.Mat();
    cv.bitwise_and(whiteMask, mask, whiteInBall);
    const maskCount = cv.countNonZero(mask);
    const whiteRatio = maskCount > 0 ? cv.countNonZero(whiteInBall) / maskCount : 0;
    whiteMask.delete(); whiteInBall.delete();

    let bestColor = null, bestScore = 0;
    for (const [colorName, info] of Object.entries(BALL_COLORS)) {
      const colorMask = new cv.Mat();
      const clo = new cv.Mat(1, 1, cv.CV_8UC3, new cv.Scalar(...info.hsvLow));
      const chi = new cv.Mat(1, 1, cv.CV_8UC3, new cv.Scalar(...info.hsvHigh));
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
    if (bestColor === 'white' && whiteRatio > 0.6) return ['white', false, Math.min(1, whiteRatio)];
    if (bestColor === 'black') return ['black', false, Math.min(1, bestScore)];

    const isStriped = whiteRatio > 0.15 && whiteRatio < 0.65;
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
}
