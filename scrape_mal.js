// Scrapes all ranked anime from MAL via Jikan API v4 for AniDex
// Output: mal_anime.ndjson (one JSON object per line)
// Resumes automatically if interrupted — safe to re-run
//
// Run: node scrape_mal.js

const fs   = require('fs');
const path = require('path');

const OUTPUT_FILE   = path.join(__dirname, 'mal_anime.ndjson');
const PROGRESS_FILE = path.join(__dirname, '.scrape_progress.json');
const BASE_URL      = 'https://api.jikan.moe/v4/top/anime';
const PER_PAGE      = 25;
const DELAY_MS      = 420;   // ~2.38 req/s, under the 3/s limit
const RETRY_DELAYS  = [1000, 2000, 4000, 8000, 16000]; // exponential backoff

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { nextPage: 1, totalPages: null, written: 0 }; }
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p));
}

async function fetchPage(page, attempt = 0) {
  const url = `${BASE_URL}?page=${page}&limit=${PER_PAGE}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    if (attempt >= RETRY_DELAYS.length) throw err;
    await sleep(RETRY_DELAYS[attempt]);
    return fetchPage(page, attempt + 1);
  }

  if (res.status === 429) {
    if (attempt >= RETRY_DELAYS.length) throw new Error(`429 persists on page ${page}`);
    const wait = RETRY_DELAYS[attempt];
    process.stdout.write(` [429, retrying in ${wait}ms]`);
    await sleep(wait);
    return fetchPage(page, attempt + 1);
  }

  if (!res.ok) {
    if (attempt >= RETRY_DELAYS.length) throw new Error(`HTTP ${res.status} on page ${page}`);
    await sleep(RETRY_DELAYS[attempt]);
    return fetchPage(page, attempt + 1);
  }

  return res.json();
}

// ── flatten one anime entry into a clean flat object ─────────────────────────
// Keeps all info but normalises arrays to comma-separated strings and
// extracts nested primitives, so ClickHouse can ingest without transforms.

function flatten(a) {
  return {
    // identity
    mal_id:           a.mal_id,
    url:              a.url,
    title:            a.title,
    title_english:    a.title_english   ?? null,
    title_japanese:   a.title_japanese  ?? null,
    title_synonyms:   (a.title_synonyms ?? []).join(' | '),

    // classification
    type:             a.type            ?? null,
    source:           a.source          ?? null,
    episodes:         a.episodes        ?? null,
    status:           a.status          ?? null,
    airing:           a.airing          ?? null,
    duration:         a.duration        ?? null,
    rating:           a.rating          ?? null,  // age rating (PG, R, etc.)
    season:           a.season          ?? null,
    year:             a.year            ?? null,

    // broadcast
    broadcast_day:    a.broadcast?.day      ?? null,
    broadcast_time:   a.broadcast?.time     ?? null,
    broadcast_tz:     a.broadcast?.timezone ?? null,

    // air dates
    aired_from:       a.aired?.from ?? null,
    aired_to:         a.aired?.to   ?? null,

    // scores & popularity
    score:            a.score        ?? null,
    scored_by:        a.scored_by    ?? null,
    rank:             a.rank         ?? null,
    popularity:       a.popularity   ?? null,
    members:          a.members      ?? null,
    favorites:        a.favorites    ?? null,

    // taxonomy (arrays → comma strings for columnar storage)
    genres:           (a.genres           ?? []).map(g => g.name).join(', '),
    themes:           (a.themes           ?? []).map(g => g.name).join(', '),
    demographics:     (a.demographics     ?? []).map(g => g.name).join(', '),
    explicit_genres:  (a.explicit_genres  ?? []).map(g => g.name).join(', '),

    // production
    studios:          (a.studios   ?? []).map(s => s.name).join(', '),
    producers:        (a.producers ?? []).map(s => s.name).join(', '),
    licensors:        (a.licensors ?? []).map(s => s.name).join(', '),

    // images
    image_jpg:        a.images?.jpg?.large_image_url  ?? a.images?.jpg?.image_url  ?? null,
    image_webp:       a.images?.webp?.large_image_url ?? a.images?.webp?.image_url ?? null,

    // trailer
    trailer_url:      a.trailer?.url ?? null,

    // text
    synopsis:         a.synopsis    ?? null,
    background:       a.background  ?? null,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const progress = loadProgress();
  let { nextPage, totalPages, written } = progress;

  const isResume = nextPage > 1;
  const writeStream = fs.createWriteStream(OUTPUT_FILE, {
    flags: isResume ? 'a' : 'w',  // append on resume, overwrite on fresh start
  });

  if (isResume) {
    console.log(`Resuming from page ${nextPage} (${written} anime already saved)`);
  } else {
    console.log('Starting fresh AniDex scrape via Jikan API...');
  }

  const startTime = Date.now();

  for (let page = nextPage; ; page++) {
    process.stdout.write(`\rPage ${page}${totalPages ? `/${totalPages}` : ''}  |  saved: ${written}  |  elapsed: ${Math.round((Date.now()-startTime)/1000)}s   `);

    const json = await fetchPage(page);

    // first page tells us the total
    if (!totalPages) {
      totalPages = Math.ceil(json.pagination.items.total / PER_PAGE);
      process.stdout.write(`\rTotal anime: ${json.pagination.items.total.toLocaleString()} across ${totalPages} pages\n`);
    }

    for (const anime of json.data) {
      writeStream.write(JSON.stringify(flatten(anime)) + '\n');
      written++;
    }

    saveProgress({ nextPage: page + 1, totalPages, written });

    if (!json.pagination.has_next_page) break;

    await sleep(DELAY_MS);
  }

  writeStream.end();
  console.log(`\n\nDone! ${written.toLocaleString()} anime saved to ${OUTPUT_FILE}`);
  fs.unlinkSync(PROGRESS_FILE);  // clean up progress file on success

  // print a sample of the fields
  const sample = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8').split('\n')[0]);
  console.log('\nFields captured:', Object.keys(sample).join(', '));
  console.log('File size:', (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1), 'MB');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  console.error('Progress saved — re-run to resume from last page.');
  process.exit(1);
});
