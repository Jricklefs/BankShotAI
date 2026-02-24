/**
 * BankShotAI - Main App Controller
 *
 * Flow: VIEWFINDER → CAPTURED → CUE_SELECTED → TARGET_SELECTED → SHOWING_SHOT
 * User takes a photo, then taps cue ball → target ball → pocket.
 */

import { Camera } from './camera.js?v=1771963460';
import { BallDetector, loadOpenCV, isOpenCVReady, detectTable } from './detection.js?v=1771963460';
import { Renderer } from './renderer.js?v=1771963460';
import { BankShotCalculator } from './physics.js?v=1771963460';
import { createSyntheticBalls, TABLE_WIDTH, TABLE_LENGTH, BALL_DIAMETER, POCKETS } from './table-config.js?v=1771963460';

const STATE = {
  LOADING:         'loading',
  VIEWFINDER:      'viewfinder',
  PROCESSING:      'processing',
  READY:           'ready',
  CUE_SELECTED:    'cue_selected',
  TARGET_SELECTED: 'target_selected',
  SHOWING_SHOT:    'showing_shot',
};

class App {
  constructor() {
    this.video = document.getElementById('camera-feed');
    this.capturedCanvas = document.getElementById('captured-image');
    this.overlay = document.getElementById('overlay');
    this.statusText = document.getElementById('status-text');
    this.toolbar = document.getElementById('toolbar');
    this.loadingOverlay = document.getElementById('loading-overlay');
    this.captureContainer = document.getElementById('capture-btn-container');
    this.captureBtn = document.getElementById('capture-btn');

    this.camera = new Camera(this.video);
    this.renderer = new Renderer(this.overlay);
    this.detector = new BallDetector();
    this.calculator = new BankShotCalculator();

    this.state = STATE.LOADING;
    this.tableCorners = null;
    this.balls = [];
    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._captureImageData = null;
    this._demoMode = false;

    this._init();
  }

  async _init() {
    this._setState(STATE.LOADING);
    this._bindEvents();
    this._resize();

    // Start camera first (fast) while OpenCV loads in background
    try {
      await this.camera.start();
    } catch (e) {
      console.warn('No camera:', e);
      this._demoMode = true;
    }

    // Show viewfinder immediately while OpenCV loads
    if (this.loadingOverlay) this.loadingOverlay.classList.add('hidden');

    if (this._demoMode) {
      this._enterDemoMode();
    } else {
      this._setState(STATE.VIEWFINDER);
    }

    // Load OpenCV in background
    try {
      await loadOpenCV((msg) => {
        if (this.state === STATE.VIEWFINDER) this._setStatus(msg + ' — Point at table and tap 📸');
      });
    } catch (e) {
      console.warn('OpenCV failed:', e);
    }

    this._renderLoop();
  }

