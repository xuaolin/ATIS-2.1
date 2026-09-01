/* Calgary TMC Traffic Event Management — Phase 1 UX + Leaflet/OpenStreetMap + operational detour filtering */

const CONFIG = {
  // No map API key required. Basemap uses OpenStreetMap standard tiles through Leaflet.
  calgaryCenter: [51.0447, -114.0719],
  calgaryBounds: [[50.75, -114.45], [51.35, -113.65]],
  refreshMs: 5 * 60 * 1000,
  upcomingLookAheadHours: 3,
  plannedLookAheadHours: 24 * 7,
  longTermThresholdHours: 36,
  detourAssumedDurationHours: 8,
  nearbyCameraCount: 5,
  sources: {
    incidents: 'https://data.calgary.ca/resource/4jah-h97u.json?$limit=250',
    detours: 'https://data.calgary.ca/resource/w8zq-79bq.json?$limit=1000',
    cameras: 'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500',
    weather: 'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&bbox=-114.45,50.75,-113.65,51.35&limit=50'
  }
};

const STATUS_ORDER = ['NEW', 'REVIEW', 'VERIFIED', 'RESPONDING', 'MONITORING', 'CLEARED', 'CLOSED'];
const STATUS_CTA = {
  NEW: ['REVIEW EVENT', 'REVIEW'],
  REVIEW: ['VERIFY EVENT', 'VERIFIED'],
  VERIFIED: ['START RESPONSE', 'RESPONDING'],
  RESPONDING: ['START MONITORING', 'MONITORING'],
  MONITORING: ['CLEAR EVENT', 'CLEARED'],
  CLEARED: ['CLOSE EVENT', 'CLOSED'],
  CLOSED: ['REOPEN EVENT', 'MONITORING']
};
const ACTION_LABELS = {
  verified: 'Event verification',
  cameraChecked: 'Camera check',
  signalReviewed: 'Signal timing review',
  dmsActivated: 'DMS action',
  detourRequired: 'Detour requirement',
  publicUpdate: 'Public update action'
};

const state = {
  incidents: [],
  detours: [],
  cameras: [],
  weather: [],
  manual: loadLocal('tmc_manual_events_v1', []),
  operator: loadLocal('tmc_operator_state_v1', {}),
  allEvents: [],
  selectedId: null,
  filter: 'ACTIVE',
  search: '',
  activeTab: 'overview',
  feedErrors: [],
  markersByEventId: new Map(),
  layersEnabled: { INCIDENT: true, ACTIVE: true, UPCOMING: true, PLANNED: false, MANUAL: true, CAMERA: false, WEATHER: true },
  mapContextLatLng: null,
  undoStack: []
};

const els = {};
let map;
let baseMapLayer;
let weatherDataLayer;
let layers = {};
let mapReady = false;

function loadLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveLocal(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function slug(value = '') { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 42) || 'event'; }
function parseDate(value) { if (!value) return null; const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
function formatTime(value) {
  const d = value instanceof Date ? value : parseDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function formatClockDate(d = new Date()) {
  els.clock.textContent = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  els.dateLabel.textContent = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' }).format(d).toUpperCase();
}
function relativeAge(value) {
  const d = parseDate(value);
  if (!d) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
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
function pointFrom(obj) {
  if (obj?.point?.coordinates?.length >= 2) return [Number(obj.point.coordinates[1]), Number(obj.point.coordinates[0])];
  const lat = Number(obj?.latitude ?? obj?.lat); const lon = Number(obj?.longitude ?? obj?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}
function firstDate(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (parseDate(value)) return value;
  }
  return null;
}
function inferIncidentPriority(text = '') {
  const s = text.toLowerCase();
  if (/all lanes?[^.]{0,30}closed|(?:full|complete|total)\s+(?:road\s+)?closure|road\s+closed|intersection\s+closed|emergency|serious|multi[- ]vehicle|major collision/.test(s)) return 'HIGH';
  if (/collision|signal|hazard|stalled|blocked|lane/.test(s)) return 'MEDIUM';
  return 'LOW';
}
function inferDetourPriority(text = '') {
  const s = text.toLowerCase();
  if (/all lanes?[^.]{0,30}closed|(?:full|complete|total)\s+(?:road\s+)?closure|road\s+closed|closed to all traffic|both directions?[^.]{0,30}closed|intersection\s+closed|bridge\s+closed|major detour/.test(s)) return 'HIGH';
  if (/single[- ]lane|one lane[^.]{0,30}closed|shoulder|sidewalk|local access|drive with caution/.test(s)) return 'LOW';
  if (/lanes?[^.]{0,30}closed|lane closure|ramp[^.]{0,30}closed|detour|reduced lanes?|alternating traffic|traffic impact|closure/.test(s)) return 'MEDIUM';
  return 'LOW';
}
function operatorFor(id) {
  if (!state.operator[id]) state.operator[id] = { status: 'NEW', actions: {}, notes: [], timeline: [] };
  return state.operator[id];
}
function persistOperator() { saveLocal('tmc_operator_state_v1', state.operator); }
function addTimeline(id, text) {
  const op = operatorFor(id);
  op.timeline.unshift({ at: new Date().toISOString(), text });
  op.timeline = op.timeline.slice(0, 100);
  persistOperator();
}

function toast(title, detail = '', { type = 'success', actionLabel = '', onAction = null, ttl = 4200 } = {}) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<div class="toast-copy"><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ''}`;
  els.toastStack.appendChild(node);
  let removed = false;
  const remove = () => { if (removed) return; removed = true; node.remove(); };
  const timer = setTimeout(remove, ttl);
  if (actionLabel && onAction) {
    node.querySelector('button').addEventListener('click', () => { clearTimeout(timer); onAction(); remove(); });
  }
}

function calgaryClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Edmonton',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[get('weekday')] ?? date.getDay(), minuteOfDay: Number(get('hour') || 0) * 60 + Number(get('minute') || 0) };
}
function parseClockValue(hourText, minuteText, meridiemText) {
  let h = Number(hourText); const m = Number(minuteText || 0); const mer = String(meridiemText || '').toLowerCase();
  if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === 'pm' && h !== 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
  }
  if (h < 0 || h > 23) return null;
  return h * 60 + m;
}
function scheduleAllowedDays(text) {
  const s = String(text || '').toLowerCase();
  if (/weekdays?|monday\s*(?:-|–|—|to|through)\s*friday/.test(s)) return new Set([1,2,3,4,5]);
  if (/weekends?/.test(s)) return new Set([0,6]);
  const names = [['sun',0],['mon',1],['tue',2],['wed',3],['thu',4],['fri',5],['sat',6]];
  const found = names.filter(([name]) => new RegExp(`\\b${name}(?:day|sday|nesday|rsday|urday)?\\b`, 'i').test(s)).map(([,d]) => d);
  return found.length ? new Set(found) : new Set([0,1,2,3,4,5,6]);
}
function extractRecurringSchedule(text = '') {
  const s = String(text).replace(/[–—]/g, '-');
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|\bto\b|\buntil\b)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  const match = s.match(re);
  if (!match) return null;
  let [, h1, m1, mer1, h2, m2, mer2] = match;
  if (!mer1 && mer2 && Number(h1) <= 12 && Number(h2) <= 12) mer1 = mer2;
  const startMin = parseClockValue(h1, m1, mer1);
  const endMin = parseClockValue(h2, m2, mer2);
  if (startMin === null || endMin === null || startMin === endMin) return null;
  const fmt = mins => `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
  return { startMin, endMin, allowedDays: scheduleAllowedDays(s), label: `${fmt(startMin)}–${fmt(endMin)}` };
}
function evaluateRecurringSchedule(schedule, now = new Date()) {
  if (!schedule) return { active: false, nextStartMinutes: Infinity };
  const { day, minuteOfDay } = calgaryClockParts(now);
  const allowed = d => schedule.allowedDays.has((d + 7) % 7);
  let active = false;
  if (schedule.startMin < schedule.endMin) {
    active = allowed(day) && minuteOfDay >= schedule.startMin && minuteOfDay < schedule.endMin;
  } else {
    active = (allowed(day) && minuteOfDay >= schedule.startMin) || (allowed(day - 1) && minuteOfDay < schedule.endMin);
  }
  let nextStartMinutes = Infinity;
  for (let deltaDay = 0; deltaDay <= 7; deltaDay++) {
    const targetDay = (day + deltaDay) % 7;
    if (!allowed(targetDay)) continue;
    const diff = deltaDay * 1440 + schedule.startMin - minuteOfDay;
    if (diff > 0) { nextStartMinutes = diff; break; }
  }
  return { active, nextStartMinutes };
}
function strongContinuousImpact(text = '') {
  const s = text.toLowerCase();
  return /24\s*(?:hours?|hrs?)|24\/7|continuous|around the clock|all lanes?[^.]{0,30}closed|road\s+closed|closed to all traffic|intersection\s+closed|both directions?[^.]{0,30}closed|bridge\s+closed/.test(s);
}
function classifyDetour(event, nowMs = Date.now()) {
  const start = parseDate(event.start)?.getTime() ?? null;
  const end = parseDate(event.end)?.getTime() ?? null;
  const upcomingMs = CONFIG.upcomingLookAheadHours * 3600 * 1000;
  const plannedMs = CONFIG.plannedLookAheadHours * 3600 * 1000;
  if (end !== null && end < nowMs) return { operationalClass: 'EXCLUDE', activityReason: 'Expired' };
  if (start !== null && start > nowMs) {
    const diff = start - nowMs;
    if (diff <= upcomingMs) return { operationalClass: 'UPCOMING', activityReason: `Starts ${relativeAge(event.start)}` };
    if (diff <= plannedMs) return { operationalClass: 'PLANNED', activityReason: 'Scheduled work' };
    return { operationalClass: 'EXCLUDE', activityReason: 'Outside planning window' };
  }
  const schedule = event.schedule || extractRecurringSchedule(`${event.title} ${event.description}`);
  if (schedule) {
    const timing = evaluateRecurringSchedule(schedule);
    event.nextOccurrenceMinutes = timing.nextStartMinutes;
    if (timing.active) return { operationalClass: 'ACTIVE', activityReason: `Active · ${schedule.label}` };
    if (timing.nextStartMinutes <= CONFIG.upcomingLookAheadHours * 60) return { operationalClass: 'UPCOMING', activityReason: `Starts in ${formatMinutesAhead(timing.nextStartMinutes)} · ${schedule.label}` };
    return { operationalClass: 'PLANNED', activityReason: `Scheduled · ${schedule.label}` };
  }
  if (start === null && end === null) return { operationalClass: 'EXCLUDE', activityReason: 'No schedule' };
  if (start !== null && end !== null) {
    const durationHours = (end - start) / 3600000;
    if (durationHours <= CONFIG.longTermThresholdHours || strongContinuousImpact(`${event.title} ${event.description}`)) return { operationalClass: 'ACTIVE', activityReason: 'Active now' };
    return { operationalClass: 'PLANNED', activityReason: 'Long-term construction' };
  }
  if (start !== null) {
    const assumedEnd = start + CONFIG.detourAssumedDurationHours * 3600000;
    return assumedEnd >= nowMs ? { operationalClass: 'ACTIVE', activityReason: 'Active now' } : { operationalClass: 'EXCLUDE', activityReason: 'Assumed complete' };
  }
  return end !== null && end - nowMs <= 12 * 3600000 ? { operationalClass: 'ACTIVE', activityReason: 'Active now' } : { operationalClass: 'PLANNED', activityReason: 'Scheduled work' };
}
function formatMinutesAhead(mins) {
  if (!Number.isFinite(mins)) return 'later';
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  return `${Math.round(mins / 60)}h`;
}
function classifyManual(event) {
  const start = parseDate(event.start)?.getTime();
  if (!start || start <= Date.now()) return 'ACTIVE';
  const diff = start - Date.now();
  return diff <= CONFIG.upcomingLookAheadHours * 3600000 ? 'UPCOMING' : 'PLANNED';
}
function eventLayerKey(event) {
  if (event.type === 'INCIDENT') return 'INCIDENT';
  if (event.type === 'MANUAL') return 'MANUAL';
  return ['ACTIVE','UPCOMING','PLANNED'].includes(event.operationalClass) ? event.operationalClass : 'PLANNED';
}
function operationalLabel(event) {
  if (event.type === 'INCIDENT') return 'INCIDENT';
  if (event.type === 'MANUAL') return event.operationalClass === 'UPCOMING' ? 'UPCOMING MANUAL' : 'MANUAL';
  if (event.operationalClass === 'ACTIVE') return 'ACTIVE CLOSURE';
  return event.operationalClass || 'PLANNED';
}
function queueTimeLabel(event) {
  if (event.operationalClass === 'ACTIVE' && event.type === 'DETOUR') return 'NOW';
  if (event.operationalClass === 'UPCOMING' && Number.isFinite(event.nextOccurrenceMinutes)) return `IN ${formatMinutesAhead(event.nextOccurrenceMinutes)}`;
  if (event.operationalClass === 'PLANNED') return 'PLANNED';
  return relativeAge(event.updated || event.start);
}

function normalizeIncident(row, i) {
  const coords = pointFrom(row);
  const title = row.incident_info || row.description || `Traffic incident ${i + 1}`;
  const description = row.description || row.incident_info || 'No additional description provided.';
  const start = firstDate(row, ['start_dt','start_date','start','begin_dt']);
  const updated = firstDate(row, ['modified_dt','updated_dt','updated','start_dt']) || start;
  return { id: `INC-${slug(title)}-${slug(start || String(i))}`, sourceId: row.id || null, source: 'CITY OF CALGARY · CURRENT TRAFFIC INCIDENTS', type: 'INCIDENT', operationalClass: 'ACTIVE', title, description, start, updated, coords, priority: inferIncidentPriority(`${title} ${description}`), raw: row };
}
function normalizeDetour(row, i) {
  const coords = pointFrom(row);
  const title = row.construction_info || row.detour_info || row.title || row.description || `Construction detour ${i + 1}`;
  const description = row.description || row.construction_info || row.detour_info || 'No additional description provided.';
  const start = firstDate(row, ['start_dt','start_date','start_datetime','start','begin_dt','from_dt']);
  const end = firstDate(row, ['end_dt','end_date','end_datetime','end','finish_dt','to_dt']);
  const updated = firstDate(row, ['modified_dt','updated_dt','updated','start_dt']) || start;
  const event = { id: `DET-${slug(title)}-${slug(start || end || String(i))}`, source: 'CITY OF CALGARY · CONSTRUCTION / ROAD RESTRICTIONS', type: 'DETOUR', title, description, start, end, updated, coords, priority: inferDetourPriority(`${title} ${description}`), raw: row };
  event.schedule = extractRecurringSchedule(`${title} ${description}`);
  Object.assign(event, classifyDetour(event));
  return event;
}
function normalizeManual(row) {
  const event = { ...row, type: 'MANUAL', source: 'TMC MANUAL EVENT' };
  event.operationalClass = classifyManual(event);
  return event;
}
function isOperationalDetour(event) {
  const s = `${event.title || ''} ${event.description || ''}`.toLowerCase();
  return /closed|closure|lane|detour|ramp|traffic|intersection|access|road|reduced/.test(s);
}
function dedupeDetours(events) {
  const seen = new Set();
  return events.filter(event => {
    const lat = event.coords?.[0]?.toFixed?.(4) || '';
    const lon = event.coords?.[1]?.toFixed?.(4) || '';
    const key = [slug(event.title), event.start || '', event.end || '', lat, lon].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json, application/geo+json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function refreshData({ silent = false } = {}) {
  if (!silent) setMapStatus('Refreshing Calgary public feeds…');
  state.feedErrors = [];
  const tasks = [['incidents', CONFIG.sources.incidents], ['detours', CONFIG.sources.detours], ['cameras', CONFIG.sources.cameras], ['weather', CONFIG.sources.weather]];
  const settled = await Promise.allSettled(tasks.map(([, url]) => fetchJson(url)));
  settled.forEach((result, idx) => {
    const name = tasks[idx][0];
    if (result.status === 'fulfilled') {
      if (name === 'incidents') state.incidents = (result.value || []).map(normalizeIncident).filter(e => e.coords);
      if (name === 'detours') state.detours = dedupeDetours((result.value || []).map(normalizeDetour).filter(e => e.coords).filter(isOperationalDetour).filter(e => e.operationalClass !== 'EXCLUDE'));
      if (name === 'cameras') state.cameras = (result.value || []).map((c, i) => ({ id: `CAM-${i}-${slug(c.camera_location || '')}`, title: c.camera_location || `Traffic camera ${i+1}`, quadrant: c.quadrant || '', url: typeof c.camera_url === 'object' ? c.camera_url.url : c.camera_url, coords: pointFrom(c), raw: c })).filter(c => c.coords);
      if (name === 'weather') state.weather = result.value?.features || [];
    } else {
      state.feedErrors.push(`${name}: ${result.reason?.message || 'failed'}`);
    }
  });
  if (!state.incidents.length && !state.detours.length && state.feedErrors.length >= 2) injectDemoFallback();
  rebuildEvents();
  renderAll();
  els.lastRefresh.textContent = `REFRESH ${formatTime(new Date())}`;
  updateHealth();
  setMapStatus(state.feedErrors.length ? `DEGRADED · ${state.feedErrors.join(' · ')}` : 'LIVE · OpenStreetMap + Calgary Open Data + ECCC');
  if (!silent) toast('Public feeds refreshed', `${state.allEvents.length} event records available.`);
}

function injectDemoFallback() {
  const now = new Date();
  state.incidents = [{ id: 'DEMO-INC-001', source: 'DEMO FALLBACK · LIVE FEED UNAVAILABLE', type: 'INCIDENT', operationalClass: 'ACTIVE', title: 'Demo collision — Deerfoot Trail NE', description: 'Sample event displayed only because live public feeds could not be reached from this browser.', start: new Date(now.getTime() - 18*60000).toISOString(), updated: now.toISOString(), coords: [51.084, -113.992], priority: 'HIGH', raw: {} }];
  state.detours = [{ id: 'DEMO-DET-001', source: 'DEMO FALLBACK · LIVE FEED UNAVAILABLE', type: 'DETOUR', operationalClass: 'ACTIVE', activityReason: 'Active now', title: 'Demo planned closure — 16 Avenue NW', description: 'Sample construction detour for interface demonstration.', start: new Date(now.getTime() - 60*60000).toISOString(), end: new Date(now.getTime() + 8*3600*1000).toISOString(), updated: now.toISOString(), coords: [51.067, -114.105], priority: 'MEDIUM', raw: {} }];
}
function rebuildEvents() {
  const manual = state.manual.map(normalizeManual);
  const classRank = { ACTIVE: 0, UPCOMING: 1, PLANNED: 2 };
  const priorityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  state.allEvents = [...state.incidents, ...state.detours, ...manual].sort((a, b) => {
    const classDiff = (classRank[a.operationalClass] ?? 9) - (classRank[b.operationalClass] ?? 9);
    if (classDiff) return classDiff;
    const priorityDiff = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    if (priorityDiff) return priorityDiff;
    return (parseDate(b.updated || b.start)?.getTime() || 0) - (parseDate(a.updated || a.start)?.getTime() || 0);
  });
}
function updateHealth() {
  els.systemHealth.classList.remove('healthy', 'degraded');
  if (!state.feedErrors.length) { els.systemHealth.classList.add('healthy'); els.healthText.textContent = 'PUBLIC FEEDS ONLINE'; }
  else { els.systemHealth.classList.add('degraded'); els.healthText.textContent = 'DEGRADED'; }
}
function setMapStatus(text) { els.mapStatus.textContent = text; }

function setLayersPanel(open) {
  if (!els.layerBox || !els.layersToggleBtn) return;
  els.layerBox.classList.toggle('is-collapsed', !open);
  els.layersToggleBtn.classList.toggle('active', open);
  els.layersToggleBtn.setAttribute('aria-expanded', String(open));
  els.layerBox.setAttribute('aria-hidden', String(!open));
}

function toggleLayersPanel() {
  const open = els.layerBox?.classList.contains('is-collapsed');
  setLayersPanel(!!open);
}

function initMap() {
  if (!window.L) {
    mapReady = false;
    document.getElementById('map').innerHTML = `<div class="map-key-required"><div class="map-key-icon osm-icon">M</div><strong>MAP LIBRARY DID NOT LOAD</strong><span>Check your internet connection and refresh the page.</span></div>`;
    setMapStatus('MAP OFFLINE · Leaflet library unavailable');
    return;
  }

  map = L.map('map', {
    center: CONFIG.calgaryCenter,
    zoom: 11,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true
  });

  baseMapLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const makeClusterGroup = kind => {
    if (!L.markerClusterGroup) return L.layerGroup();
    return L.markerClusterGroup({
      maxClusterRadius: kind === 'PLANNED' ? 55 : 44,
      disableClusteringAtZoom: 15,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      removeOutsideVisibleBounds: true,
      iconCreateFunction: cluster => L.divIcon({
        className: `tmc-cluster tmc-cluster-${kind.toLowerCase()}`,
        html: `<div class="tmc-cluster-bubble">${cluster.getChildCount()}</div>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19]
      })
    });
  };
  layers = {
    INCIDENT: makeClusterGroup('INCIDENT'),
    ACTIVE: makeClusterGroup('ACTIVE'),
    UPCOMING: makeClusterGroup('UPCOMING'),
    PLANNED: makeClusterGroup('PLANNED'),
    MANUAL: makeClusterGroup('MANUAL'),
    CAMERA: L.layerGroup()
  };

  weatherDataLayer = L.geoJSON(null, {
    style: {
      color: '#2385d9',
      weight: 2,
      opacity: 0.92,
      fillColor: '#2385d9',
      fillOpacity: 0.08
    },
    onEachFeature: (feature, layer) => {
      const props = feature?.properties || {};
      const name = props.alert_name_en || props.alert_short_name_en || 'Weather alert';
      const area = props.feature_name_en || '';
      layer.bindPopup(`<div class="gm-popup"><div class="popup-kicker">ECCC WEATHER ALERT</div><div class="popup-title">${escapeHtml(name)}</div><div>${escapeHtml(area)}</div></div>`);
    }
  });

  map.on('contextmenu', ev => openMapContextMenu(ev.originalEvent, ev.latlng));
  map.on('click', () => { closeMapContextMenu(); setLayersPanel(false); });
  map.on('movestart', () => setLayersPanel(false));

  mapReady = true;
  syncLayerVisibility();
  setMapStatus('MAP ONLINE · OpenStreetMap');
}

function markerIcon(type) {
  const styles = {
    INCIDENT: { fill: '#d82f43', stroke: '#fff', glyph: '!' },
    ACTIVE: { fill: '#e08b28', stroke: '#fff', glyph: '↪' },
    UPCOMING: { fill: '#c4a61e', stroke: '#fff', glyph: 'U' },
    PLANNED: { fill: '#6d7e89', stroke: '#fff', glyph: 'P' },
    MANUAL: { fill: '#35bce8', stroke: '#fff', glyph: '+' },
    CAMERA: { fill: '#526779', stroke: '#fff', glyph: '●' }
  };
  const s = styles[type] || styles.MANUAL;
  const size = type === 'CAMERA' ? 24 : 32;
  const fontSize = type === 'CAMERA' ? 8 : 14;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2"/><circle cx="16" cy="16" r="14" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="2"/><text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${s.glyph}</text></svg>`;
  return L.divIcon({
    className: 'tmc-leaflet-marker',
    html: svg,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)]
  });
}

function clearMapLayers() {
  Object.values(layers).forEach(layerGroup => layerGroup?.clearLayers?.());
  state.markersByEventId.clear();
  weatherDataLayer?.clearLayers?.();
}

function renderMap() {
  if (!mapReady || !map) return;
  clearMapLayers();

  state.allEvents.forEach(event => {
    const layerKey = eventLayerKey(event);
    if (!event.coords || !layers[layerKey]) return;
    const marker = L.marker(event.coords, {
      icon: markerIcon(layerKey),
      title: event.title,
      riseOnHover: true
    });

    const op = operatorFor(event.id);
    marker.bindPopup(`<div class="gm-popup"><div class="popup-kicker">${escapeHtml(operationalLabel(event))} · ${escapeHtml(op.status)}</div><div class="popup-title">${escapeHtml(event.title)}</div><div>${escapeHtml(event.description).slice(0,180)}</div><div class="popup-actions"><button data-map-action="open" data-id="${escapeHtml(event.id)}">OPEN</button><button data-map-action="camera" data-id="${escapeHtml(event.id)}">CAMERAS</button><button data-map-action="verify" data-id="${escapeHtml(event.id)}">VERIFY</button></div></div>`);

    marker.on('click', () => selectEvent(event.id, false));
    marker.on('popupopen', bindPopupActions);
    marker.addTo(layers[layerKey]);

    state.markersByEventId.set(event.id, marker);
  });

  state.cameras.forEach(cam => {
    const marker = L.marker(cam.coords, {
      icon: markerIcon('CAMERA'),
      title: cam.title,
      riseOnHover: true
    });
    const safeUrl = cam.url ? escapeHtml(cam.url) : '';
    marker.bindPopup(`<div class="gm-popup"><div class="popup-kicker">TRAFFIC CAMERA</div><div class="popup-title">${escapeHtml(cam.title)}</div>${safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener">Open camera</a>` : ''}</div>`);
    marker.addTo(layers.CAMERA);
  });

  if (state.weather.length) {
    try {
      weatherDataLayer.addData({ type: 'FeatureCollection', features: state.weather });
    } catch {}
  }

  syncLayerVisibility();
}

function bindPopupActions() {
  document.querySelectorAll('[data-map-action]').forEach(btn => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.mapAction;
      selectEvent(id, false);
      if (action === 'camera') showCameraModal();
      if (action === 'verify') setStatusForEvent(id, 'VERIFIED', { announce: true });
    });
  });
}

function syncLayerVisibility() {
  if (!mapReady || !map) return;

  ['INCIDENT','ACTIVE','UPCOMING','PLANNED','MANUAL','CAMERA'].forEach(name => {
    const group = layers[name];
    if (!group) return;
    if (state.layersEnabled[name]) {
      if (!map.hasLayer(group)) group.addTo(map);
    } else if (map.hasLayer(group)) {
      map.removeLayer(group);
    }
  });

  if (weatherDataLayer) {
    if (state.layersEnabled.WEATHER) {
      if (!map.hasLayer(weatherDataLayer)) weatherDataLayer.addTo(map);
    } else if (map.hasLayer(weatherDataLayer)) {
      map.removeLayer(weatherDataLayer);
    }
  }
}

function openMapContextMenu(domEvent, latLng) {
  state.mapContextLatLng = latLng;
  const x = Math.min(window.innerWidth - 205, Math.max(8, domEvent?.clientX ?? window.innerWidth/2));
  const y = Math.min(window.innerHeight - 120, Math.max(8, domEvent?.clientY ?? window.innerHeight/2));
  els.mapContextMenu.style.left = `${x}px`;
  els.mapContextMenu.style.top = `${y}px`;
  els.mapContextMenu.classList.remove('hidden');
}

function closeMapContextMenu() { els.mapContextMenu.classList.add('hidden'); }

function createEventAtContextLocation() {
  if (!state.mapContextLatLng) return;
  openManualModal({ lat: state.mapContextLatLng.lat, lon: state.mapContextLatLng.lng });
  closeMapContextMenu();
}

function filteredEvents() {
  const q = state.search.trim().toLowerCase();
  return state.allEvents.filter(e => {
    const op = operatorFor(e.id);
    if (op.status === 'CLOSED') return false;
    if (state.filter === 'ACTIVE' && e.operationalClass !== 'ACTIVE') return false;
    if (state.filter === 'INCIDENT' && e.type !== 'INCIDENT') return false;
    if (state.filter === 'UPCOMING' && e.operationalClass !== 'UPCOMING') return false;
    if (state.filter === 'PLANNED' && e.operationalClass !== 'PLANNED') return false;
    if (state.filter === 'MANUAL' && e.type !== 'MANUAL') return false;
    if (!q) return true;
    return `${e.title} ${e.description} ${e.id} ${e.activityReason || ''}`.toLowerCase().includes(q);
  });
}
function renderQueue() {
  const events = filteredEvents(); els.queueCount.textContent = events.length;
  if (!events.length) { els.eventQueue.innerHTML = '<div class="no-events">No events match this operational view.</div>'; return; }
  els.eventQueue.innerHTML = events.map(event => {
    const op = operatorFor(event.id); const verified = op.status === 'VERIFIED' || STATUS_ORDER.indexOf(op.status) > STATUS_ORDER.indexOf('VERIFIED');
    const opClass = event.type === 'INCIDENT' ? 'incident' : String(event.operationalClass || 'planned').toLowerCase();
    const scheduleText = event.activityReason ? `<div class="event-schedule">${escapeHtml(event.activityReason)}</div>` : '';
    return `<article class="event-card type-${escapeHtml(event.type)} operational-${escapeHtml(event.operationalClass || '')} priority-${event.priority} ${state.selectedId === event.id ? 'selected' : ''}" data-event-id="${escapeHtml(event.id)}"><span class="priority-line"></span><div class="event-card-head"><span class="event-type">${escapeHtml(event.type)}</span><span class="ops-class-badge ${opClass}">${escapeHtml(operationalLabel(event))}</span><span class="status-chip">${escapeHtml(op.status)}</span><span class="event-time">${escapeHtml(queueTimeLabel(event))}</span></div><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.description)}</p>${scheduleText}<div class="quick-actions"><button class="quick-btn" data-quick="camera">CAMERA</button><button class="quick-btn ${verified ? 'success' : ''}" data-quick="verify">${verified ? 'VERIFIED' : 'VERIFY'}</button><button class="quick-btn" data-quick="open">OPEN</button></div></article>`;
  }).join('');
  els.eventQueue.querySelectorAll('[data-event-id]').forEach(card => {
    card.addEventListener('click', () => selectEvent(card.dataset.eventId));
    card.querySelectorAll('[data-quick]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); handleQuickAction(card.dataset.eventId, btn.dataset.quick); }));
  });
}
function handleQuickAction(id, action) {
  selectEvent(id, action !== 'camera');
  if (action === 'camera') showCameraModal();
  if (action === 'verify') setStatusForEvent(id, 'VERIFIED', { announce: true });
  if (action === 'open') openDrawer();
}

function selectEvent(id, pan = true) {
  const event = state.allEvents.find(e => e.id === id); if (!event) return;
  state.selectedId = id; operatorFor(id); renderQueue(); renderDetail(); openDrawer();
  if (pan && event.coords && mapReady) { map.panTo(event.coords); if ((map.getZoom() || 0) < 14) map.setZoom(14); }
}
function openDrawer() { els.eventDrawer.classList.add('open'); els.eventDrawer.setAttribute('aria-hidden', 'false'); }
function closeDrawer() { els.eventDrawer.classList.remove('open'); els.eventDrawer.setAttribute('aria-hidden', 'true'); }
function switchDetailTab(tab) {
  state.activeTab = tab;
  els.detailTabs.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('[data-tab-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.tabPanel === tab));
}
function renderDetail() {
  const event = state.allEvents.find(e => e.id === state.selectedId); if (!event) return;
  const op = operatorFor(event.id);
  els.detailSource.textContent = event.source; els.detailTitle.textContent = event.title; els.detailId.textContent = event.id; els.detailType.textContent = event.type === 'DETOUR' ? `${event.type} · ${event.operationalClass}` : event.type;
  els.detailStart.textContent = formatTime(event.start); els.detailUpdated.textContent = formatTime(event.updated || event.start); els.detailDescription.textContent = event.description;
  els.detailPriority.textContent = event.priority; els.detailPriority.className = `priority-badge ${event.priority.toLowerCase()}`; els.detailStatus.textContent = op.status;
  const currentIdx = STATUS_ORDER.indexOf(op.status);
  els.statusRail.innerHTML = STATUS_ORDER.map((s, idx) => `<div class="status-step ${idx < currentIdx ? 'done' : ''} ${idx === currentIdx ? 'current' : ''}">${s}</div>`).join('');
  const cta = STATUS_CTA[op.status] || ['NEXT STATUS', STATUS_ORDER[Math.min(currentIdx+1, STATUS_ORDER.length-1)]];
  els.primaryWorkflowBtn.textContent = cta[0]; els.primaryWorkflowBtn.dataset.targetStatus = cta[1];
  els.undoStatusBtn.disabled = !state.undoStack.some(item => item.kind === 'status' && item.eventId === event.id);
  els.actionGrid.querySelectorAll('[data-action]').forEach(btn => { const active = !!op.actions[btn.dataset.action]; btn.classList.toggle('active', active); const s = btn.querySelector('.action-state'); if (s) s.textContent = active ? 'ON' : 'OFF'; });
  els.notesList.innerHTML = op.notes.length ? op.notes.slice(0,10).map(n => `<div class="note-card"><time>${formatTime(n.at)}</time><p>${escapeHtml(n.text)}</p></div>`).join('') : '<div class="no-events">No notes recorded for this event.</div>';
  const activity = [...op.timeline, ...op.notes.map(n => ({ at: n.at, text: `NOTE · ${n.text}` }))].sort((a,b) => new Date(b.at) - new Date(a.at));
  els.timeline.innerHTML = activity.length ? activity.map(item => `<div class="timeline-item"><div class="timeline-time">${formatTime(item.at)}</div><div class="timeline-text">${escapeHtml(item.text)}</div></div>`).join('') : '<div class="no-events">No operator activity recorded yet.</div>';
  renderCameraPreview(event);
  switchDetailTab(state.activeTab);
}

function pushUndo(item) { state.undoStack.push(item); state.undoStack = state.undoStack.slice(-25); }
function setStatusForEvent(id, targetStatus, { announce = false } = {}) {
  const event = state.allEvents.find(e => e.id === id); if (!event || !STATUS_ORDER.includes(targetStatus)) return;
  const op = operatorFor(id); const old = op.status; if (old === targetStatus) { if (announce) toast('No change', `Event is already ${targetStatus}.`, { type: 'warn' }); return; }
  op.status = targetStatus; addTimeline(id, `Status changed: ${old} → ${targetStatus}`); pushUndo({ kind: 'status', eventId: id, from: old, to: targetStatus });
  renderAll();
  if (announce) toast(`Status: ${targetStatus}`, event.title, { actionLabel: 'UNDO', onAction: () => undoLastStatusForEvent(id) });
}
function advancePrimaryWorkflow() {
  const event = state.allEvents.find(e => e.id === state.selectedId); if (!event) return;
  const target = els.primaryWorkflowBtn.dataset.targetStatus; setStatusForEvent(event.id, target, { announce: true });
}
function undoLastStatusForEvent(id) {
  const idx = [...state.undoStack].reverse().findIndex(item => item.kind === 'status' && item.eventId === id);
  if (idx < 0) return;
  const actualIdx = state.undoStack.length - 1 - idx; const item = state.undoStack.splice(actualIdx, 1)[0]; const op = operatorFor(id); const current = op.status;
  op.status = item.from; addTimeline(id, `Status restored: ${current} → ${item.from}`); renderAll(); toast('Status restored', `${current} → ${item.from}`);
}
function toggleAction(action) {
  const event = state.allEvents.find(e => e.id === state.selectedId); if (!event) return;
  const op = operatorFor(event.id); const previous = !!op.actions[action]; const next = !previous; op.actions[action] = next; addTimeline(event.id, `${ACTION_LABELS[action] || action}: ${next ? 'YES' : 'NO'}`);
  renderDetail(); renderQueue();
  toast(`${ACTION_LABELS[action] || 'Action'} ${next ? 'recorded' : 'cleared'}`, event.title, { actionLabel: 'UNDO', onAction: () => { op.actions[action] = previous; addTimeline(event.id, `${ACTION_LABELS[action] || action} restored: ${previous ? 'YES' : 'NO'}`); renderDetail(); renderQueue(); } });
}

function distanceKm(a, b) {
  const R = 6371; const dLat = (b[0]-a[0]) * Math.PI/180; const dLon = (b[1]-a[1]) * Math.PI/180;
  const lat1 = a[0] * Math.PI/180; const lat2 = b[0] * Math.PI/180;
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearbyCameras(event, limit = CONFIG.nearbyCameraCount) {
  if (!event?.coords) return [];
  return state.cameras.map(cam => ({ ...cam, distanceKm: distanceKm(event.coords, cam.coords) })).sort((a,b) => a.distanceKm-b.distanceKm).slice(0, limit);
}
function formatDistance(km) { return km < 1 ? `${Math.round(km*1000)} m` : `${km.toFixed(1)} km`; }
function renderCameraPreview(event) {
  const cameras = nearbyCameras(event, 3);
  els.cameraPreview.innerHTML = cameras.length ? cameras.map((cam, idx) => `<div class="camera-preview-item"><span><strong>${escapeHtml(cam.title)}</strong><small>${formatDistance(cam.distanceKm)} away</small></span><button data-preview-camera="${idx}">VIEW</button></div>`).join('') : '<div class="no-events">No nearby camera data available.</div>';
  els.cameraPreview.querySelectorAll('[data-preview-camera]').forEach(btn => btn.addEventListener('click', () => focusCamera(cameras[Number(btn.dataset.previewCamera)])));
}
function focusCamera(cam) {
  if (!cam) return;
  if (mapReady) { map.panTo(cam.coords); map.setZoom(16); }
  const event = state.allEvents.find(e => e.id === state.selectedId); if (event) { operatorFor(event.id).actions.cameraChecked = true; addTimeline(event.id, `Camera viewed: ${cam.title}`); renderDetail(); }
  if (cam.url) window.open(cam.url, '_blank', 'noopener');
}
function showCameraModal() {
  const event = state.allEvents.find(e => e.id === state.selectedId); if (!event) return;
  const cameras = nearbyCameras(event, 8);
  els.cameraModalList.innerHTML = cameras.length ? cameras.map((cam, idx) => `<div class="camera-modal-item"><span><strong>${escapeHtml(cam.title)}</strong><small>${formatDistance(cam.distanceKm)} · ${escapeHtml(cam.quadrant || 'Calgary')}</small></span><span class="camera-item-actions"><button data-camera-focus="${idx}">MAP</button>${cam.url ? `<a href="${escapeHtml(cam.url)}" target="_blank" rel="noopener" data-camera-open="${idx}">OPEN</a>` : ''}</span></div>`).join('') : '<div class="no-events">No traffic camera data is available.</div>';
  els.cameraModalList.querySelectorAll('[data-camera-focus]').forEach(btn => btn.addEventListener('click', () => { const cam = cameras[Number(btn.dataset.cameraFocus)]; if (mapReady && cam) { map.panTo(cam.coords); map.setZoom(16); } }));
  els.cameraModalList.querySelectorAll('[data-camera-open]').forEach(link => link.addEventListener('click', () => { const cam = cameras[Number(link.dataset.cameraOpen)]; operatorFor(event.id).actions.cameraChecked = true; addTimeline(event.id, `Camera opened: ${cam?.title || 'Traffic camera'}`); renderDetail(); }));
  els.cameraModal.classList.remove('hidden');
}
function closeCameraModal() { els.cameraModal.classList.add('hidden'); }

function renderKPIs() {
  const open = e => operatorFor(e.id).status !== 'CLOSED';
  els.kpiIncidents.textContent = state.incidents.filter(open).length;
  els.kpiActiveClosures.textContent = state.detours.filter(e => open(e) && e.operationalClass === 'ACTIVE').length;
  els.kpiUpcoming.textContent = state.allEvents.filter(e => open(e) && e.operationalClass === 'UPCOMING').length;
  els.kpiHigh.textContent = state.allEvents.filter(e => open(e) && e.operationalClass !== 'PLANNED' && e.priority === 'HIGH').length;
  els.kpiWeather.textContent = state.weather.length;
}
function renderTicker() {
  const messages = [];
  state.incidents.slice(0,4).forEach(e => messages.push(`INCIDENT · ${e.title} · updated ${formatTime(e.updated || e.start)}`));
  state.detours.filter(e => e.operationalClass === 'ACTIVE').slice(0,3).forEach(e => messages.push(`ACTIVE CLOSURE · ${e.title}${e.activityReason ? ` · ${e.activityReason}` : ''}`));
  state.detours.filter(e => e.operationalClass === 'UPCOMING').slice(0,3).forEach(e => messages.push(`UPCOMING · ${e.title}${e.activityReason ? ` · ${e.activityReason}` : ''}`));
  state.weather.slice(0,2).forEach(f => { const p = f.properties || {}; messages.push(`WEATHER · ${p.alert_name_en || p.alert_short_name_en || 'Alert'} · ${p.feature_name_en || 'Calgary region'}`); });
  if (!messages.length) messages.push('No live operational updates available.'); els.ticker.textContent = messages.join('     ◆     ');
}
function renderAll() { renderQueue(); renderMap(); if (state.selectedId) renderDetail(); renderKPIs(); renderTicker(); }

function exportSelectedEvent() {
  const event = state.allEvents.find(e => e.id === state.selectedId); if (!event) return;
  const payload = { event, operator: operatorFor(event.id), exportedAt: new Date().toISOString(), prototypeNotice: 'Local browser record; not written back to City source systems.' };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `${event.id}.json`; a.click(); URL.revokeObjectURL(url); toast('Event exported', `${event.id}.json`);
}
function fitEvents() {
  if (!mapReady || !map) return;
  const pts = state.allEvents.filter(e => e.coords && (e.operationalClass !== 'PLANNED' || state.layersEnabled.PLANNED)).map(e => e.coords);
  if (!pts.length) {
    map.fitBounds(CONFIG.calgaryBounds, { padding: [44, 44], maxZoom: 13 });
    return;
  }
  map.fitBounds(pts, { padding: [44, 44], maxZoom: 13 });
}
function openManualModal(coords = null) {
  els.manualEventModal.classList.remove('hidden');
  const form = els.manualEventForm; const now = new Date(); const local = new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0,16); form.elements.start.value = local;
  if (coords) { form.elements.lat.value = Number(coords.lat).toFixed(6); form.elements.lon.value = Number(coords.lon).toFixed(6); }
}
function closeManualModal() { els.manualEventModal.classList.add('hidden'); }
function createManualEvent(formData) {
  const id = `TMC-${Date.now().toString(36).toUpperCase()}`;
  const event = { id, title: formData.get('title').trim(), description: formData.get('description').trim(), priority: formData.get('priority'), start: formData.get('start') ? new Date(formData.get('start')).toISOString() : new Date().toISOString(), updated: new Date().toISOString(), coords: [Number(formData.get('lat')), Number(formData.get('lon'))] };
  state.manual.unshift(event); saveLocal('tmc_manual_events_v1', state.manual); operatorFor(id); addTimeline(id, 'Manual TMC event created'); rebuildEvents(); closeManualModal(); renderAll(); selectEvent(id); toast('Manual event created', event.title);
}

function cacheElements() {
  [
    'clock','dateLabel','systemHealth','healthText','openQuickCreateBtn','newEventBtn','eventSearch','filterRow','queueCount','lastRefresh','eventQueue',
    'fitEventsBtn','refreshBtn','layersToggleBtn','layerBox','closeLayersBtn','mapStatus','mapHint','eventDrawer','closeDrawerBtn','detailSource','detailTitle','detailPriority','detailStatus','detailId','detailType',
    'detailStart','detailUpdated','detailDescription','statusRail','undoStatusBtn','primaryWorkflowBtn','cameraCommandBtn','moreActionsBtn','detailTabs','actionGrid',
    'noteInput','addNoteBtn','notesList','nearestCameraBtn','exportEventBtn','timeline','cameraPreview','showCamerasBtn','kpiIncidents','kpiActiveClosures','kpiUpcoming','kpiHigh','kpiWeather','ticker',
    'mapContextMenu','contextCreateEventBtn','contextCenterBtn','manualEventModal','closeModalBtn','cancelModalBtn','manualEventForm','useMapCenterBtn','cameraModal','closeCameraModalBtn','cameraModalList','toastStack'
  ].forEach(id => els[id] = document.getElementById(id));
}
function bindEvents() {
  els.eventSearch.addEventListener('input', e => { state.search = e.target.value; renderQueue(); });
  els.filterRow.addEventListener('click', e => { const btn = e.target.closest('[data-filter]'); if (!btn) return; state.filter = btn.dataset.filter; els.filterRow.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b === btn)); renderQueue(); });
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', () => { state.layersEnabled[input.dataset.layer] = input.checked; syncLayerVisibility(); }));
  els.refreshBtn.addEventListener('click', () => refreshData()); els.fitEventsBtn.addEventListener('click', fitEvents);
  els.layersToggleBtn.addEventListener('click', e => { e.stopPropagation(); toggleLayersPanel(); });
  els.closeLayersBtn.addEventListener('click', e => { e.stopPropagation(); setLayersPanel(false); });
  els.layerBox.addEventListener('click', e => e.stopPropagation());
  els.openQuickCreateBtn.addEventListener('click', () => openManualModal()); els.newEventBtn.addEventListener('click', () => openManualModal());
  els.closeDrawerBtn.addEventListener('click', closeDrawer); els.detailTabs.addEventListener('click', e => { const btn = e.target.closest('[data-tab]'); if (btn) switchDetailTab(btn.dataset.tab); });
  els.primaryWorkflowBtn.addEventListener('click', advancePrimaryWorkflow); els.undoStatusBtn.addEventListener('click', () => { if (state.selectedId) undoLastStatusForEvent(state.selectedId); });
  els.cameraCommandBtn.addEventListener('click', showCameraModal); els.showCamerasBtn.addEventListener('click', showCameraModal); els.nearestCameraBtn.addEventListener('click', showCameraModal);
  els.moreActionsBtn.addEventListener('click', () => switchDetailTab('actions'));
  els.actionGrid.addEventListener('click', e => { const btn = e.target.closest('[data-action]'); if (btn) toggleAction(btn.dataset.action); });
  els.addNoteBtn.addEventListener('click', () => { const event = state.allEvents.find(e => e.id === state.selectedId); const text = els.noteInput.value.trim(); if (!event || !text) return; operatorFor(event.id).notes.unshift({ at: new Date().toISOString(), text }); persistOperator(); els.noteInput.value = ''; addTimeline(event.id, 'Operator note added'); renderDetail(); toast('Note added', event.title); });
  els.noteInput.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') els.addNoteBtn.click(); });
  els.exportEventBtn.addEventListener('click', exportSelectedEvent);
  els.contextCreateEventBtn.addEventListener('click', createEventAtContextLocation); els.contextCenterBtn.addEventListener('click', () => { if (mapReady && state.mapContextLatLng) map.panTo(state.mapContextLatLng); closeMapContextMenu(); });
  document.addEventListener('click', e => { if (!e.target.closest('#mapContextMenu')) closeMapContextMenu(); });
  els.closeModalBtn.addEventListener('click', closeManualModal); els.cancelModalBtn.addEventListener('click', closeManualModal); els.manualEventModal.addEventListener('click', e => { if (e.target === els.manualEventModal) closeManualModal(); });
  els.useMapCenterBtn.addEventListener('click', () => { if (!mapReady || !map) return; const c = map.getCenter(); els.manualEventForm.elements.lat.value = c.lat.toFixed(6); els.manualEventForm.elements.lon.value = c.lng.toFixed(6); });
  els.manualEventForm.addEventListener('submit', e => { e.preventDefault(); createManualEvent(new FormData(e.currentTarget)); e.currentTarget.reset(); });
  els.closeCameraModalBtn.addEventListener('click', closeCameraModal); els.cameraModal.addEventListener('click', e => { if (e.target === els.cameraModal) closeCameraModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeManualModal(); closeCameraModal(); closeMapContextMenu(); setLayersPanel(false); } });
}

async function init() {
  cacheElements(); bindEvents(); rebuildEvents(); formatClockDate(); setInterval(formatClockDate, 1000); await initMap(); renderAll(); refreshData(); setInterval(() => refreshData({ silent: true }), CONFIG.refreshMs);
}

document.addEventListener('DOMContentLoaded', init);
