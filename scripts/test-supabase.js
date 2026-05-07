// @ts-nocheck
/* global process */
// scripts/test-supabase.js
// One-off connection test for Step 8 of Phase 1.
// Verifies that environment variables are loaded correctly and that
// we can read from the Supabase pubs table.
// Run with: node --env-file=.env scripts/test-supabase.js

import { createClient } from '@supabase/supabase-js';

// Read environment variables
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

// Validate environment variables are present before doing anything
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing environment variables.');
  console.error('VITE_SUPABASE_URL:', supabaseUrl ? '✅ set' : '❌ missing');
  console.error('VITE_SUPABASE_ANON_KEY:', supabaseAnonKey ? '✅ set' : '❌ missing');
  console.error('Make sure .env exists and has both values filled in.');
  process.exit(1);
}

console.log('Environment variables loaded:');
console.log('  VITE_SUPABASE_URL:', supabaseUrl);
console.log('  VITE_SUPABASE_ANON_KEY:', supabaseAnonKey.slice(0, 20) + '...');

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testConnection() {
  console.log('\nTesting connection to Supabase...\n');

  // Test 1: Read from pubs table
  const { data: pubs, error: pubsError } = await supabase
    .from('pubs')
    .select('*')
    .limit(1);

  if (pubsError) {
    console.error('❌ pubs table read failed:', pubsError.message);
    process.exit(1);
  }
  console.log('✅ pubs table — readable. Rows:', pubs.length, '(expected 0 — table is empty)');

  // Test 2: Read from buildings table
  const { data: buildings, error: buildingsError } = await supabase
    .from('buildings')
    .select('*')
    .limit(1);

  if (buildingsError) {
    console.error('❌ buildings table read failed:', buildingsError.message);
    process.exit(1);
  }
  console.log('✅ buildings table — readable. Rows:', buildings.length, '(expected 0 — table is empty)');

  // Test 3: Read from sun_windows table
  const { data: windows, error: windowsError } = await supabase
    .from('sun_windows')
    .select('*')
    .limit(1);

  if (windowsError) {
    console.error('❌ sun_windows table read failed:', windowsError.message);
    process.exit(1);
  }
  console.log('✅ sun_windows table — readable. Rows:', windows.length, '(expected 0 — table is empty)');

  console.log('\n✅ All connection tests passed. Supabase is set up correctly.');
  console.log('   Ready for Step 9 — ingestion script.\n');
}

testConnection().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});