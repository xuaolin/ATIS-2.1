/* Calgary TMC Traffic Event Management — V2 operations console */

const CONFIG = {
  // Google Maps JavaScript API key. Restrict this key to your GitHub Pages domain and Maps JavaScript API.
  googleMapsApiKey: 'PASTE_YOUR_GOOGLE_MAPS_API_KEY_HERE',
  calgaryCenter: [51.0447, -114.0719],
  calgaryBounds: [[50.75, -114.45], [51.35, -113.65]],
  refreshMs: 5 * 60 * 1000,
  detourLookAheadHours: 24,
  sources: {
    incidents: 'https://data.calgary.ca/resource/4jah-h97u.json?$limit=250',
    detours: 'https://data.calgary.ca/resource/w8zq-79bq.json?$limit=1000',
    cameras: 'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500',
    weather: 'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&bbox=-114.45,50.75,-113.65,51.35&limit=50'
  }
};

const STATUS_ORDER = ['NEW', 'REVIEW', 'VERIFIED', 'RESPONDING', 'MONITORING', 'CLEARED', 'CLOSED'];
const ACTION_LABELS = {
  verified: 'Event verification changed',
  cameraChecked: 'Camera check changed',
  signalReviewed: 'Signal timing review changed',
  dmsActivated: 'DMS action changed',
  detourRequired: 'Detour requirement changed',
  publicUpdate: 'Public update action changed'
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
  feedErrors: [],
  markersByEventId: new Map(),
  layersEnabled: { TRAFFIC: true, INCIDENT: true, DETOUR: true, MANUAL: true, CAMERA: false, WEATHER: true }
};

const els = {};
let map;
let trafficLayer;
let weatherDataLayer;
let infoWindow;
let layers = {};
let mapReady = false;

function loadLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveLocal(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}
function slug(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 42) || 'event';
}
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
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
  if (mins < 1) return 'NOW';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}
