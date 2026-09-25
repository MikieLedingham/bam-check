import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDigitOk, upcEToUpcA, normalizeBarcode, sameBarcode } from '../lib/gtin.js';
import { normalizeUsda, normalizeOff, pickUsdaMatch, mergeRecords, sanityCheck } from '../lib/lookup.js';
import { assess, parseTerms, findTerms, portionFat, dayTotal } from '../lib/score.js';
import { validateManual, applyManual, whyNoFat } from '../lib/manual.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

// ---- barcodes -------------------------------------------------------------

test('check digits: valid codes pass, single-digit errors fail', () => {
  assert.ok(checkDigitOk('036000291452')); // classic UPC-A example
  assert.ok(checkDigitOk('016000275287')); // Cheerios
  assert.ok(checkDigitOk('3017620422003')); // Nutella
  assert.ok(!checkDigitOk('036000291453'));
  assert.ok(!checkDigitOk('3017620422004'));
  assert.ok(!checkDigitOk('12345'));
});

test('UPC-E expands to the right UPC-A for each zero-suppression form', () => {
  assert.equal(upcEToUpcA('01234565'), '012345000065');
  for (const e of ['01234565', '01234534', '01234543', '01234512']) {
    const a = upcEToUpcA(e);
    assert.equal(a.length, 12);
  }
  assert.equal(upcEToUpcA('21234565'), null);
});

test('normalizeBarcode pads to GTIN-14 and derives the EAN-13 form', () => {
  const r = normalizeBarcode('016000275287');
  assert.ok(r.ok);
  assert.equal(r.gtin14, '00016000275287');
  assert.equal(r.ean13, '0016000275287');
  assert.equal(r.kind, 'UPC-A');
});

test('a scanner-style 13-digit UPC-A and the typed 12 digits are the same product', () => {
  const scanned = normalizeBarcode('0016000275287', 'ean_13');
  const typed = normalizeBarcode('016000275287');
  assert.equal(scanned.code, '016000275287');
  assert.equal(scanned.code, typed.code);
  assert.equal(scanned.gtin14, typed.gtin14);
  assert.equal(scanned.kind, 'UPC-A');
  // a real EAN-13 keeps its 13 digits
  const nutella = normalizeBarcode('3017620422003');
  assert.equal(nutella.code, '3017620422003');
  assert.equal(nutella.kind, 'EAN-13');
  assert.equal(nutella.ean13, '3017620422003');
});

test('normalizeBarcode rejects bad check digits and wrong lengths', () => {
  assert.equal(normalizeBarcode('016000275288').ok, false);
  assert.equal(normalizeBarcode('12345').ok, false);
  assert.equal(normalizeBarcode('').ok, false);
});

test('normalizeBarcode accepts spaces/dashes from manual typing', () => {
  assert.ok(normalizeBarcode('0 16000-27528 7').ok);
});

test('UPC-E is expanded when the scanner says upc_e', () => {
  const r = normalizeBarcode('01234565', 'upc_e');
  assert.ok(r.ok);
  assert.equal(r.code, '012345000065');
});

test('USDA stores barcodes as 8, 11, 12, 13 or 14 digits: every form is searched and matched', () => {
  const upcA = normalizeBarcode('012000222412'); // seen stored as 12 digits
  assert.deepEqual(new Set(upcA.forms), new Set(['00012000222412', '012000222412', '0012000222412', '12000222412']));
  const fromScanner = normalizeBarcode('0012000222412', 'ean_13'); // scanner reports the 13-digit form
  assert.deepEqual(new Set(fromScanner.forms), new Set(upcA.forms));
  // a record stored under ANY of those forms is the same product
  for (const stored of ['00012000222412', '0012000222412', '012000222412', '12000222412']) {
    const json = { foods: [{ gtinUpc: stored, description: 'X', modifiedDate: '2020-01-01' }] };
    assert.ok(pickUsdaMatch(json, upcA.forms), stored);
  }
  // ...but a different product never is, and non-zero digits are never dropped
  assert.equal(pickUsdaMatch({ foods: [{ gtinUpc: '012000222413' }] }, upcA.forms), null);
  assert.ok(!sameBarcode('12000222412', '212000222412'));
  const gtin14 = normalizeBarcode('10012000222417'); // GTIN-14 with an indicator digit
  if (gtin14.ok) assert.ok(!gtin14.forms.includes('0012000222417'));
});

