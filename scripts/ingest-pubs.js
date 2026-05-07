// @ts-nocheck
/* global process, Buffer */
// scripts/ingest-pubs.js
// Phase 1, Step 9: Pull Coventry venues from Overpass and upsert into Supabase.
// Run with: node --env-file=.env scripts/ingest-pubs.js

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const COVENTRY_BBOX = {
  south: 52.3748,
  west: -1.5887,
  north: 52.4577,
  east: -1.4340,
};

const BATCH_SIZE = 50;
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'Pint-DataIngestion/0.1 (https://github.com/SukhrajD001/pint)';

// Tags that rescue a restaurant from the default-exclude rule
const RESCUE_SIGNALS = ['real_ale', 'microbrewery', 'bar'];

function buildQuery(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:25];
(
  nwr["amenity"="pub"](${b});
  nwr["amenity"="bar"](${b});
  nwr["amenity"="biergarten"](${b});
  nwr["amenity"="restaurant"](${b});
);
out center;
`;
}

async function queryOverpass(query) {
  const url = OVERPASS_ENDPOINT + '?data=' + encodeURIComponent(query);
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Overpass error ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

function classifyOutdoorSpace(tags = {}) {
  if (tags.beer_garden === 'yes') return 'confirmed_garden';
  if (tags.outdoor_seating === 'yes') return 'confirmed_seating';
  return 'unverified';
}

function getRestaurantRescueSignal(tags = {}) {
  for (const signal of RESCUE_SIGNALS) {
    if (tags[signal] === 'yes') return signal;
  }
  return null;
}

function validateAndMap(element, ingestedAt) {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  const tags = element.tags ?? {};

  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return {
    osm_id: `${element.type}/${element.id}`,
    osm_type: element.type,
    name: typeof tags.name === 'string' && tags.name.length > 0 ? tags.name : 'Unknown Pub',
    lat,
    lng,
    amenity: tags.amenity,
    outdoor_confidence: classifyOutdoorSpace(tags),
    excluded_from_main_view: false,
    osm_tags: tags,
    last_ingested_at: ingestedAt,
  };
}

async function upsertBatch(supabase, batch) {
  const { error } = await supabase
    .from('pubs')
    .upsert(batch, { onConflict: 'osm_id' });
  if (error) throw error;
}

async function main() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.VITE_SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('[ingest] Missing environment variables.');
    console.error('  VITE_SUPABASE_URL:', supabaseUrl ? '✅ set' : '❌ missing');
    console.error('  VITE_SUPABASE_SERVICE_KEY:', serviceKey ? '✅ set' : '❌ missing');
    process.exit(1);
  }

  // Decode the JWT role claim to confirm we have the service key, not the anon key.
  // The JWT payload is base64-encoded (not encrypted) so reading it is safe.
  try {
    const payload = JSON.parse(Buffer.from(serviceKey.split('.')[1], 'base64').toString('utf8'));
    const role = payload.role ?? 'unknown';
    if (role === 'service_role') {
      console.log('[ingest] Key type: service_role ✅');
    } else {
      console.error(`[ingest] Key type: ${role} ⚠️  — expected service_role. Check VITE_SUPABASE_SERVICE_KEY in .env (you may have pasted the anon key by mistake).`);
      process.exit(1);
    }
  } catch {
    console.error('[ingest] Could not decode key — is VITE_SUPABASE_SERVICE_KEY a valid JWT?');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const ingestedAt = new Date().toISOString();

  console.log('[ingest] Querying Overpass API for Coventry venues...');

  let elements;
  try {
    const data = await queryOverpass(buildQuery(COVENTRY_BBOX));
    elements = data.elements ?? [];
  } catch (err) {
    console.error('[ingest] Failed to fetch from Overpass:', err.message);
    process.exit(1);
  }

  console.log(`[ingest] Overpass returned ${elements.length} raw elements`);
  console.log('[ingest] Filtering and validating...\n');

  const toIngest = [];
  let skippedExplicitNo = 0;
  let skippedRestaurant = 0;
  let skippedNoCoords = 0;
  let rescueCount = 0;

  for (const el of elements) {
    const tags = el.tags ?? {};
    const amenity = tags.amenity;

    // Respect the explicit "no outdoor seating" tag from the venue owner
    if (tags.outdoor_seating === 'no') {
      skippedExplicitNo++;
      continue;
    }

    // Restaurants are excluded unless they carry a pub-like signal
    let rescueSignal = null;
    if (amenity === 'restaurant') {
      rescueSignal = getRestaurantRescueSignal(tags);
      if (!rescueSignal) {
        skippedRestaurant++;
        continue;
      }
    } else if (amenity !== 'pub' && amenity !== 'bar' && amenity !== 'biergarten') {
      continue;
    }

    const record = validateAndMap(el, ingestedAt);
    if (!record) {
      skippedNoCoords++;
      continue;
    }

    if (rescueSignal) {
      console.log(`[ingest] Restaurant rescued: "${record.name}" — signal: ${rescueSignal}=yes`);
      rescueCount++;
    }

    toIngest.push(record);
  }

  console.log('\n[ingest] Filter summary:');
  console.log(`  To ingest:                       ${toIngest.length}`);
  console.log(`  Skipped (outdoor_seating=no):    ${skippedExplicitNo}`);
  console.log(`  Skipped (restaurant, no rescue): ${skippedRestaurant}`);
  console.log(`  Skipped (no coordinates):        ${skippedNoCoords}`);
  console.log(`  Restaurant rescues:              ${rescueCount}`);

  if (toIngest.length === 0) {
    console.log('\n[ingest] Nothing to ingest. Exiting.');
    return;
  }

  const totalBatches = Math.ceil(toIngest.length / BATCH_SIZE);
  console.log(`\n[ingest] Upserting ${toIngest.length} records in ${totalBatches} batch(es)...`);

  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < toIngest.length; i += BATCH_SIZE) {
    const batch = toIngest.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      await upsertBatch(supabase, batch);
      upserted += batch.length;
      console.log(`[ingest] Batch ${batchNum}/${totalBatches} — upserted ${batch.length} records`);
    } catch (err) {
      failed += batch.length;
      console.error(`[ingest] Batch ${batchNum}/${totalBatches} failed:`, err.message);
    }
  }

  console.log('\n[ingest] Done.');
  console.log(`  Upserted: ${upserted}`);

  if (failed > 0) {
    console.error(`  Failed:   ${failed} (check logs above)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ingest] Unexpected error:', err.message);
  process.exit(1);
});
