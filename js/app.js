/**
 * BankShotAI - Main App Controller
 *
 * State machine: SCANNING → READY → CUE_SELECTED → TARGET_SELECTED → SHOWING_SHOT
 * Auto table detection, no manual corner taps.
 */

import { Camera } from './camera.js';
import { BallDetector, loadOpenCV, isOpenCVReady, detectTable } from './detection.js';
import { Renderer } from './renderer.js';
import { BankShotCalculator } from './physics.js';
import { createSyntheticBalls, TABLE_WIDTH, TABLE_LENGTH, BALL_DIAMETER, POCKETS } from './table-config.js';

const STATE = {
  LOADING:         'loading',
  SCANNING:        'scanning',
  READY:           'ready',
  CUE_SELECTED:    'cue_selected',
  TARGET_SELECTED: 'target_selected',
  SHOWING_SHOT:    'showing_shot',
};

class App {
  constructor() {
    this.video = document.getElementById('camera-feed');
    this.overlay = document.getElementById('overlay');
    this.statusText = document.getElementById('status-text');
    this.toolbar = document.getElementById('toolbar');
    this.loadingOverlay = document.getElementById('loading-overlay');

    this.camera = new Camera(this.video);
    this.renderer = new Renderer(this.overlay);
    this.detector = new BallDetector();
    this.calculator = new BankShotCalculator();

    this.state = STATE.LOADING;
    this.tableCorners = null;     // video pixel coords [BL, BR, TR, TL]
    this.canvasCorners = null;    // corners mapped to canvas coords (for outline drawing)
    this.balls = [];
    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;   // pocket name
    this.shots = [];              // shots for selected pocket
    this.captureCanvas = document.createElement('canvas');
    this._scanTimer = null;
    this._demoMode = false;

    this._init();
  }

  async _init() {
    this._setState(STATE.LOADING);
    this._bindEvents();
    this._resize();

    // Load OpenCV
    try {
      await loadOpenCV((msg) => this._setStatus(msg));
    } catch (e) {
      this._setStatus('OpenCV failed — demo mode only');
    }

    // Start camera
    try {
      await this.camera.start();
    } catch (e) {
      this._setStatus('No camera — using demo mode');
      this._demoMode = true;
    }

    // Hide loading overlay
    if (this.loadingOverlay) this.loadingOverlay.classList.add('hidden');

    if (this._demoMode) {
      this._enterDemoMode();
    } else {
      this._setState(STATE.SCANNING);
      this._startScanning();
    }

    this._renderLoop();
  }

