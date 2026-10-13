// Прототип самого рискованного звена: взаимное чтение QR между телефоном и ноутбуком.
// Никаких запросов в сеть: всё считается и хранится на устройстве.

import { drawQr } from './js/qr.js';
import { Scanner, cameraErrorText, listCameras } from './js/scanner.js';
import { isIos, isStandalone, loadDeviceKey, requestPersistence } from './js/devicekey.js';
import { PhoneCore, StationCore } from './shared/station-core.js';
import {
  bytesEqual, decodeChallenge, decodeEnroll, encodeEnroll, fromBase64, fromHex, kindOf, toBase64, toHex,
} from './shared/proto.js';
import { kidOf } from './shared/keys.js';

const VERSION = '1.0';
const params = new URLSearchParams(location.search);
const PREFER = params.get('decoder') === 'wasm' ? 'wasm' : 'auto';

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* хранилище недоступно */ }
  },
};

const DIAG = { nativeKey: 1, standalone: 2, persisted: 4, offline: 8, nativeDecoder: 16, keyExisted: 32, ios: 64 };

// --- Общее -------------------------------------------------------------------

function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== id;
  store.set('proto-role', id);
  window.scrollTo(0, 0);
}

let toastTimer = 0;
function toast(message, ms = 5000) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

let audio = null;
function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch (e) { audio = null; }
}

function beep(kind) {
  if (!audio) return;
  const tones = kind === 'ok' ? [[880, 0, 0.09], [1320, 0.09, 0.12]] : [[220, 0, 0.22]];
  for (const [freq, at, len] of tones) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audio.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + len);
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + at);
    osc.stop(audio.currentTime + at + len + 0.02);
  }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* не критично */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepAwake();
});

function seconds(ms) {
  return (ms / 1000).toFixed(1).replace('.', ',') + ' с';
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function offlineReady() {
  return Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) { /* без офлайн-копии страница всё равно работает при наличии сети */ }
  renderHomeOffline();
}

function renderHomeOffline() {
  $('home-offline').textContent = offlineReady()
    ? 'Офлайн-копия готова: страница откроется и без интернета.'
    : 'Офлайн-копия загружается. Обновите страницу один раз, пока есть интернет.';
}

// --- Телефон -----------------------------------------------------------------

const phone = {
  key: null, core: null, scanner: null, facing: 'user', diag: 0,
  enrolledSess: '', enrollText: '', lastSeen: -1e9, presentStart: 0, answerAt: 0,
  count: 0, acked: false, doneTimer: 0, longWindow: false, shownQr: '',
};

async function guessLabel() {
  const saved = store.get('proto-label', '');
  if (saved) return saved;
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const v = await navigator.userAgentData.getHighEntropyValues(['model']);
      if (v.model) return v.model;
    }
  } catch (e) { /* модель недоступна */ }
  if (isIos()) return 'iPhone';
  return /Android/.test(navigator.userAgent) ? 'Android' : 'Телефон';
}

function checkItem(state, title, detail) {
  const li = document.createElement('li');
  li.className = state;
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = state === 'yes' ? '✓' : state === 'no' ? '✕' : '!';
  const body = document.createElement('div');
  body.textContent = title;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    body.appendChild(small);
  }
  li.append(mark, body);
  return li;
}

async function runPhoneChecks() {
  const list = $('checks');
  list.textContent = '';
  let diag = isIos() ? DIAG.ios : 0;

  list.appendChild(window.isSecureContext
    ? checkItem('yes', 'Защищённое соединение')
    : checkItem('no', 'Нет защищённого соединения', 'Камера и ключ работают только по адресу с https.'));

  try {
    phone.key = await loadDeviceKey({ dbName: 'zdes-proto' });
    phone.core = new PhoneCore({ sign: phone.key.sign, kid: phone.key.kid });
    if (phone.key.mode === 'native') diag |= DIAG.nativeKey;
    if (phone.key.existed) diag |= DIAG.keyExisted;
    const where = phone.key.mode === 'native' ? 'Хранится в неизвлекаемом виде.' : 'Запасной режим хранения: браузер не сохранил неизвлекаемый ключ.';
    list.appendChild(phone.key.existed
      ? checkItem('yes', 'Ключ устройства сохранился с прошлого запуска', where)
      : checkItem('soft', 'Ключ устройства создан только что', where + ' Закройте страницу и откройте снова: эта строка должна смениться на «сохранился».'));
  } catch (e) {
    list.appendChild(checkItem('no', 'Не удалось создать ключ устройства', String(e && e.message || e)));
  }

  const persisted = await requestPersistence();
  if (persisted) diag |= DIAG.persisted;
  list.appendChild(persisted
    ? checkItem('yes', 'Браузер закрепил данные сайта')
    : checkItem('soft', 'Браузер может очистить данные сайта', isIos()
      ? 'На iPhone добавьте страницу на экран «Домой» и открывайте с иконки.'
      : 'Установите страницу как приложение через меню браузера.'));

  const standalone = isStandalone();
  if (standalone) diag |= DIAG.standalone;
  list.appendChild(standalone
    ? checkItem('yes', 'Открыто с главного экрана')
    : checkItem('soft', 'Открыто во вкладке браузера', isIos()
      ? 'Safari: «Поделиться» → «На экран Домой». Потом откройте с иконки и повторите проверку.'
      : 'Меню браузера → «Установить приложение» или «Добавить на главный экран».'));

  if (offlineReady()) diag |= DIAG.offline;
  list.appendChild(offlineReady()
    ? checkItem('yes', 'Работает без интернета')
    : checkItem('soft', 'Офлайн-копия ещё не готова', 'Обновите страницу один раз, пока есть интернет.'));

  phone.diag = diag;
  $('label').value = await guessLabel();
}

