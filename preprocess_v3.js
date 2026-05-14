// Builds main.bin.{gz,br} — binary columnar format replacing main.json.gz
// Worker reads typed array views directly (zero JSON.parse), pre-built indexes included
// Run: node preprocess_v3.js

const fs   = require('fs');
const zlib = require('zlib');

console.log('Reading NDJSON…');
const rows = fs.readFileSync('mal_anime.ndjson','utf8').trim().split('\n').map(l=>JSON.parse(l));
const n    = rows.length;
console.log(`Loaded ${n} rows`);

const PILL_COLS = ['type','status','season','rating','source'];
const TAG_COLS  = ['genres','themes','demographics','studios'];
const BUCKETS   = 28;

// ── typed array builders ──────────────────────────────────────────────────────
const pickF32 = col => {
  const a = new Float32Array(n);
  rows.forEach((r,i) => { a[i] = r[col] != null ? r[col] : NaN; });
  return a;
};
const pickI32 = (col, nil=-1) => {
  const a = new Int32Array(n);
  rows.forEach((r,i) => { a[i] = r[col] != null ? r[col] : nil; });
  return a;
};
const pickU8Bool = col => {
  const a = new Uint8Array(n);
  rows.forEach((r,i) => { a[i] = r[col] ? 1 : 0; });
  return a;
};

// ── string pool builders ──────────────────────────────────────────────────────
function makePool(vals) {
  const s = new Set(vals.filter(Boolean)); return [...s].sort();
}
function makePillPool(col) { return makePool(rows.map(r=>r[col])); }
function makeTagPool(col)  {
  const s = new Set();
  rows.forEach(r => { if (r[col]) r[col].split(', ').filter(Boolean).forEach(t=>s.add(t)); });
  return [...s].sort();
}

// ── categorical encoder (Uint8, 0=null) ──────────────────────────────────────
function encodeCat(col, pool) {
  const map = new Map(pool.map((v,i)=>[v,i+1]));
  const a = new Uint8Array(n);
  rows.forEach((r,i) => { a[i] = map.get(r[col]) ?? 0; });
  return a;
}

// ── tag encoder: Uint8 count per row + Uint16 flat codes ─────────────────────
function encodeTags(col, pool) {
  const map = new Map(pool.map((v,i)=>[v,i]));
  const cnt   = new Uint8Array(n);
  const parts = [];
  let total = 0;
  rows.forEach((r,i) => {
    const tags  = r[col] ? r[col].split(', ').filter(Boolean) : [];
    const codes = tags.map(t=>map.get(t)).filter(c=>c!==undefined);
    cnt[i] = Math.min(255, codes.length);
    parts.push(codes);
    total += codes.length;
  });
  const flat = new Uint16Array(total);
  let pos = 0;
  for (const c of parts) { flat.set(c, pos); pos += c.length; }
  return { cnt, flat };
}

// ── title as UTF-8 bytes + Uint32 byte offsets ────────────────────────────────
function encodeStrings(col) {
  const enc  = new TextEncoder();
  const strs = rows.map(r => r[col] ? enc.encode(String(r[col])) : new Uint8Array(0));
  const offsets = new Uint32Array(n+1);
  let p = 0;
  for (let i=0;i<n;i++) { offsets[i]=p; p+=strs[i].length; }
  offsets[n] = p;
  const data = new Uint8Array(p);
  p = 0;
  for (const s of strs) { data.set(s,p); p+=s.length; }
  return { offsets, data };
}

// ── inverted index builder → pack into Uint32 flat + lengths ─────────────────
function buildPillIdx(col, pool) {
  const map = new Map(pool.map((v,i)=>[v,i]));
  const buckets = pool.map(()=>[]);
  rows.forEach((r,i)=>{ const pi=map.get(r[col]); if(pi!==undefined) buckets[pi].push(i); });
  return packIdx(buckets);
}
function buildAiringIdx() {
  const a=[], b=[];
  rows.forEach((r,i)=>(r.airing?a:b).push(i));
  return packIdx([a,b]);
}
function buildTagIdx(col, pool) {
  const map = new Map(pool.map((v,i)=>[v,i]));
  const buckets = pool.map(()=>[]);
  rows.forEach((r,i)=>{
    if(!r[col]) return;
    r[col].split(', ').filter(Boolean).forEach(t=>{
      const pi=map.get(t); if(pi!==undefined) buckets[pi].push(i);
    });
  });
  return packIdx(buckets);
}
function packIdx(buckets) {
  const lengths = buckets.map(b=>b.length);
  const total   = lengths.reduce((s,l)=>s+l,0);
  const data    = new Uint32Array(total);
  let pos=0;
  for (const b of buckets) { data.set(b,pos); pos+=b.length; }
  return { lengths: new Uint32Array(lengths), data };
}

