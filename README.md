# AniDex

An index for every anime on MyAnimeList — 30,449 titles, all dimensions filterable and sortable. Loads in under a second. All filtering runs in a Web Worker at <5ms per query. Deployable to GitHub Pages with zero server required.

---

## Files

| File | Size | Purpose |
|------|------|---------|
| `dashboard.html` | 36KB | Single-page app — all UI + JS |
| `worker.js` | 9.9KB | Web Worker: owns all data, handles filter/sort/paginate |
| `config.js` | 0.5KB | **Single toggle between server and serverless mode** |
| `server.js` | 2.1KB | Static HTTP server (server mode only) |
| `main.json.gz` | 896KB | Initial data payload — gzip (serverless mode) |
| `main.json.br` | 750KB | Initial data payload — Brotli (server mode) |
| `display.json.gz` | 4.8MB | Display enrichment payload — gzip (serverless mode) |
| `display.json.br` | 3.5MB | Display enrichment payload — Brotli (server mode) |
| `mal_anime.ndjson` | 38MB | Raw scraped source — gitignored, only needed to re-preprocess |
| `scrape_mal.js` | 6.6KB | Scraper: fetches all ranked anime from Jikan API |
| `preprocess_v2.js` | 4.4KB | Converts NDJSON → both gz and br columnar payloads |
| `.github/workflows/deploy.yml` | — | GitHub Actions: deploys serverless build to GitHub Pages |
| `.gitignore` | — | Excludes NDJSON (38MB) and .br files from git |

---

## Running

### Serverless mode (default — matches GitHub Pages exactly)

```bash
python3 -m http.server 8080
# → http://localhost:8080/dashboard.html
```

Uses `main.json.gz` + `display.json.gz`. The worker fetches and decompresses them manually using the browser's `DecompressionStream` API. No Node.js needed at runtime.

### Server mode (smaller payload, Brotli)

```bash
node server.js
# → http://localhost:8080/dashboard.html
```

Uses `main.json.br` + `display.json.br` served with `Content-Encoding: br`. Browser decompresses transparently. 750KB vs 896KB for the initial payload.

### Switching modes

Edit one line in `config.js`:

```js
const CONFIG = {
  mode: 'serverless'  // 'serverless' | 'server'
};
```

That's the only change needed. The dashboard reads this at page load and passes it to the worker in the first `postMessage`.

---

## GitHub Pages Deployment

1. In your repo: Settings → Pages → Source → **GitHub Actions**
2. Push to `main` — the workflow runs automatically

The workflow (`deploy.yml`) copies only what's needed into `dist/`:
```
dashboard.html  worker.js  config.js  main.json.gz  display.json.gz
```
Everything else (server.js, scraper, preprocessor, .br files, NDJSON) is excluded. The `dist/` folder is uploaded as a Pages artifact and deployed.

What's committed to git: ~6MB total (`main.json.gz` at 896KB + `display.json.gz` at 4.8MB + code). The 38MB NDJSON and `.br` files are gitignored.

---

## Re-scraping

```bash
node scrape_mal.js        # ~30 min, produces mal_anime.ndjson — resumable if interrupted
node preprocess_v2.js     # produces main.json.gz + main.json.br + display.json.gz + display.json.br
```

After re-running preprocess, commit the new `.gz` files and push. The GitHub Actions workflow deploys them automatically.

---

## Data Source

**Jikan API v4** (`api.jikan.moe/v4`) — unofficial MyAnimeList REST API. No API key, no auth, free.

- **Endpoint:** `GET /top/anime?page=N&limit=25`
- **Rate limits:** 3 req/sec, 60 req/min
- **Total pages:** 1,218 at 25 items per page
- **Scrape delay:** 420ms between requests. On 429, exponential backoff: 1s → 2s → 4s → 8s → 16s, up to 5 retries before skipping a page
- **Progress saving:** writes `{ nextPage, totalPages, written }` to `.scrape_progress.json` after every page. Re-run the script to resume. Deletes the file on success
- **Coverage:** 30,449 ranked anime. MAL only ranks anime that have received at least a minimum number of scores — truly obscure titles with zero scores are excluded by the API