function phoneStatus(text) {
  $('phone-status').textContent = text;
}

function phoneShowQr(text) {
  if (text === phone.shownQr) return;
  phone.shownQr = text;
  drawQr($('phone-qr'), text);
}

async function onPhoneTexts(texts) {
  for (const text of texts) {
    if (kindOf(text) !== 'challenge') continue;
    let ch;
    try { ch = decodeChallenge(text); } catch (e) { continue; }
    const now = performance.now();
    if (now - phone.lastSeen > 2000) phone.presentStart = now;
    phone.lastSeen = now;
    phone.longWindow = Boolean(ch.flags & 2);
    const sess = toHex(ch.sess);
    if (ch.acks.some((ack) => bytesEqual(ack, phone.key.kid))) phone.enrolledSess = sess;

    if (phone.enrolledSess !== sess) {
      phoneShowQr(phone.enrollText);
      phoneStatus('Станция знакомится с телефоном. Держите экран напротив камеры ноутбука.');
      continue;
    }
    const seen = await phone.core.handleScan(text);
    if (!seen) continue;
    if (seen.changed) {
      phone.answerAt = now;
      phoneShowQr(seen.responseText);
    }
    if (seen.acked && !phone.acked) {
      phone.acked = true;
      phone.count += 1;
      $('phone-count').textContent = 'Отметок: ' + phone.count;
      $('phone-done-time').textContent = 'за ' + seconds(now - phone.presentStart);
      $('phone-done').hidden = false;
      if (navigator.vibrate) navigator.vibrate(120);
      clearTimeout(phone.doneTimer);
      phone.doneTimer = setTimeout(() => { $('phone-done').hidden = true; }, 2200);
      phoneStatus('Станция подтвердила отметку. Уберите телефон и поднесите снова для следующего замера.');
    } else if (!seen.acked) {
      phone.acked = false;
      phoneStatus('Код станции получен. Держите экран напротив камеры ноутбука.');
    }
  }
}

function phoneIdleTick() {
  if (!phone.scanner || !phone.scanner.running) return;
  const now = performance.now();
  const idle = now - phone.lastSeen;
  const s = phone.scanner.stats;
  $('phone-stats').textContent = `Распознавание: ${s.kind === 'native' ? 'встроенное' : 'ZXing'}, кадр ${s.width}×${s.height}, ${Math.round(s.decodeMs)} мс`;
  if (idle < 2500) return;
  if (phone.acked) {
    phoneStatus('Отметка записана. Для нового замера поднесите телефон ещё раз.');
    return;
  }
  if (!phone.shownQr || phone.enrolledSess === '') {
    phoneStatus(phone.facing === 'user'
      ? 'Поднесите телефон экраном к экрану ноутбука: фронтальная камера должна видеть код станции.'
      : 'Наведите основную камеру на код станции.');
    return;
  }
  const limit = phone.longWindow ? 90000 : 12000;
  const age = now - phone.answerAt;
  if (age > limit) phoneStatus('Код устарел. Наведите камеру на экран станции ещё раз.');
  else phoneStatus(`Код получен ${Math.round(age / 1000)} с назад. Покажите этот экран камере ноутбука.`);
}

