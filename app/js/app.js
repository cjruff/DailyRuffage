// Daily Ruffage — main app (views + routing).
// Code: © Corey J Ruff

import { db, blankRecipe } from './db.js';
import { settings, saveSettings, hasServer, api, sync, imageUrl, shrinkImage } from './sync.js';
import { ingredientsToText, textToIngredients, stepsToText, textToSteps, escapeHtml as h,
         searchText, norm } from './text.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
let recipes = [];          // in-memory copy of all (non-deleted) recipes
let listState = { q: '', filter: 'all', scroll: 0 };
let wakeLock = null;

/* ---------- boot ---------- */
async function boot() {
  if (!(await db.getMeta('seeded'))) {
    try {
      const seed = await (await fetch('data/seed-recipes.json')).json();
      // marked dirty so the first sync uploads them; the server ignores copies it already has
      await db.putMany(seed.map(r => ({ ...r, _dirty: true })));
      await db.setMeta('seeded', true);
    } catch (e) { console.warn('seed failed', e); }
  }
  await reload();
  window.addEventListener('hashchange', route);
  $('#back').onclick = () => history.length > 1 ? history.back() : go('#/');
  $('#menu-settings').onclick = () => go('#/settings');
  $('#fab').onclick = () => go('#/add');
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  doSync(true);
  setInterval(() => doSync(true), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { doSync(true); if (wakeLock) requestWake(); }
  });
}

async function reload() {
  recipes = (await db.all()).filter(r => !r.deleted);
  recipes.forEach(r => { r._s = searchText(r); });
  updateDot();
}

function updateDot() {
  const dot = $('#sync-dot');
  if (!hasServer()) { dot.className = ''; return; }
  dot.className = recipes.some(r => r._dirty) ? 'pending' : 'ok';
}

async function doSync(quiet) {
  if (!hasServer() || !navigator.onLine) return;
  try {
    const r = await sync();
    await reload();
    if (r.pulled && /^#\/?$/.test(location.hash || '#/')) renderList();
    if (!quiet) toast(`Synced — ${r.pushed} sent, ${r.pulled} received`);
  } catch (e) {
    $('#sync-dot').className = 'err';
    if (!quiet) toast('Sync failed: ' + e.message);
  }
}

function go(hash) { location.hash = hash; }
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function setTop(title, back) {
  $('#page-title').textContent = title;
  $('#back').hidden = !back;
}
function showFab(on) { $('#fab-wrap').hidden = !on; }

async function saveRecipe(r) {
  r.updatedAt = new Date().toISOString();
  r._dirty = true;
  const { _s, ...clean } = r;
  await db.put(clean);
  await reload();
  doSync(true);
}

/* ---------- routing ---------- */
function route() {
  releaseWake();
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/(\w+)?\/?([^/]+)?\/?(\w+)?/) || [];
  const [, page, id, sub] = m;
  window.scrollTo(0, 0);
  if (!page) return renderList();
  if (page === 'r' && sub === 'edit') return renderEdit(id);
  if (page === 'r' && sub === 'cook') return renderRecipe(id, true);
  if (page === 'r') return renderRecipe(id, false);
  if (page === 'new') return renderEdit(null);
  if (page === 'add') return renderAdd();
  if (page === 'settings') return renderSettings();
  renderList();
}

/* ---------- list ---------- */
function filtered() {
  const words = norm(listState.q).split(/\s+/).filter(Boolean);
  let rs = recipes;
  if (listState.filter === 'fav') rs = rs.filter(r => r.favorite);
  else if (listState.filter === 'review') rs = rs.filter(r => r.needsReview);
  else if (listState.filter === 'recent') rs = [...rs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 25);
  else if (listState.filter.startsWith('tag:')) { const t = listState.filter.slice(4); rs = rs.filter(r => (r.tags || []).includes(t)); }
  if (words.length) rs = rs.filter(r => words.every(w => r._s.includes(w)));
  const score = r => words.length ? words.filter(w => norm(r.title).includes(w)).length : 0;
  if (listState.filter === 'recent' && !words.length) return rs;
  return [...rs].sort((a, b) => score(b) - score(a) || a.title.localeCompare(b.title));
}

