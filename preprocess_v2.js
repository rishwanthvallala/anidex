// AniDex — splits mal_anime.ndjson into two compressed payloads:
//   main.json.br  — everything needed for filtering + basic display (~0.8MB)
//   display.json.br — synopsis, background, title_japanese (loads in background)
// Run: node preprocess_v2.js

const fs   = require('fs');
const zlib = require('zlib');

console.log('Reading NDJSON…');
const rows = fs.readFileSync('mal_anime.ndjson', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const n = rows.length;
console.log(`Loaded ${n} anime`);

const pick    = col => rows.map(r => r[col] ?? null);
const pickStr = col => rows.map(r => r[col] || '');

// ── option lists for filter UI (built here, not stored as inverted indexes) ──
function buildOpts(fields) {
  const opts = {};
  for (const [field, isTag] of fields) {
    const set = new Set();
    rows.forEach(r => {
      const v = r[field];
      if (!v) return;
      if (isTag) v.split(', ').filter(Boolean).forEach(t => set.add(t));
      else set.add(String(v));
    });
    opts[field] = [...set].sort();
  }
  return opts;
}

const opts = buildOpts([
  ['type', false], ['status', false], ['season', false],
  ['rating', false], ['source', false], ['broadcast_day', false],
  ['genres', true], ['themes', true], ['demographics', true], ['studios', true],
]);
opts.airing = ['Airing', 'Finished'];

// ── MAIN payload ─────────────────────────────────────────────────────────────
// Only what's needed for filtering + title for search. Renders instantly.
// No indexes (rebuilt in worker). No images, no display strings, no synopsis.
const main = {
  n, opts,
  // numerics
  mal_id:     pick('mal_id'),
  score:      pick('score'),
  scored_by:  pick('scored_by'),
  rank:       pick('rank'),
  popularity: pick('popularity'),
  members:    pick('members'),
  favorites:  pick('favorites'),
  episodes:   pick('episodes'),
  year:       pick('year'),
  airing:     rows.map(r => r.airing ? 1 : 0),
  // title only — needed for text search
  title: pick('title'),
  // categoricals
  type:   pick('type'),
  status: pick('status'),
  season: pick('season'),
  rating: pick('rating'),
  source: pick('source'),
  // tags (worker builds inverted indexes from these)
  genres:       pickStr('genres'),
  themes:       pickStr('themes'),
  demographics: pickStr('demographics'),
  studios:      pickStr('studios'),
};

// ── DISPLAY payload ───────────────────────────────────────────────────────────
// All display fields — loads in background, enriches table within seconds.
const display = {
  n,
  title_english:   pick('title_english'),
  title_japanese:  pick('title_japanese'),
  image_jpg:       pick('image_jpg'),
  duration:        pick('duration'),
  aired_from:      pick('aired_from'),
  aired_to:        pick('aired_to'),
  broadcast_day:   pick('broadcast_day'),
  broadcast_time:  pick('broadcast_time'),
  producers:       pickStr('producers'),
  licensors:       pickStr('licensors'),
  synopsis:        pick('synopsis'),
  background:      pick('background'),
  trailer_url:     pick('trailer_url'),
  explicit_genres: pickStr('explicit_genres'),
};

// ── write + compress (both formats) ──────────────────────────────────────────
// Outputs .br (server mode) and .gz (serverless mode) for each payload.
// Which format is used at runtime is controlled by config.js.

const BROTLI_OPTS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } };

function writeBoth(name, obj) {
  process.stdout.write(`${name}… `);
  const json = JSON.stringify(obj);
  const br   = zlib.brotliCompressSync(json, BROTLI_OPTS);
  const gz   = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(`${name}.br`, br);
  fs.writeFileSync(`${name}.gz`, gz);
  console.log(`${(json.length/1024/1024).toFixed(1)}MB raw → ${(br.length/1024).toFixed(0)}KB br / ${(gz.length/1024).toFixed(0)}KB gz`);
  return { br: br.length, gz: gz.length };
}

const m = writeBoth('main.json',    main);
const d = writeBoth('display.json', display);

console.log(`\n  server mode    (brotli): main ${(m.br/1024).toFixed(0)}KB + display ${(d.br/1024).toFixed(0)}KB`);
console.log(`  serverless mode (gzip):  main ${(m.gz/1024).toFixed(0)}KB + display ${(d.gz/1024).toFixed(0)}KB`);
