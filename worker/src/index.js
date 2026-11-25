// Daily Ruffage — Cloudflare Worker backend.
// Sync (D1), source photos (stored in D1 too, so no R2 / card needed), and recipe import
// from screenshots, links (TikTok captions, recipe websites) and free-form text.
// Code: © Corey J Ruff

const MAX_IMAGES = 10;
// Cloudflare cuts a request off (error 524) if the Worker sends nothing for 100 s,
// so give the AI a little less than that and return a readable error instead.
const AI_TIMEOUT_MS = 85_000;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/' ) return json({ ok: true, app: 'daily-ruffage' }, 200, cors);
      if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404, cors);
      if (!env.PASSCODE || req.headers.get('X-Passcode') !== env.PASSCODE) return json({ error: 'Wrong passcode' }, 401, cors);

      if (url.pathname === '/api/recipes' && req.method === 'GET') return json(await listRecipes(env, url.searchParams.get('since') || ''), 200, cors);
      if (url.pathname === '/api/recipes' && req.method === 'POST') return json(await upsertRecipes(env, await req.json()), 200, cors);
      if (url.pathname.startsWith('/api/img/') && req.method === 'GET') return await getImage(env, decodeURIComponent(url.pathname.slice(9)), cors);
      if (url.pathname === '/api/import' && req.method === 'POST') return json(await importRecipe(req, env), 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || String(e) }, e.status || 500, cors);
    }
  },
};

/* ---------- helpers ---------- */
function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Passcode', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
function fail(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
function uuid() { return crypto.randomUUID(); }
function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---------- sync ---------- */
async function listRecipes(env, since) {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare('SELECT data FROM recipes WHERE updated_at > ?1 ORDER BY updated_at').bind(since).all();
  return { now, recipes: results.map(r => JSON.parse(r.data)) };
}

async function upsertRecipes(env, body) {
  const list = Array.isArray(body?.recipes) ? body.recipes : [];
  if (list.length > 200) throw fail('Too many recipes in one request');
  // newest edit wins: only overwrite when the incoming copy is newer
  const stmt = env.DB.prepare(`INSERT INTO recipes (id, updated_at, deleted, data) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted, data = excluded.data
    WHERE excluded.updated_at > recipes.updated_at`);
  const batch = list.filter(r => r && typeof r.id === 'string' && r.updatedAt)
    .map(r => stmt.bind(r.id, r.updatedAt, r.deleted ? 1 : 0, JSON.stringify(r)));
  if (batch.length) await env.DB.batch(batch);
  return { now: new Date().toISOString(), accepted: batch.length };
}

/* ---------- images ---------- */
async function saveImage(env, file) {
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 1_900_000) throw fail('A photo is too large (max ~1.9 MB after shrinking)');
  const key = uuid() + '.jpg';
  await env.DB.prepare('INSERT INTO images (key, mime, data, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(key, file.type || 'image/jpeg', buf, new Date().toISOString()).run();
  return { key, buf, mime: file.type || 'image/jpeg' };
}

async function dropImages(env, saved) {
  if (!saved.length) return;
  const stmt = env.DB.prepare('DELETE FROM images WHERE key = ?1');
  try { await env.DB.batch(saved.map(s => stmt.bind(s.key))); } catch (e) { console.error(e); }
}

async function getImage(env, key, cors) {
  const row = await env.DB.prepare('SELECT mime, data FROM images WHERE key = ?1').bind(key).first();
  if (!row) return json({ error: 'Image not found' }, 404, cors);
  const bytes = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data);
  return new Response(bytes, { headers: { ...cors, 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000' } });
}

/* ---------- import ---------- */
async function importRecipe(req, env) {
  const form = await req.formData();
  const images = form.getAll('images').filter(f => f && typeof f !== 'string');
  const text = (form.get('text') || '').toString().trim();
  const link = (form.get('url') || '').toString().trim();
  const save = form.get('save') === '1';            // iOS Shortcut: save straight to the "Needs review" list
  const addedBy = (form.get('addedBy') || '').toString();
  if (!images.length && !text && !link) throw fail('Nothing to import');
  if (images.length > MAX_IMAGES) throw fail(`Up to ${MAX_IMAGES} images per recipe`);

  let recipe = null, sourceUrl = '', origin = '', context = text;
  const saved = [];
  for (const f of images) saved.push(await saveImage(env, f));

  if (link) {
    sourceUrl = link;
    const got = await fromLink(link);
    origin = got.origin;
    if (got.recipe) recipe = got.recipe;                         // structured recipe found on the page
    else context = [got.text, context].filter(Boolean).join('\n\n');
  }
  if (!recipe) {
    if (!context && !saved.length) throw fail('Could not find any recipe text at that link. Try screenshots instead.');
    try { recipe = await aiParse(env, context, saved); }
    catch (e) { await dropImages(env, saved); throw e; }      // don't leave orphan photos behind
    origin = origin || (saved.length ? 'Screenshots' : 'Typed / dictated');
  }
  const now = new Date().toISOString();
  const full = {
    id: uuid(), title: '', description: '', servings: '', prepTime: '', cookTime: '', ingredients: [], steps: [],
    notes: '', tags: [], favorite: false, rating: 0, source: '',
    ...recipe, sourceUrl: sourceUrl || recipe.sourceUrl || '', origin, images: saved.map(s => s.key), addedBy,
    needsReview: true, createdAt: now, updatedAt: now, deleted: false,
  };
  if (save) await upsertRecipes(env, { recipes: [full] });
  return { recipe: full, saved: save };
}

async function fromLink(link) {
  let u; try { u = new URL(link); } catch { throw fail('That doesn’t look like a link'); }
  const host = u.hostname.replace(/^www\./, '');
  if (host.endsWith('tiktok.com')) {
    // TikTok's public oEmbed returns the caption — many recipe creators put the full recipe there.
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(link));
    if (!r.ok) throw fail('TikTok didn’t return that video (is it private?)');
    const j = await r.json();
    return { origin: 'TikTok' + (j.author_name ? ` (@${j.author_name})` : ''),
      text: `TikTok video by ${j.author_name || 'unknown'}. Caption:\n${j.title || ''}` };
  }
  const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 (DailyRuffage importer)', Accept: 'text/html' } });
  if (!r.ok) throw fail(`That site returned ${r.status}`);
  const html = await r.text();
  const ld = findJsonLdRecipe(html);
  if (ld) return { origin: host, recipe: mapJsonLd(ld) };
  return { origin: host, text: htmlToText(html).slice(0, 20000) };
}

function findJsonLdRecipe(html) {
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const stack = [JSON.parse(m[1].trim())];
      while (stack.length) {
        const n = stack.pop();
        if (Array.isArray(n)) { stack.push(...n); continue; }
        if (!n || typeof n !== 'object') continue;
        const t = n['@type']; if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return n;
        if (n['@graph']) stack.push(n['@graph']);
      }
    } catch { /* bad JSON on page; keep looking */ }
  }
  return null;
}

