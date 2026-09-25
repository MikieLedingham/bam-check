import { store, localDayKey } from './lib/store.js';
import { lookupBarcode } from './lib/lookup.js';
import { assess, dayTotal, parseTerms, termRegex } from './lib/score.js';
import { normalizeBarcode } from './lib/gtin.js';
import { applyManual, validateManual, whyNoFat } from './lib/manual.js';
import { Scanner, cameraSupported, describeCameraError, prepareDecoder, decodeImageFile } from './lib/scanner.js';

const $ = (sel) => document.querySelector(sel);
const APP_VERSION = '0.1.0';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtG = (v) => {
  if (v == null || !Number.isFinite(v)) return '-';
  if (v > 0 && v < 0.1) return '<0.1 g';
  return `${Math.round(v * 10) / 10} g`;
};

const state = {
  tab: 'scan',
  cur: null, // { product, portion:{servings,grams}, errors, saved? }
  token: 0, // guards against a slow lookup landing after the user moved on
};

const el = {
  video: $('#video'),
  viewfinder: $('#viewfinder'),
  status: $('#scanStatus'),
  startBtn: $('#startBtn'),
  manualForm: $('#manualForm'),
  manualInput: $('#manualInput'),
  result: $('#result'),
  scanner: $('#scanner'),
  setup: $('#setupNotice'),
  chip: $('#budgetChip'),
  toast: $('#toast'),
  recentBox: $('#recentBox'),
  recentList: $('#recentList'),
  tools: $('#vfTools'),
  torchBtn: $('#torchBtn'),
  zoomBtn: $('#zoomBtn'),
  photoBtn: $('#photoBtn'),
  photoInput: $('#photoInput'),
};

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 2600);
}

// ------------------------------------------------------------------ tabs

function showTab(name) {
  state.tab = name;
  if (name !== 'scan') stopCamera();
  for (const t of ['scan', 'today', 'settings']) $(`#tab-${t}`).hidden = t !== name;
  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'today') renderToday();
  if (name === 'settings') renderSettings();
  if (name === 'scan') renderScanChrome();
  window.scrollTo(0, 0);
}

function renderChip() {
  const s = store.settings();
  if (s.dailyFatG) {
    const total = dayTotal(store.log(), localDayKey());
    el.chip.textContent = `Today ${fmtG(total)} / ${s.dailyFatG} g`;
  } else {
    el.chip.textContent = 'No target set';
  }
}

function renderScanChrome() {
  const s = store.settings();
  el.setup.hidden = Boolean(s.dailyFatG);
  renderChip();
  const recent = store.recent();
  el.recentBox.hidden = recent.length === 0;
  el.recentList.innerHTML = recent
    .slice(0, 12)
    .map((r) => `<li><button type="button" data-barcode="${esc(r.product.barcode)}">${esc(r.product.name || r.product.barcode)}<span class="muted small">${esc(r.product.brand ? ` - ${r.product.brand}` : '')}</span></button></li>`)
    .join('');
}

// ---------------------------------------------------------------- camera

const scanner = new Scanner(el.video, { onCode: (raw, format) => handleBarcode(raw, format) });

function setStatus(msg, isErr = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('err', isErr);
}

let hintTimer;
let torchOn = false;
let zoomLevel = 1;

async function startCamera() {
  clearResult();
  if (!cameraSupported()) {
    setStatus('This browser cannot use the camera here. Take a photo or type the number instead.', true);
    return;
  }
  setStatus('Starting camera...');
  el.startBtn.hidden = true;
  try {
    await scanner.start();
    el.viewfinder.hidden = false;
    setStatus('Hold the barcode inside the box, about 6-8 inches away.');
    setupCameraTools();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (scanner.running) setStatus('Not reading? Move back a little, keep the barcode flat, add light - or use "Take a photo" or type the number below.');
    }, 9000);
  } catch (err) {
    el.viewfinder.hidden = true;
    el.startBtn.hidden = false;
    setStatus(describeCameraError(err), true);
  }
}

// Light and zoom buttons appear only where this phone's browser supports them.
function setupCameraTools() {
  const c = scanner.controls();
  torchOn = false;
  zoomLevel = 1;
  el.torchBtn.hidden = !c.torch;
  el.zoomBtn.hidden = !c.zoom;
  el.tools.hidden = !(c.torch || c.zoom);
  el.torchBtn.setAttribute('aria-pressed', 'false');
  el.zoomBtn.textContent = 'Zoom 1x';
}