  _bindEvents() {
    window.addEventListener('resize', () => this._resize());

    // Capture button
    this.captureBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._capturePhoto();
    });

    // Tap handling on overlay
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
    // capturedCanvas is now an <img>, no need to resize
    this.renderer.resize(w, h);
  }










  // --- Photo capture ---

  _capturePhoto() {
    if (!this.camera.running) return;

    this._setState(STATE.PROCESSING);

    // Capture frame from video
    const tempCanvas = document.createElement('canvas');
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    tempCanvas.width = vw;
    tempCanvas.height = vh;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, vw, vh);
    this._captureImageData = ctx.getImageData(0, 0, vw, vh);

    // Show frozen image as data URL on the <img> element
    this.capturedCanvas.src = tempCanvas.toDataURL('image/jpeg', 0.9);
    this._hasCapture = true;

    this.video.classList.add('hidden');
    this.capturedCanvas.classList.remove('hidden');
    this.captureContainer.classList.add('hidden');

    // Wait for img to render, then compute draw rect and process
    setTimeout(() => {
      const rect = this.capturedCanvas.getBoundingClientRect();
      const imgAspect = vw / vh;
      const containerAspect = rect.width / rect.height;
      let drawW, drawH, drawX, drawY;
      if (imgAspect > containerAspect) {
        drawW = rect.width;
        drawH = rect.width / imgAspect;
        drawX = 0;
        drawY = (rect.height - drawH) / 2;
      } else {
        drawH = rect.height;
        drawW = rect.height * imgAspect;
        drawX = (rect.width - drawW) / 2;
        drawY = 0;
      }
      this._photoDrawX = drawX;
      this._photoDrawY = drawY;
      this._photoDrawW = drawW;
      this._photoDrawH = drawH;
      this._processCapture();
    }, 100);
  }

  _processCapture() {
    if (!this._captureImageData || !isOpenCVReady()) {
      this._enterDemoMode();
      return;
    }

    // Detect table — MUST succeed before we look for balls
    let tableResult = null;
    try {
      tableResult = detectTable(this._captureImageData);
      console.log('[App] Table detection:', tableResult);
    } catch (e) {
      console.error('[App] Table detection error:', e);
    }

    if (!tableResult || tableResult.confidence < 0.15) {
      this.tableCorners = null;
      this.balls = [];
      this.renderer.clearPhotoMode();
      this._setStatus('Could not detect table — try a different angle');
      this._setState(STATE.READY);
      return;
    }

    this.tableCorners = tableResult.corners;

    // Detect balls ONLY within the warped table region
    try {
      this.balls = this.detector.detect(this._captureImageData, this.tableCorners);
      console.log(`[App] Detected ${this.balls.length} balls`);
    } catch (e) {
      console.error('[App] Ball detection failed:', e);
      this.balls = [];
    }

    // Set up photo-overlay mode with letterbox coords
    if (this.detector.inverseMatrix) {
      this.renderer.setPhotoMode(
        this.detector,
        this.tableCorners,
        this._captureImageData.width,
        this._captureImageData.height,
        this._photoDrawX || 0,
        this._photoDrawY || 0,
        this._photoDrawW || this.overlay.width,
        this._photoDrawH || this.overlay.height
      );
    }

    if (this.balls.length === 0) {
      this._setStatus('Table found but no balls detected — try better lighting');
    }

    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._setState(STATE.READY);
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
      case STATE.SHOWING_SHOT:
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
    let bestPocket = null, bestDist = Infinity;
    for (const [name, pos] of Object.entries(POCKETS)) {
      const [px, py] = this.renderer.toCanvas(pos[0], pos[1]);
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) { bestDist = d; bestPocket = name; }
    }

    const maxTapDist = Math.max(60, BALL_DIAMETER * this.renderer.scaleX * 3);
    if (!bestPocket || bestDist > maxTapDist) return;

    this.selectedPocket = bestPocket;
    this._calculateShots();
    this._setState(STATE.SHOWING_SHOT);
  }

  _calculateShots() {
    if (this.selectedCue === null || this.selectedTarget === null || !this.selectedPocket) return;

    const cue = this.balls[this.selectedCue];
    const target = this.balls[this.selectedTarget];

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
      [STATE.VIEWFINDER]:      'Point at table and tap 📸',
      [STATE.PROCESSING]:      'Detecting table & balls...',
      [STATE.READY]:           this.balls.length > 0
                                 ? `${this.balls.length} balls found — Tap the cue ball`
                                 : 'No balls detected — Retake or Demo',
      [STATE.CUE_SELECTED]:    'Now tap the target ball',
      [STATE.TARGET_SELECTED]: 'Tap a pocket',
      [STATE.SHOWING_SHOT]:    `${this.shots.length} shot${this.shots.length !== 1 ? 's' : ''} found`,
    };
    this._setStatus(messages[state] || '');
    this._updateToolbar();
    this._updateVisibility();
  }

  _setStatus(msg) {
    this.statusText.textContent = msg;
  }

  _updateVisibility() {
    // Show/hide capture button
    if (this.state === STATE.VIEWFINDER) {
      this.captureContainer.classList.remove('hidden');
      this.video.classList.remove('hidden');
      this.capturedCanvas.classList.add('hidden');
    } else {
      this.captureContainer.classList.add('hidden');
    }
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
      case STATE.VIEWFINDER:
        btn('Test Image', () => this._loadTestImage());
        btn('Demo Mode', () => this._enterDemoMode());
        break;

      case STATE.READY:
        btn('Retake', () => this._retake(), 'primary');
        btn('Test Image', () => this._loadTestImage());
        btn('Demo Mode', () => this._enterDemoMode());
        break;

      case STATE.CUE_SELECTED:
      case STATE.TARGET_SELECTED:
        btn('Reset', () => this._resetSelection());
        btn('Retake', () => this._retake());
        break;

      case STATE.SHOWING_SHOT:
        btn('Reset', () => this._resetSelection(), 'primary');
        btn('Retake', () => this._retake());
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

  _retake() {
    this.tableCorners = null;
    this.balls = [];
    this.selectedCue = null;
    this.selectedTarget = null;
    this.selectedPocket = null;
    this.shots = [];
    this._captureImageData = null;

    // Show video, hide captured
    this._hasCapture = false;
    this.video.classList.remove('hidden');
    this.capturedCanvas.classList.add('hidden');
    this.renderer.clearPhotoMode();

    this._setState(STATE.VIEWFINDER);
  }

  _loadTestImage() {
    this._setState(STATE.PROCESSING);
    this.video.classList.add('hidden');
    this.captureContainer.classList.add('hidden');

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Get ImageData at full image resolution for detection
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;
      const tctx = tempCanvas.getContext('2d');
      tctx.drawImage(img, 0, 0);
      this._captureImageData = tctx.getImageData(0, 0, img.width, img.height);

      // Show the image directly (img element with object-fit: contain handles scaling)
      this.capturedCanvas.src = 'test_table.jpg';
      this.capturedCanvas.classList.remove('hidden');
      this._hasCapture = true;

      // Compute where the image renders on screen for overlay mapping
      // object-fit: contain centers the image, we need to figure out the actual rendered rect
      // Use a timeout to let the img element render first
      setTimeout(() => {
        const rect = this.capturedCanvas.getBoundingClientRect();
        const imgAspect = img.width / img.height;
        const containerAspect = rect.width / rect.height;
        let drawW, drawH, drawX, drawY;
        if (imgAspect > containerAspect) {
          drawW = rect.width;
          drawH = rect.width / imgAspect;
          drawX = 0;
          drawY = (rect.height - drawH) / 2;
        } else {
          drawH = rect.height;
          drawW = rect.height * imgAspect;
          drawX = (rect.width - drawW) / 2;
          drawY = 0;
        }
        this._photoDrawX = drawX;
        this._photoDrawY = drawY;
        this._photoDrawW = drawW;
        this._photoDrawH = drawH;
        console.log(`[App] Image ${img.width}x${img.height} rendered at (${drawX.toFixed(0)},${drawY.toFixed(0)}) ${drawW.toFixed(0)}x${drawH.toFixed(0)} in ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} container`);

        this._processCapture();
      }, 100);
    };
    img.onerror = () => {
      this._setStatus('Failed to load test image');
      this._setState(STATE.VIEWFINDER);
    };
    img.src = 'test_table.jpg';
  }

  _enterDemoMode() {
    this._demoMode = true;
    this.video.classList.add('hidden');
    this.capturedCanvas.classList.add('hidden');
    this.captureContainer.classList.add('hidden');
    this.renderer.clearPhotoMode();
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
      case STATE.VIEWFINDER:
        // Just show camera feed, maybe a subtle guide
        this.renderer.drawScanningOverlay();
        break;

      case STATE.PROCESSING:
        this.renderer.drawTable();
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
