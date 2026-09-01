ATIS-2.1 Phase 2.1 — UI / Workflow Polish

Replace these three files in GitHub:
- index.html
- styles-phase1.css
- app-phase1.js

What changed
1. Event map markers no longer open a duplicate white popup. Hover shows a compact tooltip; click opens the Side Drawer. Camera/weather popups remain.
2. Workflow is now a compact two-row 7-step grid with no horizontal scrollbar.
3. Event cards no longer repeat DETOUR + PLANNED + PLANNED. They use a small type icon, operational class, status and a useful time label.
4. Related Events now returns up to 5 stronger candidates using corridor tokens + distance + time + type/class scoring. Cards show match confidence.
5. UNVERIFIED now means ACTIVE/UPCOMING events whose workflow is NEW or REVIEW. Planned work no longer inflates the number.
6. Recurring schedule parsing now handles a.m./p.m. punctuation and weekday+weekend language better. Long-term records with limited-hours language that cannot be confidently parsed stay PLANNED instead of being assumed ACTIVE.
7. Event Drawer reduced from 430px to 405px on desktop.
8. Cache-busting version updated to phase21-20260831-1.

Deploy
Commit the three replacements, wait for GitHub Pages, then Ctrl+F5.