function pointFrom(obj) {
  if (obj?.point?.coordinates?.length >= 2) return [Number(obj.point.coordinates[1]), Number(obj.point.coordinates[0])];
  const lat = Number(obj?.latitude ?? obj?.lat);
  const lon = Number(obj?.longitude ?? obj?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}
function inferPriority(text = '') {
  const s = text.toLowerCase();
  if (/all lanes|road closed|full closure|major|serious|multi-vehicle|emergency|fatal|blocked|closure/.test(s)) return 'HIGH';
  if (/collision|signal|hazard|stalled|lane|detour|construction/.test(s)) return 'MEDIUM';
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
  op.timeline = op.timeline.slice(0, 80);
  persistOperator();
}

function normalizeIncident(row, i) {
  const coords = pointFrom(row);
  const title = row.incident_info || row.description || `Traffic incident ${i + 1}`;
  const description = row.description || row.incident_info || 'No additional description provided.';
  return {
    id: `INC-${slug(title)}-${slug(row.start_dt || String(i))}`,
    sourceId: row.id || null,
    source: 'CITY OF CALGARY · CURRENT TRAFFIC INCIDENTS',
    type: 'INCIDENT',
    title,
    description,
    start: row.start_dt || null,
    updated: row.modified_dt || row.start_dt || null,
    coords,
    priority: inferPriority(`${title} ${description}`),
    raw: row
  };
}

function normalizeDetour(row, i) {
  const coords = pointFrom(row);
  const title = row.construction_info || row.description || `Construction detour ${i + 1}`;
  const description = row.description || row.construction_info || 'No additional description provided.';
  return {
    id: `DET-${slug(title)}-${slug(row.start_dt || String(i))}`,
    source: 'CITY OF CALGARY · CONSTRUCTION DETOURS',
    type: 'DETOUR',
    title,
    description,
    start: row.start_dt || null,
    end: row.end_dt || null,
    updated: row.start_dt || null,
    coords,
    priority: inferPriority(`${title} ${description}`),
    raw: row
  };
}

function normalizeManual(row) {
  return { ...row, type: 'MANUAL', source: 'TMC MANUAL EVENT' };
}

function detourInWindow(event) {
  const now = Date.now();
  const start = parseDate(event.start)?.getTime() ?? now;
  const end = parseDate(event.end)?.getTime() ?? (start + 24*3600*1000);
  const lookAhead = CONFIG.detourLookAheadHours * 3600 * 1000;
  return end >= now && start <= now + lookAhead;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json, application/geo+json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function refreshData({ silent = false } = {}) {
  if (!silent) setMapStatus('Refreshing Calgary public feeds…');
  state.feedErrors = [];

  const tasks = [
    ['incidents', CONFIG.sources.incidents],
    ['detours', CONFIG.sources.detours],
    ['cameras', CONFIG.sources.cameras],
    ['weather', CONFIG.sources.weather]
  ];
  const settled = await Promise.allSettled(tasks.map(([, url]) => fetchJson(url)));

  settled.forEach((result, idx) => {
    const name = tasks[idx][0];
    if (result.status === 'fulfilled') {
      if (name === 'incidents') state.incidents = (result.value || []).map(normalizeIncident).filter(e => e.coords);
      if (name === 'detours') state.detours = (result.value || []).map(normalizeDetour).filter(e => e.coords).filter(detourInWindow);
      if (name === 'cameras') state.cameras = (result.value || []).map((c, i) => ({
        id: `CAM-${i}-${slug(c.camera_location || '')}`,
        title: c.camera_location || `Traffic camera ${i+1}`,
        quadrant: c.quadrant || '',
        url: typeof c.camera_url === 'object' ? c.camera_url.url : c.camera_url,
        coords: pointFrom(c), raw: c
      })).filter(c => c.coords);
      if (name === 'weather') state.weather = result.value?.features || [];
    } else {
      state.feedErrors.push(`${name}: ${result.reason?.message || 'failed'}`);
    }
  });

  if (!state.incidents.length && !state.detours.length && state.feedErrors.length >= 2) injectDemoFallback();

  rebuildEvents();
  renderAll();
  const now = new Date();
  els.lastRefresh.textContent = `REFRESH ${formatTime(now)}`;
  updateHealth();
  setMapStatus(state.feedErrors.length ? `DEGRADED · ${state.feedErrors.join(' · ')}` : 'LIVE · Google Traffic + Calgary Open Data + ECCC');
}

function injectDemoFallback() {
  const now = new Date();
  state.incidents = [{
    id: 'DEMO-INC-001', source: 'DEMO FALLBACK · LIVE FEED UNAVAILABLE', type: 'INCIDENT',
    title: 'Demo collision — Deerfoot Trail NE',
    description: 'Sample event displayed only because live public feeds could not be reached from this browser.',
    start: new Date(now.getTime() - 18*60000).toISOString(), updated: now.toISOString(), coords: [51.084, -113.992], priority: 'HIGH', raw: {}
  }];
  state.detours = [{
    id: 'DEMO-DET-001', source: 'DEMO FALLBACK · LIVE FEED UNAVAILABLE', type: 'DETOUR',
    title: 'Demo planned closure — 16 Avenue NW',
    description: 'Sample construction detour for interface demonstration.',
    start: new Date(now.getTime() - 60*60000).toISOString(), end: new Date(now.getTime() + 8*3600*1000).toISOString(), updated: now.toISOString(), coords: [51.067, -114.105], priority: 'MEDIUM', raw: {}
  }];
}

function rebuildEvents() {
  const manual = state.manual.map(normalizeManual);
  state.allEvents = [...state.incidents, ...state.detours, ...manual]
    .sort((a, b) => (parseDate(b.updated || b.start)?.getTime() || 0) - (parseDate(a.updated || a.start)?.getTime() || 0));
}

function updateHealth() {
  els.systemHealth.classList.remove('healthy', 'degraded');
  if (!state.feedErrors.length) {
    els.systemHealth.classList.add('healthy');
    els.healthText.textContent = 'PUBLIC FEEDS ONLINE';
  } else {
    els.systemHealth.classList.add('degraded');
    els.healthText.textContent = 'DEGRADED';
  }
}
function setMapStatus(text) { els.mapStatus.textContent = text; }

async function loadGoogleMapsApi() {
  if (window.google?.maps) return;
  const key = String(CONFIG.googleMapsApiKey || '').trim();
  if (!key || key.includes('PASTE_YOUR')) {
    throw new Error('GOOGLE_MAPS_API_KEY_REQUIRED');
  }

  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-maps-loader]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Maps failed to load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.googleMapsLoader = 'true';
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(script);
  });
}