test('USDA records holding a UPC without its check digit are found, exactly and only', () => {
  const r = normalizeBarcode('038000817717'); // real US UPC; USDA stores it as 03800081771
  assert.ok(r.ok);
  assert.deepEqual(r.exactForms, ['03800081771']);
  assert.ok(pickUsdaMatch({ foods: [{ gtinUpc: '03800081771' }] }, r.forms, r.exactForms));
  assert.equal(pickUsdaMatch({ foods: [{ gtinUpc: '03800081772' }] }, r.forms, r.exactForms), null); // one digit off
  assert.equal(pickUsdaMatch({ foods: [{ gtinUpc: '3800081771' }] }, r.forms, r.exactForms), null); // zero-stripped guess is NOT accepted
  assert.deepEqual(normalizeBarcode('3017620422003').exactForms, []); // EAN-13: no such form
});

test('an 8-digit UPC-E keeps its raw form so a record stored that way is found', () => {
  const r = normalizeBarcode('01201303', 'upc_e');
  assert.ok(r.ok);
  assert.ok(r.forms.includes('01201303'));
  assert.ok(r.forms.includes('012000000133'));
  assert.ok(pickUsdaMatch({ foods: [{ gtinUpc: '01201303' }] }, r.forms));
});

test('in-store price-embedded labels are recognised', () => {
  // 2-prefix EAN-13 with valid check digit
  let base = '200123400100';
  const d = base.split('').map(Number);
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  const code = base + ((10 - (sum % 10)) % 10);
  const r = normalizeBarcode(code);
  assert.ok(r.ok);
  assert.ok(r.storeLabel);
});

// ---- data sources ---------------------------------------------------------

test('USDA record: per-serving fat is derived from per-100 g and the serving size', () => {
  const food = pickUsdaMatch(fx('usda-search-gtin.json'), '00016000275287');
  assert.ok(food);
  const rec = normalizeUsda(food);
  assert.equal(rec.fat100, 6.41);
  assert.equal(rec.servingG, 20);
  assert.equal(rec.fatServing, 1.28);
  assert.match(rec.servingText, /3\/4 cup/);
  assert.match(rec.ingredients, /WHOLE GRAIN OATS/);
  assert.equal(rec.name, 'Cheerios Cereal');
});

test('USDA match requires the GTIN to actually equal the one scanned', () => {
  assert.equal(pickUsdaMatch(fx('usda-search-gtin.json'), '00016000275999'), null);
  assert.equal(pickUsdaMatch({ foods: [] }, '00016000275287'), null);
});

test('Open Food Facts record with only per-100 g data has no serving fat', () => {
  const rec = normalizeOff(fx('off-nutella.json'));
  assert.equal(rec.fat100, 30.9);
  assert.equal(rec.fatServing, null);
  assert.equal(rec.servingG, null);
  assert.equal(rec.satFat100, 10.6);
  assert.ok(rec.ingredients.length > 10);
});

test('Open Food Facts prefers the English ingredient list when there is one', () => {
  const rec = normalizeOff(fx('off-nutella.json'));
  assert.match(rec.ingredients, /^Sugar, vegetable fat/);
  assert.equal(rec.ingredientsForeign, false);
});