function hl(text) {
  const words = norm(listState.q).split(/\s+/).filter(w => w.length > 1);
  let out = h(text);
  for (const w of words) {
    const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

function renderList() {
  setTop('Daily Ruffage', false); showFab(true);
  const tags = [...new Set(recipes.flatMap(r => r.tags || []))].sort();
  const reviewCount = recipes.filter(r => r.needsReview).length;
  const chips = [['all', 'All'], ['fav', '★ Favorites'], ['recent', 'Recent'],
    ...(reviewCount ? [['review', `Needs review (${reviewCount})`]] : []),
    ...tags.map(t => ['tag:' + t, t])];
  view.innerHTML = `
    <div class="search"><input id="q" type="search" placeholder="Search ${recipes.length} recipes — try “chicken lemon”"
      value="${h(listState.q)}" autocomplete="off" autocorrect="off">
      <div class="chips">${chips.map(([k, l]) => `<button class="chip ${listState.filter === k ? 'on' : ''}" data-f="${h(k)}">${h(l)}</button>`).join('')}</div>
    </div>
    <div class="count" id="count"></div>
    <ul class="rlist" id="rlist"></ul>`;
  const draw = () => {
    const rs = filtered();
    $('#count').textContent = `${rs.length} recipe${rs.length === 1 ? '' : 's'}`;
    $('#rlist').innerHTML = rs.length ? rs.map(r => `
      <li data-id="${r.id}"><div class="t">${hl(r.title || 'Untitled')}${r.favorite ? ' <span title="Favorite">★</span>' : ''}${r.needsReview ? '<span class="badge review">review</span>' : ''}</div>
      <div class="m">${[r.ingredients.filter(i => i.item).length + ' ingredients', ...(r.tags || []), r.origin].filter(Boolean).map(h).join(' · ')}</div></li>`).join('')
      : `<div class="empty">Nothing matches. ${listState.q ? 'Try fewer words.' : ''}</div>`;
  };
  draw();
  $('#q').oninput = e => { listState.q = e.target.value; draw(); };
  view.querySelectorAll('.chip').forEach(c => c.onclick = () => { listState.filter = c.dataset.f; renderList(); });
  $('#rlist').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) { listState.scroll = window.scrollY; go('#/r/' + li.dataset.id); } };
  if (listState.scroll) { window.scrollTo(0, listState.scroll); listState.scroll = 0; }
}

