// Harvest licensed (CC / public-domain) devotional audio from the Internet Archive into the NAAD feed.
//   node harvest-archive.mjs feed.json [maxNew]
// Only items that carry an explicit licenseurl are considered; every mp3 is checked with GET+Range.
import { readFileSync, writeFileSync } from 'node:fs';

const FEED = process.argv[2] || 'feed.json';
const MAX_NEW = Number(process.argv[3]) || 400;

const QUERIES = [
  'aarti', 'chalisa', 'stotram', 'stotra', 'bhajan', 'bhajans', 'mantra', 'mantras', 'kirtan', 'dhun',
  'hanuman', 'shiv', 'shiva', 'ganesh', 'ganpati', 'durga', 'devi', 'krishna', 'ram', 'vishnu', 'lakshmi',
  'sai baba', 'gayatri', 'om namah shivaya', 'sundarkand', 'vishnu sahasranama', 'lalita', 'suprabhatam',
  'abhang', 'bhakti', 'devotional hindi', 'sanskrit chant', 'vedic chanting', 'shabad', 'gurbani', 'sukhmani',
];

const feed = JSON.parse(readFileSync(FEED, 'utf8'));
const haveItem = new Set(feed.tracks.map((t) => t.itemId).filter(Boolean));
const haveUrl = new Set(feed.tracks.map((t) => t.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(1500 * (i + 1));
  }
  return null;
}

const kinds = [
  [/aarti|arti|आरती/i, 'aarti'],
  [/chalisa|चालीसा/i, 'chalisa'],
  [/stotram|stotra|stotr|sahasranam|kavach|ashtak|suprabhat|lalita|stuti/i, 'stotram'],
  [/mantra|chant|gayatri|om |jaap|japa|shloka|veda|vedic/i, 'mantra'],
  [/dhun|dhoon|kirtan|naam|jaap/i, 'dhun'],
  [/katha|pravachan|ramayan|bhagwat|gita|puran|sundarkand|sunderkand/i, 'katha'],
  [/bhajan|bhakti|devotional|abhang|shabad|gurbani/i, 'bhajan'],
];
const deities = [
  [/hanuman|bajrang|sundar|sunder/i, 'vishnu'],
  [/ram(?!\w)|sita|krishna|govind|hari|vishnu|narayan|lakshmi|venkatesh|balaji|vithal/i, 'vishnu'],
  [/shiv|shankar|mahadev|rudra|bholenath|om namah/i, 'mahadev'],
  [/ganesh|ganpati|gajanan|vinayak/i, 'ganesh'],
  [/durga|devi|ambe|amba|kali|mata|maa |sherawali|navratri|saraswati/i, 'devi'],
];
// A track is kept only if its title/album/subject clearly says it is devotional; this removes
// field recordings, radio shows, library audio and other things that merely mention a keyword.
const DEVO = /(aarti|aarati|\barti\b|chalisa|stotra|stotram|mantra|bhajan|kirtan|dhun\b|dhoon|bhakti|hanuman|ganesh|ganpati|\bshiv|shankar|durga|laxmi|lakshmi|krishna|govind|radha|sai baba|gayatri|sundar ?kand|sunderkand|sahasranam|suprabhat|abhang|shabad|gurbani|chanting|vedic|santoshi|vishnu|\bdevi\b|\bmata\b|\bmaa\b|jagdamba|ambe|ramayan|bhagwat|gita|japa|jaap|om namah|narayan|venkatesh|balaji|vitthal|tulsi|meera|surdas|kabir bhajan)/i;
const JUNK = /(field recording|framework|kansas|initiation|folk instrument|ghoomar|podcast|interview|lecture|sermon|radio show|test|sample)/i;
const GENERIC = /^(avseq|track|side|rs-|skss|audio|untitled|\d+$|[a-z]{0,4}\d{1,3}$)/i;
const pick = (arr, text, dflt) => (arr.find(([re]) => re.test(text)) || [, dflt])[1];

const secs = (v) => {
  if (!v) return 0;
  if (String(v).includes(':')) return String(v).split(':').reduce((a, p) => a * 60 + (Number(p) || 0), 0);
  return Math.round(Number(v) || 0);
};

async function verify(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
    return r.status === 200 || r.status === 206;
  } catch {
    return false;
  }
}

const candidates = new Map();
for (const q of QUERIES) {
  const expr = `(${q.includes(' ') ? `"${q}"` : q}) AND mediatype:audio AND licenseurl:*`;
  const u =
    'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(expr) +
    '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=60&output=json&sort[]=downloads+desc';
  const j = await getJson(u);
  for (const d of j?.response?.docs ?? []) {
    if (!haveItem.has(d.identifier) && !candidates.has(d.identifier)) candidates.set(d.identifier, d);
  }
  await sleep(400);
}
console.log('candidate items:', candidates.size);

const added = [];
for (const [id, d] of candidates) {
  if (added.length >= MAX_NEW) break;
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  await sleep(300);
  if (!meta?.files) continue;
  const lic = meta.metadata?.licenseurl || d.licenseurl;
  if (!lic) continue;
  const mp3s = meta.files.filter((f) => /\.mp3$/i.test(f.name) && !/sample|preview|_64kb/i.test(f.name));
  // one item can hold an album: take up to 6 tracks
  for (const f of mp3s.slice(0, 6)) {
    if (added.length >= MAX_NEW) break;
    const url = `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(f.name)}`;
    if (haveUrl.has(url)) continue;
    const dur = secs(f.length);
    if (dur && dur < 30) continue;
    if (!(await verify(url))) continue;
    let base = f.title || f.name.replace(/\.mp3$/i, '').replace(/^\d+[\s._-]*/, '');
    const albumT = String(meta.metadata?.title ?? '');
    if (GENERIC.test(base.trim()) || base.trim().length < 3) base = `${albumT} (${mp3s.indexOf(f) + 1})`;
    const text = `${base} ${albumT} ${Array.isArray(meta.metadata?.subject) ? meta.metadata.subject.join(' ') : meta.metadata?.subject ?? ''}`;
    if (!DEVO.test(`${base} ${albumT}`) || JUNK.test(text)) continue;
    const kind = kinds.find(([re]) => re.test(base))?.[1] ?? pick(kinds, albumT, 'bhajan');
    const artist = Array.isArray(meta.metadata?.creator) ? meta.metadata.creator[0] : meta.metadata?.creator;
    haveUrl.add(url);
    added.push({
      id: `ia-${id}-${added.length}`.slice(0, 90),
      title: String(base).slice(0, 110),
      artist: String(artist || 'Traditional').slice(0, 70),
      url,
      duration: dur,
      deity: pick(deities, text, 'general'),
      lang: /sanskrit|mantra|stotr|veda/i.test(text) ? 'sa' : 'hi',
      tags: [kind],
      album: String(meta.metadata?.title ?? '').slice(0, 80) || undefined,
      source: 'Internet Archive',
      itemId: id,
      license: lic.includes('publicdomain') ? 'Public domain' : 'Creative Commons',
    });
  }
}

feed.tracks.push(...added);
if (added.length) {
  feed.version = (Number(feed.version) || 1) + 1;
  feed.updatedAt = new Date().toISOString();
  writeFileSync(FEED, JSON.stringify(feed, null, 2) + '\n');
}
const byTag = {};
for (const t of added) byTag[t.tags[0]] = (byTag[t.tags[0]] || 0) + 1;
console.log(`added ${added.length}`, byTag, `feed total ${feed.tracks.length}`);