function mapJsonLd(n) {
  const clean = s => htmlToText(String(s ?? '')).trim();
  const dur = s => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(s || ''); if (!m) return ''; return [m[1] && m[1] + ' hr', m[2] && m[2] + ' min'].filter(Boolean).join(' '); };
  const steps = []; const walk = (x, section) => {
    if (!x) return;
    if (typeof x === 'string') { clean(x).split(/\n+/).filter(Boolean).forEach(t => steps.push(section ? { text: t, section } : { text: t })); return; }
    if (Array.isArray(x)) return x.forEach(y => walk(y, section));
    if (x['@type'] === 'HowToSection') return walk(x.itemListElement, clean(x.name));
    if (x.text) steps.push(section ? { text: clean(x.text), section } : { text: clean(x.text) });
  };
  walk(n.recipeInstructions);
  const y = Array.isArray(n.recipeYield) ? n.recipeYield[0] : n.recipeYield;
  return {
    title: clean(n.name), description: clean(n.description).slice(0, 500), servings: y ? String(y) : '',
    prepTime: dur(n.prepTime), cookTime: dur(n.cookTime),
    ingredients: (n.recipeIngredient || []).map(s => parseIngredient(clean(s))),
    steps, source: clean(typeof n.author === 'object' ? (Array.isArray(n.author) ? n.author[0]?.name : n.author.name) : n.author),
    tags: [],
  };
}

function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const AMT = /^[\d½¼¾⅓⅔⅛⅜⅝⅞.\-\/]+$/;
const UNITS = new Set(('tsp tsps teaspoon teaspoons tbsp tbs tablespoon tablespoons cup cups oz ounce ounces lb lbs pound pounds ' +
  'pinch dash can cans clove cloves pkg package packages qt quart quarts pint pints stick sticks slice slices jar jars ' +
  'bunch head sprig sprigs g kg ml l small medium large whole').split(' '));
function parseIngredient(line) {
  const toks = line.split(/\s+/).filter(Boolean); const amt = [];
  while (toks.length && AMT.test(toks[0])) amt.push(toks.shift());
  let unit = '';
  if (amt.length && toks.length > 1 && UNITS.has(toks[0].toLowerCase().replace(/\.$/, ''))) unit = toks.shift();
  return { amount: amt.join(' '), unit, item: toks.join(' ') };
}

/* ---------- AI ---------- */
async function aiFetch(url, opts, deadline) {
  const left = deadline - Date.now();
  if (left < 5_000) throw fail('The AI took too long to read this. Try again, or send fewer screenshots at a time.', 504);
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(left) }); }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw fail('The AI took too long to read this. Try again, or send fewer screenshots at a time.', 504);
    throw e;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BUSY = new Set([429, 500, 503]);   // "high demand", rate limit, hiccup: worth another try