async function initMap() {
  try {
    await loadGoogleMapsApi();
  } catch (err) {
    mapReady = false;
    const mapEl = document.getElementById('map');
    mapEl.innerHTML = `<div class="map-key-required"><div class="map-key-icon">G</div><strong>GOOGLE MAPS API KEY REQUIRED</strong><span>Add your key at the top of <code>app.js</code>, then refresh.</span></div>`;
    setMapStatus('MAP OFFLINE · Google Maps API key required');
    return;
  }

  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: CONFIG.calgaryCenter[0], lng: CONFIG.calgaryCenter[1] },
    zoom: 11,
    mapTypeId: 'roadmap',
    disableDefaultUI: true,
    zoomControl: true,
    scaleControl: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
    backgroundColor: '#e9ecef'
  });

  infoWindow = new google.maps.InfoWindow({ disableAutoPan: false });
  trafficLayer = new google.maps.TrafficLayer();
  weatherDataLayer = new google.maps.Data();
  weatherDataLayer.setStyle({
    strokeColor: '#2385d9',
    strokeOpacity: 0.92,
    strokeWeight: 2,
    fillColor: '#2385d9',
    fillOpacity: 0.08
  });
  weatherDataLayer.addListener('click', ev => {
    const props = {};
    ev.feature.forEachProperty((value, key) => { props[key] = value; });
    const name = props.alert_name_en || props.alert_short_name_en || 'Weather alert';
    const area = props.feature_name_en || '';
    infoWindow.setContent(`<div class="gm-popup"><div class="popup-kicker">ECCC WEATHER ALERT</div><div class="popup-title">${escapeHtml(name)}</div><div>${escapeHtml(area)}</div></div>`);
    infoWindow.setPosition(ev.latLng);
    infoWindow.open({ map });
  });

  layers = { INCIDENT: [], DETOUR: [], MANUAL: [], CAMERA: [] };
  mapReady = true;
  syncLayerVisibility();
}

function markerSvg(type) {
  const styles = {
    INCIDENT: { fill: '#d82f43', stroke: '#ffffff', glyph: '!' },
    DETOUR: { fill: '#e6a23c', stroke: '#ffffff', glyph: '↪' },
    MANUAL: { fill: '#35bce8', stroke: '#ffffff', glyph: '+' },
    CAMERA: { fill: '#526779', stroke: '#ffffff', glyph: '●' }
  };
  const s = styles[type] || styles.MANUAL;
  const size = type === 'CAMERA' ? 22 : 30;
  const fontSize = type === 'CAMERA' ? 8 : 14;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2"/><circle cx="16" cy="16" r="14" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="2"/><text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${s.glyph}</text></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2)
  };
}

function clearGoogleMarkers() {
  Object.values(layers).forEach(items => {
    if (!Array.isArray(items)) return;
    items.forEach(marker => marker.setMap(null));
    items.length = 0;
  });
  state.markersByEventId.clear();
  if (weatherDataLayer) {
    const features = [];
    weatherDataLayer.forEach(feature => features.push(feature));
    features.forEach(feature => weatherDataLayer.remove(feature));
  }
}

