# Pint 🍺
Find the sunniest beer garden near you — and know how long it'll stay that way.

## What it does
Pint shows you which nearby pubs with outdoor seating are currently sunny, 
using real shadow modelling based on building heights and sun position — 
not just whether it's cloudy.

## Tech stack
React · Vite · Leaflet.js · SunCalc.js · OpenStreetMap · Supabase · Vercel

## Status
Currently in active development.

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

## Project structure
- `src/` — React frontend
- `scripts/` — Node.js data ingestion scripts (OSM → Supabase)
- `migrations/` — SQL schema migrations