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

// ── load ─────────────────────────────────────────────────────────────────────
async function loadMain() {
  self.postMessage({ type: 'progress', pct: 10, msg: 'Downloading main data…' });
  const text = await fetchJson('main.json');
  self.postMessage({ type: 'progress', pct: 55, msg: 'Parsing…' });
  D = JSON.parse(text);

  self.postMessage({ type: 'progress', pct: 75, msg: 'Building typed arrays…' });
  const n = D.n;
  ta_score      = new Float64Array(D.score.map(v => v ?? NaN));
  ta_scored_by  = new Int32Array(D.scored_by);
  ta_rank       = new Int32Array(D.rank);
  ta_popularity = new Int32Array(D.popularity);
  ta_members    = new Int32Array(D.members);
  ta_favorites  = new Int32Array(D.favorites);
  ta_episodes   = new Int32Array(D.episodes);
  ta_year       = new Int32Array(D.year);

  self.postMessage({ type: 'progress', pct: 88, msg: 'Building indexes…' });
  buildIndexes();

  self.postMessage({ type: 'ready', total: D.n, opts: D.opts });

  // load display data in background immediately after signalling ready
  loadDisplay();
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
