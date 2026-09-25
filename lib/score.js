// Turns a product + her settings into a green / amber / red / grey answer.
//
// Rules of the road (do not weaken these):
//   * Green is only ever shown when the fat number is known AND every
//     check she has switched on could actually be run.
//   * Missing or doubtful data is grey ("can't tell"), never green.
//   * With no daily fat budget entered there is no verdict at all ("facts"):
//     the numbers come from her care team, not from this app.

export const DEFAULT_SETTINGS = {
  dailyFatG: null, // set from her dietitian's advice; verdict lights stay off until then
  greenPct: 10, // one portion up to this % of the daily budget = green
  amberPct: 25, // ... up to this % = amber, above = red
  avoid: [], // ingredient words that make a food red
  watch: [], // ingredient words that make a food at least amber
};

export function parseTerms(text) {
  const seen = new Set();
  for (const t of String(text ?? '').split(/[,;\n]/)) {
    const term = t.trim().toLowerCase();
    if (term) seen.add(term);
  }
  return [...seen];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A term matches where it starts a word ("oil" matches "oils", not "boiled").
export function termRegex(terms) {
  if (!terms.length) return null;
  return new RegExp(`(^|[^a-z0-9])(${terms.map(escapeRe).join('|')})`, 'gi');
}

export function findTerms(text, terms) {
  const re = termRegex(terms);
  if (!re || !text) return [];
  const hits = new Set();
  for (const m of String(text).matchAll(re)) hits.add(m[2].toLowerCase());
  return [...hits];
}

// portion: { servings } when the product has a per-serving fat figure,
//          { grams } when it only has per-100 g figures.
export function portionFat(product, portion = {}) {
  if (!product) return { fatG: null, satFatG: null, mode: 'none' };
  if (product.fatServing != null) {
    const s = Number.isFinite(portion.servings) && portion.servings > 0 ? portion.servings : 1;
    return {
      fatG: product.fatServing * s,
      satFatG: product.satFatServing != null ? product.satFatServing * s : null,
      mode: 'serving',
      servings: s,
    };
  }
  if (product.fat100 != null) {
    const g = portion.grams;
    if (!Number.isFinite(g) || g <= 0) return { fatG: null, satFatG: null, mode: 'grams', needGrams: true };
    return {
      fatG: (product.fat100 * g) / 100,
      satFatG: product.satFat100 != null ? (product.satFat100 * g) / 100 : null,
      mode: 'grams',
      grams: g,
    };
  }
  return { fatG: null, satFatG: null, mode: 'none' };
}

const fmt = (g) => `${Math.round(g * 10) / 10} g`;

// Community-edited entries that nobody has verified never earn green.
const TRUST_NOTES = {
  unverified: "This entry was typed in by the community and nobody has verified it. Read the fat on the pack to be sure.",
  flagged: "The database's own checks flagged a problem with this entry's nutrition numbers. Read the fat on the pack.",
};

export function assess({ product, portion, settings = {}, loggedTodayG = 0 }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const reasons = [];
  const p = portionFat(product, portion);
  const avoidHits = findTerms(product?.ingredients, s.avoid);
  const watchHits = findTerms(product?.ingredients, s.watch);
  const budget = Number.isFinite(s.dailyFatG) && s.dailyFatG > 0 ? s.dailyFatG : null;
  const rulesOnIngredients = s.avoid.length + s.watch.length > 0;
  const ingredientsKnown = Boolean(product?.ingredients) && !product?.ingredientsForeign;

  const out = {
    level: 'grey',
    title: "Can't tell",
    reasons,
    fatG: p.fatG,
    satFatG: p.satFatG,
    portion: p,
    avoidHits,
    watchHits,
    sharePct: null,
    remainingG: null,
  };

  if (avoidHits.length) {
    out.level = 'red';
    out.title = 'Better to skip';
    reasons.push(`Ingredients include ${avoidHits.join(', ')} - on your avoid list.`);
  }
  if (watchHits.length) reasons.push(`Ingredients include ${watchHits.join(', ')} - on your watch list.`);
  const trustNote = TRUST_NOTES[product?.trust] || null;
  if (trustNote) reasons.push(trustNote);
  // A serving written for toddlers understates what an adult eats, so no
  // green until she has set her own portion (portion.confirmed).
  const childNote = product?.childServing && !portion?.confirmed;
  if (childNote) reasons.push('This serving size is listed for young children. Use + or - to set the amount you will really eat.');
  const cantCheckWords = rulesOnIngredients && !ingredientsKnown;
  if (cantCheckWords) {
    reasons.push(product?.ingredients
      ? "The ingredient list isn't in English, so your avoid/watch words couldn't be checked."
      : "No ingredient list was found, so your avoid/watch words couldn't be checked.");
  }

  if (p.fatG == null) {
    if (out.level !== 'red') {
      out.level = 'grey';
      out.title = "Can't tell";
    }
    reasons.push(p.needGrams
      ? 'This product only lists fat per 100 g - enter how many grams you will eat.'
      : 'No fat information was found for this product. Read the label on the pack.');
    return out;
  }

  if (budget == null) {
    if (out.level !== 'red') {
      out.level = watchHits.length ? 'amber' : 'facts';
      out.title = watchHits.length ? 'Check first' : 'Numbers only';
    }
    reasons.push('No daily fat budget is set yet, so there is no green/amber/red - only the numbers.');
    return out;
  }

  out.sharePct = (p.fatG / budget) * 100;
  out.remainingG = budget - loggedTodayG;
  if (out.level === 'red') return out;

  // The share of the budget is shown in the banner (sharePct); reasons list
  // only what changed the colour.
  let level = out.sharePct <= s.greenPct ? 'green' : out.sharePct <= s.amberPct ? 'amber' : 'red';

  if (p.fatG > out.remainingG) {
    level = 'red';
    reasons.push(out.remainingG > 0
      ? `Only ${fmt(out.remainingG)} of today's budget is left.`
      : "Today's fat budget is already used up.");
  } else if (level === 'green' && p.fatG > out.remainingG * 0.5) {
    level = 'amber';
    reasons.push(`It would use more than half of the ${fmt(out.remainingG)} left today.`);
  }

  if (watchHits.length && level === 'green') level = 'amber';
  if (level === 'green' && (cantCheckWords || trustNote || childNote)) level = 'amber';
  if (product?.conflict) {
    reasons.push('The two databases disagree about the fat in this product - the higher figure was used. Check the label.');
    if (level === 'green') level = 'amber';
  }

  out.level = level;
  out.title = { green: 'Good choice', amber: 'Okay in moderation', red: 'Better to skip' }[level];
  return out;
}

export function dayTotal(log, dayKey) {
  return log.filter((e) => e.day === dayKey).reduce((sum, e) => sum + (e.fatG || 0), 0);
}