/* ---------- recipe view / cook mode ---------- */
async function renderRecipe(id, cook) {
  const r = recipes.find(x => x.id === id);
  if (!r) { view.innerHTML = '<div class="empty">Recipe not found.</div>'; setTop('', true); return; }
  setTop(cook ? 'Cooking' : r.title, true); showFab(false);
  let sec = null;
  const steps = r.steps.map((s, i) => {
    let pre = '';
    if (s.section && s.section !== sec) { sec = s.section; pre = `</ol><h4>${h(sec)}</h4><ol class="steps">`; }
    return `${pre}<li data-i="${i}">${h(s.text)}</li>`;
  }).join('');
  view.innerHTML = `
  <article class="recipe ${cook ? 'cook' : ''}">
    <h2>${h(r.title)}</h2>
    ${r.description ? `<p class="desc">${h(r.description)}</p>` : ''}
    <div class="meta-row">
      ${r.servings ? `<span>Serves ${h(r.servings)}</span>` : ''}
      ${r.prepTime ? `<span>Prep ${h(r.prepTime)}</span>` : ''}
      ${r.cookTime ? `<span>Cook ${h(r.cookTime)}</span>` : ''}
      ${(r.tags || []).map(t => `<span class="badge">${h(t)}</span>`).join('')}
    </div>
    ${cook ? '' : `<div class="actions">
      <button class="btn primary" id="cook">🍳 Cook mode</button>
      <button class="btn" id="fav">${r.favorite ? '★ Favorite' : '☆ Favorite'}</button>
      <span class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" aria-label="${n} stars">${n <= (r.rating || 0) ? '★' : '☆'}</button>`).join('')}</span>
      <button class="btn" id="edit">Edit</button>
      ${navigator.share ? '<button class="btn" id="share">Share</button>' : ''}
    </div>`}
    ${r.needsReview && !cook ? `<div class="panel">⚠️ This one was imported automatically — give it a once-over.
       <button class="btn" id="reviewed" style="margin-left:6px">Looks good</button></div>` : ''}
    <div class="photos" id="photos"></div>
    <h3>Ingredients</h3>
    <ul class="ings">${r.ingredients.map(i => i.section !== undefined ? `<li class="sec">${h(i.section)}</li>`
      : `<li><span class="a">${h([i.amount, i.unit].filter(Boolean).join(' '))}</span><span>${h(i.item)}</span></li>`).join('')}</ul>
    <h3>Directions</h3>
    <ol class="steps">${steps}</ol>
    ${r.notes ? `<h3>Notes</h3><div class="notes">${h(r.notes)}</div>` : ''}
    <div class="meta-row" style="margin-top:20px">
      ${r.source ? `<span>Source: ${h(r.source)}</span>` : ''}
      ${r.sourceUrl ? `<span><a href="${h(r.sourceUrl)}" target="_blank" rel="noopener">Original link ↗</a></span>` : ''}
      ${r.origin ? `<span>From ${h(r.origin)}</span>` : ''}
      ${r.addedBy ? `<span>Added by ${h(r.addedBy)}</span>` : ''}
    </div>
    ${cook ? '<div class="actions"><button class="btn" id="done">Done cooking</button></div>' : ''}
  </article>`;
  // tap to check off while cooking
  view.querySelectorAll('.ings li:not(.sec), .steps li').forEach(li => li.onclick = () => li.classList.toggle('done'));
  if (cook) { requestWake(); $('#done').onclick = () => history.back(); }
  else {
    $('#cook').onclick = () => go(`#/r/${id}/cook`);
    $('#edit').onclick = () => go(`#/r/${id}/edit`);
    $('#fav').onclick = async () => { r.favorite = !r.favorite; await saveRecipe(r); renderRecipe(id, false); };
    $('#stars').onclick = async e => { const n = +e.target.dataset.n; if (!n) return; r.rating = r.rating === n ? 0 : n; await saveRecipe(r); renderRecipe(id, false); };
    if ($('#share')) $('#share').onclick = () => navigator.share({ title: r.title, text: recipeAsText(r) }).catch(() => {});
    if ($('#reviewed')) $('#reviewed').onclick = async () => { r.needsReview = false; await saveRecipe(r); renderRecipe(id, false); toast('Marked as reviewed'); };
  }
  // photos (from server, cached locally)
  if (r.images?.length && hasServer()) {
    const box = $('#photos');
    for (const key of r.images) {
      try {
        const img = document.createElement('img'); img.src = await imageUrl(key); img.alt = 'Recipe source photo';
        img.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${img.src}">`; lb.onclick = () => lb.remove(); document.body.append(lb); };
        box.append(img);
      } catch { /* offline and not cached */ }
    }
  }
}

function recipeAsText(r) {
  return [r.title, '', 'Ingredients:', ...r.ingredients.map(i => i.section ? `\n${i.section}:` : '• ' + [i.amount, i.unit, i.item].filter(Boolean).join(' ')),
    '', 'Directions:', ...r.steps.map((s, i) => `${i + 1}. ${s.text}`), r.notes ? '\n' + r.notes : ''].join('\n');
}

async function requestWake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }

/* ---------- edit ---------- */
function renderEdit(id, draft) {
  const existing = id ? recipes.find(x => x.id === id) : null;
  const r = draft || (existing ? structuredClone(existing) : { ...blankRecipe(), addedBy: settings().name || '' });
  setTop(existing ? 'Edit recipe' : 'New recipe', true); showFab(false);
  view.innerHTML = `
  <form class="form" id="f" autocomplete="off">
    <label>Title</label><input type="text" name="title" value="${h(r.title)}" required>
    <label>Description</label><textarea name="description" rows="2">${h(r.description)}</textarea>
    <div class="row2">
      <div><label>Servings</label><input type="text" name="servings" value="${h(r.servings)}"></div>
      <div><label>Tags</label><input type="text" name="tags" value="${h((r.tags || []).join(', '))}" placeholder="chicken, weeknight"></div>
    </div>
    <div class="row2">
      <div><label>Prep time</label><input type="text" name="prepTime" value="${h(r.prepTime)}"></div>
      <div><label>Cook time</label><input type="text" name="cookTime" value="${h(r.cookTime)}"></div>
    </div>
    <label>Ingredients</label>
    <textarea class="big" name="ingredients">${h(ingredientsToText(r.ingredients))}</textarea>
    <div class="hint">One per line, amount first (“2 cups flour”). Start a line with ## for a group heading (“## Sauce”).</div>
    <label>Directions</label>
    <textarea class="big" name="steps">${h(stepsToText(r.steps))}</textarea>
    <div class="hint">One step per line. ## for a heading. Numbers are added automatically.</div>
    <label>Notes</label><textarea name="notes">${h(r.notes)}</textarea>
    <div class="row2">
      <div><label>Source</label><input type="text" name="source" value="${h(r.source)}" placeholder="Cooking Light, Mom…"></div>
      <div><label>Link</label><input type="url" name="sourceUrl" value="${h(r.sourceUrl)}" placeholder="https://"></div>
    </div>
    <label class="check"><input type="checkbox" name="needsReview" ${r.needsReview ? 'checked' : ''}> Needs review</label>
    <div class="actions" style="margin-top:20px">
      <button class="btn primary" type="submit">Save</button>
      <button class="btn" type="button" id="cancel">Cancel</button>
      ${existing ? '<button class="btn danger" type="button" id="del">Delete</button>' : ''}
    </div>
  </form>`;
  const f = $('#f');
  f.onsubmit = async e => {
    e.preventDefault();
    const v = n => f.elements[n].value.trim();
    Object.assign(r, {
      title: v('title'), description: v('description'), servings: v('servings'),
      prepTime: v('prepTime'), cookTime: v('cookTime'), notes: v('notes'), source: v('source'), sourceUrl: v('sourceUrl'),
      tags: v('tags').split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
      ingredients: textToIngredients(f.elements.ingredients.value), steps: textToSteps(f.elements.steps.value),
      needsReview: f.elements.needsReview.checked,
    });
    await saveRecipe(r);
    toast('Saved');
    location.replace('#/r/' + r.id);
  };
  $('#cancel').onclick = () => history.back();
  if ($('#del')) $('#del').onclick = async () => {
    if (!confirm(`Delete “${r.title}”?`)) return;
    r.deleted = true; await saveRecipe(r); toast('Deleted'); location.replace('#/');
  };
}

/* ---------- add / import ---------- */
function renderAdd() {
  setTop('Add a recipe', true); showFab(false);
  const online = hasServer();
  const off = online ? '' : 'disabled';
  view.innerHTML = `
  ${online ? '' : `<div class="panel">📶 Photo, link and text import need the server set up first —
     <a href="#/settings">Settings</a>. You can still type a recipe in by hand.</div>`}
  <div class="panel">
    <h3>📸 From screenshots or photos</h3>
    <div class="hint">Pick all the screenshots for <b>one</b> recipe, in order.</div>
    <input type="file" id="photos" accept="image/*" multiple ${off} style="margin-top:10px">
    <div class="thumbs" id="thumbs"></div>
    <div class="actions"><button class="btn primary" id="goPhotos" disabled>Read recipe</button></div>
  </div>
  <div class="panel">
    <h3>🔗 From a link</h3>
    <div class="hint">TikTok, a recipe website, Instagram… (uses the caption or the page’s recipe)</div>
    <div class="form"><input type="url" id="url" placeholder="Paste link" ${off}></div>
    <div class="actions"><button class="btn primary" id="goUrl" ${off}>Get recipe</button></div>
  </div>
  <div class="panel">
    <h3>🎙️ Type, paste or dictate</h3>
    <div class="hint">Messy is fine — tap the keyboard mic and talk it through while the video plays.</div>
    <div class="form"><textarea id="txt" rows="5" placeholder="two cups flour, a stick of butter, bake at 375 for like 20 min…" ${off}></textarea></div>
    <div class="actions"><button class="btn primary" id="goTxt" ${off}>Make it a recipe</button></div>
  </div>
  <div class="panel">
    <h3>✍️ By hand</h3>
    <div class="actions"><button class="btn" id="goBlank">Blank recipe</button></div>
  </div>
  <div id="status"></div>`;
  $('#goBlank').onclick = () => go('#/new');
  let files = [];
  $('#photos').onchange = e => {
    files = [...e.target.files];
    $('#thumbs').innerHTML = files.map(f => `<img src="${URL.createObjectURL(f)}">`).join('');
    $('#goPhotos').disabled = !files.length;
  };
  const run = async (fd, label) => {
    view.querySelectorAll('button, input, textarea').forEach(b => b.disabled = true);
    $('#status').innerHTML = `<div class="panel"><span class="busy"></span>${label}</div>`;
    try {
      fd.append('addedBy', settings().name || '');
      const res = await api('/api/import', { method: 'POST', body: fd });
      const { recipe } = await res.json();
      const draft = { ...blankRecipe(), ...recipe, needsReview: true, addedBy: settings().name || '' };
      renderEdit(null, draft);
      toast('Check it over, then Save');
    } catch (e) {
      $('#status').innerHTML = `<div class="panel">❌ ${h(e.message)}</div>`;
      view.querySelectorAll('button, input, textarea').forEach(b => b.disabled = false);
    }
  };
  $('#goPhotos').onclick = async () => {
    const fd = new FormData();
    for (const f of files) fd.append('images', await shrinkImage(f), f.name.replace(/\.\w+$/, '') + '.jpg');
    run(fd, `Reading ${files.length} image${files.length > 1 ? 's' : ''}… (10–30 seconds)`);
  };
  $('#goUrl').onclick = () => { const u = $('#url').value.trim(); if (!u) return; const fd = new FormData(); fd.append('url', u); run(fd, 'Fetching…'); };
  $('#goTxt').onclick = () => { const t = $('#txt').value.trim(); if (!t) return; const fd = new FormData(); fd.append('text', t); run(fd, 'Writing it up…'); };
}

