-- ============================================================================
-- Pint — Database Schema
-- ============================================================================
-- This file defines the complete Postgres schema for Pint, run against
-- Supabase. It is the source of truth for our database structure.
--
-- IMPORTANT: This file is run ONCE when setting up a new environment.
-- After the initial run, schema changes go in numbered migration files
-- (e.g. migrations/001_add_phone_to_pubs.sql) — never edit this file
-- after it's been applied to a live database.
--
-- To apply this schema:
--   1. Open Supabase SQL Editor
--   2. Paste this file's contents
--   3. Click Run
--
-- All tables have RLS enabled with a public read policy.
-- Inserts and updates require the service role key (server-side only).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: pubs
-- Stores all venues from OpenStreetMap, with space for future enrichment.
-- ----------------------------------------------------------------------------

create table pubs (
  -- Identity
  id uuid primary key default gen_random_uuid(),
  osm_id text unique not null,
  osm_type text not null check (osm_type in ('node', 'way', 'relation')),

  -- Core info
  name text not null default 'Unknown Pub',
  lat float8 not null,
  lng float8 not null,
  amenity text not null check (amenity in ('pub', 'bar', 'biergarten', 'restaurant')),

  -- Outdoor space classification
  outdoor_confidence text not null
    check (outdoor_confidence in ('confirmed_garden', 'confirmed_seating', 'unverified')),
  excluded_from_main_view boolean not null default false,

  -- Future-proofing
  osm_tags jsonb not null default '{}'::jsonb,
  external_data_sources jsonb not null default '{}'::jsonb,
  manual_override text check (manual_override in ('force_include', 'force_exclude', 'closed') or manual_override is null),

  -- Audit
  created_at timestamptz not null default now(),
  last_ingested_at timestamptz not null default now()
);

create index pubs_osm_id_idx on pubs (osm_id);
create index pubs_amenity_idx on pubs (amenity);
create index pubs_excluded_idx on pubs (excluded_from_main_view);
create index pubs_location_idx on pubs (lat, lng);

alter table pubs enable row level security;
create policy "Public read access" on pubs for select using (true);

-- ----------------------------------------------------------------------------
-- Table: buildings
-- Stores building footprints and heights for shadow projection in Phase 2.
-- ----------------------------------------------------------------------------

create table buildings (
  -- Identity
  id uuid primary key default gen_random_uuid(),
  osm_id text unique not null,
  osm_type text not null check (osm_type in ('way', 'relation')),

  -- Geometry
  footprint jsonb not null,

  -- Height
  height_m float8 not null default 7,
  height_source text not null default 'default'
    check (height_source in ('osm', 'default', 'crowdsourced')),
  height_verified boolean not null default false,

  -- Audit
  created_at timestamptz not null default now(),
  last_ingested_at timestamptz not null default now()
);

create index buildings_osm_id_idx on buildings (osm_id);
create index buildings_height_source_idx on buildings (height_source);

alter table buildings enable row level security;
create policy "Public read access" on buildings for select using (true);

-- ----------------------------------------------------------------------------
-- Table: sun_windows
-- Pre-computed sun status for every pub, every hour, every day.
-- Populated nightly by the shadow projection job (Phase 2, Step 13).
-- ----------------------------------------------------------------------------

create table sun_windows (
  -- Identity
  id uuid primary key default gen_random_uuid(),
  pub_id uuid not null references pubs(id) on delete cascade,

  -- When this window applies
  date date not null,
  hour int not null check (hour >= 0 and hour <= 23),

  -- The actual sun status
  status text not null check (status in ('sunny', 'partial', 'shaded')),
  confidence float8 not null default 1.0 check (confidence >= 0 and confidence <= 1),

  -- Audit
  computed_at timestamptz not null default now(),

  -- Prevent duplicates: one row per pub per hour per date
  unique (pub_id, date, hour)
);

create index sun_windows_pub_date_idx on sun_windows (pub_id, date);
create index sun_windows_lookup_idx on sun_windows (date, hour, status);

alter table sun_windows enable row level security;
create policy "Public read access" on sun_windows for select using (true);

-- Grant read access to the anon role for all tables
-- Required for the publishable key to read via the REST API
grant select on pubs to anon;
grant select on buildings to anon;
grant select on sun_windows to anon;

-- Grant full access to the service_role for all tables
-- Required for ingestion scripts and scheduled jobs that use the service key.
-- Supabase applies this automatically when tables are created via the UI,
-- but NOT when schema is applied via raw SQL — so we set it explicitly here.
grant all on pubs        to service_role;
grant all on buildings   to service_role;
grant all on sun_windows to service_role;