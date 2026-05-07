// @ts-nocheck
/* global process, Buffer */
// scripts/ingest-buildings.js
// Phase 1, Step 10b: Pull building footprints near Coventry pubs from Overpass
// and upsert into Supabase.
// Run with: node --env-file=.env scripts/ingest-buildings.js

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const COVENTRY_BBOX = {
  south: 52.3748,
  west: -1.5887,
  north: 52.4577,
  east: -1.4340,
};

const BATCH_SIZE = 50;
const MAX_PUB_DISTANCE_M = 200;
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'Pint-DataIngestion/0.1 (https://github.com/SukhrajD001/pint)';

function buildQuery(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:60];
(
  way["building"](${b});
  relation["building"](${b});
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

function isNearAnyPub(centroidLat, centroidLng, pubs) {
  for (const pub of pubs) {
    if (haversineMetres(centroidLat, centroidLng, pub.lat, pub.lng) <= MAX_PUB_DISTANCE_M) {
      return true;
    }
  }
  return false;
}

// Returns [lon, lat] ring for ways directly, or from the first outer member for relations.
function extractRing(element) {
  if (element.type === 'way') {
    return element.geometry?.map(p => [p.lon, p.lat]) ?? null;
  }
  if (element.type === 'relation') {
    const outer = element.members?.find(m => m.type === 'way' && m.role === 'outer');
    return outer?.geometry?.map(p => [p.lon, p.lat]) ?? null;
  }
  return null;
}

function extractFootprint(element) {
  const ring = extractRing(element);
  // Need at least 3 unique vertices (4 points to include the closing coordinate)
  if (!ring || ring.length < 4) return null;

  // GeoJSON Polygon rings must be explicitly closed
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  return { type: 'Polygon', coordinates: [ring] };
}

// Vertex arithmetic mean — sufficient for proximity filtering and Phase 2 shadow projection
function computeCentroid(ring) {
  let sumLat = 0;
  let sumLon = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  const n = ring.length;
  return { lat: sumLat / n, lng: sumLon / n };
}

function extractHeight(tags = {}) {
  // "height" tag is already in metres; parseFloat handles "12 m" → 12 gracefully
  if (tags.height !== undefined) {
    const h = parseFloat(tags.height);
    if (isFinite(h) && h > 0) return { height_m: h, height_source: 'osm' };
  }

  // "building:levels" → floors × 3.5m per floor
  if (tags['building:levels'] !== undefined) {
    const levels = parseFloat(tags['building:levels']);
    if (isFinite(levels) && levels > 0) return { height_m: levels * 3.5, height_source: 'osm' };
  }

  return { height_m: 7.0, height_source: 'default' };
}

function validateAndMap(element, ingestedAt) {
  const footprint = extractFootprint(element);
  if (!footprint) return null;

  const centroid = computeCentroid(footprint.coordinates[0]);
  if (!isFinite(centroid.lat) || !isFinite(centroid.lng)) return null;

  const tags = element.tags ?? {};
  const { height_m, height_source } = extractHeight(tags);

  return {
    osm_id: `${element.type}/${element.id}`,
    osm_type: element.type,
    footprint,
    height_m,
    height_source,
    last_ingested_at: ingestedAt,
    // _centroid is used for proximity filtering only — stripped before upsert
    _centroid: centroid,
  };
}

async function upsertBatch(supabase, batch) {
  const { error } = await supabase
    .from('buildings')
    .upsert(batch, { onConflict: 'osm_id' });
  if (error) throw error;
}

async function main() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.VITE_SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('[ingest-buildings] Missing environment variables.');
    console.error('  VITE_SUPABASE_URL:', supabaseUrl ? '✅ set' : '❌ missing');
    console.error('  VITE_SUPABASE_SERVICE_KEY:', serviceKey ? '✅ set' : '❌ missing');
    process.exit(1);
  }

  try {
    const payload = JSON.parse(Buffer.from(serviceKey.split('.')[1], 'base64').toString('utf8'));
    const role = payload.role ?? 'unknown';
    if (role === 'service_role') {
      console.log('[ingest-buildings] Key type: service_role ✅');
    } else {
      console.error(`[ingest-buildings] Key type: ${role} ⚠️  — expected service_role. Check VITE_SUPABASE_SERVICE_KEY in .env.`);
      process.exit(1);
    }
  } catch {
    console.error('[ingest-buildings] Could not decode key — is VITE_SUPABASE_SERVICE_KEY a valid JWT?');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const ingestedAt = new Date().toISOString();

  // Load all pub coordinates for proximity filtering
  console.log('[ingest-buildings] Loading pubs from Supabase...');
  const { data: pubs, error: pubsError } = await supabase
    .from('pubs')
    .select('lat, lng');
  if (pubsError) {
    console.error('[ingest-buildings] Failed to load pubs:', pubsError.message);
    process.exit(1);
  }
  console.log(`[ingest-buildings] Loaded ${pubs.length} pubs for proximity filtering`);

  // Query Overpass — buildings are a large dataset, allow up to 60s
  console.log('[ingest-buildings] Querying Overpass API for Coventry buildings...');
  console.log('  (this may take up to 60 seconds)\n');

  let elements;
  try {
    const data = await queryOverpass(buildQuery(COVENTRY_BBOX));
    elements = data.elements ?? [];
  } catch (err) {
    console.error('[ingest-buildings] Failed to fetch from Overpass:', err.message);
    process.exit(1);
  }

  console.log(`[ingest-buildings] Overpass returned ${elements.length} raw building elements`);
  console.log('[ingest-buildings] Filtering and mapping...\n');

  const toIngest = [];
  let skippedNoGeometry = 0;
  let skippedTooFar = 0;
  let heightFromOsm = 0;
  let heightDefaulted = 0;

  for (const el of elements) {
    const record = validateAndMap(el, ingestedAt);
    if (!record) {
      skippedNoGeometry++;
      continue;
    }

    if (!isNearAnyPub(record._centroid.lat, record._centroid.lng, pubs)) {
      skippedTooFar++;
      continue;
    }

    if (record.height_source === 'osm') heightFromOsm++;
    else heightDefaulted++;

    // Strip the centroid helper before inserting — it is not a DB column
    const { _centroid, ...dbRecord } = record;
    toIngest.push(dbRecord);
  }

  console.log('[ingest-buildings] Filter summary:');
  console.log(`  To ingest:                  ${toIngest.length}`);
  console.log(`  Skipped (no geometry):      ${skippedNoGeometry}`);
  console.log(`  Skipped (>200m from a pub): ${skippedTooFar}`);
  console.log(`  Height from OSM tags:       ${heightFromOsm}`);
  console.log(`  Height defaulted to 7m:     ${heightDefaulted}`);

  if (toIngest.length === 0) {
    console.log('\n[ingest-buildings] Nothing to ingest. Exiting.');
    return;
  }

  const totalBatches = Math.ceil(toIngest.length / BATCH_SIZE);
  console.log(`\n[ingest-buildings] Upserting ${toIngest.length} records in ${totalBatches} batch(es)...`);

  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < toIngest.length; i += BATCH_SIZE) {
    const batch = toIngest.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      await upsertBatch(supabase, batch);
      upserted += batch.length;
      console.log(`[ingest-buildings] Batch ${batchNum}/${totalBatches} — upserted ${batch.length} records`);
    } catch (err) {
      failed += batch.length;
      console.error(`[ingest-buildings] Batch ${batchNum}/${totalBatches} failed:`, err.message);
    }
  }

  console.log('\n[ingest-buildings] Done.');
  console.log(`  Upserted: ${upserted}`);

  if (failed > 0) {
    console.error(`  Failed:   ${failed} (check logs above)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ingest-buildings] Unexpected error:', err.message);
  process.exit(1);
});