/* ---------- settings ---------- */
async function renderSettings() {
  setTop('Settings', true); showFab(false);
  const s = settings();
  const last = await db.getMeta('lastSync');
  const pending = recipes.filter(r => r._dirty).length;
  view.innerHTML = `
  <div class="panel form">
    <h3>Your name</h3>
    <input type="text" id="name" value="${h(s.name || '')}" placeholder="Shown as “Added by”">
  </div>
  <div class="panel form">
    <h3>Server (sync + photo import)</h3>
    <label>Worker URL</label><input type="url" id="url" value="${h(s.serverUrl || '')}" placeholder="https://daily-ruffage.yourname.workers.dev">
    <label>Passcode</label><input type="password" id="pass" value="${h(s.passcode || '')}">
    <div class="hint">${last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet'}${pending ? ` · ${pending} change(s) waiting` : ''}</div>
    <div class="actions"><button class="btn primary" id="save">Save</button><button class="btn" id="syncNow" ${hasServer() ? '' : 'disabled'}>Sync now</button></div>
  </div>
  <div class="panel">
    <h3>Backup</h3>
    <div class="hint">A full copy of every recipe as one JSON file.</div>
    <div class="actions"><button class="btn" id="export">Download backup</button>
      <label class="btn">Restore from file<input type="file" id="restore" accept="application/json,.json" hidden></label></div>
  </div>
  <footer class="about">Daily Ruffage · ${recipes.length} recipes<br>Code: © Corey J Ruff</footer>`;
  $('#name').onchange = e => saveSettings({ name: e.target.value.trim() });
  $('#save').onclick = () => {
    saveSettings({ name: $('#name').value.trim(), serverUrl: $('#url').value.trim(), passcode: $('#pass').value });
    toast('Saved'); updateDot(); renderSettings(); doSync(false);
  };
  $('#syncNow').onclick = () => doSync(false);
  $('#export').onclick = async () => {
    const all = (await db.all()).map(({ _dirty, ...r }) => r);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'daily-ruffage', exportedAt: new Date().toISOString(), recipes: all }, null, 1)], { type: 'application/json' }));
    a.download = `daily-ruffage-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#restore').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.recipes;
      if (!Array.isArray(list) || !list.every(r => r.id && 'title' in r)) throw new Error('Not a cookbook backup');
      const local = new Map((await db.all()).map(r => [r.id, r]));
      const newer = list.filter(r => !local.has(r.id) || r.updatedAt > local.get(r.id).updatedAt);
      await db.putMany(newer.map(r => ({ ...r, _dirty: true })));
      await reload(); toast(`Restored ${newer.length} recipe(s)`); doSync(true);
    } catch (err) { toast('Restore failed: ' + err.message); }
  };
}

boot();
