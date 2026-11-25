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
      return json({ error: e.message || String(e), ...(e.code ? { code: e.code } : {}) }, e.status || 500, cors);
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
function fail(msg, status = 400, code = '') { const e = new Error(msg); e.status = status; if (code) e.code = code; return e; }
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

  const deadline = Date.now() + AI_TIMEOUT_MS;      // one time budget for the whole import
  const saved = [];
  for (const f of images) saved.push(await saveImage(env, f));
  let out;
  try { out = link ? await importLink(env, link, text, saved, deadline) : await importMaterial(env, text, saved, deadline); }
  catch (e) { await dropImages(env, saved); throw e; }      // don't leave orphan photos behind

  const { recipe, origin, status } = out;
  if (status === 'partial')
    recipe.notes = ['⚠️ Partial import: some of the recipe wasn’t in what I could read. Check the video or source for the rest.', recipe.notes].filter(Boolean).join('\n\n');
  const now = new Date().toISOString();
  const full = {
    id: uuid(), title: '', description: '', servings: '', prepTime: '', cookTime: '', ingredients: [], steps: [],
    notes: '', tags: [], favorite: false, rating: 0, source: '',
    ...recipe, sourceUrl: link || recipe.sourceUrl || '', origin, images: saved.map(s => s.key), addedBy,
    needsReview: true, createdAt: now, updatedAt: now, deleted: false,
  };
  if (save) await upsertRecipes(env, { recipes: [full] });
  return { recipe: full, saved: save, status };
}

// Screenshots / typed / dictated
async function importMaterial(env, text, saved, deadline) {
  const ai = await aiParse(env, text, saved, deadline);
  if (ai.status === 'none' || ai.status === 'pointer')
    throw fail(ai.recipe.notes || 'No recipe found in that. Try clearer screenshots of the ingredients and steps.', 422, 'none');
  return { recipe: ai.recipe, origin: saved.length ? 'Screenshots' : 'Typed / dictated', status: ai.status };
}

// Links: pick the cheapest route that works.
//  1) the page has structured recipe data (most recipe sites)  → done, no AI
//  2) caption / page text holds the whole recipe                → done
//  3) it points to a website with the recipe                    → follow the link and read that
//  4) only part of it                                           → save what's there, flagged "partial"
//  5) nothing (recipe is only in the video)                     → tell her how to get it in
async function importLink(env, link, extraText, saved, deadline) {
  const got = await fromLink(link);
  if (got.recipe) return { recipe: got.recipe, origin: got.origin, status: 'complete' };
  const material = [got.text, extraText].filter(Boolean).join('\n\n');
  const ai = await aiParse(env, material, saved, deadline);
  console.log('import', got.origin, 'status:', ai.status, 'recipeUrl:', ai.recipeUrl);
  if (ai.status === 'complete') return { recipe: ai.recipe, origin: got.origin, status: 'complete' };

  // try any recipe link the caption gives
  const candidates = [...new Set([ai.recipeUrl, ...urlsIn(material)].map(normalizeUrl).filter(Boolean))]
    .filter(u => !SKIP_HOSTS.test(new URL(u).hostname)).slice(0, 3);
  for (const url of candidates) {
    if (deadline - Date.now() < 20_000) break;
    try {
      const site = await fromLink(url);
      const host = new URL(url).hostname.replace(/^www\./, '');
      const origin = `${got.origin} → ${host}`;
      const note = `Full recipe: ${url}`;
      if (site.recipe) { console.log('followed', url, 'structured'); return { recipe: withNote(site.recipe, note), origin, status: 'complete' }; }
      const ai2 = await aiParse(env, `${material}\n\nThe linked page (${url}):\n${site.text}`, [], deadline);
      console.log('followed', url, 'status:', ai2.status);
      if (ai2.status === 'complete' || (ai2.status === 'partial' && ai.status !== 'partial'))
        return { recipe: withNote(ai2.recipe, note), origin, status: ai2.status };
    } catch (e) { console.log('follow failed', url, e.message); }
  }
  if (ai.status === 'partial') return { recipe: ai.recipe, origin: got.origin, status: 'partial' };
  const isTikTok = /tiktok/i.test(got.origin);
  if (ai.status === 'pointer')
    throw fail((isTikTok ? 'The creator says the recipe is somewhere else (their website, “link in bio”, or the comments), '
      : 'That page points somewhere else for the recipe, ') + 'and there was no link I could follow. '
      + 'Screenshots of the ingredients and steps from the video will work instead.', 422, 'elsewhere');
  throw fail(isTikTok ? 'This TikTok’s caption doesn’t include the recipe. It’s probably only in the video: '
    + 'take screenshots where the ingredients and steps show, then use 📸.'
    : 'Couldn’t find a recipe on that page. Try screenshots instead.', 422, 'video_only');
}

