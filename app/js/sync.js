// Talking to the Cloudflare Worker. The app works fully offline without it;
// once a server URL + passcode are set, changes sync both ways (newest edit wins).
// Code: © Corey J Ruff

import { db } from './db.js';

const KEY = 'daily-ruffage-settings';
export function settings() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) { localStorage.setItem(KEY, JSON.stringify({ ...settings(), ...s })); }
export function hasServer() { const s = settings(); return !!(s.serverUrl && s.passcode); }

export async function api(path, opts = {}) {
  const s = settings();
  if (!s.serverUrl) throw new Error('No server set up yet (Settings).');
  const res = await fetch(s.serverUrl.replace(/\/$/, '') + path, {
    ...opts, headers: { 'X-Passcode': s.passcode || '', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    const body = await res.text().catch(() => '');
    try { const j = JSON.parse(body); if (j.error) msg = j.error; }
    catch {                                     // Cloudflare's own error pages are plain text, not JSON
      if (res.status === 524) msg = 'The server took too long (over 100 s). Try again, or fewer screenshots at a time.';
      else if (/error code/i.test(body)) msg = 'Server error ' + res.status + '. Try again in a minute.';
    }
    throw new Error(msg);
  }
  return res;
}

let syncing = null;
export function sync() {
  if (!hasServer()) return Promise.resolve({ skipped: true });
  if (syncing) return syncing;
  syncing = (async () => {
    const all = await db.all();
    const dirty = all.filter(r => r._dirty);
    if (dirty.length) {
      const clean = dirty.map(({ _dirty, ...r }) => r);
      for (let i = 0; i < clean.length; i += 50) {
        await api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipes: clean.slice(i, i + 50) }) });
      }
      // only clear the flag if the record wasn't edited again while we were pushing
      const now = await db.all();
      const sent = new Map(dirty.map(r => [r.id, r.updatedAt]));
      await db.putMany(now.filter(r => r._dirty && sent.get(r.id) === r.updatedAt).map(r => ({ ...r, _dirty: false })));
    }
    const since = (await db.getMeta('lastSync')) || '';
    const res = await api('/api/recipes?since=' + encodeURIComponent(since));
    const { now: serverNow, recipes } = await res.json();
    const local = new Map((await db.all()).map(r => [r.id, r]));
    const incoming = recipes.filter(r => {
      const l = local.get(r.id);
      return !l || r.updatedAt > l.updatedAt;
    });
    if (incoming.length) await db.putMany(incoming.map(r => ({ ...r, _dirty: false })));
    await db.setMeta('lastSync', serverNow);
    return { pushed: dirty.length, pulled: incoming.length };
  })().finally(() => { syncing = null; });
  return syncing;
}

// Images live on the server; cache them locally once fetched so they show offline.
const urlCache = new Map();
export async function imageUrl(key) {
  if (urlCache.has(key)) return urlCache.get(key);
  let blob = await db.getImage(key);
  if (!blob) {
    const res = await api('/api/img/' + encodeURIComponent(key));
    blob = await res.blob();
    await db.putImage(key, blob);
  }
  const u = URL.createObjectURL(blob);
  urlCache.set(key, u);
  return u;
}

// Shrink photos before upload: smaller for storage and for the AI, still easily readable.
export async function shrinkImage(file, max = 1800) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { return file; }
}
