# Pint 🍺
Find the sunniest beer garden near you — and know how long it'll stay that way.

## What it does
Most weather apps tell you if it's sunny — not whether *that specific beer garden* is in the sun. Pint solves this by combining real-time weather, sun position calculations, and building shadow modelling to show you which nearby pub gardens are actually sunny right now, and how long they'll stay that way.

## How it works
1. **Venue data** — pub locations and outdoor seating pulled from OpenStreetMap
2. **Building data** — surrounding building footprints and heights from OSM, used to calculate shadow coverage
3. **Sun position** — SunCalc.js calculates sun altitude and azimuth for any location and time
4. **Shadow projection** — building heights + sun angle → shadow polygons → check if garden falls inside
5. **Live weather** — Open-Meteo API cross-references shadow status with actual cloud cover

## Tech stack
| Layer | Tool |
|---|---|
| Frontend | React + Vite (mobile-optimised) |
| Map | Leaflet.js + OpenStreetMap tiles |
| Database | Supabase (Postgres) |
| Sun position | SunCalc.js |
| Weather | Open-Meteo API |
| Venue + building data | OpenStreetMap via Overpass API |
| Deployment | Vercel |

## Status
**Phase 1 complete** — data pipeline live with 155 Coventry pubs, 26,589 building footprints, and 867 road segments ingested into Supabase.

**Phase 2 in progress** — shadow calculation engine (sun position + building projection).

Planned phases: Core Logic → Frontend → Crowdsourcing → UK-wide coverage.

## Project structure
```
src/          React frontend
scripts/      Node.js data ingestion pipeline (OSM → Supabase)
migrations/   SQL schema migrations (forward-only, numbered)
```

## Prerequisites
- Node.js 18+
- A Supabase project (see `.env.example` for required variables)

## Running locally
```bash
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

## Environment variables
Copy `.env.example` to `.env` and fill in your Supabase credentials:
```bash
cp .env.example .env
```

## Data pipeline
The ingestion scripts live in `scripts/` and are run independently of the frontend:
```bash
node --env-file=.env scripts/ingest-pubs.js        # Ingest venue data
node --env-file=.env scripts/ingest-buildings.js   # Ingest building footprints
node --env-file=.env scripts/ingest-roads.js       # Ingest road geometry
```
Each script is idempotent — safe to re-run weekly as OSM data updates.