const SKIP_HOSTS = /(^|\.)(tiktok\.com|instagram\.com|facebook\.com|youtube\.com|youtu\.be|linktr\.ee|beacons\.ai|stan\.store|amzn\.to|amazon\.com|ltk\.app|liketk\.it)$/i;
function urlsIn(t) {
  return (t.match(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi) || []).map(u => u.replace(/[.,;:!?]+$/, ''));
}
function normalizeUrl(u) {
  u = String(u || '').trim(); if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  try { const x = new URL(u); return /\./.test(x.hostname) ? x.href : ''; } catch { return ''; }
}
function withNote(recipe, note) { return { ...recipe, notes: [recipe.notes, note].filter(Boolean).join('\n\n') }; }

// TikTok captions: try the public oEmbed, then the video page, then TikTok's embed page
// (short links like vm.tiktok.com / tiktok.com/t/... redirect to the full page). Many creators put the whole recipe there.
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
async function tiktokCaption(link) {
  let author = (link.match(/@([\w.]+)/) || [])[1] || '';
  let id = (link.match(/\/video\/(\d+)/) || [])[1] || '';
  try {
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(link), { headers: { 'User-Agent': DESKTOP_UA } });
    const j = await r.json().catch(() => ({}));
    author = j.author_unique_id || author;
    if (!id) id = (String(j.html || '').match(/\/(\d{15,})/) || [])[1] || '';
    console.log('tiktok oembed', r.status, 'title:', JSON.stringify(String(j.title || '').slice(0, 80)));
    if (j.title) return { caption: j.title, author };
  } catch (e) { console.error('tiktok oembed failed', e); }

  const pages = [[link, DESKTOP_UA], [link, PHONE_UA]];
  if (id) pages.splice(1, 0, [`https://www.tiktok.com/embed/v2/${id}`, DESKTOP_UA]);
  for (const [url, ua] of pages) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
      const html = await r.text();
      if (!id) id = (r.url.match(/\/video\/(\d+)/) || [])[1] || '';
      if (!author) author = (r.url.match(/@([\w.]+)/) || [])[1] || '';
      const found = captionFromHtml(html);
      console.log('tiktok page', r.status, url.includes('/embed/') ? 'embed' : (ua === PHONE_UA ? 'phone' : 'desktop'),
        html.length, 'via:', found.via || 'nothing', JSON.stringify(found.caption.slice(0, 80)),
        '| title tag:', JSON.stringify((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || ''));
      if (found.caption) return { caption: found.caption, author: found.author || author };
    } catch (e) { console.error('tiktok page failed', url, e); }
  }
  return { caption: '', author };
}