function renderMap() {
  if (!mapReady || !map) return;
  clearGoogleMarkers();

  state.allEvents.forEach(event => {
    if (!event.coords || !layers[event.type]) return;
    const marker = new google.maps.Marker({
      position: { lat: event.coords[0], lng: event.coords[1] },
      map: state.layersEnabled[event.type] ? map : null,
      icon: markerSvg(event.type),
      title: event.title,
      optimized: true,
      zIndex: event.priority === 'HIGH' ? 30 : event.priority === 'MEDIUM' ? 20 : 10
    });
    marker.addListener('click', () => {
      infoWindow.setContent(`<div class="gm-popup"><div class="popup-kicker">${escapeHtml(event.type)}</div><div class="popup-title">${escapeHtml(event.title)}</div><div>${escapeHtml(event.description).slice(0,180)}</div></div>`);
      infoWindow.open({ map, anchor: marker });
      selectEvent(event.id, false);
    });
    layers[event.type].push(marker);
    state.markersByEventId.set(event.id, marker);
  });

  state.cameras.forEach(cam => {
    const marker = new google.maps.Marker({
      position: { lat: cam.coords[0], lng: cam.coords[1] },
      map: state.layersEnabled.CAMERA ? map : null,
      icon: markerSvg('CAMERA'),
      title: cam.title,
      optimized: true,
      zIndex: 5
    });
    marker.addListener('click', () => {
      const safeUrl = cam.url ? escapeHtml(cam.url) : '';
      infoWindow.setContent(`<div class="gm-popup"><div class="popup-kicker">TRAFFIC CAMERA</div><div class="popup-title">${escapeHtml(cam.title)}</div>${safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener">Open camera</a>` : ''}</div>`);
      infoWindow.open({ map, anchor: marker });
    });
    layers.CAMERA.push(marker);
  });

  if (state.weather.length) {
    try {
      weatherDataLayer.addGeoJson({ type: 'FeatureCollection', features: state.weather });
    } catch { /* skip malformed geometry */ }
  }

  syncLayerVisibility();
}

function syncLayerVisibility() {
  if (!mapReady || !map) return;

  if (trafficLayer) trafficLayer.setMap(state.layersEnabled.TRAFFIC ? map : null);

  ['INCIDENT', 'DETOUR', 'MANUAL', 'CAMERA'].forEach(name => {
    const visible = !!state.layersEnabled[name];
    (layers[name] || []).forEach(marker => marker.setMap(visible ? map : null));
  });

  if (weatherDataLayer) weatherDataLayer.setMap(state.layersEnabled.WEATHER ? map : null);
}

function filteredEvents() {
  const q = state.search.trim().toLowerCase();
  return state.allEvents.filter(e => {
    if (state.filter !== 'ALL' && e.type !== state.filter) return false;
    if (!q) return true;
    return `${e.title} ${e.description} ${e.id}`.toLowerCase().includes(q);
  });
}

function renderQueue() {
  const events = filteredEvents();
  els.queueCount.textContent = events.length;
  if (!events.length) {
    els.eventQueue.innerHTML = '<div class="no-events">No events match the current filter.</div>';
    return;
  }
  els.eventQueue.innerHTML = events.map(event => {
    const op = operatorFor(event.id);
    return `<article class="event-card priority-${event.priority} ${state.selectedId === event.id ? 'selected' : ''}" data-event-id="${escapeHtml(event.id)}">
      <span class="priority-line"></span>
      <div class="event-card-head">
        <span class="event-type">${escapeHtml(event.type)}</span>
        <span class="status-chip">${escapeHtml(op.status)}</span>
        <span class="event-time">${relativeAge(event.updated || event.start)}</span>
      </div>
      <h3>${escapeHtml(event.title)}</h3>
      <p>${escapeHtml(event.description)}</p>
    </article>`;
  }).join('');

  els.eventQueue.querySelectorAll('[data-event-id]').forEach(card => {
    card.addEventListener('click', () => selectEvent(card.dataset.eventId));
  });
}

function selectEvent(id, pan = true) {
  const event = state.allEvents.find(e => e.id === id);
  if (!event) return;
  state.selectedId = id;
  operatorFor(id);
  renderQueue();
  renderDetail();
  if (pan && event.coords && mapReady) {
    map.panTo({ lat: event.coords[0], lng: event.coords[1] });
    if ((map.getZoom() || 0) < 14) map.setZoom(14);
  }
}

function renderDetail() {
  const event = state.allEvents.find(e => e.id === state.selectedId);
  if (!event) {
    els.emptyDetail.classList.remove('hidden');
    els.eventDetail.classList.add('hidden');
    return;
  }
  const op = operatorFor(event.id);
  els.emptyDetail.classList.add('hidden');
  els.eventDetail.classList.remove('hidden');
  els.detailSource.textContent = event.source;
  els.detailTitle.textContent = event.title;
  els.detailId.textContent = event.id;
  els.detailType.textContent = event.type;
  els.detailStart.textContent = formatTime(event.start);
  els.detailUpdated.textContent = formatTime(event.updated || event.start);
  els.detailDescription.textContent = event.description;
  els.detailPriority.textContent = event.priority;
  els.detailPriority.className = `priority-badge ${event.priority.toLowerCase()}`;

  const currentIdx = STATUS_ORDER.indexOf(op.status);
  els.statusRail.innerHTML = STATUS_ORDER.map((s, idx) => `<div class="status-step ${idx < currentIdx ? 'done' : ''} ${idx === currentIdx ? 'current' : ''}">${s}</div>`).join('');
  els.previousStatusBtn.disabled = currentIdx <= 0;
  els.nextStatusBtn.disabled = currentIdx >= STATUS_ORDER.length - 1;

  els.actionGrid.querySelectorAll('[data-action]').forEach(input => {
    input.checked = !!op.actions[input.dataset.action];
  });

  const activity = [
    ...op.timeline,
    ...op.notes.map(n => ({ at: n.at, text: `NOTE · ${n.text}` }))
  ].sort((a,b) => new Date(b.at) - new Date(a.at));
  els.timeline.innerHTML = activity.length ? activity.map(item => `<div class="timeline-item"><div class="timeline-time">${formatTime(item.at)}</div><div class="timeline-text">${escapeHtml(item.text)}</div></div>`).join('') : '<div class="no-events">No operator activity recorded yet.</div>';
}

function changeStatus(delta) {
  const event = state.allEvents.find(e => e.id === state.selectedId);
  if (!event) return;
  const op = operatorFor(event.id);
  const oldIdx = STATUS_ORDER.indexOf(op.status);
  const nextIdx = Math.min(STATUS_ORDER.length - 1, Math.max(0, oldIdx + delta));
  if (nextIdx === oldIdx) return;
  const old = op.status;
  op.status = STATUS_ORDER[nextIdx];
  addTimeline(event.id, `Status changed: ${old} → ${op.status}`);
  renderAll();
}

function renderKPIs() {
  const activeIncidents = state.incidents.filter(e => operatorFor(e.id).status !== 'CLOSED').length;
  const activeDetours = state.detours.filter(e => operatorFor(e.id).status !== 'CLOSED').length;
  const high = state.allEvents.filter(e => e.priority === 'HIGH' && operatorFor(e.id).status !== 'CLOSED').length;
  els.kpiIncidents.textContent = activeIncidents;
  els.kpiDetours.textContent = activeDetours;
  els.kpiHigh.textContent = high;
  els.kpiWeather.textContent = state.weather.length;
}

function renderTicker() {
  const messages = [];
  state.incidents.slice(0,4).forEach(e => messages.push(`INCIDENT · ${e.title} · updated ${formatTime(e.updated || e.start)}`));
  state.detours.slice(0,3).forEach(e => messages.push(`DETOUR · ${e.title} · start ${formatTime(e.start)}`));
  state.weather.slice(0,3).forEach(f => {
    const p = f.properties || {};
    messages.push(`WEATHER · ${p.alert_name_en || p.alert_short_name_en || 'Alert'} · ${p.feature_name_en || 'Calgary region'}`);
  });
  if (!messages.length) messages.push('No live updates available.');
  els.ticker.textContent = messages.join('     ◆     ');
}

function renderAll() {
  renderQueue();
  renderMap();
  renderDetail();
  renderKPIs();
  renderTicker();
}

function nearestCamera(event) {
  if (!event?.coords || !state.cameras.length) return null;
  const [lat1, lon1] = event.coords;
  let best = null;
  let bestDist = Infinity;
  state.cameras.forEach(cam => {
    const [lat2, lon2] = cam.coords;
    const d = Math.pow(lat2-lat1, 2) + Math.pow((lon2-lon1) * Math.cos(lat1 * Math.PI/180), 2);
    if (d < bestDist) { bestDist = d; best = cam; }
  });
  return best;
}

function openNearestCamera() {
  const event = state.allEvents.find(e => e.id === state.selectedId);
  if (!event) return;
  const cam = nearestCamera(event);
  if (!cam) { alert('No traffic camera data is available.'); return; }
  if (mapReady) {
    map.panTo({ lat: cam.coords[0], lng: cam.coords[1] });
    map.setZoom(15);
  }
  if (cam.url) window.open(cam.url, '_blank', 'noopener');
  addTimeline(event.id, `Nearest camera opened: ${cam.title}`);
  renderDetail();
}

function exportSelectedEvent() {
  const event = state.allEvents.find(e => e.id === state.selectedId);
  if (!event) return;
  const payload = { event, operator: operatorFor(event.id), exportedAt: new Date().toISOString(), prototypeNotice: 'Local V1 record; not written back to City source systems.' };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${event.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function fitEvents() {
  if (!mapReady || !map) return;
  const pts = state.allEvents.filter(e => e.coords).map(e => e.coords);
  if (!pts.length) {
    map.fitBounds({ south: CONFIG.calgaryBounds[0][0], west: CONFIG.calgaryBounds[0][1], north: CONFIG.calgaryBounds[1][0], east: CONFIG.calgaryBounds[1][1] }, 44);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  pts.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
  map.fitBounds(bounds, 44);
  google.maps.event.addListenerOnce(map, 'idle', () => { if ((map.getZoom() || 0) > 13) map.setZoom(13); });
}

function openManualModal() {
  els.manualEventModal.classList.remove('hidden');
  const form = els.manualEventForm;
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0,16);
  form.elements.start.value = local;
}
function closeManualModal() { els.manualEventModal.classList.add('hidden'); }
function createManualEvent(formData) {
  const id = `TMC-${Date.now().toString(36).toUpperCase()}`;
  const event = {
    id,
    title: formData.get('title').trim(),
    description: formData.get('description').trim(),
    priority: formData.get('priority'),
    start: formData.get('start') ? new Date(formData.get('start')).toISOString() : new Date().toISOString(),
    updated: new Date().toISOString(),
    coords: [Number(formData.get('lat')), Number(formData.get('lon'))]
  };
  state.manual.unshift(event);
  saveLocal('tmc_manual_events_v1', state.manual);
  operatorFor(id);
  addTimeline(id, 'Manual TMC event created');
  rebuildEvents();
  closeManualModal();
  renderAll();
  selectEvent(id);
}

function cacheElements() {
  [
    'clock','dateLabel','systemHealth','healthText','newEventBtn','eventSearch','filterRow','queueCount','lastRefresh','eventQueue',
    'fitEventsBtn','refreshBtn','mapStatus','emptyDetail','eventDetail','detailSource','detailTitle','detailPriority','detailId','detailType',
    'detailStart','detailUpdated','detailDescription','statusRail','previousStatusBtn','nextStatusBtn','actionGrid','noteInput','addNoteBtn',
    'nearestCameraBtn','exportEventBtn','timeline','kpiIncidents','kpiDetours','kpiHigh','kpiWeather','ticker','manualEventModal',
    'closeModalBtn','cancelModalBtn','manualEventForm','useMapCenterBtn'
  ].forEach(id => els[id] = document.getElementById(id));
}

function bindEvents() {
  els.eventSearch.addEventListener('input', e => { state.search = e.target.value; renderQueue(); });
  els.filterRow.addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    els.filterRow.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b === btn));
    renderQueue();
  });
  document.querySelectorAll('[data-layer]').forEach(input => {
    input.addEventListener('change', () => {
      state.layersEnabled[input.dataset.layer] = input.checked;
      syncLayerVisibility();
    });
  });
  els.refreshBtn.addEventListener('click', () => refreshData());
  els.fitEventsBtn.addEventListener('click', fitEvents);
  els.previousStatusBtn.addEventListener('click', () => changeStatus(-1));
  els.nextStatusBtn.addEventListener('click', () => changeStatus(1));
  els.actionGrid.addEventListener('change', e => {
    const input = e.target.closest('[data-action]');
    const event = state.allEvents.find(ev => ev.id === state.selectedId);
    if (!input || !event) return;
    const op = operatorFor(event.id);
    op.actions[input.dataset.action] = input.checked;
    addTimeline(event.id, `${ACTION_LABELS[input.dataset.action] || input.dataset.action}: ${input.checked ? 'YES' : 'NO'}`);
    renderDetail();
  });
  els.addNoteBtn.addEventListener('click', () => {
    const event = state.allEvents.find(e => e.id === state.selectedId);
    const text = els.noteInput.value.trim();
    if (!event || !text) return;
    operatorFor(event.id).notes.unshift({ at: new Date().toISOString(), text });
    persistOperator();
    els.noteInput.value = '';
    renderDetail();
  });
  els.noteInput.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') els.addNoteBtn.click();
  });
  els.nearestCameraBtn.addEventListener('click', openNearestCamera);
  els.exportEventBtn.addEventListener('click', exportSelectedEvent);
  els.newEventBtn.addEventListener('click', openManualModal);
  els.closeModalBtn.addEventListener('click', closeManualModal);
  els.cancelModalBtn.addEventListener('click', closeManualModal);
  els.manualEventModal.addEventListener('click', e => { if (e.target === els.manualEventModal) closeManualModal(); });
  els.useMapCenterBtn.addEventListener('click', () => {
    if (!mapReady || !map) return;
    const c = map.getCenter();
    els.manualEventForm.elements.lat.value = c.lat().toFixed(6);
    els.manualEventForm.elements.lon.value = c.lng().toFixed(6);
  });
  els.manualEventForm.addEventListener('submit', e => {
    e.preventDefault();
    createManualEvent(new FormData(e.currentTarget));
    e.currentTarget.reset();
  });
}

async function init() {
  cacheElements();
  bindEvents();
  rebuildEvents();
  formatClockDate();
  setInterval(formatClockDate, 1000);
  await initMap();
  renderAll();
  refreshData();
  setInterval(() => refreshData({ silent: true }), CONFIG.refreshMs);
}

document.addEventListener('DOMContentLoaded', init);