function stopCamera() {
  clearTimeout(hintTimer);
  scanner.stop();
  el.viewfinder.hidden = true;
  el.startBtn.hidden = false;
}

function clearResult() {
  state.token++;
  state.cur = null;
  el.result.hidden = true;
  el.result.innerHTML = '';
  el.scanner.hidden = false;
}

function backToScanner({ autoStart } = {}) {
  clearResult();
  setStatus("Point the camera at a food's barcode.");
  renderScanChrome();
  window.scrollTo(0, 0);
  if (autoStart) startCamera();
}

// ---------------------------------------------------------------- lookup

function showResultShell(html) {
  stopCamera();
  el.scanner.hidden = true;
  el.result.hidden = false;
  el.result.innerHTML = html;
  window.scrollTo(0, 0);
}

function messageCard(title, body, extra = '') {
  return `<div class="card"><h2>${esc(title)}</h2><p>${body}</p></div>${extra}
    <div class="actions"><button class="btn primary big" type="button" data-act="scan-again">Scan another</button></div>`;
}

async function handleBarcode(raw, format = '') {
  const bc = normalizeBarcode(raw, format);
  if (!bc.ok) {
    showResultShell(messageCard("That number didn't work", esc(bc.error)));
    return;
  }
  if (bc.storeLabel) {
    showResultShell(messageCard('Store-made label',
      'This barcode starts with 2, which stores print themselves (deli, butcher, produce, bakery) with a price or weight inside. It is not a product code, so it cannot be looked up. Ask for the nutrition information at the counter.'));
    return;
  }

  const token = ++state.token;
  showResultShell(`<div class="card" role="status"><p>Looking up <b>${esc(bc.code)}</b>...</p><div class="spinner" aria-hidden="true"></div></div>`);

  const settings = store.settings();
  const res = await lookupBarcode(raw, { usdaKey: settings.usdaKey, format });
  if (token !== state.token) return; // user moved on

  // Numbers she typed in from this pack earlier win over the databases.
  const typed = store.manualFor(bc.code);
  const product = typed ? applyManual(res.product, typed, bc.code) : res.product;
  if (product) {
    state.cur = { product, dbProduct: res.product, portion: { servings: 1, grams: null }, errors: res.errors, saved: null };
    store.remember(product); // saved copy for when there is no signal
    renderResult();
    return;
  }

  // Nothing found. If it was because we are offline, fall back to a saved copy.
  const allFailed = res.errors.length === 2;
  if (allFailed) {
    const saved = store.recentFor(bc.code);
    if (saved) {
      state.cur = { product: saved.product, dbProduct: null, portion: { servings: 1, grams: null }, errors: res.errors, saved: saved.at };
      renderResult();
      return;
    }
    showResultShell(messageCard("Couldn't reach the food databases",
      `No signal, or both services are busy (${res.errors.map((e) => `${esc(e.source)}: ${esc(e.message)}`).join('; ')}).${rateHint(res.errors)} Try again in a moment, or type the fat from the pack below.`,
      manualFormHtml(bc.code, { needName: true })));
    return;
  }
  const partial = res.errors.length
    ? `<div class="warn">${esc(res.errors[0].source)} could not be checked (${esc(res.errors[0].message)}), so this may be a gap in the search, not in the databases.${esc(rateHint(res.errors))}</div>`
    : '';
  state.cur = null;
  showResultShell(messageCard('Not found',
    `Barcode <b>${esc(bc.code)}</b> isn't in the USDA or Open Food Facts databases. Type the fat from the pack's Nutrition Facts below and it will be remembered for next time.`,
    partial + manualFormHtml(bc.code, { needName: true })));
}

// A shared demo key gets rate-limited quickly; her own free key does not.
function rateHint(errors) {
  const limited = errors.some((e) => /rate limit/i.test(e.message));
  return limited && !store.settings().usdaKey ? ' Add your free USDA key in Settings to fix this.' : '';
}

