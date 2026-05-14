// Web Worker — parses binary columnar format (main.bin.gz), no JSON.parse of data.
// Typed array views into the raw ArrayBuffer = zero-copy reads.
// Pre-built indexes shipped in binary = no index construction at runtime.

let D     = null;   // parsed main.bin data
let X     = null;   // display.json (background enrichment)
let idx   = {};     // inverted indexes (views into D.buf)
let ta_score, ta_scored_by, ta_rank, ta_popularity, ta_members, ta_favorites, ta_episodes, ta_year;
let MODE = 'serverless';

// ── fetch helpers ─────────────────────────────────────────────────────────────
async function fetchBinary(base) {
  if (MODE === 'server') {
    const res = await fetch(base);
    return res.arrayBuffer();
  }
  const res = await fetch(`${base}.gz`);
  const ds  = new DecompressionStream('gzip');
  const reader = res.body.pipeThrough(ds).getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total  = chunks.reduce((s,c) => s+c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged.buffer;
}

async function fetchJson(base) {
  if (MODE === 'server') return fetch(base).then(r => r.text());
  const res = await fetch(`${base}.gz`);
  const ds  = new DecompressionStream('gzip');
  const reader = res.body.pipeThrough(ds).getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total  = chunks.reduce((s,c) => s+c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
}

// ── parse binary main.bin ─────────────────────────────────────────────────────
async function loadMain() {
  self.postMessage({ type: 'progress', pct: 10, msg: 'Downloading…' });
  const buf = await fetchBinary('main.bin');

  self.postMessage({ type: 'progress', pct: 55, msg: 'Parsing binary…' });
  const dv = new DataView(buf);

  // Validate magic
  const magic = String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  if (magic !== 'ANI1') throw new Error(`Bad magic: ${magic}`);

  // Read header
  const headerLen  = dv.getUint32(4, true);
  const headerText = new TextDecoder().decode(new Uint8Array(buf, 8, headerLen));
  const header     = JSON.parse(headerText);
  const { n, opts, stats, pools, blocks, dataOffset } = header;

  // Block lookup
  const blockMap = new Map(blocks.map(b => [b.name, b]));

  // Create a typed array view at the correct offset (zero-copy)
  const view = (name, Type) => {
    const b = blockMap.get(name);
    if (!b) throw new Error(`Block not found: ${name}`);
    return new Type(buf, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT);
  };

  self.postMessage({ type: 'progress', pct: 70, msg: 'Loading typed arrays…' });

  // Numeric typed arrays
  ta_score      = view('score',      Float32Array);
  ta_scored_by  = view('scored_by',  Int32Array);
  ta_rank       = view('rank',       Int32Array);
  ta_popularity = view('popularity', Int32Array);
  ta_members    = view('members',    Int32Array);
  ta_favorites  = view('favorites',  Int32Array);
  ta_episodes   = view('episodes',   Int32Array);
  ta_year       = view('year',       Int32Array);

  // Store everything in D
  D = {
    buf, n, opts, stats, pools,
    mal_id:    view('mal_id',    Int32Array),
    airing:    view('airing',    Uint8Array),
    // categorical codes (decode via pools[col][code-1], 0=null)
    type_cat:   view('type_cat',   Uint8Array),
    status_cat: view('status_cat', Uint8Array),
    season_cat: view('season_cat', Uint8Array),
    rating_cat: view('rating_cat', Uint8Array),
    source_cat: view('source_cat', Uint8Array),
    // tag data
    genres_cnt:  view('genres_cnt',  Uint8Array),
    genres_data: view('genres_data', Uint16Array),
    themes_cnt:  view('themes_cnt',  Uint8Array),
    themes_data: view('themes_data', Uint16Array),
    demographics_cnt:  view('demographics_cnt',  Uint8Array),
    demographics_data: view('demographics_data', Uint16Array),
    studios_cnt:  view('studios_cnt',  Uint8Array),
    studios_data: view('studios_data', Uint16Array),
    // title
    title_off:  view('title_off',  Uint32Array),
    title_utf8: view('title_utf8', Uint8Array),
    _dec: new TextDecoder(),
  };

  // Pre-compute cumulative tag offsets (Uint32Array, O(n) once)
  for (const col of ['genres','themes','demographics','studios']) {
    const cnt = D[`${col}_cnt`];
    const off = new Uint32Array(n+1);
    for (let i=0;i<n;i++) off[i+1] = off[i]+cnt[i];
    D[`${col}_off`] = off;
  }

  self.postMessage({ type: 'progress', pct: 85, msg: 'Loading indexes…' });

  // Load pre-built inverted indexes as views
  const PILL_COLS = ['type','status','season','rating','source'];
  const TAG_COLS  = ['genres','themes','demographics','studios'];

  for (const col of PILL_COLS) {
    const lengths = view(`pidx_${col}_len`, Uint32Array);
    const data    = view(`pidx_${col}_dat`, Uint32Array);
    const pool    = pools[col];
    idx[col] = {};
    let pos = 0;
    for (let i=0; i<pool.length; i++) {
      idx[col][pool[i]] = data.subarray(pos, pos + lengths[i]);
      pos += lengths[i];
    }
  }
  // airing
  {
    const lengths = view('pidx_airing_len', Uint32Array);
    const data    = view('pidx_airing_dat', Uint32Array);
    idx.airing = {
      '1': data.subarray(0, lengths[0]),
      '0': data.subarray(lengths[0], lengths[0]+lengths[1]),
    };
  }
  for (const col of TAG_COLS) {
    const lengths = view(`tidx_${col}_len`, Uint32Array);
    const data    = view(`tidx_${col}_dat`, Uint32Array);
    const pool    = pools[col];
    idx[col] = {};
    let pos = 0;
    for (let i=0; i<pool.length; i++) {
      idx[col][pool[i]] = data.subarray(pos, pos + lengths[i]);
      pos += lengths[i];
    }
  }

  self.postMessage({ type: 'ready', total: n, opts, stats });
  loadDisplay();
}

async function loadDisplay() {
  try {
    const text = await fetchJson('display.json');
    X = JSON.parse(text);
    self.postMessage({ type: 'enriched' });
  } catch(e) {
    console.warn('display.json failed:', e.message);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function getTitle(i) {
  const s = D.title_off[i], e = D.title_off[i+1];
  return D._dec.decode(D.title_utf8.subarray(s, e));
}

function getTagStr(col, i) {
  const off  = D[`${col}_off`][i];
  const cnt  = D[`${col}_cnt`][i];
  const data = D[`${col}_data`];
  const pool = D.pools[col];
  const parts = [];
  for (let j=0; j<cnt; j++) parts.push(pool[data[off+j]]);
  return parts.join(', ');
}

function decodeCat(col, i) {
  const code = D[`${col}_cat`][i];
  return code === 0 ? null : D.pools[col][code-1];
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

  // OR pill filters
  for (const field of ['type','status','season','rating','source']) {
    const sel = filters[field];
    if (!sel?.length) continue;
    const union = new Set();
    for (const v of sel) { const a=idx[field]?.[v]; if(a) for(const i of a) union.add(i); }
    candidates = intersect(candidates, union);
  }
  // airing
  if (filters.airing?.length) {
    const union = new Set();
    for (const v of filters.airing) {
      const key = v==='Airing'?'1':'0';
      const a=idx.airing[key]; if(a) for(const i of a) union.add(i);
    }
    candidates = intersect(candidates, union);
  }
  // AND tag filters
  for (const field of ['genres','themes','demographics','studios']) {
    const sel = filters[field];
    if (!sel?.length) continue;
    for (const v of sel) {
      const a=idx[field]?.[v];
      candidates = a ? intersect(candidates, new Set(a)) : new Set();
    }
  }

  // Numeric + title scan
  const iter = candidates !== null ? [...candidates] : Array.from({length:n},(_,i)=>i);
  const titleQ = filters.title?.toLowerCase() || null;
  const { minScore, maxScore, minScoredBy, maxScoredBy, minRank, maxRank,
          minMembers, maxMembers, minFav, maxFav, minEp, maxEp, minYear, maxYear } = filters;

  const result = [];
  for (const i of iter) {
    if (titleQ) {
      const t  = getTitle(i).toLowerCase();
      const te = X ? (X.title_english[i]||'').toLowerCase() : '';
      if (!t.includes(titleQ) && !te.includes(titleQ)) continue;
    }
    const sc=ta_score[i];
    if (minScore    != null && (isNaN(sc)||sc<minScore))    continue;
    if (maxScore    != null && (isNaN(sc)||sc>maxScore))    continue;
    const sb=ta_scored_by[i];
    if (minScoredBy != null && (sb<0||sb<minScoredBy))     continue;
    if (maxScoredBy != null && (sb<0||sb>maxScoredBy))     continue;
    const rk=ta_rank[i];
    if (minRank     != null && (rk<0||rk<minRank))         continue;
    if (maxRank     != null && (rk<0||rk>maxRank))         continue;
    const mb=ta_members[i];
    if (minMembers  != null && (mb<0||mb<minMembers))       continue;
    if (maxMembers  != null && (mb<0||mb>maxMembers))       continue;
    const fv=ta_favorites[i];
    if (minFav      != null && (fv<0||fv<minFav))           continue;
    if (maxFav      != null && (fv<0||fv>maxFav))           continue;
    const ep=ta_episodes[i];
    if (minEp       != null && (ep<0||ep<minEp))            continue;
    if (maxEp       != null && (ep<0||ep>maxEp))            continue;
    const yr=ta_year[i];
    if (minYear     != null && (yr<0||yr<minYear))          continue;
    if (maxYear     != null && (yr<0||yr>maxYear))          continue;
    result.push(i);
  }

  // Sort
  const taMap = {
    score:ta_score, scored_by:ta_scored_by, rank:ta_rank, popularity:ta_popularity,
    members:ta_members, favorites:ta_favorites, episodes:ta_episodes, year:ta_year,
  };
  const ta  = taMap[sort.field];
  const asc = sort.dir === 'asc';
  result.sort((a,b) => {
    if (ta) {
      const va=ta[a], vb=ta[b];
      const aN=va<0||isNaN(va), bN=vb<0||isNaN(vb);
      if (aN&&bN) return 0; if (aN) return 1; if (bN) return -1;
      return asc?(va-vb):(vb-va);
    }
    const va=(getTitle(a)||'').toLowerCase(), vb=(getTitle(b)||'').toLowerCase();
    return asc?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0);
  });

  // Paginate + build rows
  const { offset, limit } = page;
  const rows = result.slice(offset, offset+limit).map(i => buildRow(i));
  return { total: result.length, rows };
}

function buildRow(i) {
  const scoreRaw = ta_score[i];
  return {
    mal_id:          D.mal_id[i],
    title:           getTitle(i),
    score:           isNaN(scoreRaw) ? null : scoreRaw,
    scored_by:       ta_scored_by[i] < 0  ? null : ta_scored_by[i],
    rank:            ta_rank[i]      < 0  ? null : ta_rank[i],
    popularity:      ta_popularity[i]< 0  ? null : ta_popularity[i],
    members:         ta_members[i]   < 0  ? null : ta_members[i],
    favorites:       ta_favorites[i] < 0  ? null : ta_favorites[i],
    episodes:        ta_episodes[i]  < 0  ? null : ta_episodes[i],
    year:            ta_year[i]      < 0  ? null : ta_year[i],
    airing:          D.airing[i],
    type:            decodeCat('type',   i),
    status:          decodeCat('status', i),
    season:          decodeCat('season', i),
    rating:          decodeCat('rating', i),
    source:          decodeCat('source', i),
    genres:          getTagStr('genres',       i),
    themes:          getTagStr('themes',       i),
    demographics:    getTagStr('demographics', i),
    studios:         getTagStr('studios',      i),
    // display fields from X (null until enriched)
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
    catch(err) { self.postMessage({ type:'error', msg:err.message }); }
    return;
  }
  if (type === 'filter') {
    const result = doFilter(filters, sort, page);
    self.postMessage({ type:'result', id, ...result });
  }
};
