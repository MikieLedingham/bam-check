// Barcode -> nutrition data, from two free public databases:
//   * USDA FoodData Central (branded foods) - strong US coverage
//   * Open Food Facts - crowd-sourced, fills gaps
// Each is normalised to the same record shape, sanity-checked, then merged.
// Nothing here ever decides "safe" - that is score.js, and it treats missing
// data as unknown.

import { normalizeBarcode } from './gtin.js';

const FETCH_TIMEOUT_MS = 12000;
const DEMO_KEY = 'DEMO_KEY';

// Serving descriptions written for young children ("3/4 cup (20g) (age 1-3 years)").
export const CHILD_SERVING = /\bage\b|toddler|infant|child|\bkids?\b/i;

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// Drop values that cannot be right instead of showing them.
export function sanityCheck(rec) {
  const warnings = [];
  const bad = (label) => warnings.push(`${label} looked wrong in the database, so it was ignored.`);

  if (rec.fat100 != null && (rec.fat100 < 0 || rec.fat100 > 100)) { rec.fat100 = null; bad('The fat per 100 g'); }
  if (rec.satFat100 != null && (rec.satFat100 < 0 || rec.satFat100 > 100)) { rec.satFat100 = null; bad('The saturated fat per 100 g'); }
  if (rec.fatServing != null && rec.fatServing < 0) { rec.fatServing = null; bad('The fat per serving'); }
  if (rec.fatServing != null && rec.servingG != null && rec.fatServing > rec.servingG * 1.001) {
    rec.fatServing = null; bad('The fat per serving');
  }
  if (rec.satFat100 != null && rec.fat100 != null && rec.satFat100 > rec.fat100 + 0.5) {
    rec.satFat100 = null; rec.satFatServing = null; bad('The saturated fat');
  }
  if (rec.satFatServing != null && rec.fatServing != null && rec.satFatServing > rec.fatServing + 0.5) {
    rec.satFatServing = null; bad('The saturated fat');
  }
  rec.warnings = [...(rec.warnings || []), ...warnings];
  return rec;
}

function fillServing(rec) {
  // Per-serving numbers derived from per-100 numbers when the source only
  // gave one form.
  if (rec.fatServing == null && rec.fat100 != null && rec.servingG) {
    rec.fatServing = round2((rec.fat100 * rec.servingG) / 100);
    rec.fatServingComputed = true;
  }
  if (rec.satFatServing == null && rec.satFat100 != null && rec.servingG) {
    rec.satFatServing = round2((rec.satFat100 * rec.servingG) / 100);
  }
  return rec;
}

// ---- USDA -----------------------------------------------------------------

const USDA_FAT = '204';
const USDA_SAT = '606';

export function normalizeUsda(food) {
  if (!food) return null;
  const nut = (code) => {
    for (const n of food.foodNutrients || []) {
      const c = String(n.nutrientNumber ?? n.nutrient?.number ?? '');
      if (c === code) return num(n.value ?? n.amount);
    }
    return null;
  };
  const unit = String(food.servingSizeUnit || '').toLowerCase();
  const sized = ['grm', 'g', 'mlt', 'ml'].includes(unit) && num(food.servingSize) > 0;
  const servingG = sized ? num(food.servingSize) : null;
  const household = clean(food.householdServingFullText);
  const servingText = household || (sized ? `${food.servingSize} ${unit.startsWith('m') ? 'ml' : 'g'}` : '');
  const brand = clean(food.brandName) || clean(food.brandOwner);
  const rec = {
    source: 'USDA FoodData Central',
    sourceId: String(food.fdcId ?? ''),
    name: clean(food.description),
    brand,
    servingText,
    servingG,
    servingUnit: unit.startsWith('m') ? 'ml' : 'g',
    fat100: nut(USDA_FAT),
    satFat100: nut(USDA_SAT),
    fatServing: null,
    satFatServing: null,
    ingredients: clean(food.ingredients),
    updated: clean(food.modifiedDate || food.publishedDate || food.publicationDate) || null,
    childServing: CHILD_SERVING.test(servingText),
    trust: 'label', // supplied by the manufacturer from the pack's label
    warnings: [],
  };
  return fillServing(sanityCheck(rec));
}

export function pickUsdaMatch(json, gtin14) {
  const foods = (json?.foods || []).filter((f) => String(f.gtinUpc || '').padStart(14, '0') === gtin14);
  foods.sort((a, b) => String(b.modifiedDate || '').localeCompare(String(a.modifiedDate || '')));
  return foods[0] || null;
}

// ---- Open Food Facts ------------------------------------------------------

// Error tags that mean the numbers themselves are suspect (not just a missing
// photo or serving size).
const NUTRITION_ERROR = /fat|energy|sum|greater|over|exceed|kj|kcal/i;

