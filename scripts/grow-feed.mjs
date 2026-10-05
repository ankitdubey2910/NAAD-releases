// Weekly feed grower for NAAD: adds fresh Creative-Commons tracks from Jamendo (Indian +
// devotional tags) to catalog/feed.json. Only tracks the Jamendo API itself reports as
// streamable are added. Never touches hand-curated entries; old auto-added ones are
// trimmed once the cap is reached.
//   node grow-feed.mjs [path/to/feed.json] [maxNew]
import { readFileSync, writeFileSync } from 'node:fs';

const FEED = process.argv[2] || 'catalog/feed.json';
const MAX_NEW = Number(process.argv[3]) || 40;
const CAP_AUTO = 600; // auto-added tracks kept in the feed
const CLIENT_ID = '101eed8d'; // Jamendo public client id (same one the app uses)

// tag -> how the app should file it
const PLAN = [
  { tag: 'bhajan', tags: ['bhajan'], lang: 'hi', deity: 'general' },
  { tag: 'mantra', tags: ['mantra'], lang: 'sa', deity: 'general' },
  { tag: 'sitar', tags: ['instrumental'], lang: 'en', deity: 'general' },
  { tag: 'bansuri', tags: ['instrumental'], lang: 'en', deity: 'general' },
  { tag: 'raga', tags: ['instrumental'], lang: 'en', deity: 'general' },
  { tag: 'sufi', tags: [], lang: 'hi', deity: 'general' },
  { tag: 'bollywood', tags: [], lang: 'hi', deity: 'general' },
  { tag: 'hindi', tags: [], lang: 'hi', deity: 'general' },
  { tag: 'indian', tags: [], lang: 'hi', deity: 'general' },
];

const feed = JSON.parse(readFileSync(FEED, 'utf8'));
const have = new Set(feed.tracks.map((t) => String(t.id).replace(/^feed-/, '')));

const art = (u) =>
  u && /usercontent\.jamendo\.com/.test(u) && !/[?&]width=/.test(u) ? `${u}${u.includes('?') ? '&' : '?'}width=400` : u;

async function jamendo(tag, order) {
  const qs = new URLSearchParams({
    client_id: CLIENT_ID,
    format: 'json',
    fuzzytags: tag,
    order,
    limit: '30',
    audioformat: 'mp32',
    include: 'musicinfo',
  });
  const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?${qs}`);
  if (!r.ok) throw new Error(`Jamendo ${tag} HTTP ${r.status}`);
  return (await r.json()).results ?? [];
}

const added = [];
for (const p of PLAN) {
  if (added.length >= MAX_NEW) break;
  for (const order of ['releasedate_desc', 'popularity_month']) {
    let rows = [];
    try {
      rows = await jamendo(p.tag, order);
    } catch (e) {
      console.warn(String(e));
      continue;
    }
    for (const t of rows) {
      const id = `jam-${t.id}`;
      if (!t.audio) continue;
      if (have.has(id) || added.length >= MAX_NEW) continue;
      if ((t.duration || 0) < 45) continue; // skip stingers/loops
      have.add(id);
      added.push({
        id,
        title: String(t.name).slice(0, 120),
        artist: String(t.artist_name || 'Unknown').slice(0, 80),
        url: `https://prod-1.storage.jamendo.com/?trackid=${t.id}&format=mp32&from=app-${CLIENT_ID}`,
        duration: Math.round(t.duration || 0),
        deity: p.deity,
        lang: p.lang,
        tags: p.tags,
        album: t.album_name || undefined,
        genre: t.musicinfo?.tags?.genres?.[0] || p.tag,
        image: art(t.album_image || t.image) || undefined,
        source: 'Jamendo',
        itemId: String(t.id),
        license: 'Creative Commons',
      });
    }
  }
}

feed.tracks.push(...added);
// Trim the oldest auto-added tracks beyond the cap (hand-curated ones are never removed).
const auto = feed.tracks.filter((t) => String(t.id).startsWith('jam-'));
if (auto.length > CAP_AUTO) {
  const drop = new Set(auto.slice(0, auto.length - CAP_AUTO).map((t) => t.id));
  feed.tracks = feed.tracks.filter((t) => !drop.has(t.id));
  feed.removed = [...new Set([...(feed.removed || []), ...[...drop].map((d) => `feed-${d}`)])];
}
if (added.length) {
  feed.version = (Number(feed.version) || 1) + 1;
  feed.updatedAt = new Date().toISOString();
  writeFileSync(FEED, JSON.stringify(feed, null, 2) + '\n');
}
console.log(`added ${added.length}, total ${feed.tracks.length}`);