async function startPhone() {
  unlockAudio();
  if (!phone.key) { toast('Ключ устройства не создан: отметка невозможна.'); return; }
  const label = $('label').value.trim() || 'Телефон';
  store.set('proto-label', label);
  $('phone-setup').hidden = true;
  $('phone-scan').hidden = false;
  phoneStatus('Запускаю камеру…');
  phone.scanner = new Scanner({
    video: $('phone-video'), facing: phone.facing, onTexts: onPhoneTexts, maxDim: 720, intervalMs: 60, prefer: PREFER,
    onState: (state, error) => { if (state === 'error') phoneStatus(cameraErrorText(error)); },
  });
  try {
    await phone.scanner.start();
  } catch (e) {
    phoneStatus(cameraErrorText(e));
    return;
  }
  const diag = phone.diag | (phone.scanner.stats.kind === 'native' ? DIAG.nativeDecoder : 0);
  phone.enrollText = encodeEnroll({ pub: phone.key.pub, label, diag });
  $('phone-video').classList.toggle('mirrored', phone.facing === 'user');
  phone.lastSeen = -1e9;
  phoneStatus('Поднесите телефон экраном к экрану ноутбука.');
  keepAwake();
}

function stopPhone() {
  if (phone.scanner) phone.scanner.stop();
  phone.scanner = null;
  phone.shownQr = '';
  $('phone-scan').hidden = true;
  $('phone-setup').hidden = false;
  runPhoneChecks();
}

async function switchPhoneCamera() {
  if (!phone.scanner) return;
  phone.facing = phone.facing === 'user' ? 'environment' : 'user';
  phone.scanner.maxDim = phone.facing === 'user' ? 720 : 1280;
  $('phone-video').classList.toggle('mirrored', phone.facing === 'user');
  await phone.scanner.setCamera({ facing: phone.facing });
  phoneStatus(phone.facing === 'user' ? 'Фронтальная камера: держите телефон экраном к станции.' : 'Основная камера: наведите её на код, затем покажите экран телефона станции.');
}

// --- Станция -----------------------------------------------------------------

const station = {
  core: null, scanner: null, timer: 0, infoTimer: 0, startedAt: 0,
  devices: new Map(),   // kid → { label, diag, pub, marks }
  events: [], lastSeen: new Map(), lastOkAt: null, quiet: new Map(), n: 0,
};

function loadDevices() {
  for (const d of store.get('proto-devices', [])) {
    station.devices.set(d.kid, { label: d.label, diag: d.diag, pub: fromBase64(d.pub), marks: 0 });
  }
}

function saveDevices() {
  store.set('proto-devices', [...station.devices].map(([kid, d]) => ({ kid, label: d.label, diag: d.diag, pub: toBase64(d.pub) })));
}

async function buildCore() {
  station.core = new StationCore({ windowMs: Number($('window').value), ackUnknown: false });
  for (const [kid, d] of station.devices) {
    await station.core.addDevice(fromHex(kid), d.pub, { label: d.label });
  }
}

function setBanner(kind, title, sub) {
  const el = $('banner');
  el.className = 'banner ' + kind;
  el.textContent = '';
  const box = document.createElement('div');
  box.textContent = title;
  if (sub) {
    const small = document.createElement('div');
    small.style.cssText = 'font-size:0.5em;font-weight:500;margin-top:4px';
    small.textContent = sub;
    box.appendChild(small);
  }
  el.appendChild(box);
}

// Не показывать одно и то же предупреждение на каждом кадре.
function quiet(key, ms = 1500) {
  const now = performance.now();
  if (now - (station.quiet.get(key) || -1e9) < ms) return true;
  station.quiet.set(key, now);
  return false;
}

function logEvent(kind, label, result, ageMs, gapMs, kid) {
  station.n += 1;
  const at = new Date();
  station.events.push({ n: station.n, t: Math.round(performance.now() - station.startedAt), time: at.toISOString(), type: result.type, kid, label, ageMs: ageMs == null ? null : Math.round(ageMs), gapMs: gapMs == null ? null : Math.round(gapMs) });
  const row = document.createElement('tr');
  row.className = kind;
  const cells = [station.n, at.toLocaleTimeString('ru-RU'), label, result.text, ageMs == null ? '—' : seconds(ageMs), gapMs == null ? '—' : seconds(gapMs)];
  for (const value of cells) {
    const td = document.createElement('td');
    td.textContent = value;
    row.appendChild(td);
  }
  $('log').prepend(row);
  renderSummary();
}