const PROMPT = `You turn recipe material into a structured recipe. The material may be screenshots (in order, possibly
overlapping or cut off between images), a social-media caption, web page text, or someone's rambling dictation.

Rules:
- Use only what is in the material. Do not invent ingredients, amounts, times or steps.
- Merge content split across screenshots; skip duplicates where screenshots overlap.
- Ignore ads, comments, like counts, navigation and life-story text.
- For dictation or vague amounts, write the best reading and add a short note listing anything you guessed.
- Keep the author's wording for steps where reasonable; one action or short group of actions per step.
- If the material clearly isn't a recipe, return {"title": "", "notes": "No recipe found: <why>"}.

Return ONLY JSON, no prose, in this shape:
{"title": "", "description": "", "servings": "", "prepTime": "", "cookTime": "",
 "ingredients": [{"amount": "2", "unit": "cups", "item": "flour, sifted"}, {"section": "Sauce"}, ...],
 "steps": [{"text": "Preheat oven to 350°F."}, {"text": "Whisk the sauce.", "section": "Sauce"}],
 "notes": "", "tags": ["lowercase", "few"], "source": "creator or site name if shown"}
"section" entries in ingredients are group headings; omit them if the recipe has none.`;

async function aiParse(env, text, images) {
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  const material = text ? `\n\nMaterial (text):\n${text}` : '';
  const deadline = Date.now() + AI_TIMEOUT_MS;   // one time budget for all tries combined
  let raw;
  if (provider === 'anthropic') raw = await callClaude(env, PROMPT + material, images, deadline, env.AI_MODEL);
  else {
    try { raw = await callGemini(env, PROMPT + material, images, deadline); }
    catch (e) {
      // Gemini still busy after retries: use Claude instead, if a key is set up (optional, paid, ~fraction of a cent)
      if (!e.busy || !env.ANTHROPIC_API_KEY) throw e;
      console.log('Gemini busy, falling back to Claude');
      raw = await callClaude(env, PROMPT + material, images, deadline);
    }
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw fail('The AI did not return a recipe. Try again or use screenshots.', 502);
  let r; try { r = JSON.parse(m[0]); } catch { throw fail('The AI returned something unreadable. Try again.', 502); }
  if (!r.title && r.notes) throw fail(r.notes, 422);
  return {
    title: String(r.title || ''), description: String(r.description || ''), servings: String(r.servings || ''),
    prepTime: String(r.prepTime || ''), cookTime: String(r.cookTime || ''),
    ingredients: (r.ingredients || []).map(i => i.section ? { section: String(i.section) }
      : { amount: String(i.amount || ''), unit: String(i.unit || ''), item: String(i.item || '') }),
    steps: (r.steps || []).map(s => typeof s === 'string' ? { text: s } : (s.section ? { text: String(s.text), section: String(s.section) } : { text: String(s.text || '') })).filter(s => s.text),
    notes: String(r.notes || ''), tags: (r.tags || []).map(t => String(t).toLowerCase()).slice(0, 6), source: String(r.source || ''),
  };
}

async function callGemini(env, prompt, images, deadline) {
  if (!env.GEMINI_API_KEY) throw fail('GEMINI_API_KEY is not set on the Worker', 500);
  const model = env.AI_MODEL || 'gemini-3.8-flash';
  const parts = [...images.map(i => ({ inline_data: { mime_type: i.mime, data: toBase64(i.buf) } })), { text: prompt }];
  // Reading a recipe doesn't need long "thinking", which is what made big imports slow.
  // 2.x models take a token budget; 3.x models take a level.
  let thinkingConfig = /gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
  const waits = [2_000, 5_000, 10_000];          // pauses before retry 1, 2, 3 when Gemini is busy
  for (let attempt = 0; ; attempt++) {
    const gen = { responseMimeType: 'application/json', temperature: 0.1, ...(thinkingConfig ? { thinkingConfig } : {}) };
    const r = await aiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: gen }),
    }, deadline);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
    const msg = j.error?.message || String(r.status);
    if (r.status === 400 && thinkingConfig && /think/i.test(msg)) { thinkingConfig = null; attempt--; continue; }  // model doesn't take that setting
    const wait = waits[attempt];
    if (BUSY.has(r.status) && wait !== undefined && deadline - Date.now() > wait + 20_000) { await sleep(wait); continue; }
    const e = fail(BUSY.has(r.status) ? 'Gemini is busy right now (tried ' + (attempt + 1) + ' times). Try again in a few minutes.'
      : 'Gemini error: ' + msg, 502);
    e.busy = BUSY.has(r.status);
    throw e;
  }
}

async function callClaude(env, prompt, images, deadline, model = 'claude-haiku-5-5') {
  if (!env.ANTHROPIC_API_KEY) throw fail('ANTHROPIC_API_KEY is not set on the Worker', 500);
  const content = [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: toBase64(i.buf) } })),
    { type: 'text', text: prompt }];
  const r = await aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || 'claude-haiku-5-5', max_tokens: 4096, messages: [{ role: 'user', content }] }),
  }, deadline);
  const j = await r.json();
  if (!r.ok) throw fail('Claude error: ' + (j.error?.message || r.status), 502);
  return (j.content || []).map(c => c.text || '').join('');
}
