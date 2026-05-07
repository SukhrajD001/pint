// @ts-nocheck
/* global process, Buffer */
// scripts/ingest-roads.js
// Phase 1, Step 10c: Pull road geometries near Coventry pubs from Overpass
// and upsert into Supabase.
// Run with: node --env-file=.env scripts/ingest-roads.js

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const COVENTRY_BBOX = {
  south: 52.3748,
  west: -1.5887,
  north: 52.4577,
  east: -1.4340,
};

const BATCH_SIZE = 50;
const MAX_PUB_DISTANCE_M = 100;
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'Pint-DataIngestion/0.1 (https://github.com/SukhrajD001/pint)';

// Only road types that could be a pub's street — excludes motorways, footpaths, etc.
const HIGHWAY_TYPES = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street'];

function buildQuery(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const filter = HIGHWAY_TYPES.join('|');
  return `
[out:json][timeout:45];
(
  way["highway"~"^(${filter})$"](${b});
);
out geom;
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

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Checks every geometry point against every pub — short-circuits on first hit.
// Centroid alone would miss roads where only one end passes near a pub.
function isNearAnyPub(coordinates, pubs) {
  for (const [lon, lat] of coordinates) {
    for (const pub of pubs) {
      if (haversineMetres(lat, lon, pub.lat, pub.lng) <= MAX_PUB_DISTANCE_M) {
        return true;
      }
    }
  }
  return false;
}

function extractGeometry(element) {
  const geom = element.geometry;
  if (!geom || geom.length < 2) return null;
  return {
    type: 'LineString',
    coordinates: geom.map(p => [p.lon, p.lat]),
  };
}

function validateAndMap(element, ingestedAt) {
  const geometry = extractGeometry(element);
  if (!geometry) return null;

  const tags = element.tags ?? {};
  return {
    osm_id: `way/${element.id}`,
    geometry,
    highway_type: tags.highway ?? null,
    name: typeof tags.name === 'string' && tags.name.length > 0 ? tags.name : null,
    last_ingested_at: ingestedAt,
  };
}

async function upsertBatch(supabase, batch) {
  const { error } = await supabase
    .from('roads')
    .upsert(batch, { onConflict: 'osm_id' });
  if (error) throw error;
}

async function main() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.VITE_SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('[ingest-roads] Missing environment variables.');
    console.error('  VITE_SUPABASE_URL:', supabaseUrl ? '✅ set' : '❌ missing');
    console.error('  VITE_SUPABASE_SERVICE_KEY:', serviceKey ? '✅ set' : '❌ missing');
    process.exit(1);
  }

  try {
    const payload = JSON.parse(Buffer.from(serviceKey.split('.')[1], 'base64').toString('utf8'));
    const role = payload.role ?? 'unknown';
    if (role === 'service_role') {
      console.log('[ingest-roads] Key type: service_role ✅');
    } else {
      console.error(`[ingest-roads] Key type: ${role} ⚠️  — expected service_role. Check VITE_SUPABASE_SERVICE_KEY in .env.`);
      process.exit(1);
    }
  } catch {
    console.error('[ingest-roads] Could not decode key — is VITE_SUPABASE_SERVICE_KEY a valid JWT?');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const ingestedAt = new Date().toISOString();

  // Load all pub coordinates for proximity filtering
  console.log('[ingest-roads] Loading pubs from Supabase...');
  const { data: pubs, error: pubsError } = await supabase
    .from('pubs')
    .select('lat, lng');
  if (pubsError) {
    console.error('[ingest-roads] Failed to load pubs:', pubsError.message);
    process.exit(1);
  }
  console.log(`[ingest-roads] Loaded ${pubs.length} pubs for proximity filtering`);

  // Query Overpass for road types relevant to garden location heuristic
  console.log('[ingest-roads] Querying Overpass API for Coventry roads...');
  console.log(`  Highway types: ${HIGHWAY_TYPES.join(', ')}\n`);

  let elements;
  try {
    const data = await queryOverpass(buildQuery(COVENTRY_BBOX));
    elements = data.elements ?? [];
  } catch (err) {
    console.error('[ingest-roads] Failed to fetch from Overpass:', err.message);
    process.exit(1);
  }

  console.log(`[ingest-roads] Overpass returned ${elements.length} raw road elements`);
  console.log('[ingest-roads] Filtering and mapping...\n');

  const toIngest = [];
  let skippedNoGeometry = 0;
  let skippedTooFar = 0;

  for (const el of elements) {
    const record = validateAndMap(el, ingestedAt);
    if (!record) {
      skippedNoGeometry++;
      continue;
    }

    if (!isNearAnyPub(record.geometry.coordinates, pubs)) {
      skippedTooFar++;
      continue;
    }

    toIngest.push(record);
  }

  console.log('[ingest-roads] Filter summary:');
  console.log(`  To ingest:                  ${toIngest.length}`);
  console.log(`  Skipped (no geometry):      ${skippedNoGeometry}`);
  console.log(`  Skipped (>100m from a pub): ${skippedTooFar}`);

  if (toIngest.length === 0) {
    console.log('\n[ingest-roads] Nothing to ingest. Exiting.');
    return;
  }

  const totalBatches = Math.ceil(toIngest.length / BATCH_SIZE);
  console.log(`\n[ingest-roads] Upserting ${toIngest.length} records in ${totalBatches} batch(es)...`);

  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < toIngest.length; i += BATCH_SIZE) {
    const batch = toIngest.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      await upsertBatch(supabase, batch);
      upserted += batch.length;
      console.log(`[ingest-roads] Batch ${batchNum}/${totalBatches} — upserted ${batch.length} records`);
    } catch (err) {
      failed += batch.length;
      console.error(`[ingest-roads] Batch ${batchNum}/${totalBatches} failed:`, err.message);
    }
  }

  console.log('\n[ingest-roads] Done.');
  console.log(`  Upserted: ${upserted}`);

  if (failed > 0) {
    console.error(`  Failed:   ${failed} (check logs above)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ingest-roads] Unexpected error:', err.message);
  process.exit(1);
});
