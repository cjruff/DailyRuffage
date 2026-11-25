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
    if (r.pulled) { const hsh = location.hash || '#/'; if (/^#\/?$/.test(hsh)) renderHome(); else if (hsh === '#/recipes') renderList(); }
    if (!quiet) toast(`Synced — ${r.pushed} sent, ${r.pulled} received`);
  } catch (e) {
    $('#sync-dot').className = 'err';
    if (!quiet) toast('Sync failed: ' + e.message);
  }
}

function go(hash) { location.hash = hash; }
function toast(msg, ms = 2600, action) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show'); t.classList.toggle('act', !!action);
  if (action) {
    const b = document.createElement('button'); b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show', 'act'); clearTimeout(toast._t); action.fn(); };
    t.append(b);
  }
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show', 'act'), action ? 6000 : ms);
}
// Deleting only flags a recipe; Undo (and Settings → Recently deleted) bring it back.
async function deleteRecipe(r, after) {
  r.deleted = true; await saveRecipe(r); after?.();
  toast('Deleted', 0, { label: 'Undo', fn: async () => { await restoreRecipe(r.id); after?.(); } });
}
async function restoreRecipe(id) {
  const r = await db.get(id); if (!r) return;
  r.deleted = false; await saveRecipe(r); toast('Restored “' + (r.title || 'Untitled') + '”');
}
function setTop(title, back) {
  $('#page-title').textContent = title;
  $('#back').hidden = !back;
  $('#brand').hidden = true;     // the home screen shows the big artwork instead
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
  if (!page) return renderHome();
  if (page === 'recipes') return renderList();
  if (page === 'ideas') return renderIdeas();
  if (page === 'steak') return renderSteak();
  if (page === 'r' && sub === 'edit') return renderEdit(id);
  if (page === 'r' && sub === 'cook') return renderRecipe(id, true);
  if (page === 'r') return renderRecipe(id, false);
  if (page === 'new') return renderEdit(null);
  if (page === 'add') return renderAdd(id);
  if (page === 'settings') return renderSettings();
  renderHome();
}

/* ---------- home ---------- */
function renderHome() {
  setTop('Daily Ruffage', false); showFab(false);
  const review = recipes.filter(r => r.needsReview).length;
  view.innerHTML = `
  <div class="home">
    <img class="home-art" src="icons/brand-art.jpg" alt="Chef Nala">
    <nav class="pills">
      <a class="pill" href="#/recipes"><span class="ico">🔍</span>Search Recipes</a>
      <a class="pill" href="#/ideas"><span class="ico">💡</span>Search Ideas</a>
      <a class="pill" href="#/add"><span class="ico">➕</span>Add a Recipe</a>
      <a class="pill" href="#/steak"><span class="ico">🔥</span>Grilling Steak</a>
    </nav>
    <div class="home-count">${recipes.length} recipes${review ? ` · <a href="#/recipes" id="toReview">${review} need${review === 1 ? 's' : ''} review</a>` : ''}</div>
  </div>`;
  if ($('#toReview')) $('#toReview').onclick = () => { listState.filter = 'review'; };
}

