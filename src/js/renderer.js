/**
 * BankShotAI - Canvas Overlay Renderer
 *
 * Two modes:
 * 1. Photo-overlay mode: draws balls/shots directly on captured photo using
 *    inverse perspective transform to map table coords → photo pixel coords.
 * 2. Synthetic mode (demo): draws a green table rectangle with fixed mapping.
 */

import {
  TABLE_WIDTH, TABLE_LENGTH, BALL_RADIUS, BALL_DIAMETER,
  POCKETS, CORNER_POCKET_OPENING, SIDE_POCKET_OPENING,
  BALL_COLORS
} from './table-config.js?v=1771959798';
import { DIFFICULTY } from './physics.js?v=1771959798';

const DIFF_COLORS = {
  [DIFFICULTY.EASY]:      '#00e676',
  [DIFFICULTY.MEDIUM]:    '#ffeb3b',
  [DIFFICULTY.HARD]:      '#ff9800',
  [DIFFICULTY.VERY_HARD]: '#f44336',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // Synthetic table mapping (demo mode)
    this.scaleX = 1;
    this.scaleY = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this._pulsePhase = 0;

    // Photo-overlay mode state
    this._photoMode = false;
    this._detector = null;       // BallDetector instance with inverse matrix
    this._tableCorners = null;   // 4 corners in photo pixel coords [BL, BR, TR, TL]
    this._photoWidth = 0;        // original photo width
    this._photoHeight = 0;       // original photo height
  }

  /**
   * Enable photo-overlay mode.
   * @param {object} detector - BallDetector with tableToPhoto/photoToTable methods
   * @param {number[][]} tableCorners - 4 corners in photo pixel coords
   * @param {number} photoWidth - original captured photo width
   * @param {number} photoHeight - original captured photo height
   */
  setPhotoMode(detector, tableCorners, photoWidth, photoHeight) {
    this._photoMode = true;
    this._detector = detector;
    this._tableCorners = tableCorners;
    this._photoWidth = photoWidth;
    this._photoHeight = photoHeight;
  }

  clearPhotoMode() {
    this._photoMode = false;
    this._detector = null;
    this._tableCorners = null;
  }

  resize(containerWidth, containerHeight) {
    this.canvas.width = containerWidth;
    this.canvas.height = containerHeight;

    const padding = 20;
    const availW = containerWidth - padding * 2;
    const availH = containerHeight - padding * 2;
    const tableAspect = TABLE_WIDTH / TABLE_LENGTH;
    const screenAspect = availW / availH;

    let drawW, drawH;
    if (screenAspect > tableAspect) {
      drawH = availH;
      drawW = drawH * tableAspect;
    } else {
      drawW = availW;
      drawH = drawW / tableAspect;
    }

    this.scaleX = drawW / TABLE_WIDTH;
    this.scaleY = drawH / TABLE_LENGTH;
    this.offsetX = (containerWidth - drawW) / 2;
    this.offsetY = (containerHeight - drawH) / 2;
  }

  /**
   * Convert table coords (mm) to canvas pixel coords.
   * In photo mode, uses inverse perspective transform → photo coords → canvas scaling.
   * In demo mode, uses fixed linear mapping.
   */
  toCanvas(tx, ty) {
    if (this._photoMode && this._detector) {
      const [photoX, photoY] = this._detector.tableToPhoto(tx, ty);
      // Scale from photo pixel coords to canvas (screen) coords
      const canvasX = (photoX / this._photoWidth) * this.canvas.width;
      const canvasY = (photoY / this._photoHeight) * this.canvas.height;
      return [canvasX, canvasY];
    }
    // Synthetic/demo mode
    return [
      this.offsetX + tx * this.scaleX,
      this.offsetY + (TABLE_LENGTH - ty) * this.scaleY,
    ];
  }

  /**
   * Convert canvas pixel coords to table coords (mm).
   * In photo mode, uses forward perspective transform.
   * In demo mode, uses fixed linear mapping.
   */
  toTable(cx, cy) {
    if (this._photoMode && this._detector) {
      // Scale from canvas to photo pixel coords
      const photoX = (cx / this.canvas.width) * this._photoWidth;
      const photoY = (cy / this.canvas.height) * this._photoHeight;
      return this._detector.photoToTable(photoX, photoY);
    }
    // Synthetic/demo mode
    return [
      (cx - this.offsetX) / this.scaleX,
      TABLE_LENGTH - (cy - this.offsetY) / this.scaleY,
    ];
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._pulsePhase = (this._pulsePhase + 0.04) % (Math.PI * 2);
  }

  /** Draw table surface, rails, pockets. Only used in demo/synthetic mode. */
  drawTable() {
    if (this._photoMode) {
      // In photo mode, draw a subtle table outline over the photo
      this._drawPhotoTableOutline();
      return;
    }

    const ctx = this.ctx;
    const [x0, y0] = this.toCanvas(0, 0);
    const [x1, y1] = this.toCanvas(TABLE_WIDTH, TABLE_LENGTH);
    const w = x1 - x0;
    const h = y0 - y1;

    ctx.fillStyle = 'rgba(0, 100, 50, 0.3)';
    ctx.fillRect(x0, y1, w, h);

    ctx.strokeStyle = '#5d4037';
    ctx.lineWidth = 4;
    ctx.strokeRect(x0, y1, w, h);

    // Pockets
    const pocketR = CORNER_POCKET_OPENING * this.scaleX * 0.4;
    for (const [name, pos] of Object.entries(POCKETS)) {
      const [px, py] = this.toCanvas(pos[0], pos[1]);
      const r = name.startsWith('side') ? SIDE_POCKET_OPENING * this.scaleX * 0.4 : pocketR;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1a';
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Head string
    const [hsx, hsy] = this.toCanvas(0, TABLE_LENGTH * 0.25);
    const [hex, hey] = this.toCanvas(TABLE_WIDTH, TABLE_LENGTH * 0.25);
    ctx.beginPath();
    ctx.moveTo(hsx, hsy);
    ctx.lineTo(hex, hey);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Foot spot
    const [fsx, fsy] = this.toCanvas(TABLE_WIDTH / 2, TABLE_LENGTH * 0.75);
    ctx.beginPath();
    ctx.arc(fsx, fsy, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fill();
  }

  /** Draw the inner cushion/bumper edges on the photo — where bank shots bounce. */
  _drawPhotoTableOutline() {
    if (!this._tableCorners) return;
    const ctx = this.ctx;

    // Map the 4 table corners (BL, BR, TR, TL) to canvas coords
    const corners = this._tableCorners.map(c => [
      (c[0] / this._photoWidth) * this.canvas.width,
      (c[1] / this._photoHeight) * this.canvas.height,
    ]);

    // Draw the inner cushion line — bright yellow/green
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    ctx.lineTo(corners[1][0], corners[1][1]);
    ctx.lineTo(corners[2][0], corners[2][1]);
    ctx.lineTo(corners[3][0], corners[3][1]);
    ctx.closePath();

    // Glow effect
    ctx.save();
    ctx.shadowColor = '#00e676';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // Corner dots at pocket positions
    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c[0], c[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = '#00e676';
      ctx.fill();
    }

    // Side pocket midpoints
    const midLeft = [(corners[0][0] + corners[3][0]) / 2, (corners[0][1] + corners[3][1]) / 2];
    const midRight = [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2];
    for (const mp of [midLeft, midRight]) {
      ctx.beginPath();
      ctx.arc(mp[0], mp[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = '#00e676';
      ctx.fill();
    }
  }

  /**
   * Draw balls with selection highlighting and pulse effect.
   */
  drawBalls(balls, cueIdx = null, targetIdx = null, hintType = null) {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(this._pulsePhase);

    // Ball radius in canvas pixels — estimate from two known table points
    let r;
    if (this._photoMode) {
      // Estimate ball radius by mapping a ball-width offset
      const [cx1] = this.toCanvas(0, TABLE_LENGTH / 2);
      const [cx2] = this.toCanvas(BALL_DIAMETER, TABLE_LENGTH / 2);
      r = Math.max(6, Math.abs(cx2 - cx1) / 2);
    } else {
      r = BALL_RADIUS * this.scaleX;
    }

    balls.forEach((ball, i) => {
      const [cx, cy] = this.toCanvas(ball.x, ball.y);
      const info = BALL_COLORS[ball.color];
      const fillColor = info ? info.hex : '#888';
      const isSelected = (i === cueIdx || i === targetIdx);

      // Pulsing hint ring for tappable balls
      if (hintType === 'cue' && ball.color === 'white' && cueIdx === null) {
        this._drawPulseRing(cx, cy, r + 6, '#00e5ff', pulse);
      } else if (hintType === 'target' && ball.color !== 'white' && i !== cueIdx && targetIdx === null) {
        this._drawPulseRing(cx, cy, r + 4, '#ff9800', pulse * 0.6);
      }

      // Selection glow
      if (isSelected) {
        const glowColor = i === cueIdx ? '#00e5ff' : '#ff5722';
        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = glowColor;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
      }

      // Ball body
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (ball.isStriped) {
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = fillColor;
        ctx.fillRect(cx - r, cy - r * 0.45, r * 2, r * 0.9);
        ctx.restore();
      } else {
        ctx.fillStyle = fillColor;
        ctx.fill();
      }

      // Cue ball distinct look
      if (ball.color === 'white') {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Number
      if (ball.number > 0) {
        ctx.fillStyle = (ball.color === 'black' || ball.color === 'blue' || ball.color === 'maroon') ? '#fff' : '#000';
        ctx.font = `bold ${Math.max(8, r * 0.9)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ball.number), cx, cy);
      }
    });
  }

  _drawPulseRing(cx, cy, r, color, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha * 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * Draw pockets as tappable targets.
   * In photo mode, pocket positions are mapped via inverse perspective to photo coords.
   */
  drawPocketHighlights(activePocket = null) {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(this._pulsePhase);

    for (const [name, pos] of Object.entries(POCKETS)) {
      const [px, py] = this.toCanvas(pos[0], pos[1]);
      const r = this._photoMode ? 15 :
        (name.startsWith('side') ? SIDE_POCKET_OPENING * this.scaleX * 0.45 : CORNER_POCKET_OPENING * this.scaleX * 0.45);

      if (activePocket && activePocket === name) {
        ctx.beginPath();
        ctx.arc(px, py, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.save();
        ctx.globalAlpha = 0.3 + pulse * 0.3;
        ctx.beginPath();
        ctx.arc(px, py, r + 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffeb3b';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // In photo mode, draw a small target crosshair at pocket positions
      if (this._photoMode) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py);
        ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8);
        ctx.strokeStyle = activePocket === name ? '#00e676' : '#ffeb3b';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * Draw all shot paths.
   */
  drawShots(shots, maxShots = 8) {
    const ctx = this.ctx;
    const toDraw = shots.slice(0, maxShots);

    for (let i = toDraw.length - 1; i >= 0; i--) {
      const shot = toDraw[i];
      const color = DIFF_COLORS[shot.difficulty] || '#fff';
      const thickness = i === 0 ? 4 : Math.max(1.5, 3 - i * 0.4);
      const alpha = i === 0 ? 1.0 : Math.max(0.25, 0.7 - i * 0.1);

      ctx.save();
      ctx.globalAlpha = alpha;

      for (let s = 0; s < shot.pathSegments.length; s++) {
        const [from, to] = shot.pathSegments[s];
        const [fx, fy] = this.toCanvas(from[0], from[1]);
        const [tx, ty] = this.toCanvas(to[0], to[1]);

        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = color;
        ctx.lineWidth = s === 0 ? thickness * 0.7 : thickness;
        if (s === 0) ctx.setLineDash([6, 4]);
        else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);

        this._drawArrowHead(fx, fy, tx, ty, color, thickness);
      }

      // Ghost ball
      const [ax, ay] = this.toCanvas(shot.aimPoint[0], shot.aimPoint[1]);
      let ballR;
      if (this._photoMode) {
        const [cx1] = this.toCanvas(0, TABLE_LENGTH / 2);
        const [cx2] = this.toCanvas(BALL_DIAMETER, TABLE_LENGTH / 2);
        ballR = Math.max(6, Math.abs(cx2 - cx1) / 2);
      } else {
        ballR = BALL_RADIUS * this.scaleX;
      }

      ctx.beginPath();
      ctx.arc(ax, ay, ballR, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(ax - 4, ay); ctx.lineTo(ax + 4, ay);
      ctx.moveTo(ax, ay - 4); ctx.lineTo(ax, ay + 4);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();

      for (const bp of shot.bankPoints) {
        const [bx, by] = this.toCanvas(bp[0], bp[1]);
        this._drawBounceIndicator(bx, by, color);
      }

      const [px, py] = this.toCanvas(shot.targetPocket[0], shot.targetPocket[1]);
      ctx.beginPath();
      ctx.arc(px, py, i === 0 ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.restore();
    }

    if (toDraw.length > 0) {
      const best = toDraw[0];
      const color = DIFF_COLORS[best.difficulty];
      this._drawDifficultyBadge(best.difficulty, color);
    }
  }

  _drawArrowHead(fx, fy, tx, ty, color, size) {
    const ctx = this.ctx;
    const mx = (fx + tx) / 2;
    const my = (fy + ty) / 2;
    const angle = Math.atan2(ty - fy, tx - fx);
    const len = Math.max(5, size * 2.5);

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(len, 0);
    ctx.lineTo(-len * 0.5, -len * 0.6);
    ctx.lineTo(-len * 0.5, len * 0.6);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  _drawBounceIndicator(x, y, color) {
    const ctx = this.ctx;
    const s = 10;

    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s * 0.6, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s * 0.6, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, s * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  _drawDifficultyBadge(difficulty, color) {
    const ctx = this.ctx;
    const labels = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', very_hard: 'VERY HARD' };
    const label = labels[difficulty] || difficulty;

    const x = this.canvas.width / 2;
    const y = this.canvas.height - 20;

    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    const tw = ctx.measureText(label).width;
    const px = 8, py = 4;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    ctx.roundRect(x - tw / 2 - px, y - 8 - py, tw + px * 2, 16 + py * 2, 6);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
    ctx.restore();
  }

  drawTableOutline(corners) {
    if (!corners || corners.length !== 4) return;
    const ctx = this.ctx;

    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) {
      ctx.lineTo(corners[i][0], corners[i][1]);
    }
    ctx.closePath();
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 3;
    ctx.stroke();

    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c[0], c[1], 6, 0, Math.PI * 2);
      ctx.fillStyle = '#00e676';
      ctx.fill();
    }
  }

  drawScanningOverlay() {
    const ctx = this.ctx;
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const size = Math.min(this.canvas.width, this.canvas.height) * 0.35;
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 3;
    const half = size / 2;
    const arm = size * 0.2;

    ctx.beginPath();
    ctx.moveTo(cx - half, cy - half + arm);
    ctx.lineTo(cx - half, cy - half);
    ctx.lineTo(cx - half + arm, cy - half);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + half - arm, cy - half);
    ctx.lineTo(cx + half, cy - half);
    ctx.lineTo(cx + half, cy - half + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + half, cy + half - arm);
    ctx.lineTo(cx + half, cy + half);
    ctx.lineTo(cx + half - arm, cy + half);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - half + arm, cy + half);
    ctx.lineTo(cx - half, cy + half);
    ctx.lineTo(cx - half, cy + half - arm);
    ctx.stroke();

    ctx.restore();
  }
}