test('a non-English ingredient list is flagged so English words are not "checked" against it', () => {
  const rec = normalizeOff({ status: 1, product: { code: '1', product_name: 'X', lang: 'fr', ingredients_text: 'Sucre, huile de palme', nutriments: { fat_100g: 3 } } });
  assert.equal(rec.ingredientsForeign, true);
  const r = assess({ product: { ...rec, fatServing: 1 }, portion: {}, settings: { dailyFatG: 40, avoid: ['palm oil'], watch: [] } });
  assert.notEqual(r.level, 'green');
  assert.ok(r.reasons.some((t) => /isn't in English/.test(t)));
});

test('trust tiers: manufacturer label, checked, unverified and flagged records', () => {
  assert.equal(normalizeUsda(pickUsdaMatch(fx('usda-search-gtin.json'), '00016000275287')).trust, 'label');
  assert.equal(normalizeOff(fx('off-nutella.json')).trust, 'checked'); // verified by a contributor, only a serving-size error tag
  const base = { code: '1', product_name: 'X', nutriments: { fat_100g: 3 } };
  assert.equal(normalizeOff({ status: 1, product: base }).trust, 'unverified');
  assert.equal(normalizeOff({ status: 1, product: { ...base, checked: 'on', data_quality_errors_tags: ['en:nutrition-saturated-fat-greater-than-fat'] } }).trust, 'flagged');
});

test('unverified or flagged community data can never be green', () => {
  for (const trust of ['unverified', 'flagged']) {
    const r = assess({ product: prod({ fatServing: 1, trust }), portion: {}, settings: S() });
    assert.equal(r.level, 'amber', trust);
    assert.ok(r.reasons.length > 0);
  }
  for (const trust of ['label', 'checked']) {
    assert.equal(assess({ product: prod({ fatServing: 1, trust }), portion: {}, settings: S() }).level, 'green', trust);
  }
});

test("a child-size serving can't be green until she has set her own portion", () => {
  const p = prod({ fatServing: 1, childServing: true });
  const before = assess({ product: p, portion: { servings: 1 }, settings: S() });
  assert.equal(before.level, 'amber');
  assert.ok(before.reasons.some((t) => /young children/.test(t)));
  const after = assess({ product: p, portion: { servings: 1, confirmed: true }, settings: S() });
  assert.equal(after.level, 'green');
  assert.ok(!after.reasons.some((t) => /young children/.test(t)));
  assert.equal(normalizeUsda(pickUsdaMatch(fx('usda-search-gtin.json'), '00016000275287')).childServing, true);
});

test('the unverified warning is shown even when there is no budget yet', () => {
  const r = assess({ product: prod({ trust: 'unverified' }), portion: {}, settings: S({ dailyFatG: null }) });
  assert.equal(r.level, 'facts');
  assert.ok(r.reasons.some((t) => /nobody has verified/.test(t)));
});

test('Open Food Facts miss returns null', () => {
  assert.equal(normalizeOff({ status: 0 }), null);
  assert.equal(normalizeOff(null), null);
});

test('sanity check drops impossible numbers instead of showing them', () => {
  const r = sanityCheck({ fat100: 140, satFat100: 5, fatServing: 50, servingG: 30, warnings: [] });
  assert.equal(r.fat100, null);
  assert.equal(r.fatServing, null);
  assert.equal(r.warnings.length, 2);
  const s = sanityCheck({ fat100: 3, satFat100: 9, warnings: [] });
  assert.equal(s.satFat100, null);
});

test('merge: USDA is preferred, and a big fat disagreement picks the HIGHER figure', () => {
  const usda = { source: 'USDA', fat100: 3, warnings: [], ingredients: 'a' };
  const off = { source: 'OFF', fat100: 12, warnings: [], ingredients: 'b' };
  const m = mergeRecords([usda, off]);
  assert.equal(m.source, 'OFF');
  assert.ok(m.conflict);
  const agree = mergeRecords([usda, { ...off, fat100: 3.4 }]);
  assert.equal(agree.source, 'USDA');
  assert.equal(agree.conflict, null);
});

test('merge: a record without fat data does not beat one with it', () => {
  const m = mergeRecords([{ source: 'USDA', warnings: [] }, { source: 'OFF', fat100: 5, warnings: [] }]);
  assert.equal(m.source, 'OFF');
  assert.equal(mergeRecords([null, null]), null);
});

// ---- scoring --------------------------------------------------------------

const prod = (over = {}) => ({ name: 'X', fatServing: 3, satFatServing: 1, ingredients: 'oats, salt', ...over });
const S = (over = {}) => ({ dailyFatG: 40, greenPct: 10, amberPct: 25, avoid: [], watch: [], ...over });

test('no daily budget = numbers only, never a colour', () => {
  const r = assess({ product: prod({ fatServing: 0 }), portion: {}, settings: S({ dailyFatG: null }) });
  assert.equal(r.level, 'facts');
});

test('green / amber / red follow the share of the daily budget', () => {
  assert.equal(assess({ product: prod({ fatServing: 3 }), portion: {}, settings: S() }).level, 'green'); // 7.5%
  assert.equal(assess({ product: prod({ fatServing: 8 }), portion: {}, settings: S() }).level, 'amber'); // 20%
  assert.equal(assess({ product: prod({ fatServing: 14 }), portion: {}, settings: S() }).level, 'red'); // 35%
});

test('the boundaries are inclusive of the lower colour', () => {
  assert.equal(assess({ product: prod({ fatServing: 4 }), portion: {}, settings: S() }).level, 'green'); // exactly 10%
  assert.equal(assess({ product: prod({ fatServing: 10 }), portion: {}, settings: S() }).level, 'amber'); // exactly 25%
});

test('servings multiply the fat', () => {
  const r = assess({ product: prod({ fatServing: 3 }), portion: { servings: 3 }, settings: S() });
  assert.equal(r.fatG, 9);
  assert.equal(r.level, 'amber');
});

test('missing fat data is grey, never green', () => {
  const r = assess({ product: { name: 'X', ingredients: 'a' }, portion: {}, settings: S() });
  assert.equal(r.level, 'grey');
});

test('per-100 g only products need a gram amount before they get a colour', () => {
  const p = { name: 'N', fat100: 30.9, ingredients: 'sugar' };
  assert.equal(assess({ product: p, portion: {}, settings: S() }).level, 'grey');
  const r = assess({ product: p, portion: { grams: 20 }, settings: S() });
  assert.ok(Math.abs(r.fatG - 6.18) < 1e-9);
  assert.equal(r.level, 'amber');
});

test("a portion bigger than what's left of today's budget is red", () => {
  const r = assess({ product: prod({ fatServing: 3 }), portion: {}, settings: S(), loggedTodayG: 39 });
  assert.equal(r.level, 'red');
  const done = assess({ product: prod({ fatServing: 1 }), portion: {}, settings: S(), loggedTodayG: 40 });
  assert.equal(done.level, 'red');
});

test('a green item that would eat over half of what is left drops to amber', () => {
  const r = assess({ product: prod({ fatServing: 3 }), portion: {}, settings: S(), loggedTodayG: 35 });
  assert.equal(r.level, 'amber');
});

test('avoid words force red even when the fat is tiny', () => {
  const r = assess({ product: prod({ fatServing: 0.5, ingredients: 'water, caffeine, sugar' }), portion: {}, settings: S({ avoid: ['caffeine'] }) });
  assert.equal(r.level, 'red');
  assert.deepEqual(r.avoidHits, ['caffeine']);
});

test('avoid words work even with no budget and no fat data', () => {
  const r = assess({ product: { ingredients: 'coffee' }, portion: {}, settings: S({ dailyFatG: null, avoid: ['coffee'] }) });
  assert.equal(r.level, 'red');
});

test('watch words cap the result at amber', () => {
  const r = assess({ product: prod({ fatServing: 1, ingredients: 'sorbitol, water' }), portion: {}, settings: S({ watch: ['sorbitol'] }) });
  assert.equal(r.level, 'amber');
});

test("green is withheld when her word lists can't be checked (no ingredients)", () => {
  const r = assess({ product: prod({ fatServing: 1, ingredients: '' }), portion: {}, settings: S({ avoid: ['caffeine'] }) });
  assert.equal(r.level, 'amber');
  const ok = assess({ product: prod({ fatServing: 1, ingredients: '' }), portion: {}, settings: S() });
  assert.equal(ok.level, 'green'); // no word lists set, nothing to check
});

test('a database disagreement never yields green', () => {
  const r = assess({ product: prod({ fatServing: 1, conflict: { usedSource: 'x' } }), portion: {}, settings: S() });
  assert.equal(r.level, 'amber');
});

test('term matching starts at word boundaries', () => {
  assert.deepEqual(findTerms('boiled water, palm oils', ['oil']), ['oil']);
  assert.deepEqual(findTerms('boiled water', ['oil']), []);
  assert.deepEqual(findTerms('Caffeine (from coffee beans)', ['caffeine', 'coffee']).sort(), ['caffeine', 'coffee']);
  assert.deepEqual(findTerms('anything', []), []);
});

test('parseTerms splits on commas/newlines and de-duplicates', () => {
  assert.deepEqual(parseTerms('Caffeine, coffee\nCOFFEE; alcohol '), ['caffeine', 'coffee', 'alcohol']);
});

test('portionFat with servings default of 1 and bad input', () => {
  assert.equal(portionFat(prod({ fatServing: 4 }), { servings: NaN }).fatG, 4);
  assert.equal(portionFat(null).fatG, null);
});

test('dayTotal sums only that day', () => {
  const log = [{ day: '2026-09-25', fatG: 3 }, { day: '2026-09-25', fatG: 2.5 }, { day: '2026-09-24', fatG: 9 }];
  assert.equal(dayTotal(log, '2026-09-25'), 5.5);
});

// ---- typed-in label numbers -----------------------------------------------

test('manual entry: validation catches missing, absurd and inconsistent numbers', () => {
  assert.equal(validateManual({ fat: '' }).ok, false);
  assert.equal(validateManual({ fat: 'abc' }).ok, false);
  assert.equal(validateManual({ fat: '-1' }).ok, false);
  assert.equal(validateManual({ fat: '250' }).ok, false);
  assert.equal(validateManual({ fat: '3', sat: '9' }).ok, false); // sat > fat
  assert.equal(validateManual({ fat: '3' }, { needName: true }).ok, false); // name required when unknown product
  const ok = validateManual({ fat: '3,5', sat: '1.5', serving: ' 1 cup (30 g) ', name: '' });
  assert.ok(ok.ok);
  assert.equal(ok.value.fatServing, 3.5); // decimal comma accepted
  assert.equal(ok.value.satFatServing, 1.5);
  assert.equal(ok.value.servingText, '1 cup (30 g)');
  assert.equal(validateManual({ fat: '0' }).ok, true); // "0 g" is a real answer
});

test('manual entry replaces the database numbers, is label-trusted, and can go green', () => {
  const dbProduct = { name: 'Chips', brand: 'B', ingredients: 'potatoes, oil', fatServing: null, fat100: null, source: 'Open Food Facts', trust: 'unverified', barcode: '1' };
  const manual = validateManual({ fat: '2', sat: '0.5', serving: '1 oz' }).value;
  const p = applyManual(dbProduct, manual, '1');
  assert.equal(p.fatServing, 2);
  assert.equal(p.trust, 'label');
  assert.equal(p.name, 'Chips'); // keeps the database's name and ingredients
  assert.equal(p.ingredients, 'potatoes, oil');
  assert.deepEqual(p.alsoFound, ['Open Food Facts']);
  assert.equal(assess({ product: p, portion: {}, settings: S() }).level, 'green');
  // an unknown product gets the name she typed
  const named = applyManual(null, validateManual({ fat: '4', name: 'Deli salad' }, { needName: true }).value, '2');
  assert.equal(named.name, 'Deli salad');
  assert.equal(named.ingredients, '');
});

test('manual entry does not carry over old per-100 g, conflicts or child-serving flags', () => {
  const messy = { name: 'X', fat100: 30, fatServing: 9, conflict: { usedSource: 'y' }, childServing: true, fatServingComputed: true, warnings: ['w'], source: 'USDA FoodData Central' };
  const p = applyManual(messy, validateManual({ fat: '1' }).value, '3');
  assert.equal(p.fat100, null);
  assert.equal(p.conflict, null);
  assert.equal(p.childServing, false);
  assert.equal(p.fatServingComputed, false);
  assert.deepEqual(p.warnings, []);
});

test('whyNoFat explains which database had what', () => {
  assert.match(whyNoFat({ source: 'Open Food Facts', alsoFound: [] }, []), /Open Food Facts has this product, but no fat figure.*USDA has no record/);
  assert.match(whyNoFat({ source: 'Open Food Facts', alsoFound: [] }, [{ source: 'USDA', message: 'rate limit' }]), /USDA could not be checked/);
  assert.match(whyNoFat({ source: 'USDA FoodData Central', alsoFound: ['Open Food Facts'] }, []), /USDA FoodData Central and Open Food Facts have this product/);
});