/* ---------- grilling chart ---------- */
function renderSteak() {
  setTop('Grilling Steak', true); showFab(false);
  view.innerHTML = `<img class="chart" id="chart" src="img/grilling-steak.png" alt="Steak grilling times by thickness and doneness">
    <div class="hint" style="text-align:center">Tap the chart to enlarge.</div>`;
  $('#chart').onclick = () => lightbox($('#chart').src);
}
function lightbox(src) {
  const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${src}">`;
  lb.onclick = () => lb.remove(); document.body.append(lb);
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
  setTop('Search Recipes', true); showFab(true);
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
    sw.reset();
    $('#rlist').innerHTML = rs.length ? rs.map(r => `
      <li class="swipe" data-id="${r.id}"><div class="sw-fav">${r.favorite ? '☆ Unfavorite' : '★ Favorite'}</div><button class="sw-del" tabindex="-1">Delete</button><div class="sw-body">
      <div class="t">${hl(r.title || 'Untitled')}${r.favorite ? ' <span title="Favorite">★</span>' : ''}${r.needsReview ? '<span class="badge review">review</span>' : ''}</div>
      <div class="m">${[r.ingredients.filter(i => i.item).length + ' ingredients', ...(r.tags || []), r.origin].filter(Boolean).map(h).join(' · ')}</div></div></li>`).join('')
      : `<div class="empty">Nothing matches. ${listState.q ? 'Try fewer words.' : ''}</div>`;
  };
  const sw = enableSwipe($('#rlist'), async li => {
    const r = recipes.find(x => x.id === li.dataset.id); if (!r) return;
    r.favorite = !r.favorite; await saveRecipe(r); draw();
    toast(r.favorite ? '★ Added to favorites' : 'Removed from favorites');
  });
  draw();
  $('#q').oninput = e => { listState.q = e.target.value; draw(); };
  view.querySelectorAll('.chip').forEach(c => c.onclick = () => { listState.filter = c.dataset.f; renderList(); });
  $('#rlist').onclick = async e => {
    if (sw.justSwiped()) return;
    const li = e.target.closest('li[data-id]'); if (!li) return;
    if (e.target.closest('.sw-del')) {
      const r = recipes.find(x => x.id === li.dataset.id); if (!r) return;
      if (!confirm(`Delete “${r.title || 'Untitled'}”? (You can undo, or restore it later from Settings.)`)) { sw.close(); return; }
      await deleteRecipe(r, draw); return;
    }
    if (sw.isOpen(li)) { sw.close(); return; }
    listState.scroll = window.scrollY; go('#/r/' + li.dataset.id);
  };
  if (listState.scroll) { window.scrollTo(0, listState.scroll); listState.scroll = 0; }
}

// Swipe a row left to reveal its Delete button; swipe right to (un)favorite it (touch screens).
function enableSwipe(list, onFav) {
  const W = 92; let start = null, open = null, swiped = 0;
  const setX = (li, x, anim) => {
    const b = li.querySelector('.sw-body'); if (!b) return;
    b.style.transition = anim ? 'transform .2s ease' : 'none'; b.style.transform = x ? `translateX(${x}px)` : '';
  };
  list.addEventListener('touchstart', e => {
    const li = e.target.closest('li.swipe'); if (!li) { start = null; return; }
    if (open && open !== li) { setX(open, 0, true); open = null; }
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, li, base: li === open ? -W : 0, dir: '' };
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!start) return;
    const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
    if (!start.dir) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; start.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'; }
    if (start.dir !== 'h') return;
    e.preventDefault();
    setX(start.li, Math.max(-W * 1.4, Math.min(W * 1.4, start.base + dx)), false);
  }, { passive: false });
  list.addEventListener('touchend', e => {
    if (start?.dir === 'h') {
      const dx = e.changedTouches[0].clientX - start.x, x = start.base + dx, isOpen = x < -W / 2;
      setX(start.li, isOpen ? -W : 0, true); open = isOpen ? start.li : null; swiped = Date.now();
      if (start.base === 0 && x > W * 0.8 && onFav) onFav(start.li);
    }
    start = null;
  });
  return {
    isOpen: li => li === open,
    close: () => { if (open) { setX(open, 0, true); open = null; } },
    reset: () => { open = null; start = null; },
    justSwiped: () => Date.now() - swiped < 350,
  };
}

/* ---------- ideas (search by ingredient / style) ---------- */
// scope: 'ing' = title, tags and ingredients · 'title' = title, tags and description · 'all' = everything incl. steps
const MEAT = ['chicken', 'beef', 'steak', 'pork', 'bacon', 'ham', 'sausage', 'turkey', 'lamb', 'veal', 'chorizo', 'prosciutto',
  'pancetta', 'pepperoni', 'salami', 'hot dog', 'hotlink', 'meatball', 'meat', 'brisket', 'chuck', 'tenderloin', 'filet', 'sirloin',
  'ribeye', 'fish', 'salmon', 'shrimp', 'tuna', 'cod', 'tilapia', 'crab', 'scallop', 'lobster', 'clam', 'mussel', 'anchov', 'gelatin', 'broth', 'stock'];