One response looks like:
```json
{
  "data": [{
    "mal_id": 52991,
    "title": "Sousou no Frieren",
    "score": 9.37,
    "scored_by": 706654,
    "rank": 1,
    "genres": [{"name": "Adventure"}, {"name": "Drama"}],
    "studios": [{"name": "Madhouse"}],
    ...
  }],
  "pagination": { "items": { "total": 30449 }, "has_next_page": true }
}
```

Output format is **NDJSON** (one complete JSON object per line, not a JSON array). This allows appending without re-parsing, streaming line-by-line, and resuming partial scrapes.

---

## Data Fields Captured Per Anime

**Numeric:** `mal_id`, `score`, `scored_by`, `rank`, `popularity`, `members`, `favorites`, `episodes`, `year`, `airing`

**String:** `title`, `title_english`, `title_japanese`, `type`, `source`, `status`, `duration`, `rating` (age), `season`, `aired_from`, `aired_to`, `broadcast_day`, `broadcast_time`, `image_jpg`, `synopsis`, `background`

**Tag arrays** (comma-separated strings): `genres`, `themes`, `demographics`, `studios`, `producers`, `licensors`

---

## Payload Design — Why It's 896KB Not 38MB

### Starting point

38MB raw NDJSON → first preprocessing attempt produced a single `data.json.gz` at **7.3MB** (gzip level 9). Still too heavy for a fast initial load.

### Field-by-field size analysis (measured individually, Brotli)

| Field | Brotli size |
|-------|-------------|
| synopsis | **2,607 KB — 50% of the file** |
| url | 355 KB |
| title_japanese | 312 KB |
| inverted indexes | 310 KB |
| background | 158 KB |
| title | 259 KB |
| title_english | 123 KB |
| image_jpg | 127 KB |
| all numerics (9 fields) | 240 KB |
| tags (genres/themes/studios/demographics) | 110 KB |
| categoricals (type/status/season/etc.) | 60 KB |

Synopsis alone is 50% of the total file. It's unique natural language text — no compression algorithm shrinks it further. This analysis directly determined the split strategy.

### What changed from v1 to v2

**1. Split into two payloads**

`main.json` (fast, interactive) — all numeric fields, all categorical fields, all tag fields, title only. No synopsis, no background, no images, no Japanese titles, no inverted indexes.

`display.json` (background enrichment) — `title_english`, `title_japanese`, `image_jpg`, `synopsis`, `background`, `duration`, `aired_from/to`, `broadcast_time`, `producers`, `licensors`. Loaded by the worker immediately after posting `ready`. Merges into the row builder — the UI re-renders the current page when it arrives.

**2. Inverted indexes rebuilt in the worker, not shipped**

The 310KB of index data (`genre → [row indexes]`, `type → [row indexes]`, etc.) is omitted from the file and rebuilt at startup from the columnar arrays in ~50ms. Saves 310KB from the download.

**3. Brotli at quality 11 for server mode, gzip level 9 for serverless**

Brotli achieves ~20–25% better compression than gzip on this JSON. The serverless mode penalty is 896KB vs 750KB — worth the tradeoff for zero-server deployment.

**4. Columnar format instead of row-per-object**

Instead of 30,449 objects each with repeated key names:
```json
{"title":"X","score":8.5,"genres":"Action"}
{"title":"Y","score":7.2,"genres":"Comedy"}
```

One array per field:
```json
{ "title": ["X","Y"], "score": [8.5,7.2], "genres": ["Action","Comedy"] }
```

One `JSON.parse()` call in the browser instead of 30,449. Adjacent similar values also compress better.

### Result

| Version | Payload | Notes |
|---------|---------|-------|
| Raw NDJSON | 38MB | One JSON object per line |
| NDJSON gzip | 9MB | |
| v1: combined JSON, gzip | 7.3MB | All fields, all indexes |
| v2: `main.json.gz` | **896KB** | Filter+search data only, serverless |
| v2: `main.json.br` | **750KB** | Filter+search data only, server mode |

**~8× smaller** initial payload vs the original gzip version.

---

## Architecture — What Actually Happens

### Three completely separate phases

**Phase 1 — Scraping** (`scrape_mal.js`): Makes real external API calls to Jikan. One-time offline operation. Output: `mal_anime.ndjson`. This is the only phase that hits an external API — AniDex itself makes no external calls during browsing.