  _bindEvents() {
    window.addEventListener('resize', () => this._resize());
    this.overlay.addEventListener('click', (e) => {
      const rect = this.overlay.getBoundingClientRect();
      this._handleTap(e.clientX - rect.left, e.clientY - rect.top);
    });
    this.overlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      const rect = this.overlay.getBoundingClientRect();
      this._handleTap(t.clientX - rect.left, t.clientY - rect.top);
    });
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.overlay.width = w;
    this.overlay.height = h;
    this.renderer.resize(w, h);
  }

  // --- Tap handling ---

  _handleTap(x, y) {
    switch (this.state) {
      case STATE.READY:
        this._onBallTap(x, y, 'cue');
        break;
      case STATE.CUE_SELECTED:
        this._onBallTap(x, y, 'target');
        break;
      case STATE.TARGET_SELECTED:
        this._onPocketTap(x, y);
        break;
      case STATE.SHOWING_SHOT:
        // Allow re-tapping a different pocket
        this._onPocketTap(x, y);
        break;
    }
  }

  _onBallTap(x, y, type) {
    const [tx, ty] = this.renderer.toTable(x, y);
    let closest = -1, minDist = Infinity;

    this.balls.forEach((ball, i) => {
      if (type === 'target' && i === this.selectedCue) return;
      const d = Math.hypot(ball.x - tx, ball.y - ty);
      if (d < minDist) { minDist = d; closest = i; }
    });

    if (closest < 0 || minDist > BALL_DIAMETER * 3) return;

    if (type === 'cue') {
      this.selectedCue = closest;
      this._setState(STATE.CUE_SELECTED);
    } else {
      this.selectedTarget = closest;
      this._setState(STATE.TARGET_SELECTED);
    }
  }

  _onPocketTap(x, y) {
    // Find closest pocket to tap position
    let bestPocket = null, bestDist = Infinity;
    for (const [name, pos] of Object.entries(POCKETS)) {
      const [px, py] = this.renderer.toCanvas(pos[0], pos[1]);
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) { bestDist = d; bestPocket = name; }
    }

    // Must be within reasonable tap distance
    const maxTapDist = Math.max(40, BALL_DIAMETER * this.renderer.scaleX * 2);
    if (!bestPocket || bestDist > maxTapDist) return;

    this.selectedPocket = bestPocket;
    this._calculateShots();
    this._setState(STATE.SHOWING_SHOT);
  }

  // --- Table scanning ---

  _startScanning() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._scanTimer = setInterval(() => this._scanForTable(), 500);
  }

  _stopScanning() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
  }

  _scanForTable() {
    if (!this.camera.running || !isOpenCVReady()) return;

    const imageData = this.camera.captureFrame(this.captureCanvas);
    if (!imageData) return;

    const result = detectTable(imageData);
    if (result && result.confidence > 0.3) {
      this._stopScanning();
      this.tableCorners = result.corners;

      // Map corners from video pixel coords to canvas overlay coords
      const vw = this.camera.videoWidth || this.overlay.width;
      const vh = this.camera.videoHeight || this.overlay.height;
      const cw = this.overlay.width;
      const ch = this.overlay.height;
      this.canvasCorners = this.tableCorners.map(([vx, vy]) => [
        (vx / vw) * cw,
        (vy / vh) * ch,
      ]);

      // Detect balls
      this._detectBalls(imageData);
    }
  }

  _detectBalls(imageData = null) {
    if (!isOpenCVReady()) return;
    if (!imageData) {
      imageData = this.camera.captureFrame(this.captureCanvas);
    }
    if (!imageData && !this._demoMode) return;

    if (this._demoMode || !imageData) {
      this.balls = createSyntheticBalls();
    } else {
      try {
        this.balls = this.detector.detect(imageData, this.tableCorners);
      } catch (e) {
        console.error('Ball detection failed:', e);
        this.balls = createSyntheticBalls();
      }
    }

    if (this.balls.length === 0) {
      this.balls = createSyntheticBalls();
    }

    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._setState(STATE.READY);
  }

  _calculateShots() {
    if (this.selectedCue === null || this.selectedTarget === null || !this.selectedPocket) return;

    const cue = this.balls[this.selectedCue];
    const target = this.balls[this.selectedTarget];
    const pocketPos = POCKETS[this.selectedPocket];

    this.shots = this.calculator.findAllShots(
      [cue.x, cue.y],
      [target.x, target.y],
      this.selectedPocket,
      2
    );
  }

  // --- State management ---

  _setState(state) {
    this.state = state;
    const messages = {
      [STATE.LOADING]:         'Loading...',
      [STATE.SCANNING]:        'Point camera at table...',
      [STATE.READY]:           `${this.balls.length} balls found — Tap the cue ball`,
      [STATE.CUE_SELECTED]:    'Tap the target ball',
      [STATE.TARGET_SELECTED]: 'Tap a pocket',
      [STATE.SHOWING_SHOT]:    `${this.shots.length} shot${this.shots.length !== 1 ? 's' : ''} found — Tap another pocket or Reset`,
    };
    this._setStatus(messages[state] || '');
    this._updateToolbar();
  }

  _setStatus(msg) {
    this.statusText.textContent = msg;
  }

  _updateToolbar() {
    this.toolbar.innerHTML = '';
    const btn = (label, onClick, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'toolbar-btn' + (cls ? ' ' + cls : '');
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      this.toolbar.appendChild(b);
    };

    switch (this.state) {
      case STATE.SCANNING:
        btn('Demo Mode', () => this._enterDemoMode());
        break;

      case STATE.READY:
      case STATE.CUE_SELECTED:
      case STATE.TARGET_SELECTED:
        if (!this._demoMode) {
          btn('Re-detect', () => this._redetect());
        }
        break;

      case STATE.SHOWING_SHOT:
        btn('Reset', () => this._resetSelection(), 'primary');
        if (!this._demoMode) {
          btn('Re-detect', () => this._redetect());
        }
        break;
    }
  }

  _resetSelection() {
    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._setState(STATE.READY);
  }

  _redetect() {
    this.tableCorners = null;
    this.canvasCorners = null;
    this.balls = [];
    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._setState(STATE.SCANNING);
    this._startScanning();
  }

  _enterDemoMode() {
    this._demoMode = true;
    this._stopScanning();
    this.balls = createSyntheticBalls();
    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._setState(STATE.READY);
  }

  // --- Render loop ---

  _renderLoop() {
    requestAnimationFrame(() => this._renderLoop());
    this.renderer.clear();

    switch (this.state) {
      case STATE.SCANNING:
        this.renderer.drawScanningOverlay();
        if (this.canvasCorners) {
          this.renderer.drawTableOutline(this.canvasCorners);
        }
        break;

      case STATE.READY:
        this.renderer.drawTable();
        this.renderer.drawBalls(this.balls, null, null, 'cue');
        break;

      case STATE.CUE_SELECTED:
        this.renderer.drawTable();
        this.renderer.drawBalls(this.balls, this.selectedCue, null, 'target');
        break;

      case STATE.TARGET_SELECTED:
        this.renderer.drawTable();
        this.renderer.drawBalls(this.balls, this.selectedCue, this.selectedTarget, null);
        this.renderer.drawPocketHighlights();
        break;

      case STATE.SHOWING_SHOT:
        this.renderer.drawTable();
        this.renderer.drawBalls(this.balls, this.selectedCue, this.selectedTarget, null);
        this.renderer.drawPocketHighlights(this.selectedPocket);
        if (this.shots.length > 0) {
          this.renderer.drawShots(this.shots, 8);
        }
        break;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => new App());
