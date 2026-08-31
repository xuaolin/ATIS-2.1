// =========================
// ATIS-2.1 Detour + Priority Patch
// Replace the matching CONFIG values/functions in app-phase1.js
// =========================

// 1) In CONFIG, replace/add these settings:
//
// detourLookAheadHours: 6,
// detourAssumedDurationHours: 8,
// nearbyCameraCount: 5,

function relativeAge(value) {
  const d = parseDate(value);
  if (!d) return '—';

  const mins = Math.round((Date.now() - d.getTime()) / 60000);

  // Future event
  if (mins < 0) {
    const ahead = Math.abs(mins);
    if (ahead < 60) return `IN ${ahead}m`;
    const hrs = Math.round(ahead / 60);
    if (hrs < 48) return `IN ${hrs}h`;
    return `IN ${Math.round(hrs / 24)}d`;
  }

  if (mins < 1) return 'NOW';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function firstDate(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    const d = parseDate(value);
    if (d) return value;
  }
  return null;
}

function inferIncidentPriority(text = '') {
  const s = text.toLowerCase();

  if (
    /\ball lanes?\b.*\bclosed\b/.test(s) ||
    /\b(full|complete|total)\s+(road\s+)?closure\b/.test(s) ||
    /\broad\s+closed\b/.test(s) ||
    /\bintersection\s+closed\b/.test(s) ||
    /\bemergency\b/.test(s) ||
    /\bserious\b/.test(s) ||
    /\bmulti[- ]vehicle\b/.test(s) ||
    /\bmajor collision\b/.test(s)
  ) return 'HIGH';

  if (
    /\bcollision\b/.test(s) ||
    /\bsignal\b/.test(s) ||
    /\bhazard\b/.test(s) ||
    /\bstalled\b/.test(s) ||
    /\bblocked\b/.test(s) ||
    /\blane\b/.test(s)
  ) return 'MEDIUM';

  return 'LOW';
}

function inferDetourPriority(text = '') {
  const s = text.toLowerCase();

  // HIGH is intentionally strict:
  // only major/full closures, not every record containing the word "closure".
  if (
    /\ball lanes?\b.*\bclosed\b/.test(s) ||
    /\b(full|complete|total)\s+(road\s+)?closure\b/.test(s) ||
    /\broad\s+closed\b/.test(s) ||
    /\bclosed to all traffic\b/.test(s) ||
    /\bboth directions?\b.*\bclosed\b/.test(s) ||
    /\bintersection\s+closed\b/.test(s) ||
    /\bbridge\s+closed\b/.test(s) ||
    /\bmajor detour\b/.test(s)
  ) return 'HIGH';

  // Single-lane / minor impact stays LOW.
  if (
    /\bsingle[- ]lane\b/.test(s) ||
    /\bone lane\b.*\bclosed\b/.test(s) ||
    /\bshoulder\b/.test(s) ||
    /\bsidewalk\b/.test(s) ||
    /\blocal access\b/.test(s) ||
    /\bdrive with caution\b/.test(s)
  ) return 'LOW';

  // Most operational construction impacts belong here.
  if (
    /\blane(s)?\b.*\bclosed\b/.test(s) ||
    /\blane closure\b/.test(s) ||
    /\bramp\b.*\bclosed\b/.test(s) ||
    /\bdetour\b/.test(s) ||
    /\breduced lanes?\b/.test(s) ||
    /\balternating traffic\b/.test(s) ||
    /\btraffic impact\b/.test(s) ||
    /\bclosure\b/.test(s)
  ) return 'MEDIUM';

  return 'LOW';
}

function normalizeIncident(row, i) {
  const coords = pointFrom(row);
  const title = row.incident_info || row.description || `Traffic incident ${i + 1}`;
  const description = row.description || row.incident_info || 'No additional description provided.';

  const start = firstDate(row, ['start_dt', 'start_date', 'start', 'begin_dt']);
  const updated = firstDate(row, ['modified_dt', 'updated_dt', 'updated', 'start_dt']) || start;

  return {
    id: `INC-${slug(title)}-${slug(start || String(i))}`,
    sourceId: row.id || null,
    source: 'CITY OF CALGARY · CURRENT TRAFFIC INCIDENTS',
    type: 'INCIDENT',
    title,
    description,
    start,
    updated,
    coords,
    priority: inferIncidentPriority(`${title} ${description}`),
    raw: row
  };
}