// ── pre-compute stats (histograms + value counts for chips) ───────────────────
function computeStats(tarrays, pillCodes, pilPools, tagData, tagPools) {
  const histograms={}, fieldRanges={};
  const NUM = [
    {k:'score',    a:tarrays.score,      log:false, f32:true },
    {k:'scored_by',a:tarrays.scored_by,  log:true,  f32:false},
    {k:'rank',     a:tarrays.rank,       log:false, f32:false},
    {k:'members',  a:tarrays.members,    log:true,  f32:false},
    {k:'favorites',a:tarrays.favorites,  log:true,  f32:false},
    {k:'episodes', a:tarrays.episodes,   log:false, f32:false},
    {k:'year',     a:tarrays.year,       log:false, f32:false},
  ];
  for (const {k,a,log,f32} of NUM) {
    let lo=Infinity, hi=-Infinity;
    for (let i=0;i<n;i++) {
      const v=a[i];
      if (f32 ? isNaN(v) : v<0) continue;
      if (v<lo) lo=v; if (v>hi) hi=v;
    }
    if (lo===Infinity) { histograms[k]=[]; fieldRanges[k]=[0,1]; continue; }
    fieldRanges[k]=[lo,hi];
    const sLo=log?Math.log10(Math.max(1,lo)):lo;
    const sHi=log?Math.log10(hi):hi;
    const span=sHi-sLo||1;
    const counts=new Array(BUCKETS).fill(0);
    for (let i=0;i<n;i++) {
      const v=a[i]; if (f32?isNaN(v):v<0) continue;
      const sv=log?Math.log10(Math.max(1,v)):v;
      counts[Math.min(BUCKETS-1,Math.floor((sv-sLo)/span*BUCKETS))]++;
    }
    const mx=Math.max(...counts);
    histograms[k]=counts.map(c=>mx>0?c/mx:0);
  }
  // value counts
  const counts={};
  for (const col of PILL_COLS) {
    const pool=pilPools[col], cat=pillCodes[col];
    counts[col]={};
    for (let i=0;i<n;i++) {
      const code=cat[i]; if (code===0) continue;
      const v=pool[code-1];
      counts[col][v]=(counts[col][v]||0)+1;
    }
  }
  counts.airing={
    Airing:   tarrays.airing.reduce((s,v)=>s+(v?1:0),0),
    Finished: tarrays.airing.reduce((s,v)=>s+(v?0:1),0),
  };
  for (const col of TAG_COLS) {
    counts[col]={};
    const pool=tagPools[col], cnt=tagData[col].cnt, flat=tagData[col].flat;
    let pos=0;
    for (let i=0;i<n;i++) {
      for (let j=0;j<cnt[i];j++) {
        const t=pool[flat[pos+j]];
        counts[col][t]=(counts[col][t]||0)+1;
      }
      pos+=cnt[i];
    }
  }
  return { histograms, fieldRanges, counts };
}

// ── binary block assembler ────────────────────────────────────────────────────
// All blocks are aligned to their element size to enable zero-copy TypedArray views
const blocks = [];
let byteOffset = 0;

function toBuffer(ta) {
  return Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);
}

function addBlock(name, typedArray) {
  const align  = typedArray.BYTES_PER_ELEMENT || 1;
  const pad    = (align - (byteOffset % align)) % align;
  byteOffset  += pad; // advance to aligned position
  const buf    = toBuffer(typedArray);
  blocks.push({ name, byteOffset, byteLength: buf.length, pad });
  byteOffset  += buf.length;
  return buf;
}

// ── main ──────────────────────────────────────────────────────────────────────
process.stdout.write('Building pools… ');
const pools = {};
for (const col of PILL_COLS) pools[col] = makePillPool(col);
for (const col of TAG_COLS)  pools[col] = makeTagPool(col);
console.log('done');

process.stdout.write('Building typed arrays… ');
const tarrays = {
  score:     pickF32('score'),
  scored_by: pickI32('scored_by'),
  rank:      pickI32('rank'),
  popularity:pickI32('popularity'),
  members:   pickI32('members'),
  favorites: pickI32('favorites'),
  episodes:  pickI32('episodes'),
  year:      pickI32('year'),
  mal_id:    pickI32('mal_id'),
  airing:    pickU8Bool('airing'),
};
console.log('done');