const IDEAS = [
  ['Protein', [
    ['Chicken', 'ing', ['chicken']],
    ['Beef', 'ing', ['beef', 'steak', 'chuck', 'brisket', 'filet', 'tenderloin', 'sirloin', 'ribeye', 'meatball', 'meat loaf', 'reuben', 'goulash']],
    ['Pork', 'ing', ['pork', 'bacon', 'ham', 'sausage', 'chorizo', 'prosciutto', 'pancetta', 'hotlink', 'hot link']],
    ['Turkey', 'ing', ['turkey']],
    ['Seafood', 'ing', ['fish', 'salmon', 'shrimp', 'tuna', 'cod', 'tilapia', 'crab', 'scallop', 'lobster', 'clam', 'mussel', 'halibut']],
    ['Vegetarian', 'veg'],
  ]],
  ['Style', [
    ['Mexican', 'all', ['mexican', 'taco', 'enchilada', 'burrito', 'fajita', 'quesadilla', 'tortilla', 'salsa', 'poblano', 'jalapeno', 'chipotle', 'ancho', 'queso', 'santa fe', 'southwestern']],
    ['Italian', 'all', ['italian', 'pasta', 'parmesan', 'mozzarella', 'marinara', 'pesto', 'lasagna', 'ziti', 'risotto', 'focaccia', 'prosciutto', 'ricotta', 'basil']],
    ['Asian', 'all', ['asian', 'soy sauce', 'teriyaki', 'hoisin', 'sesame', 'ginger', 'kung pao', 'thai', 'stir fry', 'stir-fry', 'sriracha', 'peanut sauce', 'sate', 'satay', 'tempura', 'luau', 'rice vinegar']],
    ['BBQ', 'all', ['bbq', 'barbecue', 'pulled pork', 'smoked', 'rib']],
    ['Spicy', 'all', ['spicy', 'hot sauce', 'buffalo', 'cayenne', 'jalapeno', 'chipotle', 'red pepper flake', 'crushed red pepper', 'sriracha', 'habanero']],
  ]],
  ['Kind of dish', [
    ['Pasta & noodles', 'ing', ['pasta', 'spaghetti', 'penne', 'macaroni', 'noodle', 'linguine', 'fettuccine', 'rigatoni', 'lasagna', 'ziti', 'orzo', 'tortellini', 'ravioli', 'rotini', 'cavatappi', 'couscous']],
    ['Soup & chili', 'title', ['soup', 'stew', 'chili', 'chowder', 'bisque', 'goulash']],
    ['Salad', 'title', ['salad']],
    ['Casserole & bakes', 'title', ['casserole', 'bake', 'potpie', 'pot pie', 'shepherd', 'sheppard', 'ziti', 'lasagna', 'divan']],
    ['Sandwiches & wraps', 'title', ['sandwich', 'wrap', 'reuben', 'burger', 'sub', 'panini', 'sliders']],
    ['Sides', 'title', ['side', 'potato', 'green bean', 'asparagus', 'stuffing', 'hash brown', 'rice', 'vegetable', 'hush pupp', 'biscuit']],
    ['Dips & apps', 'title', ['dip', 'appetizer', 'bites', 'wings']],
    ['Sauces & rubs', 'title', ['sauce', 'marinade', 'rub', 'seasoning', 'vinaigrette', 'glaze', 'dressing', 'batter']],
    ['Breakfast', 'title', ['breakfast', 'pancake', 'waffle', 'french toast', 'omelet', 'frittata', 'quiche', 'hash brown', 'granola']],
    ['Desserts & baking', 'title', ['cake', 'cookie', 'brownie', 'pie', 'dessert', 'pudding', 'cobbler', 'crisp', 'cheesecake', 'fudge', 'lemon bars', 'bread', 'muffin', 'tart']],
    ['Drinks', 'title', ['punch', 'cider', 'limeade', 'lemonade', 'cocktail', 'smoothie', 'tea', 'sangria']],
  ]],
  ['How', [
    ['On the grill', 'all', ['grill', 'grilled', 'kabob', 'kabab', 'kebab']],
    ['Slow cooker', 'all', ['slow cooker', 'crock', 'crockpot', 'crock-pot']],
    ['30 min or less', 'quick'],
  ]],
].map(([group, items]) => [group, items.map(([label, scope, words]) => ({ label, scope, re: words &&
  new RegExp('\\b(' + words.map(w => norm(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|') + ')', 'i') }))]);
const MEAT_RE = new RegExp('\\b(' + MEAT.join('|') + ')', 'i');
const ideaState = { sel: new Set(), have: '' };

function minutes(t) {
  t = norm(t || ''); if (!t) return null;
  let m = 0, found = false;
  for (const [, n, u] of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/g)) { found = true; m += /^h/.test(u) ? n * 60 : +n; }
  if (!found && /^\d+$/.test(t.trim())) { found = true; m = +t; }
  return found ? m : null;
}
function hay(r) {
  if (r._h) return r._h;
  const ing = norm([r.title, (r.tags || []).join(' '), ...(r.ingredients || []).map(i => i.item || '')].join(' \n '));
  return (r._h = { ing, title: norm([r.title, (r.tags || []).join(' '), r.description].join(' \n ')), all: r._s });
}
function ideaMatch(r, idea) {
  const hy = hay(r);
  if (idea.scope === 'veg') return !MEAT_RE.test(hy.ing);
  if (idea.scope === 'quick') { const p = minutes(r.prepTime), c = minutes(r.cookTime); return (p != null || c != null) && (p || 0) + (c || 0) <= 30; }
  return idea.re.test(hy[idea.scope]);
}

function renderIdeas() {
  setTop('Search Ideas', true); showFab(false);
  const all = IDEAS.flatMap(([, items]) => items);
  view.innerHTML = `
    <div class="ideas-have form">
      <input type="text" id="have" value="${h(ideaState.have)}" placeholder="Got something to use up? e.g. chicken, rice, peppers" autocomplete="off">
    </div>
    ${IDEAS.map(([group, items]) => `<div class="idea-group"><div class="idea-label">${h(group)}</div><div class="chips wrap">${items.map(it => {
      const n = recipes.filter(r => ideaMatch(r, it)).length;
      return `<button class="chip ${ideaState.sel.has(it.label) ? 'on' : ''} ${n ? '' : 'zero'}" data-l="${h(it.label)}">${h(it.label)} <span class="n">${n}</span></button>`;
    }).join('')}</div></div>`).join('')}
    <div class="actions"><button class="btn" id="clearIdeas">Clear</button></div>
    <div class="count" id="icount"></div>
    <ul class="rlist" id="ilist"></ul>`;
  const draw = () => {
    const sel = all.filter(it => ideaState.sel.has(it.label));
    const words = norm(ideaState.have).split(/[,\s]+/).filter(w => w.length > 1 && !['and', 'or', 'with', 'the', 'some'].includes(w));
    if (!sel.length && !words.length) { $('#icount').textContent = 'Pick one or more above, or type what you have.'; $('#ilist').innerHTML = ''; return; }
    const res = [];
    for (const r of recipes) {
      if (!sel.every(it => ideaMatch(r, it))) continue;
      const got = words.filter(w => hay(r).ing.includes(w) || r._s.includes(w));
      if (words.length && !got.length) continue;
      res.push({ r, got });
    }
    res.sort((a, b) => b.got.length - a.got.length || (b.r.favorite - a.r.favorite) || (b.r.rating || 0) - (a.r.rating || 0) || a.r.title.localeCompare(b.r.title));
    $('#icount').textContent = `${res.length} idea${res.length === 1 ? '' : 's'}`;
    $('#ilist').innerHTML = res.length ? res.map(({ r, got }) => `
      <li data-id="${r.id}"><div class="t">${h(r.title || 'Untitled')}${r.favorite ? ' <span title="Favorite">★</span>' : ''}</div>
      <div class="m">${[...sel.map(it => it.label), ...(words.length ? [`has ${got.join(', ')}${got.length < words.length ? ` (${got.length} of ${words.length})` : ''}`] : [])].map(h).join(' · ')}</div></li>`).join('')
      : '<div class="empty">No matches. Try fewer choices.</div>';
  };
  draw();
  view.querySelectorAll('.idea-group .chip').forEach(c => c.onclick = () => {
    const l = c.dataset.l; ideaState.sel.has(l) ? ideaState.sel.delete(l) : ideaState.sel.add(l);
    c.classList.toggle('on'); draw();
  });
  $('#have').oninput = e => { ideaState.have = e.target.value; draw(); };
  $('#clearIdeas').onclick = () => { ideaState.sel.clear(); ideaState.have = ''; renderIdeas(); };
  $('#ilist').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) go('#/r/' + li.dataset.id); };
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
    ${cook ? (r.notes ? `<section class="notes-box"><div class="nb-head"><h3>Notes</h3></div><div class="notes">${h(r.notes)}</div></section>` : '')
      : `<section class="notes-box" id="notesBox"><div class="nb-head"><h3>Notes</h3><button class="btn small" id="editNotes">Edit</button></div>
      <div class="notes" id="notesText">${r.notes ? h(r.notes) : '<span class="muted">No notes yet. Tap Edit to add some.</span>'}</div></section>`}
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
    $('#editNotes').onclick = () => {
      $('#notesBox').innerHTML = `<div class="nb-head"><h3>Notes</h3></div>
        <div class="form"><textarea id="notesTa" rows="5" placeholder="Tweaks, what we'd change, who liked it…">${h(r.notes || '')}</textarea></div>
        <div class="actions"><button class="btn primary" id="saveNotes">Save notes</button><button class="btn" id="cancelNotes">Cancel</button></div>`;
      $('#notesTa').focus();
      $('#saveNotes').onclick = async () => { r.notes = $('#notesTa').value.trim(); await saveRecipe(r); toast('Notes saved'); renderRecipe(id, false); };
      $('#cancelNotes').onclick = () => renderRecipe(id, false);
    };
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
        img.onclick = () => lightbox(img.src);
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
    if (!confirm(`Delete “${r.title}”? (You can undo, or restore it later from Settings.)`)) return;
    location.replace('#/recipes'); await deleteRecipe(r, () => { if (location.hash === '#/recipes') renderList(); });
  };
}

/* ---------- add / import ---------- */
const ADD_KINDS = {
  photos: { ico: '📸', title: 'From photos & screenshots', sub: 'Pick all the screenshots for one recipe' },
  link:   { ico: '🔗', title: 'From a link', sub: 'TikTok, a recipe website…', tag: 'All the recipes, zero narcissism' },
  text:   { ico: '🎙️', title: 'Type, paste or dictate', sub: 'A caption, a note, or talk it through' },
};
function renderAdd(kind) {
  const online = hasServer();
  const needServer = online ? '' : `<div class="panel">📶 Importing needs the server set up first — <a href="#/settings">Settings</a>.</div>`;
  if (!ADD_KINDS[kind]) {
    setTop('Add a Recipe', true); showFab(false);
    view.innerHTML = needServer + Object.entries(ADD_KINDS).map(([k, t]) =>
      `<a class="tile" href="#/add/${k}"><span class="ico">${t.ico}</span><span><b>${t.title}</b><small>${t.sub}</small>${t.tag ? `<small class="tag">${t.tag}</small>` : ''}</span></a>`).join('');
    return;
  }
  const t = ADD_KINDS[kind];
  setTop(t.title, true); showFab(false);
  const off = online ? '' : 'disabled';
  const body = {
    photos: `<div class="hint big">Pick every screenshot for <b>one</b> recipe, in order. Up to 10.</div>
      <label class="btn big ${off ? 'disabled' : ''}" for="photos">Choose screenshots</label>
      <input type="file" id="photos" accept="image/*" multiple ${off} hidden>
      <div class="thumbs" id="thumbs"></div>
      <button class="btn primary big" id="goPhotos" disabled>Read recipe</button>`,
    link: `<div class="hint big">Paste a TikTok or recipe-website link. I’ll read the caption or page, and follow the creator’s recipe link if there is one.</div>
      <div class="form"><input type="url" id="url" placeholder="Paste link" ${off}></div>
      <button class="btn primary big" id="goUrl" ${off}>Get recipe</button>`,
    text: `<div class="hint big">Paste a caption or some text, or tap the keyboard mic and talk it through. Messy is fine.</div>
      <div class="form"><textarea id="txt" rows="8" placeholder="two cups flour, a stick of butter, bake at 375 for like 20 min…" ${off}></textarea></div>
      <button class="btn primary big" id="goTxt" ${off}>Make it a recipe</button>`,
  }[kind];
  view.innerHTML = `${needServer}<div class="panel add-page"><h2><span class="ico">${t.ico}</span>${t.title}</h2>${body}</div><div id="status"></div>`;
  let files = [];
  if ($('#photos')) $('#photos').onchange = e => {
    files = [...e.target.files];
    $('#thumbs').innerHTML = files.map(f => `<img src="${URL.createObjectURL(f)}">`).join('');
    $('#goPhotos').disabled = !files.length;
  };
  const run = async (fd, label) => {
    view.querySelectorAll('button, input, textarea').forEach(b => b.disabled = true);
    $('#status').innerHTML = `<div class="panel"><span class="busy"></span>${label}</div>`;
    $('#status').scrollIntoView({ behavior: 'smooth', block: 'center' });
    try {
      fd.append('addedBy', settings().name || '');
      const res = await api('/api/import', { method: 'POST', body: fd });
      const { recipe, status } = await res.json();
      const draft = { ...blankRecipe(), ...recipe, needsReview: true, addedBy: settings().name || '' };
      renderEdit(null, draft);
      toast(status === 'partial' ? 'Got part of it — check the video for the rest'
        : / → /.test(recipe.origin || '') ? 'Found the full recipe on the creator’s site — check it over'
        : 'Check it over, then Save', 4000);
    } catch (e) {
      view.querySelectorAll('button, input, textarea').forEach(b => b.disabled = false);
      if ($('#goPhotos')) $('#goPhotos').disabled = !files.length;
      const shots = kind !== 'photos' && ['video_only', 'elsewhere', 'none'].includes(e.code);
      $('#status').innerHTML = `<div class="panel">${shots ? '🎬' : '❌'} ${h(e.message)}
        ${shots ? '<div class="actions"><button class="btn primary" id="useShots">📸 Pick screenshots</button></div>' : ''}</div>`;
      if (shots) $('#useShots').onclick = () => go('#/add/photos');
    }
  };
  if ($('#goPhotos')) $('#goPhotos').onclick = async () => {
    const fd = new FormData();
    for (const f of files) fd.append('images', await shrinkImage(f), f.name.replace(/\.\w+$/, '') + '.jpg');
    run(fd, `Reading ${files.length} image${files.length > 1 ? 's' : ''}… (usually under a minute)`);
  };
  if ($('#goUrl')) $('#goUrl').onclick = () => { const u = $('#url').value.trim(); if (!u) return; const fd = new FormData(); fd.append('url', u); run(fd, 'Fetching…'); };
  if ($('#goTxt')) $('#goTxt').onclick = () => { const t = $('#txt').value.trim(); if (!t) return; const fd = new FormData(); fd.append('text', t); run(fd, 'Writing it up…'); };
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
    <label>Worker URL</label><input type="url" id="url" value="${h(s.serverUrl || '')}" placeholder="e.g. https://daily-ruffage.example.workers.dev">
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
  <div class="panel" id="trash"></div>
  <footer class="about"><img class="brand-big" src="icons/brand-art.jpg" alt="Chef Nala">Daily Ruffage · ${recipes.length} recipes<br>Code: © Corey J Ruff</footer>`;
  const drawTrash = async () => {
    const gone = (await db.all()).filter(r => r.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    $('#trash').innerHTML = `<h3>Recently deleted</h3>
      <div class="hint">Deleted recipes stay here, on every device, until you restore them.</div>
      ${gone.length ? `<ul class="trash">${gone.map(r => `<li><span>${h(r.title || 'Untitled')}<small>${new Date(r.updatedAt).toLocaleDateString()}</small></span>
        <button class="btn small" data-id="${r.id}">Restore</button></li>`).join('')}</ul>` : '<div class="hint" style="margin-top:8px">Nothing deleted.</div>'}`;
    $('#trash').querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => { await restoreRecipe(b.dataset.id); drawTrash(); });
  };
  drawTrash();
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
