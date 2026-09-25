// Numbers she types in from the pack when the databases have no fat figure
// (or the wrong one). Saved on the phone per barcode. She is reading the
// pack in her hand, so this counts as label data ("trust: label").

const num = (s) => {
  if (s == null || String(s).trim() === '') return null;
  const v = Number(String(s).replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
};

// input: strings straight from the form. Returns { ok:true, value } or { ok:false, error }.
export function validateManual({ fat, sat, serving, name }, { needName = false } = {}) {
  const f = num(fat);
  if (f == null) return { ok: false, error: 'Type the total fat in grams from the Nutrition Facts label (0 if it says 0 g).' };
  if (Number.isNaN(f) || f < 0 || f > 200) return { ok: false, error: 'Total fat should be a number of grams between 0 and 200.' };
  const s = num(sat);
  if (Number.isNaN(s) || (s != null && (s < 0 || s > f + 0.5))) {
    return { ok: false, error: "Saturated fat can't be more than the total fat - check the label." };
  }
  const cleanName = String(name || '').trim().slice(0, 80);
  if (needName && !cleanName) return { ok: false, error: 'Add a short name so you can tell what this is later.' };
  return {
    ok: true,
    value: {
      fatServing: f,
      satFatServing: s,
      servingText: String(serving || '').trim().slice(0, 60),
      name: cleanName,
      at: new Date().toISOString(),
    },
  };
}

// product may be null (barcode in no database).
export function applyManual(product, manual, barcode) {
  const base = product || { name: '', brand: '', ingredients: '', updated: null };
  return {
    ...base,
    barcode,
    name: base.name || manual.name || barcode,
    fatServing: manual.fatServing,
    satFatServing: manual.satFatServing ?? null,
    fat100: null,
    satFat100: null,
    servingG: null,
    servingText: manual.servingText || '',
    fatServingComputed: false,
    childServing: false,
    conflict: null,
    trust: 'label',
    manual: true,
    source: 'Typed in by you from the pack',
    updated: String(manual.at || '').slice(0, 10) || null,
    // Keep a note of which database record this replaced (not our own earlier edit).
    alsoFound: product?.manual ? product.alsoFound || [] : product?.source ? [product.source] : [],
    warnings: [],
  };
}

// Plain-English reason there is no fat figure, from what the lookup returned.
export function whyNoFat(product, errors = []) {
  const usdaFailed = errors.some((e) => /usda/i.test(e.source));
  const offFailed = errors.some((e) => /open food/i.test(e.source));
  const found = [product?.source, ...(product?.alsoFound || [])].filter(Boolean);
  const parts = [];
  if (found.length) parts.push(`${found.join(' and ')} ${found.length > 1 ? 'have' : 'has'} this product, but no fat figure for it.`);
  const has = (re) => found.some((f) => re.test(f));
  if (!has(/usda/i)) parts.push(usdaFailed ? 'USDA could not be checked just now.' : 'USDA has no record of this barcode.');
  if (!has(/open food/i)) parts.push(offFailed ? 'Open Food Facts could not be checked just now.' : 'Open Food Facts has no record of this barcode.');
  return parts.join(' ');
}
