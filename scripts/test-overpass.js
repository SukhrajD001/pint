// scripts/test-overpass.js
// One-off script to test Overpass API and assess venue data quality for Coventry.
// Run with: node scripts/test-overpass.js
// Saves raw results to scripts/coventry-venues-raw.json so we don't
// have to re-query Overpass when inspecting later.

import { writeFile } from 'node:fs/promises';
import fetch from 'node-fetch';

const COVENTRY_BBOX = {
  south: 52.3748,
  west: -1.5887,
  north: 52.4577,
  east: -1.4340,
};

const bboxStr = `${COVENTRY_BBOX.south},${COVENTRY_BBOX.west},${COVENTRY_BBOX.north},${COVENTRY_BBOX.east}`;

// Pull all venue types where outdoor seating is plausible.
// We include nodes, ways, AND relations (nwr) to catch all OSM mapping styles.
// We do NOT filter on outdoor_seating in the query — we filter in code so we
// can flag tier of confidence (confirmed / unverified / explicit no).
const query = `
[out:json][timeout:25];
(
  nwr["amenity"="pub"](${bboxStr});
  nwr["amenity"="bar"](${bboxStr});
  nwr["amenity"="biergarten"](${bboxStr});
  nwr["amenity"="restaurant"](${bboxStr});
);
out center;
`;

// Confidence tiers for outdoor space.
function classifyOutdoorSpace(tags = {}) {
  if (tags.outdoor_seating === 'no') return 'excluded';
  if (tags.beer_garden === 'yes') return 'confirmed_garden';
  if (tags.outdoor_seating === 'yes') return 'confirmed_seating';
  return 'unverified';
}

async function queryOverpass(overpassQuery) {
  const endpoint = 'https://overpass-api.de/api/interpreter';
  const userAgent = 'Pint-DataIngestion/0.1 (https://github.com/SukhrajD001/pint)';

  // GET is preferred for read queries — semantically correct, cacheable,
  // works reliably with Overpass's Apache front-end.
  // If a future query exceeds ~8KB encoded, switch to POST inside this function
  // and the rest of the script doesn't need to change.
  const url = endpoint + '?data=' + encodeURIComponent(overpassQuery);

  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Status:', response.status, response.statusText);
    console.error('Response body:', errorBody.slice(0, 500));
    throw new Error('Overpass rejected the request');
  }

  return response.json();
}

async function fetchVenues() {
  console.log('Querying Overpass API for Coventry venues...\n');

  const data = await queryOverpass(query);
  const elements = data.elements ?? [];

  console.log(`Total raw results: ${elements.length}\n`);

  // Counters
  const byAmenity = { pub: 0, bar: 0, biergarten: 0, restaurant: 0 };
  const byTier = {
    confirmed_garden: 0,
    confirmed_seating: 0,
    unverified: 0,
    excluded: 0,
  };
  const byType = { node: 0, way: 0, relation: 0 };
  let withName = 0;
  let withCoords = 0;

  elements.forEach((el) => {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tier = classifyOutdoorSpace(el.tags);
    const amenity = el.tags?.amenity;

    if (lat && lon) withCoords++;
    if (el.tags?.name) withName++;
    if (byAmenity[amenity] !== undefined) byAmenity[amenity]++;
    if (byTier[tier] !== undefined) byTier[tier]++;
    if (byType[el.type] !== undefined) byType[el.type]++;
  });

  const includedCount = elements.length - byTier.excluded;

  console.log('Breakdown by venue type:');
  console.log(`  pubs:        ${byAmenity.pub}`);
  console.log(`  bars:        ${byAmenity.bar}`);
  console.log(`  biergartens: ${byAmenity.biergarten}`);
  console.log(`  restaurants: ${byAmenity.restaurant}`);

  console.log('\nBreakdown by outdoor confidence tier:');
  console.log(`  confirmed_garden  (beer_garden=yes):     ${byTier.confirmed_garden}`);
  console.log(`  confirmed_seating (outdoor_seating=yes): ${byTier.confirmed_seating}`);
  console.log(`  unverified        (no tag set):          ${byTier.unverified}`);
  console.log(`  excluded          (outdoor_seating=no):  ${byTier.excluded}`);

  console.log('\nBreakdown by OSM element type:');
  console.log(`  nodes:     ${byType.node}`);
  console.log(`  ways:      ${byType.way}`);
  console.log(`  relations: ${byType.relation}`);

  console.log('\nData quality:');
  console.log(`  With coordinates: ${withCoords}/${elements.length}`);
  console.log(`  With name:        ${withName}/${elements.length}`);
  console.log(`  Total to ingest:  ${includedCount} (excluding outdoor_seating=no)`);

  // Sample 2 from each confidence tier so we can eyeball the data
  console.log('\n--- Samples by tier ---');
  ['confirmed_garden', 'confirmed_seating', 'unverified'].forEach((tier) => {
    const samples = elements
      .filter((el) => classifyOutdoorSpace(el.tags) === tier)
      .slice(0, 2);
    console.log(`\n[${tier}]`);
    if (samples.length === 0) {
      console.log('  (none)');
      return;
    }
    samples.forEach((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      console.log(`  • ${el.tags?.name || 'UNNAMED'} (${el.tags?.amenity}, ${el.type})`);
      console.log(`    lat ${lat}, lon ${lon}`);
      console.log(`    tags: ${JSON.stringify(el.tags)}`);
    });
  });

  await writeFile(
    'scripts/coventry-venues-raw.json',
    JSON.stringify(data, null, 2),
    'utf8',
  );
  console.log('\n💾 Saved raw response to scripts/coventry-venues-raw.json');
}

fetchVenues().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});