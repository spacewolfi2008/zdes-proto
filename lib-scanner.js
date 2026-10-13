// Камера и распознавание QR.
// На Android в Chrome есть встроенный BarcodeDetector; на iPhone и на Windows его нет,
// там работает ZXing, собранный в WebAssembly и лежащий рядом (без обращений в сеть).

const WASM_OPTIONS = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 2,
  tryRotate: false,
  tryInvert: false,
  textMode: 'Plain',
};

let decoderPromise = null;

async function nativeDecoder() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    return {
      kind: 'native',
      async decode(canvas) {
        const found = await detector.detect(canvas);
        return found.map((f) => f.rawValue).filter(Boolean);
      },
    };
  } catch (e) {
    return null;
  }
}

async function wasmDecoder() {
  const mod = await import('./lib-zxing-reader.js');
  const wasmUrl = new URL('./zxing_reader.wasm', import.meta.url).href;
  await mod.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  return {
    kind: 'wasm',
    async decode(canvas, ctx) {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = await mod.readBarcodes(image, WASM_OPTIONS);
      return found.filter((f) => f.isValid && f.text).map((f) => f.text);
    },
  };
}

// prefer: 'auto' | 'wasm'
export function loadDecoder(prefer = 'auto') {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      if (prefer !== 'wasm') {
        const native = await nativeDecoder();
        if (native) return native;
      }
      return wasmDecoder();
    })();
    decoderPromise.catch(() => { decoderPromise = null; });
  }
  return decoderPromise;
}

export function cameraErrorText(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Нет доступа к камере. Разрешите камеру для этого сайта в настройках браузера и откройте страницу заново.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена на этом устройстве.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Камера занята другим приложением. Закройте его и попробуйте снова.';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'Браузер не даёт доступ к камере. Откройте страницу в Chrome, Safari или Яндекс Браузере по адресу с https.';
  }
  return 'Камера не запустилась: ' + ((error && error.message) || 'неизвестная ошибка');
}

export async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch (e) {
    return [];
  }
}

export class Scanner {
  // video     — <video>, в который выводится камера (для источника-камеры)
  // source    — <canvas> вместо камеры (репетиция и автотесты)
  // facing    — 'user' (фронтальная) или 'environment' (основная)
  // onTexts   — вызывается со списком распознанных строк
  constructor({ video = null, source = null, facing = 'user', deviceId = null, onTexts, onState = null,
    maxDim = 960, intervalMs = 60, prefer = 'auto' }) {
    this.video = video;
    this.source = source;
    this.facing = facing;
    this.deviceId = deviceId;
    this.onTexts = onTexts;
    this.onState = onState;
    this.maxDim = maxDim;
    this.intervalMs = intervalMs;
    this.prefer = prefer;
    this.work = document.createElement('canvas');
    this.ctx = this.work.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this.decoder = null;
    this.running = false;
    this.timer = 0;
    this.stats = { kind: '', width: 0, height: 0, decodeMs: 0, fps: 0, frames: 0, label: '' };
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && this.running && this.stream && !this.streamAlive()) {
        this.restartCamera();
      }
    };
  }

  streamAlive() {
    return this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  async openCamera() {
    const high = this.facing === 'environment';
    const video = { width: { ideal: high ? 1920 : 1280 }, height: { ideal: high ? 1080 : 720 } };
    if (this.deviceId) video.deviceId = { exact: this.deviceId };
    else video.facingMode = { ideal: this.facing };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    this.stats.label = track ? track.label : '';
    if (track) track.addEventListener('ended', () => { if (this.running && this.onState) this.onState('ended'); });
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.srcObject = stream;
    try { await this.video.play(); } catch (e) { /* автозапуск запрещён до жеста — кадры пойдут после него */ }
  }

  closeCamera() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  async restartCamera() {
    this.closeCamera();
    try {
      await this.openCamera();
      if (this.onState) this.onState('running');
    } catch (e) {
      if (this.onState) this.onState('error', e);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      this.decoder = await loadDecoder(this.prefer);
      this.stats.kind = this.decoder.kind;
      if (!this.source) await this.openCamera();
    } catch (e) {
      this.running = false;
      this.closeCamera();
      throw e;
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.onState) this.onState('running');
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.closeCamera();
  }

  async setCamera({ facing, deviceId }) {
    if (facing) this.facing = facing;
    this.deviceId = deviceId || null;
    if (this.running && !this.source) await this.restartCamera();
  }

  async loop() {
    if (!this.running) return;
    const started = performance.now();
    try {
      const src = this.source || this.video;
      const w = this.source ? src.width : src.videoWidth;
      const h = this.source ? src.height : src.videoHeight;
      if (w && h && (this.source || src.readyState >= 2)) {
        const k = Math.min(1, this.maxDim / Math.max(w, h));
        const tw = Math.round(w * k);
        const th = Math.round(h * k);
        if (this.work.width !== tw || this.work.height !== th) {
          this.work.width = tw;
          this.work.height = th;
        }
        this.ctx.drawImage(src, 0, 0, tw, th);
        const t0 = performance.now();
        const texts = await this.decoder.decode(this.work, this.ctx);
        const spent = performance.now() - t0;
        this.stats.width = w;
        this.stats.height = h;
        this.stats.frames += 1;
        this.stats.decodeMs = this.stats.decodeMs ? this.stats.decodeMs * 0.8 + spent * 0.2 : spent;
        if (texts.length && this.running) await this.onTexts(texts);
      }
    } catch (e) {
      // Единичный сбой кадра не должен останавливать сканирование.
    }
    if (!this.running) return;
    const elapsed = performance.now() - started;
    const wait = Math.max(0, this.intervalMs - elapsed);
    this.stats.fps = 1000 / Math.max(1, elapsed + wait);
    this.timer = setTimeout(() => this.loop(), wait);
  }
}