function renderSummary() {
  const ok = station.events.filter((e) => e.type === 'ok');
  const bad = station.events.filter((e) => e.type === 'stale' || e.type === 'bad-signature');
  const age = median(ok.map((e) => e.ageMs).filter((v) => v != null));
  const gap = median(ok.map((e) => e.gapMs).filter((v) => v != null && v < 15000));
  $('st-phones').textContent = station.devices.size;
  $('st-ok').textContent = ok.length;
  $('st-age').textContent = age == null ? '—' : seconds(age);
  $('st-gap').textContent = gap == null ? '—' : seconds(gap);
  $('st-bad').textContent = bad.length;
}

async function onStationTexts(texts) {
  for (const text of texts) {
    const kind = kindOf(text);
    if (kind === 'enroll') await onEnroll(text);
    else if (kind === 'response') await onResponse(text);
  }
}

async function onEnroll(text) {
  let card;
  try { card = decodeEnroll(text); } catch (e) { return; }
  const kidBytes = await kidOf(card.pub);
  const kid = toHex(kidBytes);
  if (!station.devices.has(kid)) {
    station.devices.set(kid, { label: card.label || 'Телефон', diag: card.diag, pub: card.pub, marks: 0 });
    await station.core.addDevice(kidBytes, card.pub, { label: card.label });
    saveDevices();
    setBanner('', `Телефон «${card.label || 'без подписи'}» добавлен`, 'Подержите его у камеры ещё секунду: сейчас пройдёт первая отметка.');
    logEvent('', card.label, { type: 'enroll', text: 'знакомство' }, null, null, kid);
  }
  // Сообщаем телефону, что станция его знает: его идентификатор появляется в коде станции.
  if (!quiet('enroll-ack:' + kid, 1000)) {
    station.core.acks.push({ tag: kidBytes, until: station.core.now() + 4500 });
    station.core.dirty = true;
  }
}

async function onResponse(text) {
  const result = await station.core.handleScan(text);
  const now = performance.now();
  const device = result.kid ? station.devices.get(result.kid) : null;
  const label = device ? device.label : 'неизвестный';

  if (result.type === 'ok') {
    const gone = now - (station.lastSeen.get(result.kid) || -1e9) > 2000;
    station.lastSeen.set(result.kid, now);
    if (!gone || result.repeat) return;
    const gap = station.lastOkAt == null ? null : now - station.lastOkAt;
    station.lastOkAt = now;
    device.marks += 1;
    beep('ok');
    setBanner('ok', '✓ ' + label, 'цикл ' + seconds(result.ageMs));
    logEvent('ok', label, { type: 'ok', text: 'отмечено' }, result.ageMs, gap, result.kid);
    return;
  }
  if (result.repeat) return;
  if (result.type === 'stale') {
    // Телефон, который только что отметился и ещё показывает прежний код, — не отказ.
    if (now - (station.lastSeen.get(result.kid) || -1e9) < 20000) return;
    if (quiet('stale:' + result.kid)) return;
    beep('bad');
    setBanner('warn', 'Код устарел', 'Телефон должен видеть экран станции и одновременно показывать свой экран камере.');
    logEvent('warn', label, { type: 'stale', text: 'код устарел' }, null, null, result.kid);
  } else if (result.type === 'unknown-device') {
    if (quiet('unknown:' + result.kid, 4000)) return;
    setBanner('warn', 'Незнакомый телефон', 'Подержите его у камеры: он покажет визитку сам.');
  } else if (result.type === 'bad-signature') {
    if (quiet('bad:' + result.kid)) return;
    beep('bad');
    setBanner('bad', 'Подпись не сошлась', label);
    logEvent('bad', label, { type: 'bad-signature', text: 'подпись не сошлась' }, null, null, result.kid);
  }
}

function stationTick() {
  if (!station.core) return;
  if (station.core.tick()) {
    const text = station.core.challengeText();
    drawQr($('station-qr'), text);
    if (!$('overlay').hidden) drawQr($('overlay-qr'), text);
  }
}

function stationInfo() {
  if (!station.scanner) return;
  const s = station.scanner.stats;
  $('station-info').textContent = `распознавание: ${s.kind === 'native' ? 'встроенное' : 'ZXing'}, камера ${s.width}×${s.height}, ${Math.round(s.decodeMs)} мс на кадр${offlineReady() ? ', офлайн-копия готова' : ''}`;
}

async function fillCameras() {
  const select = $('camera');
  const cameras = await listCameras();
  select.textContent = '';
  cameras.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || 'Камера ' + (i + 1);
    select.appendChild(opt);
  });
  const active = station.scanner && station.scanner.stream && station.scanner.stream.getVideoTracks()[0];
  const current = active && active.getSettings ? active.getSettings().deviceId : '';
  if (current) select.value = current;
}