export function normalizeOff(json) {
  if (!json || json.status !== 1 || !json.product) return null;
  const p = json.product;
  const n = p.nutriments || {};
  const servingG = num(p.serving_quantity) > 0 ? num(p.serving_quantity) : null;
  const ingredientsEn = clean(p.ingredients_text_en);
  const ingredientsAny = clean(p.ingredients_text);
  const lang = clean(p.lang).toLowerCase();
  // Anyone can edit Open Food Facts. Only an entry a contributor has ticked
  // as "checked" (and that the site's own tests do not flag) earns trust.
  const nutritionErrors = (p.data_quality_errors_tags || []).filter((t) => NUTRITION_ERROR.test(t));
  const trust = nutritionErrors.length ? 'flagged' : p.checked === 'on' ? 'checked' : 'unverified';
  const rec = {
    source: 'Open Food Facts',
    sourceId: String(p.code ?? ''),
    name: clean(p.product_name_en) || clean(p.product_name) || clean(p.generic_name),
    brand: clean(p.brands).split(',')[0].trim(),
    servingText: clean(p.serving_size),
    servingG,
    servingUnit: 'g',
    fat100: num(n.fat_100g),
    satFat100: num(n['saturated-fat_100g']),
    fatServing: num(n.fat_serving),
    satFatServing: num(n['saturated-fat_serving']),
    ingredients: ingredientsEn || ingredientsAny,
    // A list in another language cannot be matched against English words.
    ingredientsForeign: Boolean(!ingredientsEn && ingredientsAny && lang && lang !== 'en'),
    updated: p.last_modified_t ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10) : null,
    childServing: CHILD_SERVING.test(clean(p.serving_size)),
    trust,
    warnings: [],
  };
  return fillServing(sanityCheck(rec));
}

// ---- merge ----------------------------------------------------------------

const hasFat = (r) => r && (r.fatServing != null || r.fat100 != null);

// Two sources disagreeing on fat is a real signal (crowd-sourced data has
// errors). When they do, use the record with MORE fat - the cautious choice -
// and say so.
export function mergeRecords(records) {
  const found = records.filter(Boolean);
  if (!found.length) return null;

  const withFat = found.filter(hasFat);
  let primary = withFat[0] || found[0];
  let conflict = null;

  const [a, b] = withFat;
  if (a && b && a.fat100 != null && b.fat100 != null) {
    const hi = Math.max(a.fat100, b.fat100);
    const lo = Math.min(a.fat100, b.fat100);
    if (hi - lo > Math.max(2, hi * 0.15)) {
      primary = a.fat100 >= b.fat100 ? a : b;
      conflict = { a: { source: a.source, fat100: a.fat100 }, b: { source: b.source, fat100: b.fat100 }, usedSource: primary.source };
    }
  }

  // Borrow gaps from the other record only where it cannot mislead.
  const product = { ...primary, alsoFound: found.filter((r) => r !== primary).map((r) => r.source), conflict };
  const other = found.find((r) => r !== primary);
  if (other) {
    if (!product.name) product.name = other.name;
    if (!product.brand) product.brand = other.brand;
    if (!product.ingredients) {
      product.ingredients = other.ingredients;
      product.ingredientsForeign = other.ingredientsForeign;
    }
  }
  product.warnings = [...primary.warnings];
  return product;
}

// ---- network --------------------------------------------------------------

async function getJson(url, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status === 404) return { notFound: true };
    if (res.status === 429) throw new Error('rate limit reached - try again in a little while');
    if (res.status === 403) throw new Error('the API key was rejected');
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    return { json: await res.json() };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const OFF_FIELDS = [
  'code', 'product_name', 'product_name_en', 'generic_name', 'brands',
  'serving_size', 'serving_quantity', 'nutriments',
  'ingredients_text', 'ingredients_text_en', 'lang', 'last_modified_t',
  'checked', 'data_quality_errors_tags',
].join(',');

async function fetchUsda(bc, key, signal) {
  const q = new URLSearchParams({
    api_key: key || DEMO_KEY,
    query: bc.gtin14,
    dataType: 'Branded',
    pageSize: '10',
  });
  const { json, notFound } = await getJson(`https://api.nal.usda.gov/fdc/v1/foods/search?${q}`, signal);
  if (notFound) return null;
  return normalizeUsda(pickUsdaMatch(json, bc.gtin14));
}

async function fetchOff(bc, signal) {
  if (!bc.ean13) return null;
  const { json, notFound } = await getJson(
    `https://world.openfoodfacts.org/api/v2/product/${bc.ean13}.json?fields=${OFF_FIELDS}`,
    signal,
  );
  if (notFound) return null;
  return normalizeOff(json);
}

// Returns { barcode, product|null, errors:[{source,message}] }.
export async function lookupBarcode(raw, { usdaKey = '', format = '', signal } = {}) {
  const bc = normalizeBarcode(raw, format);
  if (!bc.ok) return { barcode: null, product: null, errors: [], invalid: bc.error };

  const [usda, off] = await Promise.allSettled([fetchUsda(bc, usdaKey, signal), fetchOff(bc, signal)]);
  const errors = [];
  if (usda.status === 'rejected') errors.push({ source: 'USDA', message: usda.reason?.message || 'failed' });
  if (off.status === 'rejected') errors.push({ source: 'Open Food Facts', message: off.reason?.message || 'failed' });

  const product = mergeRecords([
    usda.status === 'fulfilled' ? usda.value : null,
    off.status === 'fulfilled' ? off.value : null,
  ]);
  if (product) product.barcode = bc.code;
  return { barcode: bc, product, errors };
}