process.stdout.write('Encoding categoricals… ');
const pillCodes = {};
for (const col of PILL_COLS) pillCodes[col] = encodeCat(col, pools[col]);
console.log('done');

process.stdout.write('Encoding tags… ');
const tagData = {};
for (const col of TAG_COLS) tagData[col] = encodeTags(col, pools[col]);
console.log('done');

process.stdout.write('Encoding title strings… ');
const titleStr = encodeStrings('title');
console.log('done');

process.stdout.write('Building inverted indexes… ');
const pillIdxs = {};
for (const col of PILL_COLS) pillIdxs[col] = buildPillIdx(col, pools[col]);
pillIdxs.airing = buildAiringIdx();
const tagIdxs = {};
for (const col of TAG_COLS) tagIdxs[col] = buildTagIdx(col, pools[col]);
console.log('done');

process.stdout.write('Computing stats… ');
const stats = computeStats(tarrays, pillCodes, pools, tagData, pools);
console.log('done');

// Build opts for sidebar
const opts = {};
for (const col of PILL_COLS) opts[col] = pools[col];
for (const col of TAG_COLS)  opts[col] = pools[col];
opts.airing = ['Airing','Finished'];

// Assemble binary blocks
console.log('Assembling binary blocks…');
const dataBufs = [];

function reg(name, ta) { dataBufs.push(addBlock(name, ta)); }

// Numerics
reg('score',      tarrays.score);
reg('scored_by',  tarrays.scored_by);
reg('rank',       tarrays.rank);
reg('popularity', tarrays.popularity);
reg('members',    tarrays.members);
reg('favorites',  tarrays.favorites);
reg('episodes',   tarrays.episodes);
reg('year',       tarrays.year);
reg('mal_id',     tarrays.mal_id);
reg('airing',     tarrays.airing);
// Categorical codes
for (const col of PILL_COLS) reg(`${col}_cat`, pillCodes[col]);
// Tag data
for (const col of TAG_COLS) { reg(`${col}_cnt`, tagData[col].cnt); reg(`${col}_data`, tagData[col].flat); }
// Title
reg('title_off',  titleStr.offsets);
reg('title_utf8', titleStr.data);
// Pre-built indexes
for (const col of [...PILL_COLS,'airing']) {
  reg(`pidx_${col}_len`, pillIdxs[col].lengths);
  reg(`pidx_${col}_dat`, pillIdxs[col].data);
}
for (const col of TAG_COLS) {
  reg(`tidx_${col}_len`, tagIdxs[col].lengths);
  reg(`tidx_${col}_dat`, tagIdxs[col].data);
}

// Header JSON (includes everything worker needs: opts, stats, pools, block map)
const header = { n, opts, stats, pools, blocks };
const headerBuf  = Buffer.from(JSON.stringify(header), 'utf8');
const headerPad  = (4 - ((8 + headerBuf.length) % 4)) % 4; // align data to 4 bytes
const dataOffset = 8 + headerBuf.length + headerPad;

// Patch block byteOffsets to be absolute from start of file
for (const b of blocks) b.byteOffset += dataOffset;
// Re-serialize header with correct absolute offsets
const headerFinal = Buffer.from(JSON.stringify({ ...header, dataOffset, blocks }), 'utf8');
const headerLen   = Buffer.allocUnsafe(4);
headerLen.writeUInt32LE(headerFinal.length, 0);
const padBuf = Buffer.alloc((4 - ((8 + headerFinal.length) % 4)) % 4);

// Final binary
const combined = Buffer.concat([
  Buffer.from('ANI1'),
  headerLen,
  headerFinal,
  padBuf,
  ...dataBufs,
]);

console.log(`Raw binary: ${(combined.length/1024/1024).toFixed(1)}MB`);
console.log(`Header JSON: ${(headerFinal.length/1024).toFixed(0)}KB`);

const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } };

process.stdout.write('Compressing gzip… ');
const gz = zlib.gzipSync(combined, { level: 9 });
fs.writeFileSync('main.bin.gz', gz);
console.log(`${(gz.length/1024).toFixed(0)}KB`);

process.stdout.write('Compressing brotli… ');
const br = zlib.brotliCompressSync(combined, BROTLI);
fs.writeFileSync('main.bin.br', br);
console.log(`${(br.length/1024).toFixed(0)}KB`);

console.log('\nDone. Blocks:');
header.blocks.slice(0,6).forEach(b => console.log(`  ${b.name.padEnd(20)} ${(b.byteLength/1024).toFixed(1)}KB`));
console.log(`  ... and ${header.blocks.length-6} more`);
