-- ============================================================================
-- Migration 002 — Create roads table
-- ============================================================================
-- Stores road geometry near Coventry pubs for use in the garden location
-- heuristic (Step 10d): determines which side of a pub building faces the
-- street, so we can estimate where the beer garden most likely is.
--
-- Only roads within 100m of a pub are ingested (see scripts/ingest-roads.js).
-- Highway types included: primary, secondary, tertiary, residential,
-- unclassified, living_street.
-- ============================================================================

create table roads (
  id                uuid        primary key default gen_random_uuid(),
  osm_id            text        unique not null,
  geometry          jsonb       not null,
  highway_type      text,
  name              text,
  last_ingested_at  timestamptz not null default now()
);

create index roads_osm_id_idx on roads (osm_id);

alter table roads enable row level security;
create policy "Public read access" on roads for select using (true);

-- anon key: read-only via the frontend
grant select on roads to anon;

-- service_role: full access for ingestion scripts and scheduled jobs
grant all on roads to service_role;
