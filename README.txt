ATIS-2.1 Layer UI / z-index fix

Upload and replace these 3 files:
- index.html
- styles-phase1.css
- app-phase1.js

Changes:
- Leaflet is isolated inside the map stacking context.
- Event Drawer / Modal / Context Menu / Toast now stay above the map.
- LIVE MAP LAYERS is collapsed by default.
- New LAYERS button opens/closes the panel.
- Clicking or dragging the map closes the layers panel.
- Escape closes the layers panel.
- Layer panel remains usable on smaller screens.
- Local CSS/JS links use a cache-busting version string.
- Correct Leaflet 1.9.4 CSS integrity hash is included.

After upload:
1. Commit changes.
2. Wait for GitHub Pages deployment.
3. Ctrl+F5.
