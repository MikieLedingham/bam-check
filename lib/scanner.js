// Camera + barcode reading. The decoder is ZXing compiled to WebAssembly
// (vendor/), which works in iOS Safari where the native BarcodeDetector
// API does not exist. Everything runs on the phone; no images are uploaded.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const FRAME_GAP_MS = 110; // ~9 attempts per second is plenty and easy on the battery
const CONFIRM_WINDOW_MS = 1500;

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
      return 'Camera access is blocked. On iPhone: Settings > Safari > Camera, set to Ask or Allow, then reload. You can still type the number below.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. You can type the number under the barcode instead.';
    case 'NotReadableError':
      return 'The camera is being used by another app. Close it and try again.';
    default:
      return `The camera could not start (${err?.message || err}). You can type the number instead.`;
  }
}

export class Scanner {
  constructor(video, { onCode }) {
    this.video = video;
    this.onCode = onCode;
    this.stream = null;
    this.timer = null;
    this.running = false;
    this.last = { value: '', at: 0 };
  }

  async start() {
    if (this.running) return;
    const det = getDetector();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
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

  // Require the same reading twice in a row: cheap protection against a
  // one-frame misread.
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
    this.video.srcObject = null;
  }
}
