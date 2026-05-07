-- ============================================================================
-- Migration 001 — Add garden_location columns to pubs
-- ============================================================================
-- Adds columns to support the garden location priority cascade:
--   P1: leisure=outdoor_seating polygon (highest confidence)
--   P2: heuristic estimate from building + nearby roads
--   P3: pub centroid fallback (lowest confidence)
--   On top: user-confirmed locations from Phase 4 crowdsourcing
-- ============================================================================

alter table pubs
  add column garden_location jsonb,
  add column garden_location_confidence text
    check (garden_location_confidence in (
      'mapped_polygon',
      'heuristic_road_based',
      'heuristic_default_south',
      'pub_centroid',
      'user_confirmed'
    ) or garden_location_confidence is null);

-- Index for queries that filter by confidence (e.g. "show me only verified pubs")
create index pubs_garden_confidence_idx on pubs (garden_location_confidence);