**Phase 2 — Preprocessing** (`preprocess_v2.js`): No network calls. Reads NDJSON, reshapes to columnar format, compresses both ways. Output: four files (`main.json.{gz,br}`, `display.json.{gz,br}`).

**Phase 3 — Live app**: `dashboard.html` + `worker.js` + `server.js`. The only requests are to your own server or CDN.

---

### The server (`server.js`)

~50 lines. For every file request, checks if a `.br` sibling exists — if so, serves it with `Content-Encoding: br`. Same for `.gz`. The browser sees the header and decompresses transparently before handing data to JavaScript. This is why `fetch('main.json')` in the worker returns plain JSON text with no decompression code needed in server mode.

In serverless mode, `server.js` is not used. `python3 -m http.server` serves the `.gz` files as raw binary — no Content-Encoding header — and the worker decompresses them manually.

---

### Page load sequence

**1.** HTML parses. Loading overlay covers the screen. Google Fonts loads in background.

**2.** `new Worker('worker.js')` spawns a Web Worker — a completely separate JS thread with no DOM access. All data work happens here. The main thread (UI) never blocks.

**3.** Main thread reads `CONFIG.mode` from `config.js` (already executed as a `<script>` tag in head), posts `{ type: 'load', mode: 'serverless' }` to the worker.

**4.** Worker fetches `main.json` (server mode) or `main.json.gz` (serverless mode).

**Server mode fetch:**
```js
const res  = await fetch('main.json');   // server sends main.json.br with Content-Encoding: br
const text = await res.text();           // browser decompresses Brotli, returns plain JSON
```

**Serverless mode fetch (DecompressionStream):**
```js
const res    = await fetch('main.json.gz');
const ds     = new DecompressionStream('gzip');
const reader = res.body.pipeThrough(ds).getReader();
// collect chunks → Uint8Array → TextDecoder → JSON string
```
`DecompressionStream` is a browser-native API (no libraries) that supports `'gzip'` and `'deflate'`. Brotli is explicitly not supported in JS — it only works as a server-set `Content-Encoding` header.

**5.** Worker runs `JSON.parse()` on the decompressed text. `D` is now an object with ~20 arrays, each 30,449 elements.

**6.** Worker converts numeric arrays to typed arrays:
```js
ta_score     = new Float64Array(D.score.map(v => v ?? NaN));
ta_scored_by = new Int32Array(D.scored_by);
ta_rank      = new Int32Array(D.rank);
// ... etc
```
`Float64Array` and `Int32Array` are views over contiguous binary memory. No boxing, no property lookups. A Float64Array of 30k numbers is literally 240KB of sequential 8-byte floats — iterating it for range checks is extremely cache-friendly.

**7.** Worker builds inverted indexes from the columnar arrays:
```js
D.type.forEach((v, i) => { (idx.type[v] ??= []).push(i); });
// idx.type = { "TV": [0,1,2,4,...], "Movie": [3,7,12,...], ... }
```
Same for status, season, genres, themes, studios, demographics, airing.

**8.** Worker posts `{ type: 'ready', total: 30449, opts: {...} }`. `opts` contains sorted unique values for every filterable field — the main thread uses this to build the filter sidebar pills and dropdowns dynamically.

**9.** Main thread hides loading screen, builds sidebar from `opts`, calls `dispatch()` which runs the first filter query.

**10.** Worker immediately begins loading `display.json` in background. When it arrives, posts `{ type: 'enriched' }`. Main thread re-renders current page — images, synopsis, English/Japanese titles fill in. The animated shimmer bar at the top disappears.

---

### Filter system

Every filter interaction calls `dispatch()`. Main thread posts:
```js
worker.postMessage({
  type: 'filter',
  id: 42,
  filters: { minScore: 7.0, genres: ['Action'], type: ['TV'], title: 'naruto' },
  sort: { field: 'scored_by', dir: 'desc' },
  page: { offset: 0, limit: 50 }
})
```

Worker runs `doFilter()`:

**Step 1 — Categorical filters via inverted indexes**

OR logic (pill fields — type, status, season, etc.): user selected `["TV", "Movie"]` → union of their index arrays:
```js
const union = new Set();
for (const v of ["TV","Movie"]) for (const i of idx.type[v]) union.add(i);
candidates = union;
```