function captionFromHtml(html) {
  // 1) the data blob TikTok embeds in its pages
  for (const sid of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__FRONTITY_CONNECT_STATE__', '__NEXT_DATA__']) {
    const m = html.match(new RegExp(`<script[^>]*id=["']${sid}["'][^>]*>([\\s\\S]*?)<\\/script>`));
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]);
      const item = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (item?.desc) return { caption: item.desc, author: item.author?.uniqueId || '', via: sid };
      const mod = data?.ItemModule && Object.values(data.ItemModule)[0];
      if (mod?.desc) return { caption: mod.desc, author: mod.author || '', via: sid };
    } catch {}
  }
  // 2) any "desc" string anywhere in the page's JSON; the longest one is the caption
  let best = '';
  for (const m of html.matchAll(/"desc"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    try { const t = JSON.parse('"' + m[1] + '"'); if (t.length > best.length) best = t; } catch {}
  }
  if (best.length > 20) return { caption: best, via: 'desc' };
  // 3) description meta tags, in either attribute order
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/(?:property|name)=["'](?:og:description|description|twitter:description)["']/i.test(tag)) continue;
    const c = decodeEntities((tag.match(/content=["']([^"']*)["']/i) || [])[1] || '').trim();
    if (c.length > 20 && !/^TikTok - Make Your Day/i.test(c) && !/^(?:Watch|Discover).*on TikTok/i.test(c)) return { caption: c, via: 'meta' };
  }
  return { caption: '' };
}
function decodeEntities(t) {
  return t.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

async function fromLink(link) {
  let u; try { u = new URL(link); } catch { throw fail('That doesn’t look like a link'); }
  const host = u.hostname.replace(/^www\./, '');
  if (host.endsWith('tiktok.com')) {
    const got = await tiktokCaption(link);
    if (!got.caption) throw fail('Couldn’t read that TikTok’s caption (TikTok may be blocking it, or the caption is empty). '
      + 'Try 📸 screenshots of the ingredients, or 🎙️ dictate it.', 422);
    return { origin: 'TikTok' + (got.author ? ` (@${got.author})` : ''),
      text: `TikTok video by ${got.author || 'unknown'}. Caption:\n${got.caption}` };
  }
  const r = await fetch(link, { headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow', signal: AbortSignal.timeout(15_000) });
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
- Also judge what you were given, in "status":
  "complete" = ingredients AND steps are both there (amounts may be rough);
  "partial"  = some of the recipe is there but ingredients or steps are clearly missing;
  "pointer"  = the material says the recipe is somewhere else (a website, "link in bio", comments, the video);
  "none"     = no recipe at all (explain briefly in "notes").
- "recipeUrl": if the material gives a web address for the full recipe, put it here; otherwise "".

Return ONLY JSON, no prose, in this shape:
{"status": "complete", "recipeUrl": "", "title": "", "description": "", "servings": "", "prepTime": "", "cookTime": "",
 "ingredients": [{"amount": "2", "unit": "cups", "item": "flour, sifted"}, {"section": "Sauce"}, ...],
 "steps": [{"text": "Preheat oven to 350°F."}, {"text": "Whisk the sauce.", "section": "Sauce"}],
 "notes": "", "tags": ["lowercase", "few"], "source": "creator or site name if shown"}
"section" entries in ingredients are group headings; omit them if the recipe has none.`;

async function aiParse(env, text, images, deadline = Date.now() + AI_TIMEOUT_MS) {
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  const material = text ? `\n\nMaterial (text):\n${text}` : '';
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
  const recipe = {
    title: String(r.title || ''), description: String(r.description || ''), servings: String(r.servings || ''),
    prepTime: String(r.prepTime || ''), cookTime: String(r.cookTime || ''),
    ingredients: (r.ingredients || []).map(i => i.section ? { section: String(i.section) }
      : { amount: String(i.amount || ''), unit: String(i.unit || ''), item: String(i.item || '') }).filter(i => i.section || i.item),
    steps: (r.steps || []).map(s => typeof s === 'string' ? { text: s } : (s.section ? { text: String(s.text), section: String(s.section) } : { text: String(s.text || '') })).filter(s => s.text),
    notes: String(r.notes || ''), tags: (r.tags || []).map(t => String(t).toLowerCase()).slice(0, 6), source: String(r.source || ''),
  };
  // trust the AI's verdict, but check it against what actually came back
  const hasIng = recipe.ingredients.some(i => i.item), hasSteps = recipe.steps.length > 0;
  let status = ['complete', 'partial', 'pointer', 'none'].includes(r.status) ? r.status : (hasIng || hasSteps ? 'complete' : 'none');
  if (status === 'complete' && !(hasIng && hasSteps)) status = hasIng || hasSteps ? 'partial' : 'none';
  if ((status === 'partial' || status === 'pointer') && !hasIng && !hasSteps) status = status === 'pointer' ? 'pointer' : 'none';
  return { recipe, status, recipeUrl: String(r.recipeUrl || '') };
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
