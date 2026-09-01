ATIS-2.1 Phase 1.5 — Operational Queue

Replace these three files in GitHub:
- index.html
- styles-phase1.css
- app-phase1.js

What changed:
- Main queue defaults to ACTIVE instead of showing every construction record.
- New views: ACTIVE / INCIDENT / UPCOMING / PLANNED / MANUAL.
- Detours are classified as ACTIVE, UPCOMING (next 3 hours), PLANNED, or excluded.
- Recognizes common recurring time ranges such as Daily 09:00-15:00 and Nightly 21:00-05:00.
- Long-duration construction without evidence of continuous closure is moved to PLANNED.
- Planned construction is hidden on the map by default.
- Map layers split into Active Closures, Upcoming, Planned.
- Event markers are clustered when zoomed out (Leaflet.markercluster).
- Marker colors: red incident, orange active closure, yellow upcoming, gray planned, blue manual.
- KPI strip now shows Active Incidents / Active Closures / Upcoming / High Priority / Weather.
- Existing Phase 1 Side Drawer, workflow, quick actions, camera panel, toast/undo and map layer z-index fixes are retained.

Notes:
- Time-of-day parsing is heuristic because Calgary Open Data descriptions are free text.
- If a record has a recurring time window, the console evaluates it using America/Edmonton time.
- Planned is a planning view and is intentionally not shown on the map until the Planned layer is enabled.

After upload:
1. Commit changes.
2. Wait for GitHub Pages deployment.
3. Ctrl+F5.