function normalizeDetour(row, i) {
  const coords = pointFrom(row);
  const title =
    row.construction_info ||
    row.detour_info ||
    row.title ||
    row.description ||
    `Construction detour ${i + 1}`;

  const description =
    row.description ||
    row.construction_info ||
    row.detour_info ||
    'No additional description provided.';

  // Support several possible Socrata field names.
  const start = firstDate(row, [
    'start_dt',
    'start_date',
    'start_datetime',
    'start',
    'begin_dt',
    'from_dt'
  ]);

  const end = firstDate(row, [
    'end_dt',
    'end_date',
    'end_datetime',
    'end',
    'finish_dt',
    'to_dt'
  ]);

  const updated =
    firstDate(row, ['modified_dt', 'updated_dt', 'updated', 'start_dt']) ||
    start;

  return {
    id: `DET-${slug(title)}-${slug(start || end || String(i))}`,
    source: 'CITY OF CALGARY · CONSTRUCTION DETOURS',
    type: 'DETOUR',
    title,
    description,
    start,
    end,
    updated,
    coords,
    priority: inferDetourPriority(`${title} ${description}`),
    raw: row
  };
}

function isOperationalDetour(event) {
  const s = `${event.title || ''} ${event.description || ''}`.toLowerCase();

  // Keep records that describe an actual road/traffic impact.
  return (
    /\bclosed\b/.test(s) ||
    /\bclosure\b/.test(s) ||
    /\blane\b/.test(s) ||
    /\bdetour\b/.test(s) ||
    /\bramp\b/.test(s) ||
    /\btraffic\b/.test(s) ||
    /\bintersection\b/.test(s) ||
    /\baccess\b/.test(s) ||
    /\broad\b/.test(s)
  );
}

function detourInWindow(event) {
  const now = Date.now();
  const horizon = now + CONFIG.detourLookAheadHours * 3600 * 1000;

  const startDate = parseDate(event.start);
  const endDate = parseDate(event.end);

  const start = startDate?.getTime() ?? null;
  const end = endDate?.getTime() ?? null;

  // Critical fix:
  // Do NOT treat missing dates as "now".
  // Records with no usable schedule should not enter the operational queue.
  if (start === null && end === null) return false;

  // Already finished.
  if (end !== null && end < now) return false;

  // Starts beyond the operational look-ahead window.
  if (start !== null && start > horizon) return false;

  // Has both dates: active now or starting within look-ahead.
  if (start !== null && end !== null) {
    return end >= now && start <= horizon;
  }

  // Start exists but end is missing:
  // assume a limited operational duration instead of keeping it forever.
  if (start !== null) {
    const assumedEnd =
      start + (CONFIG.detourAssumedDurationHours || 8) * 3600 * 1000;

    return assumedEnd >= now && start <= horizon;
  }

  // End exists but start is missing:
  // only accept if it is currently ongoing and ending reasonably soon.
  return end >= now && end <= horizon + 12 * 3600 * 1000;
}

function dedupeDetours(events) {
  const seen = new Set();

  return events.filter(event => {
    const lat = event.coords?.[0]?.toFixed?.(4) || '';
    const lon = event.coords?.[1]?.toFixed?.(4) || '';
    const key = [
      slug(event.title),
      event.start || '',
      event.end || '',
      lat,
      lon
    ].join('|');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/*
3) In refreshData(), replace this current line:

if (name === 'detours') state.detours = (result.value || []).map(normalizeDetour).filter(e => e.coords).filter(detourInWindow);

with:
*/

if (name === 'detours') {
  state.detours = dedupeDetours(
    (result.value || [])
      .map(normalizeDetour)
      .filter(e => e.coords)
      .filter(isOperationalDetour)
      .filter(detourInWindow)
  );
}

/*
Recommended operational definition after this patch:

ACTIVE:
  start <= now AND end >= now

UPCOMING:
  starts within the next 6 hours

UNKNOWN / UNSCHEDULED:
  excluded from Event Queue

HIGH:
  full closure / all lanes / road closed / intersection closed /
  both directions / bridge closed / major detour

MEDIUM:
  ordinary lane closures / ramps / detours / reduced lanes

LOW:
  single-lane, one-lane, shoulder, sidewalk, local-access,
  drive-with-caution type impacts
*/