AND logic (tag fields — genres, themes, studios): user selected `["Action","Romance"]` → intersection, row must have all:
```js
candidates = intersect(candidates, new Set(idx.genres["Action"]));
candidates = intersect(candidates, new Set(idx.genres["Romance"]));
```

Intersection iterates the smaller Set and checks membership in the larger — O(min(a,b)).

**Step 2 — Numeric filters (typed array scan)**
```js
const iter = candidates !== null ? [...candidates] : range(n);
const result = [];
for (const i of iter) {
  if (minScore != null && (isNaN(ta_score[i]) || ta_score[i] < minScore)) continue;
  if (minRank   != null && (ta_rank[i] < 0   || ta_rank[i]   < minRank))  continue;
  // title search checks D.title[i].toLowerCase().includes(titleQ)
  result.push(i);
}
```

**Step 3 — Sort**
```js
result.sort((a, b) => {
  const va = ta_scored_by[a], vb = ta_scored_by[b];
  return sortDir === 'desc' ? vb - va : va - vb;
});
```

Sorting by a typed array field: O(n log n) comparisons, each O(1) with no property lookup.

**Step 4 — Paginate and build rows**
```js
const rows = result.slice(offset, offset + limit).map(i => buildRow(i));
```

`buildRow(i)` pulls from `D` (always available) and `X` (display data, null until enriched) to construct a plain object. Full row objects are never built for all 30k at once — only for the 50 being rendered.

**Step 5 — postMessage result back**
```js
self.postMessage({ type: 'result', id: 42, total: result.length, rows });
```

Main thread checks `id === pendingId` before rendering. If the user typed fast and `id` is stale (a newer query was dispatched), the result is discarded.

---

### Rendering

`renderResult()` builds a `DocumentFragment` off-screen, then attaches it in one DOM operation:
```js
const frag = document.createDocumentFragment();
rows.forEach((a, i) => {
  const tr = document.createElement('tr');
  tr.innerHTML = rowHtml(a, i);
  frag.appendChild(tr);
});
tbody.innerHTML = '';
tbody.appendChild(frag);  // single reflow
```

Images use `loading="lazy"` — the browser only fetches from `cdn.myanimelist.net` when the `<img>` is in the viewport. Navigating to a new page scrolls to top, so only the first ~10 visible thumbnails load immediately.

---

### Network requests made during browsing

| Request | When | Size |
|---------|------|------|
| `GET /dashboard.html` | Page open | 36KB |
| `GET /config.js` | Page open | 0.5KB |
| `GET /worker.js` | Worker spawn | 9.9KB |
| `GET /main.json(.gz)` | Worker load | 896KB |
| `GET /display.json(.gz)` | Background | 4.8MB |
| `GET <image_url>` × N | Per visible row, lazy | From MAL CDN (not AniDex's server) |

Zero external API calls during browsing. Jikan is only hit when running `scrape_mal.js`.

---

## Design

**Fonts:** Cormorant Garamond italic (brand wordmark) · Space Mono (all numbers, table headers, sidebar labels, pagination) · Outfit (body text, pills, row titles). The combination reads as "data terminal inside a literary archive."

**Score colors — 6 tiers:**

| Range | Color | Name |
|-------|-------|------|
| 9.0+ | `#C4B5FD` | Violet |
| 8.0+ | `#818CF8` | Indigo |
| 7.0+ | `#34D399` | Emerald |
| 6.0+ | `#E8B84B` | Gold |
| 5.0+ | `#F97316` | Orange |
| <5.0 | `#F87171` | Red |

**Background:** `#05080F` (blue-black) with a 6% opacity radial blue glow near the topbar. CSS SVG noise texture at 1.8% opacity prevents flat-void appearance.

**Tags:** Left-border strip (`border-left: 2px solid`) with category-specific colors — blue for genres, emerald for themes, gold for demographics, slate for studios.

**Row hover:** Left accent bar via `box-shadow: inset 2px 0 0 var(--v)` on the first cell. Thumbnail scales 6% with lift shadow.

**Loading states:** Skeleton shimmer (`background-size: 300%` animated gradient) on cells waiting for `display.json`. Animated 1px gradient line under the topbar while enrichment loads. Both disappear when `display.json` arrives.

**Default sort:** Scored by descending — most-reviewed anime first, which surfaces the titles most people have actually rated rather than pure rank order.
