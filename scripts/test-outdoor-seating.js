/* global process */
// scripts/test-outdoor-seating.js
// Phase 1, Step 10a — diagnostic for leisure=outdoor_seating coverage in Coventry.
// Tells us how many outdoor_seating polygons exist and how many are
// within 30m of a pub — this determines if Priority 1 of the garden
// location cascade will catch anything real.
//
// Run with: node scripts/test-outdoor-seating.js

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';

const COVENTRY_BBOX = {
  south: 52.3748,
  west: -1.5887,
  north: 52.4577,
  east: -1.4340,
};

const PROXIMITY_METRES = 30;

// Haversine distance between two lat/lng points
function distanceMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Calculate centroid of a polygon (simple average of vertices)
function polygonCentroid(coords) {
  let sumLat = 0;
  let sumLon = 0;
  for (const [lon, lat] of coords) {
    sumLat += lat;
    sumLon += lon;
  }
  return { lat: sumLat / coords.length, lon: sumLon / coords.length };
}

async function queryOverpass(query) {
  const url =
    'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Pint-DataIngestion/0.1 (https://github.com/SukhrajD001/pint)',
    },
  });
  if (!response.ok) {
    throw new Error(`Overpass error: ${response.status}`);
  }
  return response.json();
}

async function run() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing env vars');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('\n📐 Outdoor Seating Diagnostic — Coventry\n');

  // Step 1: Query Overpass for outdoor_seating polygons
  console.log('1. Querying Overpass for leisure=outdoor_seating areas...');

  const bbox = `${COVENTRY_BBOX.south},${COVENTRY_BBOX.west},${COVENTRY_BBOX.north},${COVENTRY_BBOX.east}`;
  const query = `
    [out:json][timeout:25];
    (
      node["leisure"="outdoor_seating"](${bbox});
      way["leisure"="outdoor_seating"](${bbox});
      relation["leisure"="outdoor_seating"](${bbox});
    );
    out geom;
  `;

  const data = await queryOverpass(query);
  const elements = data.elements ?? [];

  console.log(`   Total outdoor_seating elements: ${elements.length}`);

  const byType = { node: 0, way: 0, relation: 0 };
  for (const el of elements) {
    if (byType[el.type] !== undefined) byType[el.type]++;
  }
  console.log(
    `   Types — nodes: ${byType.node}, ways: ${byType.way}, relations: ${byType.relation}\n`,
  );

  if (elements.length === 0) {
    console.log('⚠️  Zero outdoor_seating elements found in Coventry.');
    console.log(
      '   Priority 1 of the garden location cascade will catch nothing locally.',
    );
    console.log(
      '   The heuristic and pub-centroid fallbacks will do all the work.',
    );
    console.log(
      '   Worth keeping the code path though — coverage may be better in other UK cities.\n',
    );
    return;
  }

  // Step 2: Get pub locations from Supabase
  console.log('2. Fetching pubs from Supabase...');
  const { data: pubs, error } = await supabase
    .from('pubs')
    .select('id, name, lat, lng, osm_id');

  if (error) {
    console.error('Failed to fetch pubs:', error.message);
    process.exit(1);
  }
  console.log(`   ${pubs.length} pubs loaded\n`);

  // Step 3: For each outdoor_seating element, find nearest pub
  console.log(
    `3. Checking proximity (within ${PROXIMITY_METRES}m of any pub)...`,
  );

  let withinRange = 0;
  const matches = [];

  for (const el of elements) {
    let centre;
    if (el.type === 'node') {
      centre = { lat: el.lat, lon: el.lon };
    } else if (el.geometry) {
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      centre = polygonCentroid(coords);
    } else {
      continue; // No geometry available
    }

    let nearestPub = null;
    let nearestDist = Infinity;

    for (const pub of pubs) {
      const dist = distanceMetres(centre.lat, centre.lon, pub.lat, pub.lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestPub = pub;
      }
    }

    if (nearestDist <= PROXIMITY_METRES) {
      withinRange++;
      matches.push({
        outdoor_seating_id: `${el.type}/${el.id}`,
        outdoor_seating_name: el.tags?.name ?? null,
        nearest_pub_name: nearestPub.name,
        nearest_pub_osm_id: nearestPub.osm_id,
        distance_m: Math.round(nearestDist),
      });
    }
  }

  console.log(
    `   ${withinRange} of ${elements.length} outdoor_seating areas within ${PROXIMITY_METRES}m of a pub\n`,
  );

  if (matches.length > 0) {
    console.log('   Sample matches:');
    matches.slice(0, 10).forEach((m) => {
      console.log(`     • ${m.nearest_pub_name} ← ${m.outdoor_seating_id} (${m.distance_m}m)`);
    });
  }

  await writeFile(
    'scripts/coventry-outdoor-seating-diagnostic.json',
    JSON.stringify({ summary: { total: elements.length, withinRange }, matches }, null, 2),
  );
  console.log('\n💾 Saved results to scripts/coventry-outdoor-seating-diagnostic.json');
  console.log('\n✅ Diagnostic complete.\n');
}

run().catch((err) => {
  console.error('Diagnostic failed:', err.message);
  process.exit(1);
});