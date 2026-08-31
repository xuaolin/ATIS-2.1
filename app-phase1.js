/* Calgary TMC Traffic Event Management — Phase 1 UX + Leaflet/OpenStreetMap + operational detour filtering */

const CONFIG = {
  // No map API key required. Basemap uses OpenStreetMap standard tiles through Leaflet.
  calgaryCenter: [51.0447, -114.0719],
  calgaryBounds: [[50.75, -114.45], [51.35, -113.65]],
  refreshMs: 5 * 60 * 1000,
  detourLookAheadHours: 6,
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
  filter: 'ALL',
  search: '',
  activeTab: 'overview',
  feedErrors: [],
  markersByEventId: new Map(),
  layersEnabled: { INCIDENT: true, DETOUR: true, MANUAL: true, CAMERA: false, WEATHER: true },
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

function normalizeIncident(row, i) {
  const coords = pointFrom(row);
  const title = row.incident_info || row.description || `Traffic incident ${i + 1}`;
  const description = row.description || row.incident_info || 'No additional description provided.';
  const start = firstDate(row, ['start_dt','start_date','start','begin_dt']);
  const updated = firstDate(row, ['modified_dt','updated_dt','updated','start_dt']) || start;
  return { id: `INC-${slug(title)}-${slug(start || String(i))}`, sourceId: row.id || null, source: 'CITY OF CALGARY · CURRENT TRAFFIC INCIDENTS', type: 'INCIDENT', title, description, start, updated, coords, priority: inferIncidentPriority(`${title} ${description}`), raw: row };
}
function normalizeDetour(row, i) {
  const coords = pointFrom(row);
  const title = row.construction_info || row.detour_info || row.title || row.description || `Construction detour ${i + 1}`;
  const description = row.description || row.construction_info || row.detour_info || 'No additional description provided.';
  const start = firstDate(row, ['start_dt','start_date','start_datetime','start','begin_dt','from_dt']);
  const end = firstDate(row, ['end_dt','end_date','end_datetime','end','finish_dt','to_dt']);
  const updated = firstDate(row, ['modified_dt','updated_dt','updated','start_dt']) || start;
  return { id: `DET-${slug(title)}-${slug(start || end || String(i))}`, source: 'CITY OF CALGARY · CONSTRUCTION DETOURS', type: 'DETOUR', title, description, start, end, updated, coords, priority: inferDetourPriority(`${title} ${description}`), raw: row };
}
function normalizeManual(row) { return { ...row, type: 'MANUAL', source: 'TMC MANUAL EVENT' }; }
function isOperationalDetour(event) {
  const s = `${event.title || ''} ${event.description || ''}`.toLowerCase();
  return /closed|closure|lane|detour|ramp|traffic|intersection|access|road/.test(s);
}
function detourInWindow(event) {
  const now = Date.now();
  const horizon = now + CONFIG.detourLookAheadHours * 3600 * 1000;
  const start = parseDate(event.start)?.getTime() ?? null;
  const end = parseDate(event.end)?.getTime() ?? null;
  if (start === null && end === null) return false;
  if (end !== null && end < now) return false;
  if (start !== null && start > horizon) return false;
  if (start !== null && end !== null) return end >= now && start <= horizon;
  if (start !== null) {
    const assumedEnd = start + (CONFIG.detourAssumedDurationHours || 8) * 3600 * 1000;
    return assumedEnd >= now && start <= horizon;
  }
  return end >= now && end <= horizon + 12 * 3600 * 1000;
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
      if (name === 'detours') state.detours = dedupeDetours((result.value || []).map(normalizeDetour).filter(e => e.coords).filter(isOperationalDetour).filter(detourInWindow));
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
  state.incidents = [{ id: 'DEMO-INC-001', source: 'DEMO FALLBACK · LIVE FEED UNAVAILABLE', type: 'INCIDENT', title: 'Demo collision — Deerfoot Trail NE', description: 'Sample event displayed only because live public feeds could not be reached from this browser.', start: new Date(now.getTime() - 18*60000).toISOString(), updated: now.toISOString(), coords: [51.084, -113.992], priority: 'HIGH', raw: {} }];
  state.detours = [{ id: 'DEMO-DET-001', source: 'DEMO FALLBACK · LIVE FEED UNAVAILABLE', type: 'DETOUR', title: 'Demo planned closure — 16 Avenue NW', description: 'Sample construction detour for interface demonstration.', start: new Date(now.getTime() - 60*60000).toISOString(), end: new Date(now.getTime() + 8*3600*1000).toISOString(), updated: now.toISOString(), coords: [51.067, -114.105], priority: 'MEDIUM', raw: {} }];
}
function rebuildEvents() {
  const manual = state.manual.map(normalizeManual);
  state.allEvents = [...state.incidents, ...state.detours, ...manual].sort((a, b) => (parseDate(b.updated || b.start)?.getTime() || 0) - (parseDate(a.updated || a.start)?.getTime() || 0));
}
function updateHealth() {
  els.systemHealth.classList.remove('healthy', 'degraded');
  if (!state.feedErrors.length) { els.systemHealth.classList.add('healthy'); els.healthText.textContent = 'PUBLIC FEEDS ONLINE'; }
  else { els.systemHealth.classList.add('degraded'); els.healthText.textContent = 'DEGRADED'; }
}
function setMapStatus(text) { els.mapStatus.textContent = text; }

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

  layers = {
    INCIDENT: L.layerGroup(),
    DETOUR: L.layerGroup(),
    MANUAL: L.layerGroup(),
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
  map.on('click', () => closeMapContextMenu());

  mapReady = true;
  syncLayerVisibility();
  setMapStatus('MAP ONLINE · OpenStreetMap');
}

function markerIcon(type) {
  const styles = {
    INCIDENT: { fill: '#d82f43', stroke: '#fff', glyph: '!' },
    DETOUR: { fill: '#e6a23c', stroke: '#fff', glyph: '↪' },
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
    if (!event.coords || !layers[event.type]) return;
    const marker = L.marker(event.coords, {
      icon: markerIcon(event.type),
      title: event.title,
      riseOnHover: true
    });

    const op = operatorFor(event.id);
    marker.bindPopup(`<div class="gm-popup"><div class="popup-kicker">${escapeHtml(event.type)} · ${escapeHtml(op.status)}</div><div class="popup-title">${escapeHtml(event.title)}</div><div>${escapeHtml(event.description).slice(0,180)}</div><div class="popup-actions"><button data-map-action="open" data-id="${escapeHtml(event.id)}">OPEN</button><button data-map-action="camera" data-id="${escapeHtml(event.id)}">CAMERAS</button><button data-map-action="verify" data-id="${escapeHtml(event.id)}">VERIFY</button></div></div>`);

    marker.on('click', () => selectEvent(event.id, false));
    marker.on('popupopen', bindPopupActions);
    marker.addTo(layers[event.type]);

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

  ['INCIDENT','DETOUR','MANUAL','CAMERA'].forEach(name => {
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
  return state.allEvents.filter(e => { if (state.filter !== 'ALL' && e.type !== state.filter) return false; if (!q) return true; return `${e.title} ${e.description} ${e.id}`.toLowerCase().includes(q); });
}
function renderQueue() {
  const events = filteredEvents(); els.queueCount.textContent = events.length;
  if (!events.length) { els.eventQueue.innerHTML = '<div class="no-events">No events match the current filter.</div>'; return; }
  els.eventQueue.innerHTML = events.map(event => {
    const op = operatorFor(event.id); const verified = op.status === 'VERIFIED' || STATUS_ORDER.indexOf(op.status) > STATUS_ORDER.indexOf('VERIFIED');
    return `<article class="event-card priority-${event.priority} ${state.selectedId === event.id ? 'selected' : ''}" data-event-id="${escapeHtml(event.id)}"><span class="priority-line"></span><div class="event-card-head"><span class="event-type">${escapeHtml(event.type)}</span><span class="status-chip">${escapeHtml(op.status)}</span><span class="event-time">${relativeAge(event.updated || event.start)}</span></div><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.description)}</p><div class="quick-actions"><button class="quick-btn" data-quick="camera">CAMERA</button><button class="quick-btn ${verified ? 'success' : ''}" data-quick="verify">${verified ? 'VERIFIED' : 'VERIFY'}</button><button class="quick-btn" data-quick="open">OPEN</button></div></article>`;
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
  els.detailSource.textContent = event.source; els.detailTitle.textContent = event.title; els.detailId.textContent = event.id; els.detailType.textContent = event.type;
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
  els.kpiIncidents.textContent = state.incidents.filter(e => operatorFor(e.id).status !== 'CLOSED').length;
  els.kpiDetours.textContent = state.detours.filter(e => operatorFor(e.id).status !== 'CLOSED').length;
  els.kpiHigh.textContent = state.allEvents.filter(e => e.priority === 'HIGH' && operatorFor(e.id).status !== 'CLOSED').length;
  els.kpiWeather.textContent = state.weather.length;
}
function renderTicker() {
  const messages = [];
  state.incidents.slice(0,4).forEach(e => messages.push(`INCIDENT · ${e.title} · updated ${formatTime(e.updated || e.start)}`));
  state.detours.slice(0,3).forEach(e => messages.push(`DETOUR · ${e.title} · start ${formatTime(e.start)}`));
  state.weather.slice(0,3).forEach(f => { const p = f.properties || {}; messages.push(`WEATHER · ${p.alert_name_en || p.alert_short_name_en || 'Alert'} · ${p.feature_name_en || 'Calgary region'}`); });
  if (!messages.length) messages.push('No live updates available.'); els.ticker.textContent = messages.join('     ◆     ');
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
  const pts = state.allEvents.filter(e => e.coords).map(e => e.coords);
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
    'fitEventsBtn','refreshBtn','mapStatus','mapHint','eventDrawer','closeDrawerBtn','detailSource','detailTitle','detailPriority','detailStatus','detailId','detailType',
    'detailStart','detailUpdated','detailDescription','statusRail','undoStatusBtn','primaryWorkflowBtn','cameraCommandBtn','moreActionsBtn','detailTabs','actionGrid',
    'noteInput','addNoteBtn','notesList','nearestCameraBtn','exportEventBtn','timeline','cameraPreview','showCamerasBtn','kpiIncidents','kpiDetours','kpiHigh','kpiWeather','ticker',
    'mapContextMenu','contextCreateEventBtn','contextCenterBtn','manualEventModal','closeModalBtn','cancelModalBtn','manualEventForm','useMapCenterBtn','cameraModal','closeCameraModalBtn','cameraModalList','toastStack'
  ].forEach(id => els[id] = document.getElementById(id));
}
function bindEvents() {
  els.eventSearch.addEventListener('input', e => { state.search = e.target.value; renderQueue(); });
  els.filterRow.addEventListener('click', e => { const btn = e.target.closest('[data-filter]'); if (!btn) return; state.filter = btn.dataset.filter; els.filterRow.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b === btn)); renderQueue(); });
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', () => { state.layersEnabled[input.dataset.layer] = input.checked; syncLayerVisibility(); }));
  els.refreshBtn.addEventListener('click', () => refreshData()); els.fitEventsBtn.addEventListener('click', fitEvents);
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeManualModal(); closeCameraModal(); closeMapContextMenu(); } });
}

async function init() {
  cacheElements(); bindEvents(); rebuildEvents(); formatClockDate(); setInterval(formatClockDate, 1000); await initMap(); renderAll(); refreshData(); setInterval(() => refreshData({ silent: true }), CONFIG.refreshMs);
}

document.addEventListener('DOMContentLoaded', init);