async function startStation() {
  unlockAudio();
  $('station-setup').hidden = true;
  $('station-run').hidden = false;
  station.startedAt = performance.now();
  loadDevices();
  await buildCore();
  renderSummary();
  station.scanner = new Scanner({
    video: $('station-video'), facing: 'user', onTexts: onStationTexts, maxDim: 1280, intervalMs: 50, prefer: PREFER,
    onState: (state, error) => { if (state === 'error') setBanner('bad', 'Камера остановилась', cameraErrorText(error)); },
  });
  try {
    await station.scanner.start();
  } catch (e) {
    setBanner('bad', 'Камера не запустилась', cameraErrorText(e));
  }
  station.timer = setInterval(stationTick, 120);
  station.infoTimer = setInterval(stationInfo, 1000);
  stationTick();
  fillCameras();
  keepAwake();
}

function buildReport() {
  const ok = station.events.filter((e) => e.type === 'ok');
  const s = station.scanner ? station.scanner.stats : {};
  const flags = (diag) => Object.fromEntries(Object.entries(DIAG).map(([name, bit]) => [name, Boolean(diag & bit)]));
  return {
    app: 'zdes-proto',
    version: VERSION,
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio },
    offlineCopy: offlineReady(),
    online: navigator.onLine,
    decoder: { kind: s.kind, decodeMs: Math.round(s.decodeMs || 0) },
    camera: { label: s.label, width: s.width, height: s.height },
    windowMs: Number($('window').value),
    summary: {
      phones: station.devices.size,
      marks: ok.length,
      medianCycleMs: median(ok.map((e) => e.ageMs)),
      medianGapMs: median(ok.map((e) => e.gapMs).filter((v) => v != null && v < 15000)),
      stale: station.events.filter((e) => e.type === 'stale').length,
      badSignature: station.events.filter((e) => e.type === 'bad-signature').length,
    },
    phones: [...station.devices].map(([kid, d]) => ({ kid, label: d.label, marks: d.marks, ...flags(d.diag) })),
    events: station.events,
  };
}

async function copyReport() {
  const text = JSON.stringify(buildReport(), null, 1);
  try {
    await navigator.clipboard.writeText(text);
    toast('Отчёт скопирован. Вставьте его в чат.');
  } catch (e) {
    toast('Не получилось скопировать. Нажмите «Скачать отчёт».');
  }
}

function saveReport() {
  const blob = new Blob([JSON.stringify(buildReport(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'zdes-proto-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function resetStation() {
  if (!confirm('Стереть журнал и список телефонов на этой станции?')) return;
  station.devices.clear();
  station.events = [];
  station.lastSeen.clear();
  station.lastOkAt = null;
  station.n = 0;
  saveDevices();
  $('log').textContent = '';
  await buildCore();
  renderSummary();
  setBanner('', 'Ждём первый телефон');
}

// --- Запуск ------------------------------------------------------------------

$('version').textContent = VERSION + (PREFER === 'wasm' ? ' (принудительно ZXing)' : '');
$('go-phone').addEventListener('click', () => { show('phone'); runPhoneChecks(); });
$('go-station').addEventListener('click', () => show('station'));
$('phone-back').addEventListener('click', () => { if (phone.scanner) stopPhone(); show('home'); });
$('station-back').addEventListener('click', () => { store.set('proto-role', 'home'); location.reload(); });
$('phone-start').addEventListener('click', startPhone);
$('phone-stop').addEventListener('click', stopPhone);
$('phone-camera').addEventListener('click', switchPhoneCamera);
$('station-start').addEventListener('click', startStation);
$('copy').addEventListener('click', copyReport);
$('save').addEventListener('click', saveReport);
$('reset').addEventListener('click', resetStation);
$('window').addEventListener('change', async () => { await buildCore(); stationTick(); });
$('camera').addEventListener('change', (e) => station.scanner && station.scanner.setCamera({ deviceId: e.target.value }));
$('big').addEventListener('click', () => { $('overlay').hidden = false; drawQr($('overlay-qr'), station.core.challengeText()); });
$('overlay').addEventListener('click', () => { $('overlay').hidden = true; });
setInterval(phoneIdleTick, 500);

const role = store.get('proto-role', 'home');
if (role === 'phone') { show('phone'); runPhoneChecks(); } else if (role === 'station') show('station'); else show('home');
registerServiceWorker();
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', renderHomeOffline);
renderHomeOffline();
