/**
 * BankShotAI - Camera Module
 * getUserMedia access with rear camera preference.
 */

export class Camera {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;

    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      await this.video.play();
      this.running = true;
    } catch (err) {
      // Fallback: try any camera
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.video.srcObject = this.stream;
        await this.video.play();
        this.running = true;
      } catch (e) {
        console.error('Camera access denied:', e);
        throw e;
      }
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
    this.running = false;
  }

  /**
   * Capture current video frame to a canvas.
   * @param {HTMLCanvasElement} canvas - target canvas (resized to match video)
   * @returns {ImageData|null}
   */
  captureFrame(canvas) {
    if (!this.running) return null;
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) return null;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  get videoWidth() { return this.video.videoWidth || 0; }
  get videoHeight() { return this.video.videoHeight || 0; }
}