function manualFormHtml(barcode, { needName = false, prefill = {}, bare = false } = {}) {
  return `<form class="${bare ? '' : 'card '}manual-form" data-manual="${esc(barcode)}" autocomplete="off">
    ${bare ? '' : '<h3>Type it in from the pack</h3><p class="hint">Find "Total Fat" on the Nutrition Facts label. It is saved on this phone for next time.</p>'}
    ${needName ? `<div class="field"><label for="m-name">What is it?</label><input id="m-name" type="text" maxlength="80" value="${esc(prefill.name || '')}" placeholder="e.g. Sea salt kettle chips"></div>` : ''}
    <div class="split">
      <div class="field"><label for="m-fat">Total fat (g)</label><input id="m-fat" type="number" inputmode="decimal" min="0" max="200" step="0.1" value="${esc(prefill.fat ?? '')}"></div>
      <div class="field"><label for="m-sat">Saturated fat (g)</label><input id="m-sat" type="number" inputmode="decimal" min="0" max="200" step="0.1" value="${esc(prefill.sat ?? '')}"></div>
    </div>
    <div class="field"><label for="m-serv">Serving size on the pack</label><input id="m-serv" type="text" maxlength="60" value="${esc(prefill.serv || '')}" placeholder="e.g. 1 cup (30 g)"></div>
    <p id="m-error" class="status err" role="alert" hidden></p>
    <button class="btn primary big" type="submit">Save and use</button>
  </form>`;
}

// ---------------------------------------------------------------- result

function highlight(text, avoid, watch) {
  const re = termRegex([...avoid, ...watch]);
  if (!re || !text) return esc(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    const isAvoid = avoid.includes(m[2].toLowerCase());
    out += `${esc(text.slice(last, start))}<mark class="${isAvoid ? '' : 'watch'}">${esc(text.slice(start, end))}</mark>`;
    last = end;
  }
  return out + esc(text.slice(last));
}

const ICONS = { green: '✓', amber: '!', red: '✕', grey: '?', facts: 'i' };

function renderResult() {
  const { product: p, saved } = state.cur;
  const settings = store.settings();
  const hasServing = p.fatServing != null;
  const per100Only = !hasServing && p.fat100 != null;

  const offline = saved
    ? `<div class="warn">No signal - showing the copy saved on ${esc(new Date(saved).toLocaleDateString())}. Data may be out of date.</div>`
    : '';
  const partial = (state.cur.errors || []).length && !saved
    ? `<div class="warn">${esc(state.cur.errors.map((e) => e.source).join(' and '))} could not be checked just now (${esc(state.cur.errors[0].message)}). This answer comes from ${esc(p.source)} only.${esc(rateHint(state.cur.errors))}</div>`
    : '';

  // No fat figure anywhere -> say why and let her type it from the pack.
  // Otherwise offer a way to correct the numbers if they don't match the pack.
  const noFat = !hasServing && !per100Only;
  const prefill = { name: p.name, fat: p.manual ? p.fatServing : '', sat: p.manual ? p.satFatServing : '', serv: p.manual ? p.servingText : '' };
  let manualBlock;
  if (noFat) {
    manualBlock = `<div class="warn">${esc(whyNoFat(p, state.cur.errors || []))}</div>${manualFormHtml(p.barcode, { needName: !p.name })}`;
  } else {
    manualBlock = `${p.manual
      ? `<div class="notice">You typed these numbers from the pack (${esc(p.updated || '')}). <button class="link" type="button" data-act="manual-remove">Remove them and use the database again</button></div>`
      : ''}
      <details class="more"><summary>${p.manual ? 'Change the numbers' : "Numbers wrong or don't match the pack?"}</summary><div class="body">
        <p class="muted" style="margin-bottom:12px">Type what the pack says. It replaces the database's numbers for this product, on this phone.</p>
        ${manualFormHtml(p.barcode, { prefill, bare: true })}
      </div></details>`;
  }

  let portion = '';
  if (hasServing) {
    portion = `<div class="card">
        <b>How much are you having?</b>
        <div class="portion">
          <div class="stepper" role="group" aria-label="Number of servings">
            <button type="button" data-act="serv-" aria-label="Fewer servings">&minus;</button>
            <output id="servOut" aria-live="polite">1</output>
            <button type="button" data-act="serv+" aria-label="More servings">+</button>
          </div>
          <span id="servLbl" class="muted">serving</span>
        </div>
        <p class="hint">1 serving = ${esc(p.servingText || 'as listed on the label')}</p>
      </div>`;
  } else if (per100Only) {
    portion = `<div class="card">
        <label for="grams">How many grams will you eat?</label>
        <input id="grams" type="number" inputmode="decimal" min="1" max="2000" step="1" placeholder="e.g. 30">
        <p class="hint">This product only lists ${fmtG(p.fat100)} fat <b>per 100 g</b>, so the amount you eat matters.</p>
      </div>`;
  }

  const notes = [];
  if (p.conflict) {
    notes.push(`The two databases disagree: ${esc(p.conflict.a.source)} says ${fmtG(p.conflict.a.fat100)} fat per 100 g, ${esc(p.conflict.b.source)} says ${fmtG(p.conflict.b.fat100)}. The higher one is used. Check the label.`);
  }
  for (const w of p.warnings || []) notes.push(esc(w));
  const year = Number(String(p.updated || '').slice(0, 4));
  if (p.source.startsWith('USDA') && year && new Date().getFullYear() - year >= 3) {
    notes.push(`This record was last updated in ${year}. Recipes change, so check the pack.`);
  }
  if (p.fatServingComputed) notes.push('Fat per serving is worked out from the per-100 g figure and the serving size.');
  if (hasServing && p.fatServing <= 0.5) notes.push('Labels may round down: "0 g" can mean up to 0.5 g per serving, which adds up if you eat several.');

  el.result.innerHTML = `
    ${offline}${partial}
    <div class="card">
      <div class="product-name">${esc(p.name || 'Unnamed product')}</div>
      ${p.brand ? `<div class="brand">${esc(p.brand)}</div>` : ''}
      <div class="small muted">Barcode ${esc(p.barcode)}</div>
    </div>
    <div id="verdictBox"></div>
    ${portion}
    ${notes.map((n) => `<div class="warn">${n}</div>`).join('')}
    ${noFat ? manualBlock : ''}
    <div class="actions">
      <button class="btn primary big" type="button" id="ateBtn" data-act="ate">I ate this</button>
      <button class="btn big" type="button" data-act="scan-again">Scan another</button>
    </div>
    ${noFat ? '' : manualBlock}
    <details class="more"><summary>Ingredients</summary><div class="body">${
      p.ingredients ? highlight(p.ingredients, settings.avoid, settings.watch) : '<span class="muted">No ingredient list was found for this product.</span>'
    }</div></details>
    <details class="more"><summary>Where this data comes from</summary><div class="body">
      <p>${esc(p.source)}${p.updated ? `, record updated ${esc(p.updated)}` : ''}${p.alsoFound?.length ? `. Also found in ${esc(p.alsoFound.join(', '))}` : ''}.</p>
      <p class="muted" style="margin-top:8px">Databases can be wrong, out of date, or describe a different pack size or recipe. The label on the pack you're holding is the final word. This app is a guide, not medical advice.</p>
    </div></details>`;
  renderVerdict();
}

