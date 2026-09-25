// Camera + barcode reading. The decoder is ZXing compiled to WebAssembly
// (vendor/), which works in iOS Safari where the native BarcodeDetector
// API does not exist. Everything runs on the phone; no images are uploaded.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const FRAME_GAP_MS = 110; // ~9 attempts per second is plenty and easy on the battery
const CONFIRM_WINDOW_MS = 2500;
const PHOTO_MAX_SIDES = [2400, 4000]; // try a scaled-down copy first, then near full size

let detector = null;
let prepared = false;

function api() {
  const a = window.BarcodeDetectionAPI;
  if (!a) throw new Error('The barcode reader did not load. Check your connection and reload.');
  return a;
}

// Point the WebAssembly loader at our own copy and start fetching it early.
export function prepareDecoder() {
  if (prepared) return;
  const { prepareZXingModule } = api();
  prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) =>
        path.endsWith('.wasm') ? new URL(`vendor/${path}`, document.baseURI).href : prefix + path,
    },
    fireImmediately: true,
  });
  prepared = true;
}

function getDetector() {
  prepareDecoder();
  if (!detector) detector = new (api().BarcodeDetector)({ formats: FORMATS });
  return detector;
}

export const cameraSupported = () => Boolean(navigator.mediaDevices?.getUserMedia);

export function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. On iPhone: Settings > Safari > Camera, set to Ask or Allow, then reload. You can still take a photo or type the number below.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. You can type the number under the barcode instead.';
    case 'NotReadableError':
      return 'The camera is being used by another app. Close it and try again.';
    default:
      return `The camera could not start (${err?.message || err}). You can take a photo or type the number instead.`;
  }
}

// Read a barcode from a still photo (e.g. taken with the phone's own camera
// app, which handles focus and exposure better than a live web stream).
export async function decodeImageFile(file) {
  const det = getDetector();
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const tried = new Set();
    for (const side of PHOTO_MAX_SIDES) {
      const scale = Math.min(1, side / long);
      const key = Math.round(scale * 1000);
      if (tried.has(key)) continue;
      tried.add(key);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const codes = await det.detect(canvas);
      if (codes.length) return { rawValue: codes[0].rawValue, format: codes[0].format };
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

export class Scanner {
  constructor(video, { onCode }) {
    this.video = video;
    this.onCode = onCode;
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.timer = null;
    this.running = false;
    this.last = { value: '', at: 0 };
  }

  async start() {
    if (this.running) return;
    const det = getDetector();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    this.track = this.stream.getVideoTracks()[0] || null;
    this.caps = (this.track?.getCapabilities && this.track.getCapabilities()) || {};
    this.video.srcObject = this.stream;
    await this.video.play();
    await this.tuneFocus();
    this.running = true;
    this.last = { value: '', at: 0 };
    const tick = async () => {
      if (!this.running) return;
      try {
        if (this.video.readyState >= 2 && this.video.videoWidth) {
          const codes = await det.detect(this.video);
          if (this.running && codes.length) this.consider(codes[0]);
        }
      } catch {
        // A bad frame is not fatal; try the next one.
      }
      if (this.running) this.timer = setTimeout(tick, FRAME_GAP_MS);
    };
    tick();
  }

  // Continuous autofocus where the browser exposes it (Chrome on Android;
  // iOS Safari manages focus itself and ignores this).
  async tuneFocus() {
    if (this.caps.focusMode?.includes?.('continuous')) await this.apply({ focusMode: 'continuous' });
  }

  // What this camera/browser lets us control: { torch:boolean, zoom:{min,max}|null }.
  controls() {
    return {
      torch: Boolean(this.caps.torch),
      zoom: this.caps.zoom && this.caps.zoom.max > this.caps.zoom.min ? { min: this.caps.zoom.min, max: this.caps.zoom.max } : null,
    };
  }

  async apply(constraint) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [constraint] });
      return true;
    } catch {
      return false;
    }
  }

  setTorch(on) {
    return this.apply({ torch: Boolean(on) });
  }

  setZoom(z) {
    const c = this.controls().zoom;
    if (!c) return Promise.resolve(false);
    return this.apply({ zoom: Math.min(c.max, Math.max(c.min, z)) });
  }

  // Require the same reading twice in quick succession: cheap protection
  // against a one-frame misread.
  consider({ rawValue, format }) {
    const now = performance.now();
    if (rawValue === this.last.value && now - this.last.at <= CONFIRM_WINDOW_MS) {
      this.stop();
      this.onCode(rawValue, format);
    } else {
      this.last = { value: rawValue, at: now };
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.video.srcObject = null;
  }
}
