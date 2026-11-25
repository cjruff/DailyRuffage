// Converting between recipe structures and the plain-text editing format.
// Ingredients: one per line, "## Name" starts a section. Steps: one per line (or blank-line paragraphs).
// Code: © Corey J Ruff

const AMT = /^[\d½¼¾⅓⅔⅛⅜⅝⅞.\-\/]+$/;
const UNITS = new Set(('tsp tsps teaspoon teaspoons tbsp tbs tbl tbls tablespoon tablespoons t c cup cups oz ounce ounces ' +
  'lb lbs pound pounds pinch dash dashes can cans clove cloves pkg pkgs package packages qt quart quarts pt pint pints ' +
  'gal gallon stick sticks slice slices jar jars bottle bottles box boxes bag bags bunch head heads sprig sprigs ' +
  'envelope envelopes g kg ml l liter liters small medium large whole container containers loaf').split(' '));

export function parseIngredient(line) {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  const amt = [];
  while (toks.length && (AMT.test(toks[0]) ||
         (amt.length && (toks[0] === 'or' || toks[0] === 'to') && toks.length > 1 && AMT.test(toks[1])))) {
    amt.push(toks.shift());
  }
  let unit = '';
  if (amt.length && toks.length > 1 && UNITS.has(toks[0].toLowerCase().replace(/\.$/, ''))) unit = toks.shift();
  return { amount: amt.join(' ').replace(/(\d)([½¼¾⅓⅔⅛⅜⅝⅞])/g, '$1 $2'), unit, item: toks.join(' ') };
}

export function ingredientsToText(ings) {
  return (ings || []).map(i => i.section !== undefined ? `## ${i.section}`
    : [i.amount, i.unit, i.item].filter(Boolean).join(' ')).join('\n');
}

export function textToIngredients(txt) {
  return txt.split('\n').map(l => l.trim()).filter(Boolean).map(l =>
    l.startsWith('#') ? { section: l.replace(/^#+\s*/, '').replace(/:$/, '') } : parseIngredient(l));
}

export function stepsToText(steps) {
  let sec = null; const out = [];
  for (const s of steps || []) {
    if (s.section && s.section !== sec) { sec = s.section; out.push(`## ${sec}`); }
    out.push(s.text);
  }
  return out.join('\n');
}

export function textToSteps(txt) {
  let sec = null; const out = [];
  for (let l of txt.split('\n')) {
    l = l.trim(); if (!l) continue;
    if (l.startsWith('#')) { sec = l.replace(/^#+\s*/, '').replace(/:$/, ''); continue; }
    l = l.replace(/^(\d+[.)]|step\s*\d+[:.)]?)\s+/i, '');
    const s = { text: l }; if (sec) s.section = sec; out.push(s);
  }
  return out;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Search: every word must appear somewhere; title hits rank first.
export function searchText(r) {
  return [r.title, r.description, r.notes, r.source, (r.tags || []).join(' '),
    ...(r.ingredients || []).map(i => i.item || i.section || ''),
    ...(r.steps || []).map(s => s.text)].join(' ').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}
export function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
