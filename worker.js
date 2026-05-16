// Web Worker — owns all data, handles filter/sort/paginate off the main thread.
// Supports two fetch modes (set via config.js → passed in the 'load' message):
//   'server'     → fetch main.json  (server sets Content-Encoding: br)
//   'serverless' → fetch main.json.gz and decompress with DecompressionStream

let D = null;       // main data (always present after ready)
let X = null;       // display data (arrives later, enriches rows)
let ta_score, ta_scored_by, ta_rank, ta_popularity, ta_members, ta_favorites, ta_episodes, ta_year;
let idx = {};       // inverted indexes, built from D
let MODE = 'serverless';

// ── fetch helpers ─────────────────────────────────────────────────────────────
async function fetchJson(base) {
  if (MODE === 'server') {
    // server transparently decompresses Brotli via Content-Encoding header
    return fetch(base).then(r => r.text());
  }
  // serverless: fetch the .gz file and decompress manually with DecompressionStream
  const res = await fetch(`${base}.gz`);
  const ds  = new DecompressionStream('gzip');
  const reader = res.body.pipeThrough(ds).getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total  = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
const IDB_NAME    = 'anidex';
const IDB_VERSION = 1;
const IDB_STORE   = 'cache';
const DATA_KEY    = 'main_v1'; // bump suffix when data format changes

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
  });
}
function idbGet(db, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
function idbPut(db, key, value) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

// ── load ─────────────────────────────────────────────────────────────────────
async function loadMain() {
  // 1. Try IndexedDB cache first (repeat visits skip network entirely)
  let db;
  try {
    db = await idbOpen();
    const cached = await idbGet(db, DATA_KEY);
    if (cached?.json) {
      self.postMessage({ type: 'progress', pct: 60, msg: 'Loading from cache…' });
      D = JSON.parse(cached.json);
      buildTypedArrays();
      buildIndexes();
      self.postMessage({ type: 'ready', total: D.n, opts: D.opts });
      // stats + display still run in background
      setTimeout(() => {
        const stats = computeStats();
        self.postMessage({ type: 'stats', opts: D.opts, stats });
        loadDisplay();
      }, 0);
      return;
    }
  } catch (_) { /* IDB unavailable — fall through to network */ }

  // 2. Fresh fetch
  self.postMessage({ type: 'progress', pct: 10, msg: 'Downloading…' });
  const text = await fetchJson('main.json');

  self.postMessage({ type: 'progress', pct: 55, msg: 'Parsing…' });
  D = JSON.parse(text);

  self.postMessage({ type: 'progress', pct: 75, msg: 'Building indexes…' });
  buildTypedArrays();
  buildIndexes();

  // 3. Signal ready — UI is now interactive
  self.postMessage({ type: 'ready', total: D.n, opts: D.opts });

  // 4. Everything else runs off the critical path
  setTimeout(async () => {
    // Compute histogram/count stats and send to update chip counts
    const stats = computeStats();
    self.postMessage({ type: 'stats', opts: D.opts, stats });

    // Cache to IDB for next visit (store the raw JSON string — cheapest to restore)
    if (db) {
      try { await idbPut(db, DATA_KEY, { json: text }); } catch (_) {}
    }

    // Load display data (images, synopsis, etc.)
    loadDisplay();
  }, 0);
}

function buildTypedArrays() {
  ta_score      = new Float64Array(D.score.map(v => v ?? NaN));
  ta_scored_by  = new Int32Array(D.scored_by);
  ta_rank       = new Int32Array(D.rank);
  ta_popularity = new Int32Array(D.popularity);
  ta_members    = new Int32Array(D.members);
  ta_favorites  = new Int32Array(D.favorites);
  ta_episodes   = new Int32Array(D.episodes);
  ta_year       = new Int32Array(D.year);
}

async function loadDisplay() {
  try {
    const text = await fetchJson('display.json');
    X = JSON.parse(text);
    self.postMessage({ type: 'enriched' });
  } catch(e) {
    console.warn('display.json failed to load:', e.message);
  }
}

// ── build inverted indexes from loaded data ───────────────────────────────────
function buildIndexes() {
  const n = D.n;
  const PILL_COLS = ['type','status','season','rating','source'];
  const TAG_COLS  = ['genres','themes','demographics','studios'];

  for (const col of PILL_COLS) {
    idx[col] = {};
    D[col].forEach((v, i) => {
      if (!v) return;
      (idx[col][v] ??= []).push(i);
    });
  }

  // airing
  idx.airing = { '1': [], '0': [] };
  D.airing.forEach((v, i) => idx.airing[v ? '1' : '0'].push(i));

  // broadcast_day - not in main anymore but keep slot in case
  for (const col of TAG_COLS) {
    idx[col] = {};
    D[col].forEach((v, i) => {
      if (!v) return;
      v.split(', ').filter(Boolean).forEach(t => (idx[col][t] ??= []).push(i));
    });
  }
}

// ── filter ────────────────────────────────────────────────────────────────────
function intersect(existing, incoming) {
  if (existing === null) return new Set(incoming);
  const [small, large] = existing.size <= incoming.size ? [existing, incoming] : [incoming, existing];
  const out = new Set();
  for (const v of small) { if (large.has(v)) out.add(v); }
  return out;
}

function doFilter(filters, sort, page) {
  const n = D.n;
  let candidates = null;

  // OR pill fields
  for (const field of ['type','status','season','rating','source']) {
    const sel = filters[field];
    if (!sel?.length) continue;
    const union = new Set();
    for (const v of sel) { const a = idx[field]?.[v]; if (a) for (const i of a) union.add(i); }
    candidates = intersect(candidates, union);
  }

  // airing
  if (filters.airing?.length) {
    const union = new Set();
    for (const v of filters.airing) {
      const key = v === 'Airing' ? '1' : '0';
      const a = idx.airing[key]; if (a) for (const i of a) union.add(i);
    }
    candidates = intersect(candidates, union);
  }

  // AND tag fields
  for (const field of ['genres','themes','demographics','studios']) {
    const sel = filters[field];
    if (!sel?.length) continue;
    for (const v of sel) {
      const a = idx[field]?.[v];
      candidates = a ? intersect(candidates, new Set(a)) : new Set();
    }
  }

  // iterate candidates, apply numeric + title filters
  const iter = candidates !== null ? [...candidates] : Array.from({ length: n }, (_, i) => i);

  const titleQ = filters.title?.toLowerCase() || null;
  const { minScore, maxScore, minScoredBy, maxScoredBy, minRank, maxRank,
          minMembers, maxMembers, minFav, maxFav, minEp, maxEp, minYear, maxYear } = filters;

  const result = [];
  for (const i of iter) {
    if (titleQ) {
      const t  = (D.title[i] || '').toLowerCase();
      const te = X ? (X.title_english[i] || '').toLowerCase() : '';
      if (!t.includes(titleQ) && !te.includes(titleQ)) continue;
    }
    const sc = ta_score[i];
    if (minScore != null && (isNaN(sc) || sc < minScore)) continue;
    if (maxScore != null && (isNaN(sc) || sc > maxScore)) continue;
    const sb = ta_scored_by[i];
    if (minScoredBy != null && (sb < 0 || sb < minScoredBy)) continue;
    if (maxScoredBy != null && (sb < 0 || sb > maxScoredBy)) continue;
    const rk = ta_rank[i];
    if (minRank != null && (rk < 0 || rk < minRank)) continue;
    if (maxRank != null && (rk < 0 || rk > maxRank)) continue;
    const mb = ta_members[i];
    if (minMembers != null && (mb < 0 || mb < minMembers)) continue;
    if (maxMembers != null && (mb < 0 || mb > maxMembers)) continue;
    const fv = ta_favorites[i];
    if (minFav != null && (fv < 0 || fv < minFav)) continue;
    if (maxFav != null && (fv < 0 || fv > maxFav)) continue;
    const ep = ta_episodes[i];
    if (minEp != null && (ep < 0 || ep < minEp)) continue;
    if (maxEp != null && (ep < 0 || ep > maxEp)) continue;
    const yr = ta_year[i];
    if (minYear != null && (yr < 0 || yr < minYear)) continue;
    if (maxYear != null && (yr < 0 || yr > maxYear)) continue;
    result.push(i);
  }

  // sort
  const taMap = { score:ta_score, scored_by:ta_scored_by, rank:ta_rank,
    popularity:ta_popularity, members:ta_members, favorites:ta_favorites,
    episodes:ta_episodes, year:ta_year };
  const ta  = taMap[sort.field];
  const asc = sort.dir === 'asc';

  result.sort((a, b) => {
    let va, vb;
    if (ta) {
      va = ta[a]; vb = ta[b];
      const aN = va < 0 || isNaN(va), bN = vb < 0 || isNaN(vb);
      if (aN && bN) return 0; if (aN) return 1; if (bN) return -1;
    } else {
      va = (D[sort.field]?.[a] ?? X?.[sort.field]?.[a] ?? '').toLowerCase();
      vb = (D[sort.field]?.[b] ?? X?.[sort.field]?.[b] ?? '').toLowerCase();
    }
    return asc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
  });

  const { offset, limit } = page;
  const rows = result.slice(offset, offset + limit).map(i => buildRow(i));
  return { total: result.length, rows };
}

function buildRow(i) {
  return {
    mal_id:          D.mal_id[i],
    title:           D.title[i],
    score:           D.score[i],
    scored_by:       D.scored_by[i],
    rank:            D.rank[i],
    popularity:      D.popularity[i],
    members:         D.members[i],
    favorites:       D.favorites[i],
    episodes:        D.episodes[i],
    year:            D.year[i],
    airing:          D.airing[i],
    type:            D.type[i],
    status:          D.status[i],
    season:          D.season[i],
    rating:          D.rating[i],
    source:          D.source[i],
    genres:          D.genres[i],
    themes:          D.themes[i],
    demographics:    D.demographics[i],
    studios:         D.studios[i],
    // display fields — null until display.json loads
    title_english:   X?.title_english[i]  ?? null,
    title_japanese:  X?.title_japanese[i] ?? null,
    image_jpg:       X?.image_jpg[i]      ?? null,
    duration:        X?.duration[i]       ?? null,
    aired_from:      X?.aired_from[i]     ?? null,
    aired_to:        X?.aired_to[i]       ?? null,
    broadcast_day:   X?.broadcast_day[i]  ?? null,
    broadcast_time:  X?.broadcast_time[i] ?? null,
    producers:       X?.producers[i]      ?? null,
    licensors:       X?.licensors[i]      ?? null,
    synopsis:        X?.synopsis[i]       ?? null,
    background:      X?.background[i]     ?? null,
  };
}

// ── stats: histograms + value counts ─────────────────────────────────────────
function computeStats() {
  const n = D.n;
  const BUCKETS = 28;

  // Numeric fields: compute actual [min,max] and normalised histogram buckets.
  // Log-scale fields use log10 so the histogram is evenly distributed despite skew.
  const NUM_FIELDS = [
    { key:'score',     ta:ta_score,     log:false },
    { key:'scored_by', ta:ta_scored_by, log:true  },
    { key:'rank',      ta:ta_rank,      log:false },
    { key:'members',   ta:ta_members,   log:true  },
    { key:'favorites', ta:ta_favorites, log:true  },
    { key:'episodes',  ta:ta_episodes,  log:false },
    { key:'year',      ta:ta_year,      log:false },
  ];

  const histograms  = {};
  const fieldRanges = {};

  for (const { key, ta, log } of NUM_FIELDS) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = ta[i]; if (v <= 0 || isNaN(v)) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (lo === Infinity) { histograms[key] = []; fieldRanges[key] = [0,1]; continue; }
    fieldRanges[key] = [lo, hi];

    const sLo = log ? Math.log10(Math.max(1, lo)) : lo;
    const sHi = log ? Math.log10(hi) : hi;
    const span = sHi - sLo || 1;
    const counts = new Array(BUCKETS).fill(0);
    for (let i = 0; i < n; i++) {
      const v = ta[i]; if (v <= 0 || isNaN(v)) continue;
      const sv = log ? Math.log10(Math.max(1, v)) : v;
      counts[Math.min(BUCKETS-1, Math.floor((sv - sLo) / span * BUCKETS))]++;
    }
    const mx = Math.max(...counts);
    histograms[key] = counts.map(c => mx > 0 ? c / mx : 0);
  }

  // Value counts for chips
  const counts = {};
  // broadcast_day is in display.json (not main), so excluded here
  ['type','status','season','rating','source'].forEach(f => {
    counts[f] = {};
    D[f].forEach(v => { if (v) counts[f][v] = (counts[f][v]||0) + 1; });
  });
  counts.airing = {
    Airing:   D.airing.reduce((s,v) => s+(v?1:0), 0),
    Finished: D.airing.reduce((s,v) => s+(v?0:1), 0),
  };
  ['genres','themes','demographics','studios'].forEach(f => {
    counts[f] = {};
    D[f].forEach(v => {
      if (!v) return;
      v.split(', ').filter(Boolean).forEach(t => { counts[f][t] = (counts[f][t]||0)+1; });
    });
  });

  return { histograms, fieldRanges, counts };
}

// ── message handler ───────────────────────────────────────────────────────────
self.onmessage = async function(e) {
  const { type, id, filters, sort, page } = e.data;
  if (type === 'load') {
    MODE = e.data.mode || 'serverless';
    try { await loadMain(); }
    catch(err) { self.postMessage({ type: 'error', msg: err.message }); }
    return;
  }
  if (type === 'filter') {
    const result = doFilter(filters, sort, page);
    self.postMessage({ type: 'result', id, ...result });
  }
};