function currentAssessment() {
  const settings = store.settings();
  const loggedTodayG = dayTotal(store.log(), localDayKey());
  return { a: assess({ product: state.cur.product, portion: state.cur.portion, settings, loggedTodayG }), settings, loggedTodayG };
}

function renderVerdict() {
  if (!state.cur) return;
  const { a, settings, loggedTodayG } = currentAssessment();
  const box = $('#verdictBox');
  if (!box) return;

  let sub;
  if (a.fatG == null) sub = 'Fat amount unknown';
  else if (a.sharePct != null) sub = `${fmtG(a.fatG)} fat - ${Math.round(a.sharePct)}% of your daily budget`;
  else sub = `${fmtG(a.fatG)} fat`;

  let meter = '';
  if (settings.dailyFatG && a.fatG != null) {
    const b = settings.dailyFatG;
    const usedPct = Math.min(100, (loggedTodayG / b) * 100);
    const thisPct = Math.min(100 - usedPct, (a.fatG / b) * 100);
    const over = loggedTodayG + a.fatG > b;
    meter = `<div class="meter ${over ? 'over' : ''}"><div class="bar" role="img" aria-label="Daily budget"><i class="used" style="width:${usedPct}%"></i><i class="this" style="width:${thisPct}%"></i></div>
      <p>Today so far ${fmtG(loggedTodayG)} of ${b} g${over ? ' - this would go over' : ''}</p></div>`;
  }

  const sat = a.satFatG != null ? `<div><b>${fmtG(a.satFatG)}</b><span>saturated fat</span></div>` : '';
  box.innerHTML = `
    <div class="card">
      <div class="verdict v-${a.level}" role="status">
        <span class="vicon" aria-hidden="true">${ICONS[a.level]}</span>
        <div><div class="vtitle">${esc(a.title)}</div><div class="vsub">${esc(sub)}</div></div>
      </div>
      ${a.reasons.length ? `<ul class="reasons">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${a.fatG != null ? `<div class="nums"><div><b>${fmtG(a.fatG)}</b><span>fat</span></div>${sat}</div>` : ''}
      ${meter}
    </div>`;

  const ate = $('#ateBtn');
  if (ate) ate.disabled = a.fatG == null;
  const out = $('#servOut');
  if (out) {
    out.textContent = String(state.cur.portion.servings);
    $('#servLbl').textContent = state.cur.portion.servings === 1 ? 'serving' : 'servings';
  }
}

function portionLabel() {
  const { product: p, portion } = state.cur;
  if (p.fatServing != null) return `${portion.servings} x ${p.servingText || 'serving'}`;
  return `${portion.grams} g`;
}

function logCurrent() {
  if (!state.cur) return;
  const { a } = currentAssessment();
  if (a.fatG == null) return;
  const p = state.cur.product;
  store.addLog({
    barcode: p.barcode,
    name: p.name || p.barcode,
    brand: p.brand || '',
    fatG: Math.round(a.fatG * 100) / 100,
    satFatG: a.satFatG != null ? Math.round(a.satFatG * 100) / 100 : null,
    portion: portionLabel(),
    level: a.level,
  });
  store.remember(p, a.level);
  toast(`Added ${fmtG(a.fatG)} to today`);
  backToScanner();
}

// ----------------------------------------------------------------- today

function renderToday() {
  const s = store.settings();
  const log = store.log();
  const today = localDayKey();
  const todays = log.filter((e) => e.day === today).sort((a, b) => b.t.localeCompare(a.t));
  const total = dayTotal(log, today);

  let meter = '';
  if (s.dailyFatG) {
    const pct = Math.min(100, (total / s.dailyFatG) * 100);
    const over = total > s.dailyFatG;
    meter = `<div class="meter ${over ? 'over' : ''}"><div class="bar" role="img" aria-label="Fat used today"><i class="${over ? 'this' : 'used'}" style="width:${pct}%"></i></div>
      <p>${over ? `${fmtG(total - s.dailyFatG)} over` : `${fmtG(s.dailyFatG - total)} left`} of your ${s.dailyFatG} g daily budget</p></div>`;
  }

  const byDay = new Map();
  for (const e of log) if (e.day !== today) byDay.set(e.day, (byDay.get(e.day) || 0) + (e.fatG || 0));
  const earlier = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);

  $('#tab-today').innerHTML = `
    <div class="card"><h3>Fat eaten today</h3><div class="day-total">${fmtG(total)}</div>${meter}</div>
    <div class="card"><h3>What you've logged</h3>${
      todays.length
        ? `<ul class="entries">${todays.map((e) => `<li><div class="grow"><div><b>${esc(e.name)}</b></div><div class="small muted">${esc(e.portion || '')}</div></div><span class="fat">${fmtG(e.fatG)}</span><button class="x" type="button" data-remove="${esc(e.id)}" aria-label="Remove ${esc(e.name)}">&times;</button></li>`).join('')}</ul>`
        : '<p class="muted">Nothing yet. After scanning a food, tap "I ate this" to add it.</p>'
    }</div>
    ${earlier.length ? `<details class="more"><summary>Earlier days</summary><div class="body"><ul class="entries">${earlier.map(([d, g]) => `<li><div class="grow">${esc(d)}</div><span class="fat">${fmtG(g)}</span></li>`).join('')}</ul></div></details>` : ''}`;
  renderChip();
}

// -------------------------------------------------------------- settings

function renderSettings() {
  const s = store.settings();
  $('#tab-settings').innerHTML = `
    <div class="card">
      <h2>Your targets</h2>
      <p class="muted small">These numbers should come from your doctor or dietitian. Until a daily fat budget is set, the app shows numbers only - no green, amber or red.</p>
      <div class="field" style="margin-top:14px">
        <label for="s-budget">Daily fat budget (grams)</label>
        <input id="s-budget" type="number" inputmode="decimal" min="1" max="300" step="1" value="${s.dailyFatG ?? ''}" placeholder="not set">
      </div>
      <div class="field">
        <label for="s-avoid">Avoid - ingredient words that make a food red</label>
        <textarea id="s-avoid" placeholder="e.g. caffeine, alcohol">${esc(s.avoid.join(', '))}</textarea>
      </div>
      <div class="field">
        <label for="s-watch">Watch - words that make a food at least amber</label>
        <textarea id="s-watch" placeholder="e.g. sorbitol">${esc(s.watch.join(', '))}</textarea>
        <p class="hint">Separate words with commas. Matched against each product's ingredient list.</p>
      </div>
      <details class="more" style="margin-top:14px;padding:0 12px">
        <summary>How strict is each colour?</summary>
        <div class="body">
          <p class="muted">One serving's fat as a share of the daily budget. These are starting points - agree them with your dietitian.</p>
          <div class="split" style="margin-top:10px">
            <div><label for="s-green">Green up to %</label><input id="s-green" type="number" inputmode="numeric" min="1" max="99" value="${s.greenPct}"></div>
            <div><label for="s-amber">Amber up to %</label><input id="s-amber" type="number" inputmode="numeric" min="2" max="100" value="${s.amberPct}"></div>
          </div>
          <p class="hint">Above the amber figure, or more than is left of today's budget, is red.</p>
        </div>
      </details>
      <p id="s-error" class="status err" role="alert" hidden></p>
    </div>

    <div class="card">
      <h3>Food database key</h3>
      <label for="s-key" class="small muted" style="font-weight:400">USDA FoodData Central API key</label>
      <input id="s-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(s.usdaKey || '')}" placeholder="using the shared demo key">
      <p class="hint">Optional but recommended. The shared demo key allows only a handful of lookups per hour. A free personal key comes from api.data.gov/signup.</p>
    </div>

    <div class="card">
      <h3>Your data</h3>
      <p class="muted small">Everything above stays on this phone. Only the barcode number is sent to look a food up.</p>
      <div class="btns" style="margin-top:12px">
        <button class="btn" type="button" data-act="export">Save a backup</button>
        <label class="btn" style="display:flex;align-items:center;justify-content:center;margin:0;cursor:pointer">Restore from backup<input id="s-import" type="file" accept="application/json,.json" hidden></label>
        <button class="btn danger" type="button" data-act="wipe">Erase everything on this phone</button>
      </div>
    </div>

    <div class="card small muted">
      <b>BAM Check ${APP_VERSION}</b><br>
      A guide for reading food labels, not medical advice. Food data from USDA FoodData Central and Open Food Facts, which can contain mistakes; always check the pack. Fat is the main thing tracked here because it triggers bile release - what counts as "safe" for you is between you and your care team.
    </div>`;
}

function saveSettingsFromForm() {
  const err = $('#s-error');
  const s = store.settings();
  const fail = (msg) => { err.textContent = msg; err.hidden = false; return false; };
  err.hidden = true;

  const rawBudget = $('#s-budget').value.trim();
  let budget = null;
  if (rawBudget !== '') {
    budget = Number(rawBudget);
    if (!Number.isFinite(budget) || budget < 1 || budget > 300) return fail('The daily fat budget should be between 1 and 300 grams.');
  }
  const green = Number($('#s-green').value);
  const amber = Number($('#s-amber').value);
  if (!(green >= 1 && green <= 99 && amber > green && amber <= 100)) return fail('The amber percentage must be higher than green, and both between 1 and 100.');

  store.saveSettings({
    ...s,
    dailyFatG: budget,
    greenPct: green,
    amberPct: amber,
    avoid: parseTerms($('#s-avoid').value),
    watch: parseTerms($('#s-watch').value),
    usdaKey: $('#s-key').value.trim(),
  });
  renderChip();
  toast('Saved');
  return true;
}

async function exportBackup() {
  const text = store.exportAll();
  const name = `bam-check-backup-${localDayKey()}.json`;
  const file = new File([text], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'BAM Check backup' });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- events

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab],[data-goto],[data-act],[data-barcode],[data-remove]');
  if (!t) return;
  if (t.dataset.tab || t.dataset.goto) return showTab(t.dataset.tab || t.dataset.goto);
  if (t.dataset.barcode) return handleBarcode(t.dataset.barcode);
  if (t.dataset.remove) {
    if (confirm('Remove this from today?')) { store.removeLog(t.dataset.remove); renderToday(); }
    return;
  }
  switch (t.dataset.act) {
    case 'scan-again': return backToScanner({ autoStart: true });
    case 'serv+':
      state.cur.portion.servings = Math.min(20, state.cur.portion.servings + 0.5);
      state.cur.portion.confirmed = true;
      return renderVerdict();
    case 'serv-':
      state.cur.portion.servings = Math.max(0.5, state.cur.portion.servings - 0.5);
      state.cur.portion.confirmed = true;
      return renderVerdict();
    case 'ate': return logCurrent();
    case 'manual-remove': {
      const code = state.cur?.product?.barcode;
      if (code) { store.clearManual(code); handleBarcode(code); }
      return;
    }
    case 'export': return exportBackup();
    case 'wipe':
      if (confirm('Erase your targets, log and saved products from this phone? This cannot be undone.')) {
        store.wipe();
        renderSettings();
        renderChip();
        toast('Erased');
      }
      return;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'grams' && state.cur) {
    const g = parseFloat(e.target.value);
    state.cur.portion.grams = Number.isFinite(g) && g > 0 ? g : null;
    renderVerdict();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.closest('#tab-settings')) {
    if (e.target.id === 's-import') {
      const f = e.target.files?.[0];
      if (!f) return;
      f.text().then((txt) => {
        try { store.importAll(txt); renderSettings(); renderChip(); toast('Backup restored'); }
        catch (err) { toast(err.message || 'That file could not be read'); }
      });
      return;
    }
    saveSettingsFromForm();
  }
});

// Save fat numbers typed in from the pack.
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-manual]');
  if (!form) return;
  e.preventDefault();
  const barcode = form.dataset.manual;
  const nameEl = form.querySelector('#m-name');
  const needName = Boolean(nameEl);
  const v = validateManual({
    fat: form.querySelector('#m-fat').value,
    sat: form.querySelector('#m-sat').value,
    serving: form.querySelector('#m-serv').value,
    name: nameEl ? nameEl.value : '',
  }, { needName });
  const err = form.querySelector('#m-error');
  if (!v.ok) { err.textContent = v.error; err.hidden = false; return; }
  err.hidden = true;

  store.setManual(barcode, v.value);
  const base = state.cur?.dbProduct ?? state.cur?.product ?? null;
  const product = applyManual(base, v.value, barcode);
  state.cur = { product, dbProduct: state.cur?.dbProduct ?? null, portion: { servings: 1, grams: null }, errors: state.cur?.errors || [], saved: null };
  store.remember(product);
  toast('Saved for next time');
  renderResult();
  window.scrollTo(0, 0);
});

el.startBtn.addEventListener('click', startCamera);

el.torchBtn.addEventListener('click', async () => {
  const want = !torchOn;
  if (await scanner.setTorch(want)) {
    torchOn = want;
    el.torchBtn.setAttribute('aria-pressed', String(torchOn));
  }
});

el.zoomBtn.addEventListener('click', async () => {
  const z = scanner.controls().zoom;
  if (!z) return;
  const want = zoomLevel === 1 ? Math.min(2, z.max) : 1;
  if (await scanner.setZoom(want)) {
    zoomLevel = want;
    el.zoomBtn.textContent = `Zoom ${zoomLevel}x`;
  }
});

// Photo mode: the phone's own camera app focuses and exposes better than a
// live web stream, and we read the barcode from the picture.
el.photoBtn.addEventListener('click', () => el.photoInput.click());
el.photoInput.addEventListener('change', async () => {
  const file = el.photoInput.files?.[0];
  el.photoInput.value = '';
  if (!file) return;
  stopCamera();
  setStatus('Reading the photo...');
  try {
    const hit = await decodeImageFile(file);
    if (hit) return handleBarcode(hit.rawValue, hit.format);
    setStatus("Couldn't find a barcode in that photo. Get close so the barcode fills most of the picture (flat, in focus, good light) and try again - or type the number.", true);
  } catch (err) {
    setStatus(`Couldn't read that photo (${err.message || err}). You can type the number instead.`, true);
  }
});

el.manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = el.manualInput.value;
  if (!v.trim()) return;
  el.manualInput.value = '';
  el.manualInput.blur();
  handleBarcode(v);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
});

// ------------------------------------------------------------------ boot

try { navigator.storage?.persist?.(); } catch { /* best effort */ }
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
try { prepareDecoder(); } catch { /* reported when the camera starts */ }
renderScanChrome();

// Exposed for the self-test page only.
window.__bam = { handleBarcode, state };
