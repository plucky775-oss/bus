import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { getMessaging, getToken, onMessage, isSupported } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js';

const $ = (id) => document.getElementById(id);
const state = {
  origin: null,
  destination: null,
  route: null,
  routeStations: [],
  routeShape: [],
  locations: [],
  arrival: null,
  arrivalList: [],
  arrivalResolvedBy: 'none',
  map: null,
  routeLayer: null,
  markerLayer: null,
  userLocation: null,
  mapScope: 'full',
  vehicleScope: 'all',
  poller: null,
  firebase: null,
  firebaseConfig: null,
  swRegistration: null,
  foregroundAlarmKey: '',
  lastAlertAt: 0,
  liveLoading: false,
  firebaseAuthError: null,
  nearbyRequestId: 0,
  liveRequestId: 0,
  liveAbortController: null,
  lastLocationSuccessAt: 0,
  lastLiveUpdatedAt: 0,
  routeSearchId: 0,
  routeSearchAbortController: null,
  nearbyAbortController: null,
  savedAlerts: [],
  savedAlertPoller: null,
  savedAlertAlarmKeys: new Map(),
  savedAlertBaselineRoutes: new Set(),
  destinationFavorites: [],
  alertSaveBusy: false,
  pushRetryAfter: 0,
  audioUnlocked: false,
  audioUnlockBusy: false,
  sharedAudioContext: null,
  audioFailureToastAt: 0,
  foregroundBaselineReady: false,
  futureBusAudioBuffer: null,
  futureBusAudioBufferPromise: null,
  restoreBusy: false
};

const els = {
  apiState: $('apiState'), originInput: $('originInput'), destinationInput: $('destinationInput'),
  originSuggestions: $('originSuggestions'), destinationSuggestions: $('destinationSuggestions'),
  originSelected: $('originSelected'), destinationSelected: $('destinationSelected'),
  routeResults: $('routeResults'), liveSection: $('liveSection'), alertSection: $('alertSection'),
  chosenRoute: $('chosenRoute'), arrivalGrid: $('arrivalGrid'), pushState: $('pushState'),
  busCount: $('busCount'), mapNote: $('mapNote'), nearbyOrigin: $('nearbyOrigin'),
  toast: $('toast'), alarmAudio: $('alarmAudio'), alertInfo: $('alertInfo'),
  refreshLive: $('refreshLive'), refreshLiveLabel: $('refreshLiveLabel'),
  nearbyStatus: $('nearbyStatus'), liveVehicles: $('liveVehicles'), liveUpdated: $('liveUpdated'),
  savedAlerts: $('savedAlerts'), savedAlertCount: $('savedAlertCount'), alertRouteChip: $('alertRouteChip'),
  destinationFavorites: $('destinationFavorites'), destinationFavoriteCount: $('destinationFavoriteCount'),
  toggleDestinationFavorite: $('toggleDestinationFavorite'), favoriteDestinationHint: $('favoriteDestinationHint')
};

const DESTINATION_WALK_RADIUS_METERS = 800;
const NEARBY_RESULT_RADIUS_METERS = 1800;
const STORED_LOCATION_MAX_AGE_MS = 15 * 60 * 1000;
const SAVED_ALERTS_KEY = 'hogyeBusAlertsV2';
const DESTINATION_FAVORITES_KEY = 'hogyeBusDestinationFavoritesV1';
const LAST_JOURNEY_KEY = 'hogyeBusLastJourneyV1';
const LAST_SELECTED_ALERT_KEY = 'hogyeBusLastSelectedAlertV1';
const PUSH_CONNECT_TIMEOUT_MS = 10000;

function isAppleMobileBrowser() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneWebApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function withTimeout(promise, timeoutMs, message = '요청 시간이 초과되었습니다.') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function friendlyPushError(error) {
  const message = String(error?.message || error || '알 수 없는 오류');
  if (/시간이 초과|timeout/i.test(message)) return '푸시 서버 응답이 없어 연결을 중단했습니다.';
  if (/permission|denied|blocked/i.test(message)) return '알림 권한이 차단되어 있습니다.';
  if (/token|registration/i.test(message)) return '푸시 토큰을 발급받지 못했습니다.';
  return message;
}

function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sameId(a, b) {
  return String(a ?? '').trim() !== '' && String(a ?? '').trim() === String(b ?? '').trim();
}

function normalizeName(value = '') {
  return String(value).replace(/[\s.·,()\-]/g, '').toLowerCase();
}

function normalizePlate(value = '') {
  return String(value).replace(/\s/g, '').toUpperCase();
}

function normalizeKoreaCoordinate(xRaw, yRaw) {
  const x = number(xRaw, NaN);
  const y = number(yRaw, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const valid = (lat, lng) => lat >= 32.5 && lat <= 40 && lng >= 123 && lng <= 133;
  if (valid(y, x)) return { lat: y, lng: x };
  if (valid(x, y)) return { lat: x, lng: y };
  return null;
}

function coordinateFields(item) {
  const coordinate = normalizeKoreaCoordinate(
    item?.x ?? item?.gpsX ?? item?.longitude ?? item?.lng,
    item?.y ?? item?.gpsY ?? item?.latitude ?? item?.lat
  );
  return coordinate ? { x: coordinate.lng, y: coordinate.lat } : {};
}


function routeStationSequence(item) {
  return number(item?.stationSeq ?? item?.staOrder ?? item?.stationOrder, NaN);
}

function normalizeRouteStation(item) {
  return {
    ...item,
    ...coordinateFields(item),
    stationId: String(item?.stationId ?? item?.stationID ?? '').trim(),
    stationSeq: routeStationSequence(item),
    stationName: item?.stationName || item?.stationNm || '',
    turnSeq: number(item?.turnSeq, NaN),
    turnYn: String(item?.turnYn || '').trim().toUpperCase()
  };
}

function normalizeRouteShapePoint(item) {
  return {
    ...item,
    ...coordinateFields(item),
    lineSeq: number(item?.lineSeq ?? item?.seq ?? item?.shapeSeq, NaN)
  };
}

function normalizeBusLocation(item) {
  const stationId = String(item?.stationId ?? item?.stationID ?? '').trim();
  let stationSeq = number(item?.stationSeq ?? item?.staOrder ?? item?.stationOrder, NaN);
  if (!Number.isFinite(stationSeq) && stationId) {
    const matched = state.routeStations.find(stop => sameId(stop.stationId, stationId));
    stationSeq = routeStationSequence(matched);
  }
  return {
    ...item,
    ...coordinateFields(item),
    stationId,
    stationSeq,
    vehId: String(item?.vehId ?? item?.vehicleId ?? '').trim(),
    plateNo: item?.plateNo || item?.plateNumber || '',
    stateCd: item?.stateCd ?? item?.stateCode
  };
}

function reconcileRouteOrders(preferredOriginSeq = NaN) {
  const stations = state.routeStations || [];
  if (!stations.length || !state.route || !state.origin || !state.destination) return;

  const routeDestinationId = state.route.destinationStationId || state.destination.stationId;
  const routeDestinationName = state.route.destinationStationName || state.destination.stationName;
  const allOriginMatches = stations.filter(stop => sameId(stop.stationId, state.origin.stationId));
  const destinationMatches = stations.filter(stop => sameId(stop.stationId, routeDestinationId));
  const forcedOrigins = Number.isFinite(preferredOriginSeq)
    ? allOriginMatches.filter(stop => routeStationSequence(stop) === preferredOriginSeq)
    : [];
  const originMatches = forcedOrigins.length ? forcedOrigins : allOriginMatches;
  const previousOrigin = Number.isFinite(preferredOriginSeq) ? preferredOriginSeq : number(state.route.originStaOrder, 0);
  const previousDestination = number(state.route.destinationStaOrder, 0);
  const pairs = [];

  originMatches.forEach(originStop => destinationMatches.forEach(destinationStop => {
    const originSeq = routeStationSequence(originStop);
    const destinationSeq = routeStationSequence(destinationStop);
    if (!Number.isFinite(originSeq) || !Number.isFinite(destinationSeq) || destinationSeq <= originSeq) return;
    const score = Math.abs(originSeq - previousOrigin) * 5 + Math.abs(destinationSeq - previousDestination)
      + Math.max(0, destinationSeq - originSeq) * .001;
    pairs.push({ originSeq, destinationSeq, score });
  }));

  if (pairs.length) {
    pairs.sort((a, b) => a.score - b.score);
    state.route.originStaOrder = pairs[0].originSeq;
    state.route.destinationStaOrder = pairs[0].destinationSeq;
  } else {
    // 일부 순환·분기 노선은 동일 정류소가 중복되므로 이름까지 보조 비교한다.
    const nameMatch = (station, selected) => String(station.stationName || '').replace(/\s/g, '')
      === String(selected.stationName || '').replace(/\s/g, '');
    const fallbackOrigins = stations.filter(stop => nameMatch(stop, state.origin));
    const fallbackOrigin = (Number.isFinite(preferredOriginSeq)
      ? fallbackOrigins.find(stop => routeStationSequence(stop) === preferredOriginSeq)
      : null) || fallbackOrigins[0];
    const fallbackDestination = stations.find(stop => normalizeName(stop.stationName) === normalizeName(routeDestinationName)
      && routeStationSequence(stop) > routeStationSequence(fallbackOrigin));
    if (fallbackOrigin && fallbackDestination) {
      state.route.originStaOrder = routeStationSequence(fallbackOrigin);
      state.route.destinationStaOrder = routeStationSequence(fallbackDestination);
    }
  }

  const turnSeq = stations.map(stop => number(stop.turnSeq, NaN)).find(Number.isFinite);
  if (Number.isFinite(turnSeq)) state.route.turnSeq = turnSeq;
}

function arrivalHasVehicle(item, index = 1) {
  return Boolean(
    idText(item?.[`vehId${index}`]) ||
    String(item?.[`plateNo${index}`] || '').trim() ||
    String(item?.[`locationNo${index}`] ?? '').trim()
  );
}

function arrivalHasAnyVehicle(item) {
  return arrivalHasVehicle(item, 1) || arrivalHasVehicle(item, 2);
}

function destinationExistsAfter(originSeq) {
  const destinationId = state.route?.destinationStationId || state.destination?.stationId;
  const destinationName = normalizeName(state.route?.destinationStationName || state.destination?.stationName || '');
  return state.routeStations.some(stop => {
    const idMatches = sameId(stop.stationId, destinationId);
    const nameMatches = destinationName && normalizeName(stop.stationName) === destinationName;
    return (idMatches || nameMatches) && routeStationSequence(stop) > originSeq;
  });
}

function selectArrivalForRoute(items = []) {
  if (!state.route) return null;
  const routeId = String(state.route.routeId || '');
  const expectedDestId = String(state.route.routeDestId || '');
  const expectedDestName = normalizeName(state.route.routeDestName || '');
  const previousOrder = number(state.route.originStaOrder, 0);

  const candidates = items
    .filter(item => String(item?.routeId || '') === routeId)
    .map(item => {
      const staOrder = number(item?.staOrder, NaN);
      const destId = String(item?.routeDestId || '');
      const destName = normalizeName(item?.routeDestName || '');
      const pathValid = Number.isFinite(staOrder) && destinationExistsAfter(staOrder);
      let score = pathValid ? 160 : -240;
      if (expectedDestId && destId && expectedDestId === destId) score += 100;
      if (expectedDestName && destName) {
        if (expectedDestName === destName) score += 90;
        else if (expectedDestName.includes(destName) || destName.includes(expectedDestName)) score += 45;
      }
      if (Number.isFinite(staOrder)) {
        if (staOrder === previousOrder) score += 65;
        score -= Math.min(80, Math.abs(staOrder - previousOrder) * 2);
      }
      if (arrivalHasAnyVehicle(item)) score += 35;
      if (['RUN', 'PASS', 'WAIT'].includes(String(item?.flag || '').toUpperCase())) score += 8;
      return { item, score, pathValid };
    })
    .filter(candidate => candidate.pathValid)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.item || null;
}

function applyArrivalDirection(item, source = 'list') {
  state.arrival = item || {};
  state.arrivalResolvedBy = item ? source : 'none';
  if (!item || !state.route) return;
  const staOrder = number(item.staOrder, NaN);
  if (Number.isFinite(staOrder)) {
    state.route.originStaOrder = staOrder;
    reconcileRouteOrders(staOrder);
  }
  if (item.routeDestId) state.route.routeDestId = item.routeDestId;
  if (item.routeDestName) state.route.routeDestName = item.routeDestName;
  const turnSeq = number(item.turnSeq, NaN);
  if (Number.isFinite(turnSeq)) state.route.turnSeq = turnSeq;
}

async function api(action, params = {}, options = {}) {
  const url = new URL('/api/gbis', location.origin);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  if (options.fresh) url.searchParams.set('_t', String(Date.now()));

  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeout || 18000);

  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.message || '버스정보를 가져오지 못했습니다.');
      error.code = data.code || '';
      error.requiredApi = data.requiredApi || '';
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const abortError = new Error(timedOut ? '버스정보 응답 시간이 초과되었습니다. 다시 눌러 주세요.' : '이전 요청을 취소하고 새로 갱신합니다.');
      abortError.name = 'AbortError';
      abortError.code = timedOut ? 'CLIENT_TIMEOUT' : 'REQUEST_ABORTED';
      throw abortError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

function updateApiState(error) {
  const pill = els.apiState.closest('.live-pill');
  pill?.classList.remove('is-good', 'is-warn', 'is-error');
  if (!error) {
    els.apiState.textContent = 'API 연결됨';
    pill?.classList.add('is-good');
    return;
  }
  if (error.code === 'MISSING_SERVICE_KEY') els.apiState.textContent = 'API 키 필요';
  else if (error.code === 'API_ACCESS_DENIED') els.apiState.textContent = 'API 권한 필요';
  else if (error.code === 'INVALID_SERVICE_KEY') els.apiState.textContent = 'API 키 확인';
  else if (error.code === 'API_QUOTA_EXCEEDED') els.apiState.textContent = '호출량 초과';
  else els.apiState.textContent = '연결 오류';
  pill?.classList.add(error.code === 'API_QUOTA_EXCEEDED' ? 'is-warn' : 'is-error');
}

function stationLabel(station) {
  return `${station.stationName} · ${station.regionName || ''}${station.mobileNo ? ` · ${station.mobileNo}` : ''}`;
}

function stationMeta(station, nearby = false) {
  const parts = [];
  if (station.regionName) parts.push(esc(station.regionName));
  if (station.mobileNo) parts.push(`정류소 ${esc(station.mobileNo)}`);
  if (nearby && Number.isFinite(number(station.distance, NaN))) parts.push(`현재 위치에서 ${Math.round(number(station.distance))}m`);
  return parts.join(' · ');
}


function destinationFavoriteKey(station) {
  if (!station) return '';
  const coordinate = stationCoordinate(station);
  const coordinateKey = coordinate ? `${coordinate.lat.toFixed(5)}:${coordinate.lng.toFixed(5)}` : '';
  return String(station.stationId || `${normalizeName(station.stationName)}:${station.mobileNo || ''}:${coordinateKey}`);
}

function compactFavoriteStation(station) {
  if (!station) return null;
  return {
    stationId: String(station.stationId || ''),
    stationName: String(station.stationName || ''),
    regionName: String(station.regionName || ''),
    mobileNo: String(station.mobileNo || ''),
    ...coordinateFields(station)
  };
}

function compactJourneyRouteStation(station) {
  if (!station) return null;
  return {
    stationId: String(station.stationId || ''),
    stationName: String(station.stationName || ''),
    stationSeq: number(station.stationSeq ?? station.staOrder, 0),
    turnSeq: number(station.turnSeq, 0),
    turnYn: String(station.turnYn || ''),
    ...coordinateFields(station)
  };
}

function compactJourneyRoute(route) {
  if (!route?.routeId) return null;
  return {
    routeId: String(route.routeId || ''),
    routeName: String(route.routeName || ''),
    routeTypeName: String(route.routeTypeName || ''),
    routeDestName: String(route.routeDestName || ''),
    routeDestId: String(route.routeDestId || ''),
    originStaOrder: number(route.originStaOrder, 0),
    destinationStaOrder: number(route.destinationStaOrder, 0),
    destinationStationId: String(route.destinationStationId || ''),
    destinationStationName: String(route.destinationStationName || ''),
    destinationNearby: Boolean(route.destinationNearby),
    destinationWalkDistance: number(route.destinationWalkDistance, 0)
  };
}

function readLastJourney() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_JOURNEY_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return null;
    const origin = compactFavoriteStation(saved.origin);
    const destination = compactFavoriteStation(saved.destination);
    const route = compactJourneyRoute(saved.route);
    const routeStations = Array.isArray(saved.routeStations)
      ? saved.routeStations.map(normalizeRouteStation).filter(stop => stop.stationId || stop.stationName)
      : [];
    return {
      origin: origin?.stationId && origin?.stationName ? origin : null,
      destination: destination?.stationId && destination?.stationName ? destination : null,
      route,
      routeStations,
      savedAt: number(saved.savedAt, 0)
    };
  } catch (error) {
    console.warn('last journey read failed', error);
    return null;
  }
}

function journeyFromAlert(alert) {
  if (!alert?.routeId || !alert?.stationId || !alert?.destinationStationId) return null;
  return {
    origin: compactFavoriteStation({
      stationId: alert.stationId,
      stationName: alert.stationName || '탑승 정류장',
      regionName: alert.stationRegionName || '',
      mobileNo: alert.stationMobileNo || '',
      x: alert.stationX,
      y: alert.stationY
    }),
    destination: compactFavoriteStation({
      stationId: alert.destinationStationId,
      stationName: alert.destinationStationName || '도착 정류장',
      regionName: alert.destinationRegionName || '',
      mobileNo: alert.destinationMobileNo || '',
      x: alert.destinationX,
      y: alert.destinationY
    }),
    route: compactJourneyRoute({
      routeId: alert.routeId,
      routeName: alert.routeName,
      routeDestId: alert.routeDestId,
      routeDestName: alert.routeDestName,
      originStaOrder: alert.staOrder,
      destinationStaOrder: alert.destinationStaOrder,
      destinationStationId: alert.destinationStationId,
      destinationStationName: alert.destinationStationName
    }),
    routeStations: Array.isArray(alert.routeStations)
      ? alert.routeStations.map(normalizeRouteStation).filter(stop => stop.stationId || stop.stationName)
      : [],
    savedAt: number(alert.savedAt, 0)
  };
}

function journeyFromSelectedAlert() {
  const key = localStorage.getItem(LAST_SELECTED_ALERT_KEY) || '';
  if (!key) return null;
  const alert = state.savedAlerts.find(item => alertStorageKey(item) === key);
  return journeyFromAlert(alert);
}

function journeyFromNewestAlert() {
  const alert = [...state.savedAlerts]
    .filter(item => item?.routeId && item?.stationId && item?.destinationStationId)
    .sort((a, b) => number(b.savedAt, 0) - number(a.savedAt, 0))[0];
  return journeyFromAlert(alert);
}

function writeLastJourney() {
  try {
    const payload = {
      version: 1,
      origin: compactFavoriteStation(state.origin),
      destination: compactFavoriteStation(state.destination),
      route: compactJourneyRoute(state.route),
      routeStations: state.route
        ? state.routeStations.map(compactJourneyRouteStation).filter(Boolean)
        : [],
      savedAt: Date.now()
    };
    localStorage.setItem(LAST_JOURNEY_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('last journey save failed', error);
  }
}

function renderSelectedStation(kind, station) {
  if (!station) return;
  const selected = kind === 'origin' ? els.originSelected : els.destinationSelected;
  const suggestions = kind === 'origin' ? els.originSuggestions : els.destinationSuggestions;
  const input = kind === 'origin' ? els.originInput : els.destinationInput;
  input.value = station.stationName;
  selected.textContent = stationLabel(station);
  selected.classList.add('ready');
  suggestions.innerHTML = '';
}

function resetActiveRoute() {
  state.liveAbortController?.abort();
  if (state.poller) clearInterval(state.poller);
  state.poller = null;
  state.route = null;
  state.routeStations = [];
  state.routeShape = [];
  state.locations = [];
  state.arrival = null;
  state.arrivalList = [];
  state.liveLoading = false;
  state.foregroundAlarmKey = '';
  state.foregroundBaselineReady = false;
  els.liveSection?.classList.add('hidden');
  if (els.alertSection) {
    const hasSavedAlerts = state.savedAlerts.length > 0;
    els.alertSection.classList.toggle('hidden', !hasSavedAlerts);
    els.alertSection.classList.toggle('saved-only', hasSavedAlerts);
  }
  if (els.chosenRoute) els.chosenRoute.innerHTML = '';
  if (els.alertRouteChip) els.alertRouteChip.innerHTML = '';
}

function pairFromStoredJourney(saved) {
  const route = saved?.route;
  if (!route) return null;
  return {
    originRoute: {
      routeId: route.routeId,
      routeName: route.routeName,
      routeTypeName: route.routeTypeName,
      routeDestName: route.routeDestName,
      routeDestId: route.routeDestId,
      staOrder: route.originStaOrder
    },
    destRoute: {
      stationId: route.destinationStationId || state.destination?.stationId,
      stationName: route.destinationStationName || state.destination?.stationName,
      staOrder: route.destinationStaOrder,
      isNearby: route.destinationNearby,
      walkDistance: route.destinationWalkDistance
    },
    routeStations: saved.routeStations || []
  };
}

function readDestinationFavorites() {
  try {
    const items = JSON.parse(localStorage.getItem(DESTINATION_FAVORITES_KEY) || '[]');
    if (!Array.isArray(items)) return [];
    const unique = new Map();
    items.forEach(item => {
      const station = compactFavoriteStation(item?.station || item);
      const key = destinationFavoriteKey(station);
      if (key && station?.stationName) unique.set(key, { key, station, savedAt: number(item?.savedAt, 0) });
    });
    return [...unique.values()].sort((a, b) => number(b.savedAt, 0) - number(a.savedAt, 0));
  } catch {
    return [];
  }
}

function writeDestinationFavorites(items) {
  state.destinationFavorites = [...items];
  localStorage.setItem(DESTINATION_FAVORITES_KEY, JSON.stringify(state.destinationFavorites));
  renderDestinationFavorites();
  updateDestinationFavoriteControl();
}

function updateDestinationFavoriteControl() {
  if (!els.toggleDestinationFavorite) return;
  const key = destinationFavoriteKey(state.destination);
  const saved = Boolean(key && state.destinationFavorites.some(item => item.key === key));
  els.toggleDestinationFavorite.disabled = !state.destination;
  els.toggleDestinationFavorite.classList.toggle('saved', saved);
  els.toggleDestinationFavorite.innerHTML = saved
    ? '<span aria-hidden="true">★</span> 즐겨찾기 해제'
    : '<span aria-hidden="true">☆</span> 즐겨찾기 저장';
  if (els.favoriteDestinationHint) {
    els.favoriteDestinationHint.textContent = !state.destination
      ? '도착 정류장을 선택하면 저장할 수 있습니다.'
      : saved ? '이 도착지는 즐겨찾기에 저장되어 있습니다.' : '자주 가는 도착지를 한 번에 불러올 수 있습니다.';
  }
}

function renderDestinationFavorites() {
  if (!els.destinationFavorites || !els.destinationFavoriteCount) return;
  els.destinationFavoriteCount.textContent = `${state.destinationFavorites.length}개`;
  if (!state.destinationFavorites.length) {
    els.destinationFavorites.innerHTML = '<div class="empty favorite-empty">저장된 도착지가 없습니다.</div>';
    return;
  }
  els.destinationFavorites.innerHTML = state.destinationFavorites.map(item => {
    const station = item.station;
    const meta = [station.regionName, station.mobileNo ? `정류소 ${station.mobileNo}` : ''].filter(Boolean).join(' · ');
    return `<div class="favorite-destination-row" data-favorite-key="${esc(item.key)}">
      <button type="button" class="favorite-destination-use" data-use-favorite="${esc(item.key)}">
        <span class="favorite-star" aria-hidden="true">★</span>
        <span><strong>${esc(station.stationName)}</strong><small>${esc(meta || '저장된 도착 정류장')}</small></span>
      </button>
      <button type="button" class="favorite-destination-delete" data-delete-favorite="${esc(item.key)}" aria-label="${esc(station.stationName)} 즐겨찾기 삭제">×</button>
    </div>`;
  }).join('');
  els.destinationFavorites.querySelectorAll('[data-use-favorite]').forEach(button => {
    button.addEventListener('click', () => useDestinationFavorite(button.dataset.useFavorite));
  });
  els.destinationFavorites.querySelectorAll('[data-delete-favorite]').forEach(button => {
    button.addEventListener('click', () => removeDestinationFavorite(button.dataset.deleteFavorite));
  });
}

function toggleDestinationFavorite() {
  if (!state.destination) return toast('먼저 도착 정류장을 선택해 주세요.');
  const key = destinationFavoriteKey(state.destination);
  const existing = state.destinationFavorites.some(item => item.key === key);
  try {
    if (existing) {
      writeDestinationFavorites(state.destinationFavorites.filter(item => item.key !== key));
      toast(`${state.destination.stationName} 즐겨찾기를 해제했습니다.`);
    } else {
      const next = state.destinationFavorites.filter(item => item.key !== key);
      next.unshift({ key, station: compactFavoriteStation(state.destination), savedAt: Date.now() });
      writeDestinationFavorites(next.slice(0, 12));
      toast(`${state.destination.stationName}을 도착지 즐겨찾기에 저장했습니다.`);
    }
  } catch (error) {
    toast(`즐겨찾기 저장 실패: ${error.message}`, 4000);
  }
}

function useDestinationFavorite(key) {
  const item = state.destinationFavorites.find(favorite => favorite.key === key);
  if (!item) return;
  document.querySelectorAll('.preset').forEach(button => button.classList.remove('active'));
  selectStation('destination', { ...item.station });
  toast(`${item.station.stationName}을 도착지로 불러왔습니다.`);
}

function removeDestinationFavorite(key) {
  const item = state.destinationFavorites.find(favorite => favorite.key === key);
  if (!item) return;
  try {
    writeDestinationFavorites(state.destinationFavorites.filter(favorite => favorite.key !== key));
    toast(`${item.station.stationName} 즐겨찾기를 삭제했습니다.`);
  } catch (error) {
    toast(`즐겨찾기 삭제 실패: ${error.message}`, 4000);
  }
}

function renderStationSuggestions(kind, stations, { nearby = false } = {}) {
  const listEl = kind === 'origin' ? els.originSuggestions : els.destinationSuggestions;
  if (!stations.length) {
    listEl.innerHTML = `<div class="empty">${nearby ? '현재 위치 주변에 경기도 정류장이 없습니다.' : '검색 결과가 없습니다.'}</div>`;
    return;
  }
  listEl.innerHTML = stations.map((station, index) => `
    <button class="suggestion${nearby ? ' nearby-suggestion' : ''}" data-kind="${kind}" data-index="${index}">
      <strong>${esc(station.stationName)}</strong>
      <span>${stationMeta(station, nearby)}</span>
    </button>`).join('');
  listEl.querySelectorAll('.suggestion').forEach(button => {
    button.addEventListener('click', () => selectStation(kind, stations[Number(button.dataset.index)]));
  });
}

async function searchStations(kind) {
  const input = kind === 'origin' ? els.originInput : els.destinationInput;
  const listEl = kind === 'origin' ? els.originSuggestions : els.destinationSuggestions;
  const keyword = input.value.trim();
  if (!keyword) return toast('정류장 이름을 입력해 주세요.');
  listEl.innerHTML = '<div class="empty">검색 중…</div>';
  try {
    const { items } = await api('stationSearch', { keyword });
    const filtered = items
      .filter(item => String(item.regionName || '').includes('안양') || String(item.stationName || '').includes(keyword))
      .slice(0, 15);
    renderStationSuggestions(kind, filtered);
  } catch (error) {
    listEl.innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
    updateApiState(error);
  }
}

function geolocationMessage(error) {
  if (error?.code === 1) return '위치 권한이 차단되었습니다. iPad·iPhone은 설정 → 개인정보 보호 및 보안 → 위치 서비스에서 브라우저의 위치 권한을 허용해 주세요.';
  if (error?.code === 2) return '현재 위치를 확인할 수 없습니다. 기기의 위치 서비스를 켜고 창가나 실외에서 다시 시도해 주세요.';
  if (error?.code === 3) return '위치 확인 시간이 초과되었습니다. 정확도 우선 모드로 한 번 더 확인해 주세요.';
  return error?.message || '현재 위치를 가져오지 못했습니다.';
}

function getCurrentPosition(options) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

function watchBestPosition(duration = 9000) {
  return new Promise((resolve, reject) => {
    let best = null;
    let lastError = null;
    let watchId = null;
    let timer = null;
    const finish = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (timer) clearTimeout(timer);
      if (best) resolve(best);
      else reject(lastError || Object.assign(new Error('현재 위치 확인 시간이 초과되었습니다.'), { code: 3 }));
    };
    watchId = navigator.geolocation.watchPosition(position => {
      if (!best || number(position.coords.accuracy, 99999) < number(best.coords.accuracy, 99999)) best = position;
      if (number(position.coords.accuracy, 99999) <= 45) finish();
    }, error => {
      lastError = error;
      if (error?.code === 1) finish();
    }, {
      enableHighAccuracy: true,
      timeout: duration,
      maximumAge: 0
    });
    timer = setTimeout(finish, duration + 700);
  });
}


function saveStoredPosition(position) {
  const coords = position?.coords;
  if (!coords || !Number.isFinite(number(coords.latitude, NaN)) || !Number.isFinite(number(coords.longitude, NaN))) return;
  try {
    localStorage.setItem('hogyeBusLastPosition', JSON.stringify({
      latitude: number(coords.latitude),
      longitude: number(coords.longitude),
      accuracy: number(coords.accuracy, 0),
      savedAt: Date.now()
    }));
  } catch {}
}

function readStoredPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem('hogyeBusLastPosition') || 'null');
    if (!saved || Date.now() - number(saved.savedAt, 0) > STORED_LOCATION_MAX_AGE_MS) return null;
    if (!Number.isFinite(number(saved.latitude, NaN)) || !Number.isFinite(number(saved.longitude, NaN))) return null;
    return {
      coords: {
        latitude: number(saved.latitude),
        longitude: number(saved.longitude),
        accuracy: number(saved.accuracy, 300)
      },
      _fromStoredPosition: true
    };
  } catch {
    return null;
  }
}

async function resolveUserPosition() {
  let quickPosition = null;
  let quickError = null;
  try {
    quickPosition = await getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 180000
    });
  } catch (error) {
    quickError = error;
  }

  if (quickPosition && number(quickPosition.coords.accuracy, 9999) <= 90) {
    saveStoredPosition(quickPosition);
    return quickPosition;
  }

  try {
    const precisePosition = await watchBestPosition(11000);
    const selected = !quickPosition
      ? precisePosition
      : number(precisePosition.coords.accuracy, 9999) < number(quickPosition.coords.accuracy, 9999)
        ? precisePosition
        : quickPosition;
    saveStoredPosition(selected);
    return selected;
  } catch (error) {
    if (quickPosition) {
      saveStoredPosition(quickPosition);
      return quickPosition;
    }
    if (error?.code !== 1 && quickError?.code !== 1) {
      const stored = readStoredPosition();
      if (stored) return stored;
    }
    throw error || quickError;
  }
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeNearbyStations(items, latitude, longitude) {
  const unique = new Map();
  items.forEach(rawStation => {
    const station = { ...rawStation, ...coordinateFields(rawStation) };
    const coordinate = normalizeKoreaCoordinate(station.x, station.y);
    const measuredDistance = coordinate
      ? distanceMeters(latitude, longitude, coordinate.lat, coordinate.lng)
      : number(station.distance, 999999);
    const normalized = { ...station, distance: Math.round(measuredDistance) };
    const key = String(station.stationId || `${station.stationName}:${station.x}:${station.y}`);
    const previous = unique.get(key);
    if (!previous || number(normalized.distance, 999999) < number(previous.distance, 999999)) unique.set(key, normalized);
  });
  return [...unique.values()]
    .filter(station => number(station.distance, 999999) <= NEARBY_RESULT_RADIUS_METERS)
    .sort((a, b) => number(a.distance, 999999) - number(b.distance, 999999));
}

async function fetchNearbyStations(latitude, longitude, signal) {
  const queryPoint = async (lat, lng) => apiWithRetry('stationAround', {
    x: Number(lng).toFixed(7),
    y: Number(lat).toFixed(7)
  }, { signal, fresh: true, timeout: 20000 }, 2);

  const offsetPoint = (northMeters, eastMeters) => {
    const lat = latitude + northMeters / 111320;
    const lng = longitude + eastMeters / (111320 * Math.max(.3, Math.cos(latitude * Math.PI / 180)));
    return [lat, lng];
  };

  const collected = [];
  const failures = [];
  const queryPoints = async points => {
    await mapWithConcurrency(points, 3, async ([lat, lng]) => {
      try {
        const result = await queryPoint(lat, lng);
        collected.push(...(result.items || []));
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        failures.push(error);
      }
    });
    return normalizeNearbyStations(collected, latitude, longitude);
  };

  // 1차: 실제 GPS 지점. 응답 태그가 busStationList/busStationAroundList 어느 쪽이어도 서버에서 처리한다.
  let normalized = await queryPoints([offsetPoint(0, 0)]);
  if (normalized.length >= 5) return normalized;

  // 2차: 500m 검색 원을 서로 겹치도록 약 420m 간격으로 조회한다.
  const inner = [
    offsetPoint(420, 0), offsetPoint(-420, 0), offsetPoint(0, 420), offsetPoint(0, -420),
    offsetPoint(420, 420), offsetPoint(420, -420), offsetPoint(-420, 420), offsetPoint(-420, -420)
  ];
  normalized = await queryPoints(inner);
  if (normalized.length >= 8) return normalized;

  // 3차: GPS 오차가 크거나 정류장이 500m 경계 밖에 있을 때 1km권까지 보조 조회한다.
  const outer = [
    offsetPoint(840, 0), offsetPoint(-840, 0), offsetPoint(0, 840), offsetPoint(0, -840),
    offsetPoint(840, 840), offsetPoint(840, -840), offsetPoint(-840, 840), offsetPoint(-840, -840)
  ];
  normalized = await queryPoints(outer);
  if (!normalized.length && failures.length) throw failures[0];
  return normalized;
}

async function findNearbyOriginStations() {
  if (!window.isSecureContext) return toast('현재 위치는 HTTPS 주소에서만 사용할 수 있습니다.', 4000);
  if (!navigator.geolocation) return toast('이 브라우저는 현재 위치 기능을 지원하지 않습니다.', 4000);

  state.nearbyAbortController?.abort();
  const controller = new AbortController();
  state.nearbyAbortController = controller;
  const requestId = ++state.nearbyRequestId;
  const listEl = els.originSuggestions;
  const button = els.nearbyOrigin;
  button.disabled = true;
  button.classList.add('loading');
  if (els.nearbyStatus) els.nearbyStatus.textContent = 'GPS 위치 권한과 현재 좌표를 확인하고 있습니다…';
  listEl.innerHTML = '<div class="empty">현재 위치를 확인하는 중…</div>';

  try {
    const position = await resolveUserPosition();
    if (requestId !== state.nearbyRequestId) return;
    const { latitude, longitude, accuracy } = position.coords;
    state.userLocation = { lat: latitude, lng: longitude, accuracy: number(accuracy, 0) };
    const sourceText = position._fromStoredPosition ? '최근 확인 위치' : '현재 위치';
    if (els.nearbyStatus) {
      els.nearbyStatus.textContent = `${sourceText} 확인 · 정확도 약 ${Math.round(number(accuracy, 0))}m · 주변 정류장 조회 중…`;
    }
    if (state.map) renderMap(false);

    listEl.innerHTML = '<div class="empty">가까운 정류장을 거리순으로 찾는 중…</div>';
    const nearby = (await fetchNearbyStations(latitude, longitude, controller.signal)).slice(0, 30);
    if (requestId !== state.nearbyRequestId) return;
    renderStationSuggestions('origin', nearby, { nearby: true });

    if (nearby.length) {
      updateApiState();
      if (els.nearbyStatus) {
        els.nearbyStatus.textContent = `${sourceText} 기준 ${nearby.length}개 · 가까운 순서 · 위치 정확도 약 ${Math.round(number(accuracy, 0))}m`;
      }
      toast(`현재 위치 주변에서 ${nearby.length}개 정류장을 찾았습니다.`);
    } else {
      if (els.nearbyStatus) els.nearbyStatus.textContent = '주변정류소 API에서 결과가 없습니다. 정확한 위치를 켜고 다시 눌러 주세요.';
      listEl.innerHTML = '<div class="empty">현재 좌표 주변에서 경기버스 정류소가 조회되지 않았습니다. iPad·iPhone 설정에서 브라우저의 “정확한 위치”를 켠 뒤 다시 시도해 주세요.</div>';
    }
  } catch (error) {
    if (requestId !== state.nearbyRequestId || error?.name === 'AbortError') return;
    const message = geolocationMessage(error);
    if (els.nearbyStatus) els.nearbyStatus.textContent = message;
    listEl.innerHTML = `<div class="empty error">${esc(message)}</div>`;
    if (error?.code && ![1, 2, 3].includes(error.code)) updateApiState(error);
  } finally {
    if (requestId === state.nearbyRequestId) {
      state.nearbyAbortController = null;
      button.disabled = false;
      button.classList.remove('loading');
    }
  }
}

function selectStation(kind, station) {
  const previous = state[kind];
  const changed = !previous || !sameId(previous.stationId, station.stationId);
  if (changed && state.route) resetActiveRoute();
  state[kind] = station;
  renderSelectedStation(kind, station);
  if (kind === 'destination') updateDestinationFavoriteControl();
  writeLastJourney();
  toast(`${kind === 'origin' ? '탑승' : '도착'} 정류장을 선택했습니다.`);
}

function stationCoordinate(selected) {
  const coordinate = normalizeKoreaCoordinate(
    selected?.x ?? selected?.gpsX ?? selected?.longitude ?? selected?.lng,
    selected?.y ?? selected?.gpsY ?? selected?.latitude ?? selected?.lat
  );
  return coordinate;
}

function routeStopMatchesSelection(stop, selected, { allowCoordinateFallback = false } = {}) {
  if (!stop || !selected) return false;
  if (sameId(stop.stationId, selected.stationId)) return true;
  if (!allowCoordinateFallback) return false;

  const stopName = normalizeName(stop.stationName);
  const selectedName = normalizeName(selected.stationName);
  if (!stopName || stopName !== selectedName) return false;

  const stopPosition = stationPosition(stop);
  const selectedPosition = stationCoordinate(selected);
  if (!stopPosition || !selectedPosition) return false;
  return distanceMeters(stopPosition[0], stopPosition[1], selectedPosition.lat, selectedPosition.lng) <= 25;
}

function buildDirectRouteCandidate(originRoute, routeStations) {
  const ordered = (routeStations || [])
    .map(normalizeRouteStation)
    .filter(stop => Number.isFinite(routeStationSequence(stop)))
    .sort((a, b) => routeStationSequence(a) - routeStationSequence(b));
  if (!ordered.length) return null;

  let originStops = ordered.filter(stop => routeStopMatchesSelection(stop, state.origin));
  let exactDestinationStops = ordered.filter(stop => routeStopMatchesSelection(stop, state.destination));

  // 드물게 정류소 조회와 경유정류소 조회의 ID가 다를 때만 같은 이름+근접 좌표로 보조 매칭한다.
  if (!originStops.length) {
    originStops = ordered.filter(stop => routeStopMatchesSelection(stop, state.origin, { allowCoordinateFallback: true }));
  }
  if (!exactDestinationStops.length) {
    exactDestinationStops = ordered.filter(stop => routeStopMatchesSelection(stop, state.destination, { allowCoordinateFallback: true }));
  }
  if (!originStops.length) return null;

  const expectedOriginOrders = (originRoute?._originOrders || [originRoute?.staOrder])
    .map(value => number(value, NaN))
    .filter(Number.isFinite);
  const exactPairs = [];
  const nearbyPairs = [];
  const destinationCoordinate = stationCoordinate(state.destination);

  originStops.forEach(originStop => {
    const originSeq = routeStationSequence(originStop);
    if (!Number.isFinite(originSeq)) return;
    const orderPenalty = expectedOriginOrders.length
      ? Math.min(...expectedOriginOrders.map(order => Math.abs(originSeq - order))) * 100
      : 0;

    exactDestinationStops.forEach(destinationStop => {
      const destinationSeq = routeStationSequence(destinationStop);
      if (!Number.isFinite(destinationSeq) || destinationSeq <= originSeq) return;
      const stopCount = destinationSeq - originSeq;
      exactPairs.push({
        originStop, destinationStop, originSeq, destinationSeq, stopCount,
        walkDistance: 0, isNearby: false, score: orderPenalty + stopCount
      });
    });

    if (!destinationCoordinate) return;
    ordered.forEach(destinationStop => {
      const destinationSeq = routeStationSequence(destinationStop);
      if (!Number.isFinite(destinationSeq) || destinationSeq <= originSeq) return;
      const pos = stationPosition(destinationStop);
      if (!pos) return;
      const walkDistance = distanceMeters(pos[0], pos[1], destinationCoordinate.lat, destinationCoordinate.lng);
      if (walkDistance > DESTINATION_WALK_RADIUS_METERS) return;
      const stopCount = destinationSeq - originSeq;
      nearbyPairs.push({
        originStop, destinationStop, originSeq, destinationSeq, stopCount,
        walkDistance: Math.round(walkDistance), isNearby: true,
        score: orderPenalty + walkDistance * 8 + stopCount
      });
    });
  });

  // 정확히 같은 정류장이 있으면 우선하고, 없을 때만 목적지 도보권 정류장을 사용한다.
  const pairs = exactPairs.length ? exactPairs : nearbyPairs;
  if (!pairs.length) return null;
  pairs.sort((a, b) => a.score - b.score);
  const best = pairs[0];

  return {
    originRoute: {
      ...originRoute,
      staOrder: best.originSeq,
      routeId: String(originRoute.routeId || '').trim(),
      routeName: originRoute.routeName || originRoute.routeNo || '',
      routeDestName: originRoute.routeDestName || originRoute.routeDestNm || '',
      routeTypeName: originRoute.routeTypeName || ''
    },
    destRoute: {
      stationId: best.destinationStop.stationId,
      stationName: best.destinationStop.stationName,
      staOrder: best.destinationSeq,
      requestedStationId: state.destination.stationId,
      requestedStationName: state.destination.stationName,
      isNearby: best.isNearby,
      walkDistance: best.walkDistance
    },
    routeStations: ordered,
    stopCount: best.stopCount
  };
}

async function mapWithConcurrency(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function apiWithRetry(action, params, options = {}, attempts = 2) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api(action, params, { ...options, fresh: attempt > 0 || options.fresh });
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || ['INVALID_SERVICE_KEY', 'API_ACCESS_DENIED', 'MISSING_SERVICE_KEY'].includes(error?.code)) throw error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 280 + attempt * 320));
    }
  }
  throw lastError;
}

async function findRoutes() {
  if (!state.origin || !state.destination) return toast('출발·도착 정류장을 먼저 선택해 주세요.');
  if (sameId(state.origin.stationId, state.destination.stationId)) return toast('출발 정류장과 다른 도착 정류장을 선택해 주세요.');

  state.routeSearchAbortController?.abort();
  const controller = new AbortController();
  state.routeSearchAbortController = controller;
  const requestId = ++state.routeSearchId;
  const findButton = $('findRoutes');
  const findLabel = $('findRoutesLabel') || findButton?.querySelector('span');
  if (findButton) findButton.disabled = true;
  if (findLabel) findLabel.textContent = '운행 노선 확인 중';
  els.routeResults.innerHTML = '<div class="empty">출발 정류장에 정차하는 모든 버스를 확인 중…</div>';

  try {
    // 목적지 정류소의 노선 목록과 단순 교집합을 만들지 않는다.
    // 출발 정류장에 정차하는 노선을 전부 가져온 뒤 각 노선의 실제 경유 순서를 확인한다.
    const originData = await api('stationRoutes', { stationId: state.origin.stationId }, {
      signal: controller.signal,
      fresh: true,
      timeout: 20000
    });
    if (requestId !== state.routeSearchId) return;

    const routeGroups = new Map();
    for (const rawRoute of originData.items || []) {
      const routeId = String(rawRoute?.routeId || '').trim();
      if (!routeId) continue;
      const existing = routeGroups.get(routeId);
      if (existing) {
        existing._originOrders.push(rawRoute.staOrder);
        continue;
      }
      routeGroups.set(routeId, { ...rawRoute, routeId, _originOrders: [rawRoute.staOrder] });
    }
    const uniqueRoutes = [...routeGroups.values()];

    if (!uniqueRoutes.length) {
      els.routeResults.innerHTML = '<div class="empty">선택한 출발 정류장에 정차하는 경기버스가 없습니다.</div>';
      return;
    }

    let completed = 0;
    let failed = 0;
    const candidates = await mapWithConcurrency(uniqueRoutes, 3, async originRoute => {
      try {
        const stationData = await apiWithRetry('routeStations', { routeId: originRoute.routeId }, {
          signal: controller.signal,
          timeout: 22000
        }, 2);
        return buildDirectRouteCandidate(originRoute, stationData.items || []);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        failed += 1;
        return null;
      } finally {
        completed += 1;
        if (requestId === state.routeSearchId) {
          els.routeResults.innerHTML = `<div class="empty">출발 정류장 운행 노선 ${uniqueRoutes.length}개 중 ${completed}개 확인 중…</div>`;
        }
      }
    });
    if (requestId !== state.routeSearchId) return;

    const directRoutes = candidates
      .filter(Boolean)
      .sort((a, b) => {
        const stopDifference = number(a.stopCount, 9999) - number(b.stopCount, 9999);
        if (stopDifference) return stopDifference;
        return String(a.originRoute.routeName || '').localeCompare(String(b.originRoute.routeName || ''), 'ko-KR', { numeric: true });
      });

    if (!directRoutes.length) {
      const failedNote = failed ? `<br><small>${failed}개 노선은 API 응답 오류로 확인하지 못했습니다. 잠시 후 다시 눌러 주세요.</small>` : '';
      els.routeResults.innerHTML = `<div class="empty">출발 정류장에 정차하는 ${uniqueRoutes.length}개 노선을 실제 경유 순서로 확인했지만, 선택한 도착 정류장까지 바로 가는 버스가 없습니다.${failedNote}</div>`;
      return;
    }

    els.routeResults.innerHTML = `<div class="route-result-summary">출발 정류장 운행 노선 ${uniqueRoutes.length}개를 확인해 직행 ${directRoutes.length}개를 찾았습니다.</div>${directRoutes.map((pair, index) => {
      const stops = number(pair.stopCount, number(pair.destRoute.staOrder) - number(pair.originRoute.staOrder));
      const nearbyNote = pair.destRoute.isNearby
        ? ` · ${esc(pair.destRoute.stationName)} 하차 · 도보 약 ${Math.max(10, Math.round(number(pair.destRoute.walkDistance, 0) / 10) * 10)}m`
        : '';
      return `<button class="route-option" data-index="${index}">
        <span class="route-number">${esc(pair.originRoute.routeName)}</span>
        <span><strong>${esc(pair.originRoute.routeDestName || '진행 방향')}</strong><small>${stops}개 정류장 이동 · ${esc(pair.originRoute.routeTypeName || '경기버스')}${nearbyNote}</small></span>
        <span class="route-arrow">›</span>
      </button>`;
    }).join('')}`;

    els.routeResults.querySelectorAll('.route-option').forEach(button => {
      button.addEventListener('click', () => chooseRoute(directRoutes[Number(button.dataset.index)]));
    });
    toast(`직행 버스 ${directRoutes.length}개를 찾았습니다.`);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    els.routeResults.innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
    updateApiState(error);
  } finally {
    if (requestId === state.routeSearchId) {
      state.routeSearchAbortController = null;
      if (findButton) findButton.disabled = false;
      if (findLabel) findLabel.textContent = '직행 버스 찾기';
    }
  }
}

async function chooseRoute(pair, options = {}) {
  state.liveAbortController?.abort();
  state.routeStations = (pair.routeStations || [])
    .map(normalizeRouteStation)
    .filter(stop => Number.isFinite(routeStationSequence(stop)))
    .sort((a, b) => routeStationSequence(a) - routeStationSequence(b));
  state.routeShape = [];
  state.locations = [];
  state.arrival = null;
  state.arrivalList = [];
  state.arrivalResolvedBy = 'none';
  state.mapScope = 'full';
  state.vehicleScope = 'all';
  document.querySelectorAll('[data-map-scope]').forEach(button => {
    button.classList.toggle('active', button.dataset.mapScope === 'full');
  });
  document.querySelectorAll('[data-vehicle-scope]').forEach(button => {
    button.classList.toggle('active', button.dataset.vehicleScope === 'all');
  });
  state.foregroundAlarmKey = '';
  state.foregroundBaselineReady = false;
  state.route = {
    routeId: pair.originRoute.routeId,
    routeName: pair.originRoute.routeName,
    routeTypeName: pair.originRoute.routeTypeName,
    routeDestName: pair.originRoute.routeDestName,
    routeDestId: pair.originRoute.routeDestId || '',
    originStaOrder: number(pair.originRoute.staOrder),
    destinationStaOrder: number(pair.destRoute.staOrder),
    destinationStationId: String(pair.destRoute.stationId || ''),
    destinationStationName: pair.destRoute.stationName || state.destination.stationName,
    destinationNearby: Boolean(pair.destRoute.isNearby),
    destinationWalkDistance: number(pair.destRoute.walkDistance, 0)
  };
  writeLastJourney();
  els.liveSection.classList.remove('hidden');
  els.alertSection.classList.remove('hidden');
  els.alertSection.classList.remove('saved-only');
  const currentAlertKey = `${state.route.routeId}_${state.origin.stationId}`;
  if (state.savedAlerts.some(alert => alertStorageKey(alert) === currentAlertKey)) {
    localStorage.setItem(LAST_SELECTED_ALERT_KEY, currentAlertKey);
  }
  const destinationGuide = state.route.destinationNearby
    ? `${esc(state.destination.stationName)} 인근 · ${esc(state.route.destinationStationName)} 하차 후 도보 약 ${Math.max(10, Math.round(state.route.destinationWalkDistance / 10) * 10)}m`
    : esc(state.destination.stationName);
  els.chosenRoute.innerHTML = `<div class="chosen-route-main"><span class="chosen-route-number">${esc(state.route.routeName)}</span><span><strong>${esc(state.route.routeDestName || '선택 노선')} 방면</strong><p>${esc(state.origin.stationName)} → ${destinationGuide}</p></span></div><small class="chosen-route-hint">실제 노선 전체와 운행 차량을 표시합니다. 목적지와 같은 정류장이 없으면 도보 800m 이내의 가장 가까운 하차 정류장도 함께 찾습니다.</small>`;
  if (els.alertRouteChip) els.alertRouteChip.innerHTML = `<b>${esc(state.route.routeName)}번</b><span>${esc(state.origin.stationName)} 정류장 알림</span>`;
  $('saveAlert').textContent = `${state.route.routeName}번 알림 저장`;
  loadAlertFormForCurrentRoute();
  if (els.liveVehicles) els.liveVehicles.innerHTML = '<div class="empty">노선과 운행 차량을 불러오는 중…</div>';
  if (!options.restore) els.liveSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await loadLive(true, { manual: true });
  startPolling();
}

async function loadLive(fit = false, { manual = false, silent = false } = {}) {
  if (!state.route || !state.origin) return;
  if (state.liveLoading && !manual) return;
  if (state.liveLoading && manual) state.liveAbortController?.abort();

  const requestId = ++state.liveRequestId;
  const controller = new AbortController();
  state.liveAbortController = controller;
  state.liveLoading = true;
  if (els.refreshLive) {
    els.refreshLive.disabled = true;
    els.refreshLive.classList.add('is-loading');
  }
  if (els.refreshLiveLabel) els.refreshLiveLabel.textContent = '갱신 중';
  if (els.liveUpdated) els.liveUpdated.textContent = '실시간 정보 확인 중…';

  const errors = [];
  let locationSucceeded = false;
  let arrivalSucceeded = false;
  try {
    if (!state.routeStations.length) {
      const stationsData = await api('routeStations', { routeId: state.route.routeId }, { signal: controller.signal, timeout: 20000 });
      if (requestId !== state.liveRequestId) return;
      state.routeStations = (stationsData.items || [])
        .map(normalizeRouteStation)
        .filter(stop => Number.isFinite(routeStationSequence(stop)) && stationPosition(stop))
        .sort((a, b) => routeStationSequence(a) - routeStationSequence(b));
    }

    if (!state.routeStations.length) throw new Error('선택한 버스의 경유 정류소 좌표를 찾지 못했습니다. 노선 API 승인 상태를 확인해 주세요.');
    reconcileRouteOrders();

    const [shapeResult, locationResult, arrivalListResult] = await Promise.allSettled([
      state.routeShape.length
        ? Promise.resolve({ items: state.routeShape })
        : api('routeLines', { routeId: state.route.routeId }, { signal: controller.signal, timeout: 20000 }),
      api('busLocations', { routeId: state.route.routeId }, { signal: controller.signal, fresh: true, timeout: 18000 }),
      api('arrivalList', { stationId: state.origin.stationId }, { signal: controller.signal, fresh: true, timeout: 18000 })
    ]);
    if (requestId !== state.liveRequestId) return;

    if (shapeResult.status === 'fulfilled') {
      const shape = (shapeResult.value.items || [])
        .map(normalizeRouteShapePoint)
        .filter(point => stationPosition(point))
        .sort((a, b) => number(a.lineSeq) - number(b.lineSeq));
      if (shape.length) state.routeShape = shape;
    } else if (shapeResult.reason?.name !== 'AbortError') {
      errors.push(shapeResult.reason);
    }

    if (locationResult.status === 'fulfilled') {
      locationSucceeded = true;
      const nextLocations = (locationResult.value.items || [])
        .map(normalizeBusLocation)
        .filter(bus => Number.isFinite(number(bus.stationSeq, NaN)) || bus.stationId || normalizeKoreaCoordinate(bus.x, bus.y));
      if (nextLocations.length) {
        state.locations = nextLocations;
        state.lastLocationSuccessAt = Date.now();
      } else if (!state.locations.length || Date.now() - state.lastLocationSuccessAt > 90000) {
        state.locations = [];
      }
    } else if (locationResult.reason?.name !== 'AbortError') {
      errors.push(locationResult.reason);
      if (Date.now() - state.lastLocationSuccessAt > 90000) state.locations = [];
    }

    let matchedArrival = null;
    if (arrivalListResult.status === 'fulfilled') {
      arrivalSucceeded = true;
      state.arrivalList = arrivalListResult.value.items || [];
      matchedArrival = selectArrivalForRoute(state.arrivalList);
      if (matchedArrival) applyArrivalDirection(matchedArrival, 'list');
    } else if (arrivalListResult.reason?.name !== 'AbortError') {
      errors.push(arrivalListResult.reason);
      state.arrivalList = [];
    }

    // 목록조회에서 방향을 못 찾으면 기존 항목조회로 한 번 더 확인한다.
    if (!matchedArrival) {
      try {
        const arrivalItem = await api('arrival', {
          stationId: state.origin.stationId,
          routeId: state.route.routeId,
          staOrder: state.route.originStaOrder
        }, { signal: controller.signal, fresh: true, timeout: 18000 });
        if (requestId !== state.liveRequestId) return;
        arrivalSucceeded = true;
        applyArrivalDirection(arrivalItem.item || null, 'item');
      } catch (error) {
        if (error?.name !== 'AbortError') errors.push(error);
        state.arrival ||= {};
      }
    }

    state.lastLiveUpdatedAt = Date.now();
    writeLastJourney();
    renderArrival();
    renderLiveVehicleList();
    renderMap(fit || manual);
    checkForegroundAlarm();

    if (locationSucceeded || arrivalSucceeded) {
      updateApiState();
      els.apiState.textContent = '실시간 연결됨';
      els.apiState.closest('.live-pill')?.classList.add('is-good');
    } else if (errors[0]) {
      updateApiState(errors[0]);
    }

    if (els.liveUpdated) {
      const time = new Date(state.lastLiveUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      els.liveUpdated.textContent = `${time} 갱신 · 30초 자동 갱신`;
    }

    if (manual && !silent) {
      const collections = busCollections();
      const confirmedCount = collections.official.length + collections.current.length;
      toast(confirmedCount
        ? `현재 정류장으로 오는 차량 ${confirmedCount}대와 실제 노선을 갱신했습니다.`
        : collections.predicted.length
          ? `공식 도착정보는 없지만 다음 회차에 가까운 차량 ${collections.predicted.length}대를 표시했습니다.`
          : collections.all.length
            ? `전체 운행 차량 ${collections.all.length}대를 지도에 표시했습니다.`
            : '현재 운행 차량이 조회되지 않았습니다. 실제 노선은 지도에 표시했습니다.', 4400);
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    updateApiState(error);
    if (!silent) toast(error.message, 4200);
    if (state.routeStations.length) {
      renderArrival();
      renderLiveVehicleList();
      renderMap(fit || manual);
    }
  } finally {
    if (requestId === state.liveRequestId) {
      state.liveLoading = false;
      state.liveAbortController = null;
      if (els.refreshLive) {
        els.refreshLive.disabled = false;
        els.refreshLive.classList.remove('is-loading');
      }
      if (els.refreshLiveLabel) els.refreshLiveLabel.textContent = '새로고침';
    }
  }
}

function renderArrival() {
  const a = state.arrival || {};
  const fallback = busCollections().approaching;
  const cards = [1, 2].map(index => {
    const minRaw = a[`predictTime${index}`];
    const secRaw = a[`predictTimeSec${index}`];
    const stopsRaw = a[`locationNo${index}`];
    const hasMinutes = minRaw !== null && minRaw !== undefined && String(minRaw).trim() !== '';
    const hasSeconds = secRaw !== null && secRaw !== undefined && String(secRaw).trim() !== '';
    const hasStops = stopsRaw !== null && stopsRaw !== undefined && String(stopsRaw).trim() !== '';
    const hasOfficial = hasMinutes || hasSeconds || hasStops || arrivalHasVehicle(a, index);
    const min = hasMinutes ? number(minRaw, -1) : hasSeconds ? Math.ceil(number(secRaw, 0) / 60) : -1;
    const stops = number(stopsRaw, -1);
    const plate = a[`plateNo${index}`] || '';
    const stationName = a[`stationNm${index}`] || '';

    if (hasOfficial) {
      const timeText = min >= 0 ? (min <= 0 ? '곧 도착' : `${min}분`) : '실시간';
      const stopText = hasStops
        ? (stops <= 0 ? '정류장 도착·통과 중' : `${stops}정거장 전`)
        : '도착정보 확인 중';
      return `<div class="arrival-card">
        <div class="arrival-label">${index === 1 ? '가장 가까운 버스' : '다음 버스'}</div>
        <div class="arrival-time">${timeText}</div>
        <div class="arrival-stops">${stopText}</div>
        <div class="arrival-label">${esc(stationName || plate || '공식 도착정보')}</div>
      </div>`;
    }

    const bus = fallback[index - 1];
    if (bus) {
      const remaining = number(bus._remainingStops, -1);
      const modeText = bus._returnApproach ? '회차 후 접근'
        : bus._fallbackApproach ? '다음 회차' : '실시간 위치';
      const distanceText = remaining < 0 ? '위치 확인 중'
        : remaining === 0 ? '탑승 정류장 도착·진입 중'
          : bus._fallbackApproach ? `다음 회차까지 약 ${remaining}정거장`
            : `탑승 정류장까지 약 ${remaining}정거장`;
      const vehicle = bus.plateNo || (bus.vehId ? `차량 ${bus.vehId}` : '차량정보 확인 중');
      return `<div class="arrival-card estimated${bus._returnApproach ? ' returning' : ''}">
        <div class="arrival-label">${index === 1 ? '가장 가까운 운행 차량' : '그다음 운행 차량'}</div>
        <div class="arrival-time">${modeText}</div>
        <div class="arrival-stops">${distanceText}</div>
        <div class="arrival-label">${esc(vehicle)} · 실시간 위치 기준</div>
      </div>`;
    }

    return `<div class="arrival-card empty-arrival">
      <div class="arrival-label">${index === 1 ? '가장 가까운 버스' : '다음 버스'}</div>
      <div class="arrival-time">정보 없음</div>
      <div class="arrival-stops">현재 운행정보 없음</div>
      <div class="arrival-label">잠시 후 다시 갱신해 주세요.</div>
    </div>`;
  }).join('');
  els.arrivalGrid.innerHTML = cards;
}

function interpolateBusPosition(location) {
  const direct = normalizeKoreaCoordinate(
    location?.x ?? location?.gpsX ?? location?.longitude,
    location?.y ?? location?.gpsY ?? location?.latitude
  );
  if (direct) return [direct.lat, direct.lng];

  const ordered = [...state.routeStations].sort((a, b) => routeStationSequence(a) - routeStationSequence(b));
  const stationId = String(location?.stationId || '').trim();
  const seq = number(location?.stationSeq, NaN);
  let currentIndex = stationId ? ordered.findIndex(stop => sameId(stop.stationId, stationId)) : -1;
  if (currentIndex < 0 && Number.isFinite(seq)) currentIndex = ordered.findIndex(stop => routeStationSequence(stop) === seq);
  if (currentIndex < 0 && Number.isFinite(seq)) {
    currentIndex = ordered.reduce((best, stop, index) => {
      const distance = Math.abs(routeStationSequence(stop) - seq);
      return distance < best.distance ? { index, distance } : best;
    }, { index: -1, distance: Infinity }).index;
  }
  if (currentIndex < 0) return null;

  const current = ordered[currentIndex];
  const next = ordered[currentIndex + 1];
  const currentPos = stationPosition(current);
  if (!currentPos) return null;
  if (location._synthetic || !next) return currentPos;
  const nextPos = stationPosition(next) || currentPos;
  const stateCode = number(location.stateCd, -1);
  const ratio = stateCode === 0 ? .58 : stateCode === 2 ? .28 : .08;
  return [
    currentPos[0] + (nextPos[0] - currentPos[0]) * ratio,
    currentPos[1] + (nextPos[1] - currentPos[1]) * ratio
  ];
}

function stationPosition(stop) {
  const coordinate = normalizeKoreaCoordinate(
    stop?.x ?? stop?.gpsX ?? stop?.longitude,
    stop?.y ?? stop?.gpsY ?? stop?.latitude
  );
  return coordinate ? [coordinate.lat, coordinate.lng] : null;
}


function idText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function arrivalMetadata(index) {
  const arrival = state.arrival || {};
  const vehId = idText(arrival[`vehId${index}`]);
  const locationRaw = arrival[`locationNo${index}`];
  const hasLocation = locationRaw !== null && locationRaw !== undefined && String(locationRaw).trim() !== '';
  const locationNo = number(locationRaw, -1);
  if (!vehId && !hasLocation && !arrival[`plateNo${index}`]) return null;
  return {
    _arrivalRank: index,
    _locationNo: locationNo,
    _predictTime: number(arrival[`predictTime${index}`], -1),
    vehId,
    plateNo: arrival[`plateNo${index}`] || '',
    stationName: arrival[`stationNm${index}`] || '',
    stateCd: arrival[`stateCd${index}`]
  };
}

function mergeArrivalBus(bus, metadata) {
  return {
    ...bus,
    ...metadata,
    vehId: idText(bus?.vehId) || metadata.vehId,
    plateNo: bus?.plateNo || metadata.plateNo,
    stateCd: bus?.stateCd ?? metadata.stateCd
  };
}

function routeTopology() {
  const ordered = [...(state.routeStations || [])]
    .filter(stop => Number.isFinite(routeStationSequence(stop)))
    .sort((a, b) => routeStationSequence(a) - routeStationSequence(b));
  const count = ordered.length;
  const sequences = ordered.map(routeStationSequence);
  const minSeq = count ? Math.min(...sequences) : 0;
  const maxSeq = count ? Math.max(...sequences) : 0;
  const originSeq = number(state.route?.originStaOrder, NaN);
  const destinationSeq = number(state.route?.destinationStaOrder, NaN);
  let originIndex = ordered.findIndex(stop => routeStationSequence(stop) === originSeq);
  if (originIndex < 0 && state.origin?.stationId) {
    originIndex = ordered.findIndex(stop => sameId(stop.stationId, state.origin.stationId));
  }
  let destinationIndex = ordered.findIndex(stop => routeStationSequence(stop) === destinationSeq);
  if (destinationIndex < 0 && state.destination?.stationId) {
    destinationIndex = ordered.findIndex(stop => sameId(stop.stationId, state.destination.stationId));
  }

  let turnSeq = number(state.route?.turnSeq, NaN);
  if (!Number.isFinite(turnSeq)) {
    const turnStop = ordered.find(stop => stop.turnYn === 'Y')
      || ordered.find(stop => Number.isFinite(number(stop.turnSeq, NaN)));
    turnSeq = turnStop ? number(turnStop.turnSeq, routeStationSequence(turnStop)) : NaN;
  }
  let turnIndex = Number.isFinite(turnSeq)
    ? ordered.findIndex(stop => routeStationSequence(stop) === turnSeq)
    : -1;
  if (turnIndex < 0 && Number.isFinite(turnSeq) && count) {
    turnIndex = ordered.reduce((best, stop, index) => {
      const distance = Math.abs(routeStationSequence(stop) - turnSeq);
      return distance < best.distance ? { index, distance } : best;
    }, { index: -1, distance: Infinity }).index;
  }

  const hasReturnLeg = turnIndex >= 0 && turnIndex < count - 1;
  const originAtStart = originIndex >= 0 && originIndex <= Math.max(1, Math.floor(count * .06));
  return {
    ordered, count, minSeq, maxSeq, originSeq, destinationSeq,
    originIndex, destinationIndex, turnSeq, turnIndex,
    hasReturnLeg, loopCapable: hasReturnLeg, originAtStart
  };
}

function busRouteIndex(bus, topology = routeTopology()) {
  if (!topology.count) return -1;
  const seq = number(bus?.stationSeq, NaN);
  if (Number.isFinite(seq)) {
    const exact = topology.ordered.findIndex(stop => routeStationSequence(stop) === seq);
    if (exact >= 0) return exact;
  }
  if (bus?.stationId) {
    const matches = topology.ordered
      .map((stop, index) => ({ stop, index }))
      .filter(entry => sameId(entry.stop.stationId, bus.stationId));
    if (matches.length === 1) return matches[0].index;
    if (matches.length && Number.isFinite(seq)) {
      return matches.sort((a, b) => Math.abs(routeStationSequence(a.stop) - seq) - Math.abs(routeStationSequence(b.stop) - seq))[0].index;
    }
    if (matches.length) return matches[0].index;
  }
  if (!Number.isFinite(seq)) return -1;
  return topology.ordered.reduce((best, stop, index) => {
    const distance = Math.abs(routeStationSequence(stop) - seq);
    return distance < best.distance ? { index, distance } : best;
  }, { index: -1, distance: Infinity }).index;
}

function syntheticArrivalBus(metadata) {
  const topology = routeTopology();
  const locationNo = Math.max(0, number(metadata._locationNo, 0));
  const originIndex = topology.originIndex;
  let matched = null;

  if (originIndex >= 0 && topology.count) {
    const targetIndex = topology.loopCapable
      ? (originIndex - locationNo + topology.count) % topology.count
      : Math.max(0, originIndex - locationNo);
    matched = topology.ordered[targetIndex] || null;
  }

  if (!matched) {
    const arrivalName = normalizeName(metadata.stationName);
    const matchingStops = arrivalName
      ? state.routeStations.filter(stop => {
        const stopName = normalizeName(stop.stationName);
        return stopName && (stopName === arrivalName || stopName.includes(arrivalName) || arrivalName.includes(stopName));
      })
      : [];
    matched = matchingStops[0] || null;
  }

  return {
    ...metadata,
    _synthetic: true,
    stationId: matched?.stationId || '',
    stationSeq: matched ? routeStationSequence(matched) : number(state.route?.originStaOrder, 1)
  };
}

function busUniqueKey(bus) {
  return idText(bus?.vehId) || normalizePlate(bus?.plateNo) || `synthetic:${bus?._arrivalRank || ''}:${bus?.stationSeq}`;
}

function annotateBusProgress(bus) {
  const topology = routeTopology();
  const busIndex = busRouteIndex(bus, topology);
  if (busIndex < 0 || topology.originIndex < 0) {
    return {
      ...bus, _routeIndex: busIndex, _remainingStops: NaN,
      _directApproach: false, _returnApproach: false, _nextCycle: false
    };
  }

  const stateCode = number(bus?.stateCd, -1);
  const departedOrigin = busIndex === topology.originIndex && stateCode === 2;
  const sameOriginPhysical = sameId(bus?.stationId, state.origin?.stationId);
  let remainingStops;
  if (sameOriginPhysical && !departedOrigin) remainingStops = 0;
  else if (busIndex < topology.originIndex) remainingStops = topology.originIndex - busIndex;
  else if (busIndex === topology.originIndex) remainingStops = departedOrigin && topology.loopCapable ? topology.count : 0;
  else remainingStops = topology.loopCapable ? topology.count - busIndex + topology.originIndex : NaN;

  let directApproach = false;
  let returnApproach = false;
  if (topology.turnIndex >= 0) {
    if (topology.originIndex <= topology.turnIndex) {
      directApproach = busIndex < topology.originIndex || (busIndex === topology.originIndex && !departedOrigin);
      returnApproach = topology.originAtStart && topology.hasReturnLeg
        && busIndex >= topology.turnIndex && busIndex > topology.originIndex;
      directApproach ||= returnApproach;
    } else {
      // 탑승 정류장이 회차점 이후라면 회차 전 차량도 같은 운행에서 정류장으로 접근한다.
      directApproach = busIndex < topology.originIndex || (busIndex === topology.originIndex && !departedOrigin);
    }
  } else {
    directApproach = busIndex < topology.originIndex || (busIndex === topology.originIndex && !departedOrigin);
  }
  if (sameOriginPhysical && !departedOrigin) directApproach = true;

  const nextCycle = !directApproach && topology.loopCapable && Number.isFinite(remainingStops);
  return {
    ...bus,
    _routeIndex: busIndex,
    _remainingStops: remainingStops,
    _directApproach: directApproach,
    _returnApproach: returnApproach,
    _nextCycle: nextCycle
  };
}

function busCollections() {
  const actual = (state.locations || []).map(bus => annotateBusProgress({ ...bus, vehId: idText(bus.vehId) }));
  const actualByVehicle = new Map(actual.filter(bus => bus.vehId).map(bus => [bus.vehId, bus]));
  const actualByPlate = new Map(actual.filter(bus => bus.plateNo).map(bus => [normalizePlate(bus.plateNo), bus]));
  const matchedIds = new Set();
  const matchedPlates = new Set();
  const exactArrivals = [1, 2].map(arrivalMetadata).filter(Boolean).map(metadata => {
    const plateKey = normalizePlate(metadata.plateNo);
    const match = (metadata.vehId ? actualByVehicle.get(metadata.vehId) : null)
      || (plateKey ? actualByPlate.get(plateKey) : null);
    const merged = match ? mergeArrivalBus(match, metadata) : syntheticArrivalBus(metadata);
    if (match) {
      if (metadata.vehId) matchedIds.add(metadata.vehId);
      if (plateKey) matchedPlates.add(plateKey);
    }
    const annotated = annotateBusProgress(merged);
    return {
      ...annotated,
      _remainingStops: number(metadata._locationNo, annotated._remainingStops),
      _nextCycle: false,
      _directApproach: true,
      _officialArrival: true
    };
  });

  const unmatchedActual = actual.filter(bus => {
    if (bus.vehId && matchedIds.has(bus.vehId)) return false;
    if (bus.plateNo && matchedPlates.has(normalizePlate(bus.plateNo))) return false;
    return true;
  });
  const currentApproaching = unmatchedActual
    .filter(bus => bus._directApproach && Number.isFinite(number(bus._remainingStops, NaN)))
    .sort((a, b) => number(a._remainingStops, Infinity) - number(b._remainingStops, Infinity));

  const directCount = exactArrivals.length + currentApproaching.length;
  const predicted = unmatchedActual
    .filter(bus => !bus._directApproach && Number.isFinite(number(bus._remainingStops, NaN)) && number(bus._remainingStops, 0) > 0)
    .sort((a, b) => number(a._remainingStops, Infinity) - number(b._remainingStops, Infinity))
    .slice(0, Math.max(0, 2 - directCount))
    .map(bus => ({ ...bus, _fallbackApproach: true, _nextCycle: true }));

  const approaching = [...exactArrivals, ...currentApproaching, ...predicted]
    .filter((bus, index, array) => array.findIndex(item => busUniqueKey(item) === busUniqueKey(bus)) === index)
    .sort((a, b) => {
      if (a._arrivalRank && b._arrivalRank) return a._arrivalRank - b._arrivalRank;
      if (a._arrivalRank) return -1;
      if (b._arrivalRank) return 1;
      if (a._directApproach !== b._directApproach) return a._directApproach ? -1 : 1;
      return number(a._remainingStops, Infinity) - number(b._remainingStops, Infinity);
    });

  const exactByVehicle = new Map(exactArrivals.filter(bus => bus.vehId && !bus._synthetic).map(bus => [bus.vehId, bus]));
  const exactByPlate = new Map(exactArrivals.filter(bus => bus.plateNo && !bus._synthetic).map(bus => [normalizePlate(bus.plateNo), bus]));
  const predictedByKey = new Map(predicted.map(bus => [busUniqueKey(bus), bus]));
  const all = actual.map(bus => exactByVehicle.get(bus.vehId)
    || exactByPlate.get(normalizePlate(bus.plateNo))
    || predictedByKey.get(busUniqueKey(bus))
    || bus);
  exactArrivals.filter(bus => bus._synthetic).forEach(bus => all.push(bus));
  const dedupedAll = all.filter((bus, index, array) => array.findIndex(item => busUniqueKey(item) === busUniqueKey(bus)) === index);
  return {
    approaching,
    all: dedupedAll,
    official: exactArrivals,
    current: currentApproaching,
    returning: currentApproaching.filter(bus => bus._returnApproach),
    predicted
  };
}

function renderLiveVehicleList() {
  if (!els.liveVehicles || !state.route) return;
  const collections = busCollections();
  const incomingKeys = new Set(collections.approaching.map(busUniqueKey));
  const predictedKeys = new Set(collections.predicted.map(busUniqueKey));
  const returningKeys = new Set(collections.returning.map(busUniqueKey));
  const ordered = [...collections.all].sort((a, b) => {
    const aIncoming = incomingKeys.has(busUniqueKey(a));
    const bIncoming = incomingKeys.has(busUniqueKey(b));
    if (aIncoming !== bIncoming) return aIncoming ? -1 : 1;
    return number(a._remainingStops, Infinity) - number(b._remainingStops, Infinity);
  });

  if (!ordered.length) {
    els.liveVehicles.innerHTML = '<div class="empty">현재 운행 차량이 조회되지 않았습니다. 노선은 지도에 계속 표시됩니다.</div>';
    return;
  }

  els.liveVehicles.innerHTML = ordered.map((bus, index) => {
    const key = busUniqueKey(bus);
    const incoming = incomingKeys.has(key);
    const predicted = predictedKeys.has(key);
    const returning = returningKeys.has(key);
    const status = busMapStatus(bus);
    const vehicle = bus.plateNo || (bus.vehId ? `차량 ${bus.vehId}` : '차량번호 확인 중');
    const stateText = bus._arrivalRank ? `${bus._arrivalRank}번째`
      : returning ? '회차 후 접근'
        : predicted ? '다음 회차'
          : incoming ? '오는 버스' : '운행 중';
    return `<button type="button" class="live-vehicle-row${incoming ? ' incoming' : ''}${predicted ? ' predicted' : ''}${returning ? ' returning' : ''}" data-live-vehicle="${index}">
      <span class="live-route-badge">${esc(state.route.routeName)}</span>
      <span class="live-vehicle-copy"><strong>${esc(vehicle)}</strong><small>${esc(status.label)}</small></span>
      <span class="live-vehicle-state">${stateText}</span>
    </button>`;
  }).join('');

  els.liveVehicles.querySelectorAll('[data-live-vehicle]').forEach(button => button.addEventListener('click', () => {
    const bus = ordered[Number(button.dataset.liveVehicle)];
    const position = interpolateBusPosition(bus);
    if (position && state.map) state.map.setView(position, Math.max(state.map.getZoom(), 16), { animate: true });
  }));
}

function ensureMap() {
  if (state.map) return state.map;
  state.map = L.map('map', { zoomControl: true }).setView([37.39, 126.95], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(state.map);
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);
  return state.map;
}

function stopMarkerClass(seq) {
  const topology = routeTopology();
  const index = topology.ordered.findIndex(stop => routeStationSequence(stop) === seq);
  if (seq === state.route.originStaOrder) return 'origin';
  if (seq === state.route.destinationStaOrder) return 'destination';
  if (index >= 0) {
    if (index < topology.originIndex) return 'approach';
    if (topology.originAtStart && topology.hasReturnLeg && index >= topology.turnIndex) return 'approach';
  }
  if (seq > state.route.destinationStaOrder) return 'after';
  return 'journey';
}

function busMapStatus(bus) {
  const seq = number(bus.stationSeq, NaN);
  const remaining = number(bus._remainingStops, NaN);
  if (bus._arrivalRank) {
    const locationNo = number(bus._locationNo, -1);
    const arrivalLabel = bus._arrivalRank === 1 ? '첫 번째 도착 버스' : '두 번째 도착 버스';
    const distanceLabel = locationNo < 0 ? '위치 확인 중' : locationNo === 0 ? '곧 도착' : `${locationNo}정거장 전`;
    return {
      className: bus._arrivalRank === 1 ? 'arrival-first' : 'arrival-second',
      label: `${arrivalLabel} · ${distanceLabel}`
    };
  }
  if (bus._returnApproach) {
    return {
      className: 'return-approach',
      label: Number.isFinite(remaining)
        ? `회차 후 탑승 정류장까지 약 ${remaining}정거장`
        : '회차 후 탑승 정류장으로 접근 중'
    };
  }
  if (bus._fallbackApproach) {
    return {
      className: 'next-cycle',
      label: Number.isFinite(remaining) ? `다음 회차까지 약 ${remaining}정거장` : '다음 회차 위치 확인 중'
    };
  }
  if (bus._directApproach) {
    return {
      className: 'approach',
      label: Number.isFinite(remaining) && remaining > 0
        ? `탑승 정류장까지 약 ${remaining}정거장`
        : '탑승 정류장 도착·진입 중'
    };
  }
  const nextText = Number.isFinite(remaining) ? ` · 다음 회차까지 약 ${remaining}정거장` : '';
  if (Number.isFinite(seq) && seq <= state.route.destinationStaOrder) return { className: 'journey', label: `탑승 정류장을 지나 목적지 방향으로 운행 중${nextText}` };
  return { className: 'after', label: `목적지 이후 구간 운행 중${nextText}` };
}

function drawPolyline(stops, options) {
  const latlngs = stops.map(stationPosition).filter(Boolean);
  if (latlngs.length > 1) L.polyline(latlngs, options).addTo(state.routeLayer);
  return latlngs;
}

function splitRoutePath(latlngs, maxJumpMeters = 3500) {
  const segments = [];
  let current = [];
  latlngs.forEach(point => {
    const previous = current[current.length - 1];
    if (previous && distanceMeters(previous[0], previous[1], point[0], point[1]) > maxJumpMeters) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(point);
  });
  if (current.length > 1) segments.push(current);
  return segments;
}


function approachStopSegments(ordered) {
  const topology = routeTopology();
  if (topology.originIndex < 0 || !ordered.length) return [];
  const segments = [];

  if (topology.originIndex > 0) segments.push(ordered.slice(0, topology.originIndex + 1));
  if (topology.originAtStart && topology.hasReturnLeg) {
    const returnSegment = ordered.slice(Math.max(0, topology.turnIndex), ordered.length);
    const lastPos = stationPosition(returnSegment[returnSegment.length - 1]);
    const originPos = stationPosition(ordered[topology.originIndex]);
    if (lastPos && originPos && distanceMeters(lastPos[0], lastPos[1], originPos[0], originPos[1]) < 4000) {
      const samePoint = distanceMeters(lastPos[0], lastPos[1], originPos[0], originPos[1]) < 20;
      if (!samePoint) returnSegment.push(ordered[topology.originIndex]);
    }
    if (returnSegment.length > 1) segments.push(returnSegment);
  }
  if (!segments.length && topology.originIndex >= 0) segments.push(ordered.slice(0, topology.originIndex + 1));
  return segments;
}

function nearestShapeIndex(latlngs, position, preferredIndex = NaN) {
  if (!position || !latlngs.length) return -1;
  const preferred = Number.isFinite(preferredIndex)
    ? Math.max(0, Math.min(latlngs.length - 1, Math.round(preferredIndex)))
    : NaN;
  const radius = Number.isFinite(preferred) ? Math.max(24, Math.round(latlngs.length * .18)) : latlngs.length;
  const start = Number.isFinite(preferred) ? Math.max(0, preferred - radius) : 0;
  const end = Number.isFinite(preferred) ? Math.min(latlngs.length - 1, preferred + radius) : latlngs.length - 1;
  let best = { index: -1, distance: Infinity };
  for (let index = start; index <= end; index += 1) {
    const point = latlngs[index];
    const distance = distanceMeters(position[0], position[1], point[0], point[1]);
    if (distance < best.distance) best = { index, distance };
  }
  return best.index;
}

function routeShapeSliceForStops(shapeLatlngs, topology, stops) {
  if (!shapeLatlngs.length || !topology.count || !stops?.length) return [];
  const first = stops[0];
  const last = stops[stops.length - 1];
  const firstSeq = routeStationSequence(first);
  const lastSeq = routeStationSequence(last);
  const firstStationIndex = topology.ordered.findIndex(stop => routeStationSequence(stop) === firstSeq);
  let lastStationIndex = topology.ordered.findIndex(stop => routeStationSequence(stop) === lastSeq);
  const firstPos = stationPosition(first);
  const lastPos = stationPosition(last);
  if (firstStationIndex < 0 || !firstPos || !lastPos) return [];

  const maxShapeIndex = shapeLatlngs.length - 1;
  const stationDenominator = Math.max(1, topology.count - 1);
  const firstPreferred = firstStationIndex / stationDenominator * maxShapeIndex;
  let lastPreferred = lastStationIndex >= 0 ? lastStationIndex / stationDenominator * maxShapeIndex : NaN;

  // 회차 후 노선 끝에서 출발 정류장으로 돌아오는 구간은 shape의 끝부분을 사용한다.
  const wrapsToOrigin = firstStationIndex > topology.originIndex
    && sameId(last.stationId, state.origin?.stationId);
  if (wrapsToOrigin) {
    lastStationIndex = topology.count - 1;
    lastPreferred = maxShapeIndex;
  }

  const shapeStart = nearestShapeIndex(shapeLatlngs, firstPos, firstPreferred);
  let shapeEnd = wrapsToOrigin
    ? maxShapeIndex
    : nearestShapeIndex(shapeLatlngs, lastPos, lastPreferred);
  if (shapeStart < 0 || shapeEnd < 0 || shapeEnd <= shapeStart) return [];
  return shapeLatlngs.slice(shapeStart, shapeEnd + 1);
}

function renderMap(fit = false) {
  const map = ensureMap();
  state.routeLayer.clearLayers();
  state.markerLayer.clearLayers();

  const ordered = [...state.routeStations].sort((a, b) => number(a.stationSeq) - number(b.stationSeq));
  const routeShapeLatlngs = (state.routeShape || []).map(stationPosition).filter(Boolean);
  const routeShapeSegments = splitRoutePath(routeShapeLatlngs);
  routeShapeSegments.forEach(segment => {
    L.polyline(segment, { color: '#ffffff', weight: 10, opacity: .88, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
    L.polyline(segment, { color: '#b8c2cf', weight: 5, opacity: .72, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
  });
  const stationRouteLatlngs = drawPolyline(ordered, {
    color: '#b8c2cf', weight: routeShapeSegments.length ? 3 : 7,
    opacity: routeShapeSegments.length ? .22 : .68, lineCap: 'round', lineJoin: 'round'
  });
  const allLatlngs = routeShapeSegments.length ? routeShapeSegments.flat() : stationRouteLatlngs;
  const approachSegments = approachStopSegments(ordered);
  const journeyStops = ordered.filter(stop => {
    const seq = number(stop.stationSeq);
    return seq >= state.route.originStaOrder && seq <= state.route.destinationStaOrder;
  });
  const afterStops = ordered.filter(stop => number(stop.stationSeq) >= state.route.destinationStaOrder);

  const topology = routeTopology();
  const canUseExactShape = routeShapeSegments.length === 1 && routeShapeLatlngs.length > 3;
  const approachLatlngs = [];
  approachSegments.forEach(segment => {
    const exactSegment = canUseExactShape ? routeShapeSliceForStops(routeShapeLatlngs, topology, segment) : [];
    if (exactSegment.length > 1) {
      L.polyline(exactSegment, { color: '#78121d', weight: 11, opacity: .30, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
      L.polyline(exactSegment, { color: '#ef3340', weight: 7, opacity: .98, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
      approachLatlngs.push(...exactSegment);
    } else {
      drawPolyline(segment, { color: '#78121d', weight: 11, opacity: .30, lineCap: 'round', lineJoin: 'round' });
      approachLatlngs.push(...drawPolyline(segment, { color: '#ef3340', weight: 7, opacity: .98, lineCap: 'round', lineJoin: 'round' }));
    }
  });

  const exactJourney = canUseExactShape ? routeShapeSliceForStops(routeShapeLatlngs, topology, journeyStops) : [];
  let journeyLatlngs;
  if (exactJourney.length > 1) {
    L.polyline(exactJourney, { color: '#806600', weight: 12, opacity: .28, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
    L.polyline(exactJourney, { color: '#ffd43b', weight: 8, opacity: .99, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
    journeyLatlngs = exactJourney;
  } else {
    drawPolyline(journeyStops, { color: '#806600', weight: 12, opacity: .28, lineCap: 'round', lineJoin: 'round' });
    journeyLatlngs = drawPolyline(journeyStops, { color: '#ffd43b', weight: 8, opacity: .99, lineCap: 'round', lineJoin: 'round' });
  }

  const exactAfter = canUseExactShape ? routeShapeSliceForStops(routeShapeLatlngs, topology, afterStops) : [];
  if (exactAfter.length > 1) {
    L.polyline(exactAfter, { color: '#9da8b5', weight: 4, opacity: .34, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
  } else {
    drawPolyline(afterStops, { color: '#9da8b5', weight: 4, opacity: .34, lineCap: 'round', lineJoin: 'round' });
  }

  if (allLatlngs.length) {
    const badgePos = allLatlngs[Math.floor(allLatlngs.length / 2)];
    const routeBadge = L.divIcon({
      className: '',
      html: `<div class="route-map-badge"><span>${esc(state.route.routeName)}</span><small>${esc(state.route.routeDestName || '선택 노선')}</small></div>`,
      iconSize: [104, 38], iconAnchor: [52, 19]
    });
    L.marker(badgePos, { icon: routeBadge, interactive: false, zIndexOffset: 700 }).addTo(state.routeLayer);
  }

  ordered.forEach(stop => {
    const pos = stationPosition(stop);
    if (!pos) return;
    const seq = number(stop.stationSeq);
    const markerClass = stopMarkerClass(seq);
    const icon = L.divIcon({
      className: '',
      html: `<div class="stop-marker ${markerClass}"></div>`,
      iconSize: markerClass === 'origin' || markerClass === 'destination' ? [18, 18] : [11, 11],
      iconAnchor: markerClass === 'origin' || markerClass === 'destination' ? [9, 9] : [5, 5]
    });
    const stopLabel = markerClass === 'origin' ? '탑승 정류장' : markerClass === 'destination' ? '도착 정류장' : `${seq}번째 정류장`;
    L.marker(pos, { icon })
      .bindPopup(`<strong>${esc(stop.stationName)}</strong><br>${stopLabel}`)
      .addTo(state.markerLayer);
  });

  const collections = busCollections();
  const visibleBuses = state.vehicleScope === 'approaching' ? collections.approaching : collections.all;
  const visibleBusPositions = [];

  visibleBuses.forEach(bus => {
    const seq = number(bus.stationSeq);
    const pos = interpolateBusPosition(bus);
    if (!pos) return;
    visibleBusPositions.push(pos);
    const status = busMapStatus(bus);
    const icon = L.divIcon({
      className: '',
      html: `<div class="bus-marker ${status.className}"><span class="bus-route-number">${esc(state.route.routeName)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17h12M7 4h10a3 3 0 0 1 3 3v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a3 3 0 0 1 3-3Zm-1 9h12M8 8h8M7 21v-3m10 3v-3"/></svg><small>${esc(String(bus.plateNo || bus.vehId || '').slice(-4))}</small></div>`,
      iconSize: bus._arrivalRank ? [68, 52] : [62, 48],
      iconAnchor: bus._arrivalRank ? [34, 26] : [31, 24]
    });
    const vehicleLabel = bus.plateNo || (bus.vehId ? `차량 ${bus.vehId}` : '차량정보 확인 중');
    const sourceLabel = bus._synthetic ? '<br><small>도착정보 기준 추정 위치</small>' : bus._fallbackApproach ? '<br><small>다음 회차 후보 · GPS 위치 기준</small>' : '';
    L.marker(pos, { icon, zIndexOffset: bus._arrivalRank ? 1300 : bus._fallbackApproach ? 1200 : 1000 })
      .bindPopup(`<strong>${esc(state.route.routeName)}번</strong><br>${esc(vehicleLabel)}<br>${esc(status.label)}<br>${seq}번째 정류장 부근${sourceLabel}`)
      .addTo(state.markerLayer);
  });

  if (state.userLocation) {
    const userPos = [state.userLocation.lat, state.userLocation.lng];
    if (state.userLocation.accuracy > 0) {
      L.circle(userPos, {
        radius: Math.min(Math.max(state.userLocation.accuracy, 20), 300),
        color: '#0f86ff', weight: 1, opacity: .45, fillColor: '#28a5ff', fillOpacity: .09
      }).addTo(state.markerLayer);
    }
    const icon = L.divIcon({
      className: '',
      html: '<div class="current-location-marker"><span></span></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });
    L.marker(userPos, { icon, zIndexOffset: 1500 }).bindPopup('<strong>내 현재 위치</strong>').addTo(state.markerLayer);
  }

  const confirmedCount = collections.official.length + collections.current.length;
  const predictedCount = collections.predicted.length;
  const allCount = collections.all.length;
  els.busCount.textContent = confirmedCount
    ? `오는 버스 ${confirmedCount}대 · 전체 ${allCount}대`
    : predictedCount
      ? `다음 회차 후보 ${predictedCount}대 · 전체 ${allCount}대`
      : `오는 버스 0대 · 전체 ${allCount}대`;
  if (state.vehicleScope === 'approaching') {
    els.mapNote.textContent = confirmedCount
      ? '빨간선은 탑승 정류장으로 들어오는 구간, 노란선은 탑승 후 목적지까지 이동할 구간입니다.'
      : predictedCount
        ? '공식 도착 예정 차량이 없어, 현재 노선 위 차량 중 다음 회차에 가장 먼저 올 가능성이 높은 차량을 주황색으로 표시합니다.'
        : '현재 탑승 정류장에 접근 중인 차량이 확인되지 않습니다. “전체 차량”에서 모든 운행 위치를 볼 수 있습니다.';
  } else {
    els.mapNote.textContent = allCount
      ? '빨간선은 오는 버스 구간, 노란선은 탑승 후 이동 구간입니다. 회색은 나머지 노선입니다.'
      : '선택한 실제 노선은 표시됐지만 현재 운행 차량 정보가 없습니다. 잠시 후 새로고침해 주세요.';
  }

  if (fit) {
    let fitLatlngs = state.mapScope === 'journey' && journeyLatlngs.length ? journeyLatlngs : allLatlngs;
    if (state.vehicleScope === 'approaching' && approachLatlngs.length) fitLatlngs = [...approachLatlngs, ...visibleBusPositions];
    if (!fitLatlngs.length) fitLatlngs = stationRouteLatlngs;
    if (state.userLocation && !state.routeShape.length) fitLatlngs = [...fitLatlngs, [state.userLocation.lat, state.userLocation.lng]];
    if (fitLatlngs.length > 1) map.fitBounds(fitLatlngs, { padding: [34, 34], maxZoom: 16 });
    else if (fitLatlngs.length === 1) map.setView(fitLatlngs[0], 15);
  }
  setTimeout(() => map.invalidateSize(), 100);
}


function alertStorageKey(alert) {
  return `${String(alert?.routeId || '')}_${String(alert?.stationId || '')}`;
}

function readSavedAlerts() {
  try {
    let alerts = JSON.parse(localStorage.getItem(SAVED_ALERTS_KEY) || '[]');
    if (!Array.isArray(alerts)) alerts = [];
    const legacy = JSON.parse(localStorage.getItem('hogyeBusAlert') || 'null');
    if (legacy?.routeId && legacy?.stationId) {
      const legacyKey = alertStorageKey(legacy);
      if (!alerts.some(alert => alertStorageKey(alert) === legacyKey)) alerts.push({ ...legacy, _key: legacyKey });
      localStorage.removeItem('hogyeBusAlert');
    }
    return alerts
      .filter(alert => alert?.routeId && alert?.stationId)
      .map(alert => ({ ...alert, _key: alert._key || alertStorageKey(alert) }))
      .sort((a, b) => String(a.routeName || '').localeCompare(String(b.routeName || ''), 'ko'));
  } catch {
    return [];
  }
}

function writeSavedAlerts(alerts) {
  state.savedAlerts = [...alerts].sort((a, b) => String(a.routeName || '').localeCompare(String(b.routeName || ''), 'ko'));
  localStorage.setItem(SAVED_ALERTS_KEY, JSON.stringify(state.savedAlerts));
  renderSavedAlerts();
}

function upsertSavedAlert(payload) {
  const key = alertStorageKey(payload);
  state.savedAlertAlarmKeys.delete(key);
  state.savedAlertBaselineRoutes.delete(key);
  const next = state.savedAlerts.filter(alert => alertStorageKey(alert) !== key);
  next.push({
    ...payload,
    _key: key,
    routeStations: state.route?.routeId === payload.routeId
      ? state.routeStations.map(compactJourneyRouteStation).filter(Boolean)
      : (payload.routeStations || []),
    savedAt: Date.now()
  });
  localStorage.setItem(LAST_SELECTED_ALERT_KEY, key);
  writeSavedAlerts(next);
  writeLastJourney();
}

function alertDaysText(days = []) {
  const labels = ['일', '월', '화', '수', '목', '금', '토'];
  const normalized = [...new Set((days || []).map(Number))].sort((a, b) => a - b);
  if (normalized.length === 7) return '매일';
  if (normalized.length === 5 && [1, 2, 3, 4, 5].every(day => normalized.includes(day))) return '평일';
  return normalized.map(day => labels[day]).join('·') || '요일 없음';
}

function renderSavedAlerts() {
  if (!els.savedAlerts || !els.savedAlertCount) return;
  els.savedAlertCount.textContent = `${state.savedAlerts.length}개`;
  if (!state.savedAlerts.length) {
    els.savedAlerts.innerHTML = '<div class="empty compact-empty">저장된 버스 알림이 없습니다.</div>';
    if (!state.route && els.alertSection) {
      els.alertSection.classList.add('hidden');
      els.alertSection.classList.remove('saved-only');
    }
    return;
  }
  if (!state.route && els.alertSection) {
    els.alertSection.classList.remove('hidden');
    els.alertSection.classList.add('saved-only');
  }
  els.savedAlerts.innerHTML = state.savedAlerts.map(alert => `
    <article class="saved-alert-row" data-alert-key="${esc(alertStorageKey(alert))}">
      <span class="saved-route-number">${esc(alert.routeName || '버스')}</span>
      <div class="saved-alert-copy">
        <strong>${esc(alert.stationName || '탑승 정류장')}</strong>
        <span>${esc(alert.startTime || '00:00')}–${esc(alert.endTime || '23:59')} · ${esc(alertDaysText(alert.days))} · ${number(alert.leadStops, 3)}정거장 전</span>
        <small>${esc(alertModeLabel(alert.alertMode))} · ${esc(alertSoundLabel(alert.alertSound))}</small>
      </div>
      <div class="saved-alert-actions">
        <button type="button" class="saved-alert-load" data-load-alert="${esc(alertStorageKey(alert))}">불러오기</button>
        <button type="button" class="saved-alert-delete" data-delete-alert="${esc(alertStorageKey(alert))}" aria-label="${esc(alert.routeName || '')}번 알림 삭제">삭제</button>
      </div>
    </article>`).join('');
  els.savedAlerts.querySelectorAll('[data-load-alert]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await restoreSavedAlert(button.dataset.loadAlert, { scroll: true });
    });
  });
  els.savedAlerts.querySelectorAll('[data-delete-alert]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const key = button.dataset.deleteAlert;
      if (!key || button.disabled) return;
      button.disabled = true;
      button.textContent = '삭제 중…';
      await removeSavedAlert(key);
    });
  });
}

async function restoreSavedAlert(key, { scroll = false } = {}) {
  if (!key || state.restoreBusy) return;
  const alert = state.savedAlerts.find(item => alertStorageKey(item) === key);
  const journey = journeyFromAlert(alert);
  if (!journey?.origin || !journey?.destination || !journey?.route) {
    toast('저장된 알림의 노선정보를 복원할 수 없습니다.');
    return;
  }
  state.restoreBusy = true;
  localStorage.setItem(LAST_SELECTED_ALERT_KEY, key);
  try {
    state.origin = journey.origin;
    state.destination = journey.destination;
    renderSelectedStation('origin', state.origin);
    renderSelectedStation('destination', state.destination);
    updateDestinationFavoriteControl();
    await chooseRoute(pairFromStoredJourney(journey), { restore: true });
    applyAlertToForm(alert);
    els.alertInfo.textContent = `${alert.routeName}번 예약 설정을 복원했습니다.`;
    writeLastJourney();
    if (scroll) els.alertSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`${alert.routeName}번 예약 설정을 불러왔습니다.`);
  } catch (error) {
    console.warn('saved alert restore failed', error);
    toast(`예약 복원 실패: ${error.message}`, 5000);
  } finally {
    state.restoreBusy = false;
  }
}

async function restoreSavedStateIfNeeded() {
  if (state.route || state.restoreBusy) return;
  state.savedAlerts = readSavedAlerts();
  renderSavedAlerts();
  const firstAlert = state.savedAlerts[0];
  const preferred = localStorage.getItem(LAST_SELECTED_ALERT_KEY) || (firstAlert ? alertStorageKey(firstAlert) : '');
  if (preferred) await restoreSavedAlert(preferred);
}

function applyAlertToForm(alert) {
  if (!alert) return;
  $('startTime').value = alert.startTime || '15:00';
  $('endTime').value = alert.endTime || '23:00';
  $('leadStops').value = String(number(alert.leadStops, 3));
  $('alertMode').value = alert.alertMode || 'push';
  $('alertSound').value = alert.alertSound || 'standard';
  $('alertEnabled').checked = alert.enabled !== false;
  const activeDays = new Set((alert.days || []).map(Number));
  document.querySelectorAll('.day').forEach(button => button.classList.toggle('active', activeDays.has(Number(button.dataset.day))));
}

function loadAlertFormForCurrentRoute() {
  if (!state.route || !state.origin) return;
  const key = `${state.route.routeId}_${state.origin.stationId}`;
  const saved = state.savedAlerts.find(alert => alertStorageKey(alert) === key);
  if (saved) {
    applyAlertToForm(saved);
    els.alertInfo.textContent = `${saved.routeName}번에 저장한 알림 설정을 불러왔습니다. 수정 후 다시 저장할 수 있습니다.`;
  } else {
    els.alertInfo.textContent = `${state.route.routeName}번 알림을 새로 설정합니다. 다른 버스 알림과 별도로 저장됩니다.`;
  }
}

async function removeSavedAlert(key) {
  const alert = state.savedAlerts.find(item => alertStorageKey(item) === key);
  state.savedAlertAlarmKeys.delete(key);
  state.savedAlertBaselineRoutes.delete(key);
  if (!alert) {
    renderSavedAlerts();
    return;
  }

  // Firebase 상태나 네트워크 오류 때문에 삭제 버튼이 막히지 않도록
  // 먼저 기기 저장소에서 즉시 제거하고 화면을 갱신한다.
  try {
    const remaining = state.savedAlerts.filter(item => alertStorageKey(item) !== key);
    writeSavedAlerts(remaining);
  } catch (localError) {
    console.error('local alert delete failed', localError);
    renderSavedAlerts();
    toast(`기기 알림 삭제 실패: ${localError.message}`, 4500);
    return;
  }

  if (localStorage.getItem(LAST_SELECTED_ALERT_KEY) === key) {
    const replacement = state.savedAlerts[0];
    if (replacement) localStorage.setItem(LAST_SELECTED_ALERT_KEY, alertStorageKey(replacement));
    else localStorage.removeItem(LAST_SELECTED_ALERT_KEY);
  }
  toast(`${alert.routeName || '버스'}번 알림을 기기에서 삭제했습니다.`);
  if (state.route && state.origin && key === `${state.route.routeId}_${state.origin.stationId}`) {
    els.alertInfo.textContent = `${state.route.routeName}번 알림이 삭제되었습니다. 새 조건으로 다시 저장할 수 있습니다.`;
  }

  // 서버 저장본은 별도로 정리한다. 실패해도 기기에서 삭제한 항목을 되살리지 않는다.
  if (!state.firebase?.firestore || !state.firebase?.user) return;

  const documentId = alert._docId || `${state.firebase.user.uid}_${alert.routeId}_${alert.stationId}`;
  const alertRef = doc(state.firebase.firestore, 'busAlerts', documentId);
  try {
    await deleteDoc(alertRef);
  } catch (remoteError) {
    console.warn('remote alert delete failed; trying to disable it', remoteError);
    try {
      // 예약 함수는 enabled == true 문서만 조회하므로 삭제가 일시 실패하면 우선 비활성화한다.
      await setDoc(alertRef, {
        enabled: false,
        armed: false,
        token: '',
        updatedAt: serverTimestamp()
      }, { merge: true });
      toast(`${alert.routeName || '버스'}번은 기기에서 삭제했고 서버 알림도 중지했습니다.`, 4200);
    } catch (disableError) {
      console.warn('remote alert disable failed', disableError);
      toast('기기에서는 삭제됐지만 서버 정리에 실패했습니다. 인터넷 연결 후 같은 버스를 저장했다가 다시 삭제해 주세요.', 6500);
    }
  }
}

function selectedDays() {
  return [...document.querySelectorAll('.day.active')].map(btn => Number(btn.dataset.day));
}

function withinAlertSchedule(alert) {
  const now = new Date();
  const day = now.getDay();
  const hhmm = now.toTimeString().slice(0, 5);
  const start = alert?.startTime || '00:00';
  const end = alert?.endTime || '23:59';
  const days = Array.isArray(alert?.days) ? alert.days.map(Number) : [];
  const timeOk = start <= end ? hhmm >= start && hhmm <= end : hhmm >= start || hhmm <= end;
  return alert?.enabled !== false && days.includes(day) && timeOk;
}

function withinLocalSchedule() {
  return withinAlertSchedule({
    enabled: $('alertEnabled').checked,
    startTime: $('startTime').value || '00:00',
    endTime: $('endTime').value || '23:59',
    days: selectedDays()
  });
}

function alertModeLabel(mode = 'push') {
  return ({
    push: '소리·진동·푸시',
    soundPush: '소리·푸시',
    vibratePush: '진동·푸시',
    pushOnly: '푸시만'
  })[mode] || '소리·진동·푸시';
}

function alertSoundLabel(sound = 'standard') {
  return ({
    standard: '기본 알림음',
    bright: '경쾌한 알림음',
    urgent: '긴급 알림음',
    soft: '부드러운 알림음',
    chime: '차임 알림음',
    futureBus: '미래형 버스 알림음',
    silent: '무음'
  })[sound] || '기본 알림음';
}

function alertModeUsesSound(mode = 'push') {
  return mode === 'push' || mode === 'soundPush';
}

function alertModeUsesVibration(mode = 'push') {
  return mode === 'push' || mode === 'vibratePush';
}

function soundPattern(sound = 'standard') {
  const patterns = {
    standard: { type: 'sine', gain: .34, notes: [[0, 740, .34], [.42, 880, .34], [.84, 740, .42]] },
    bright: { type: 'triangle', gain: .28, notes: [[0, 880, .24], [.28, 1100, .24], [.56, 1320, .36]] },
    urgent: { type: 'square', gain: .22, notes: [[0, 690, .22], [.27, 980, .22], [.54, 690, .22], [.81, 980, .42]] },
    soft: { type: 'sine', gain: .18, notes: [[0, 523, .42], [.48, 659, .55]] },
    chime: { type: 'sine', gain: .25, notes: [[0, 784, .32], [.16, 1047, .42], [.34, 1319, .62]] },
    silent: { type: 'sine', gain: 0, notes: [] }
  };
  return patterns[sound] || patterns.standard;
}

const FUTURE_BUS_ALERT_URL = new URL('/assets/future-bus-alert.mp3?v=2.8.0', window.location.origin).href;
let customAlertAudio = null;

function getCustomAlertAudio() {
  // HTMLAudio는 Web Audio 재생이 불가능할 때만 실제 알림 순간에 생성한다.
  // 앱 시작 시에는 음원을 로드하거나 play()하지 않는다.
  if (!customAlertAudio) {
    customAlertAudio = new Audio();
    customAlertAudio.src = FUTURE_BUS_ALERT_URL;
    customAlertAudio.preload = 'none';
    customAlertAudio.playsInline = true;
    customAlertAudio.setAttribute('playsinline', '');
    customAlertAudio.setAttribute('webkit-playsinline', '');
    customAlertAudio.volume = 0.92;
  }
  return customAlertAudio;
}

function getSharedAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.sharedAudioContext || state.sharedAudioContext.state === 'closed') {
    state.sharedAudioContext = new AudioContextClass();
  }
  return state.sharedAudioContext;
}

async function loadFutureBusAudioBuffer() {
  if (state.futureBusAudioBuffer) return state.futureBusAudioBuffer;
  if (state.futureBusAudioBufferPromise) return state.futureBusAudioBufferPromise;
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  state.futureBusAudioBufferPromise = (async () => {
    const response = await fetch(FUTURE_BUS_ALERT_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`알림음 파일을 불러오지 못했습니다. (${response.status})`);
    const bytes = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    state.futureBusAudioBuffer = buffer;
    return buffer;
  })().finally(() => {
    state.futureBusAudioBufferPromise = null;
  });
  return state.futureBusAudioBufferPromise;
}

async function unlockAudioFromGesture() {
  if (state.audioUnlocked || state.audioUnlockBusy) return state.audioUnlocked;
  state.audioUnlockBusy = true;
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') await ctx.resume();

    // 실제 노래 대신 출력 게인이 0인 짧은 신호로 오디오 권한만 준비한다.
    // 따라서 앱을 열거나 화면을 처음 눌러도 알림음이 들리지 않는다.
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.015);
    state.audioUnlocked = ctx.state === 'running';
    if (state.audioUnlocked) void loadFutureBusAudioBuffer().catch(error => console.debug('future alert preload skipped', error));
    return state.audioUnlocked;
  } catch (error) {
    console.debug('audio context unlock skipped', error);
    return false;
  } finally {
    state.audioUnlockBusy = false;
  }
}

async function playFutureBusAlert({ fromTest = false, fallback = true } = {}) {
  try {
    const ctx = getSharedAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') await ctx.resume();
      const buffer = await withTimeout(loadFutureBusAudioBuffer(), 9000, '미래형 알림음 준비 시간이 초과되었습니다.');
      if (buffer && ctx.state === 'running') {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        gain.gain.value = 0.92;
        source.connect(gain).connect(ctx.destination);
        source.start(0);
        state.audioUnlocked = true;
        return true;
      }
    }

    // Web Audio를 지원하지 않는 브라우저에서 실제 테스트/알림 순간에만 사용한다.
    const audio = getCustomAlertAudio();
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    audio.volume = 0.92;
    const playback = audio.play();
    if (playback?.then) await playback;
    state.audioUnlocked = true;
    return true;
  } catch (error) {
    console.warn('custom alert audio playback failed', error);
    const now = Date.now();
    if (fromTest || now - state.audioFailureToastAt > 12000) {
      state.audioFailureToastAt = now;
      const detail = error?.name === 'NotAllowedError'
        ? '알림 테스트를 한 번 눌러 소리 권한을 준비해 주세요.'
        : '음원 재생에 실패해 기본 차임으로 대신 재생합니다.';
      toast(`미래형 알림음 재생 실패 · ${detail}`, 4500);
    }
    if (fallback) playToneAlarm('chime', { vibrate: false });
    return false;
  }
}

function playToneAlarm(sound = 'standard', { vibrate = true } = {}) {
  if (vibrate) navigator.vibrate?.([280, 110, 280, 110, 480]);
  const pattern = soundPattern(sound);
  if (!pattern.notes.length) return false;
  const ctx = getSharedAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  pattern.notes.forEach(([offset, frequency, duration]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = pattern.type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, ctx.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(Math.max(.001, pattern.gain), ctx.currentTime + offset + .025);
    gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + offset + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + offset);
    osc.stop(ctx.currentTime + offset + duration + .03);
  });
  return true;
}

function playAlarm(sound = 'standard', { vibrate = true } = {}) {
  if (sound === 'futureBus') {
    if (vibrate) navigator.vibrate?.([280, 110, 280, 110, 480]);
    void playFutureBusAlert({ fallback: true });
    return;
  }
  playToneAlarm(sound, { vibrate });
}

async function testConfiguredAlert() {
  const button = $('testAlert');
  const original = button.innerHTML;
  button.disabled = true;
  const mode = $('alertMode').value || 'push';
  const sound = $('alertSound').value || 'standard';
  try {
    button.textContent = '알림음 준비 중…';
    if (!alertModeUsesSound(mode)) {
      if (alertModeUsesVibration(mode)) navigator.vibrate?.([280, 110, 280, 110, 480]);
      toast(`${alertModeLabel(mode)} 테스트를 실행했습니다.`);
      return;
    }
    if (sound === 'futureBus') {
      // click 제스처의 첫 동기 구간에서 바로 play()가 호출되도록 다른 await보다 먼저 실행한다.
      const played = await playFutureBusAlert({ fromTest: true, fallback: true });
      if (played) toast('미래형 버스 알림음을 재생했습니다.');
      return;
    }
    await unlockAudioFromGesture();
    playToneAlarm(sound, { vibrate: alertModeUsesVibration(mode) });
    toast(`${alertSoundLabel(sound)} 테스트를 재생했습니다.`);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function playConfiguredAlert(alertConfig = null) {
  const mode = alertConfig?.alertMode || $('alertMode').value || 'push';
  const sound = alertConfig?.alertSound || $('alertSound').value || 'standard';
  if (alertModeUsesSound(mode)) playAlarm(sound, { vibrate: alertModeUsesVibration(mode) });
  else if (alertModeUsesVibration(mode)) navigator.vibrate?.([280, 110, 280, 110, 480]);
}

async function showLocalNotification(title, body, alertConfig = null) {
  if ('Notification' in window && Notification.permission === 'granted' && state.swRegistration) {
    const routeId = alertConfig?.routeId || state.route?.routeId || 'bus';
    const alertMode = alertConfig?.alertMode || $('alertMode').value;
    await state.swRegistration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      tag: `foreground-${routeId}`, requireInteraction: true,
      silent: alertMode === 'pushOnly',
      vibrate: alertModeUsesVibration(alertMode) ? [300, 120, 300, 120, 500] : [],
      data: { url: '/', alertMode, alertSound: alertConfig?.alertSound || $('alertSound').value || 'standard' }
    });
  }
}


async function checkSavedAlertRoutes() {
  const alerts = state.savedAlerts.filter(withinAlertSchedule).slice(0, 12);
  if (!alerts.length) return;
  for (const alert of alerts) {
    const routeKey = alertStorageKey(alert);
    // 현재 화면에서 보고 있는 노선은 더 정확한 실시간 위치 결합 로직이 따로 처리한다.
    if (state.route && state.origin && routeKey === `${state.route.routeId}_${state.origin.stationId}`) continue;
    try {
      const result = await api('arrival', {
        stationId: alert.stationId,
        routeId: alert.routeId,
        staOrder: alert.staOrder
      }, { fresh: true, timeout: 15000 });
      const item = result.item || {};
      const locationNo = number(item.locationNo1, 0);
      const lead = number(alert.leadStops, 3);
      const vehicleKey = String(item.plateNo1 || item.vehId1 || 'unknown');
      const alarmKey = `${new Date().toDateString()}:${routeKey}:${vehicleKey}`;
      // 앱을 열었을 때 이미 알림 구간 안에 있던 버스는 기준 상태만 기록한다.
      // 이후 다른 버스가 새로 진입할 때만 소리를 재생해 시작하자마자 노래가 나오는 현상을 막는다.
      if (!state.savedAlertBaselineRoutes.has(routeKey)) {
        state.savedAlertBaselineRoutes.add(routeKey);
        if (locationNo > 0 && locationNo <= lead) state.savedAlertAlarmKeys.set(routeKey, alarmKey);
        else state.savedAlertAlarmKeys.delete(routeKey);
        continue;
      }
      if (locationNo > 0 && locationNo <= lead && state.savedAlertAlarmKeys.get(routeKey) !== alarmKey) {
        state.savedAlertAlarmKeys.set(routeKey, alarmKey);
        state.lastAlertAt = Date.now();
        const title = `${alert.routeName || '버스'}번 ${locationNo}정거장 전`;
        const body = `${alert.stationName || '탑승 정류장'}에 곧 도착합니다.`;
        playConfiguredAlert(alert);
        await showLocalNotification(title, body, alert);
        toast(`${title} · ${body}`, 5000);
      }
      if (locationNo <= 0 || locationNo > lead + 2) state.savedAlertAlarmKeys.delete(routeKey);
    } catch (error) {
      console.warn('saved alert foreground check failed', routeKey, error);
    }
  }
}

function startSavedAlertPolling() {
  clearInterval(state.savedAlertPoller);
  state.savedAlertPoller = setInterval(() => checkSavedAlertRoutes(), 60000);
  setTimeout(() => checkSavedAlertRoutes(), 6000);
}

function checkForegroundAlarm() {
  if (!state.route || !withinLocalSchedule()) return;
  let locationNo = number(state.arrival?.locationNo1, 0);
  let plate = String(state.arrival?.plateNo1 || '');
  let vehicleId = String(state.arrival?.vehId1 || '');
  let approximate = false;

  // 종점 정류소는 공식 도착정보가 비는 경우가 있어 실시간 stationSeq로 남은 정류장을 계산한다.
  if (locationNo <= 0) {
    const currentBus = busCollections().approaching
      .filter(bus => number(bus._remainingStops, 0) > 0)
      .sort((a, b) => number(a._remainingStops, Infinity) - number(b._remainingStops, Infinity))[0];
    if (currentBus) {
      locationNo = number(currentBus._remainingStops, 0);
      plate = String(currentBus.plateNo || '');
      vehicleId = String(currentBus.vehId || '');
      approximate = !currentBus._officialArrival;
    }
  }

  const lead = number($('leadStops').value, 3);
  const vehicleKey = plate || vehicleId || 'unknown';
  const key = `${new Date().toDateString()}:${state.route.routeId}:${vehicleKey}`;

  // 노선을 처음 복원하거나 선택했을 때 이미 가까이 있던 차량은 기준값만 잡는다.
  // 다음 차량이 새로 알림 구간에 들어오는 순간부터 알림을 울린다.
  if (!state.foregroundBaselineReady) {
    state.foregroundBaselineReady = true;
    state.foregroundAlarmKey = locationNo > 0 && locationNo <= lead ? key : '';
    return;
  }

  if (locationNo > 0 && locationNo <= lead && key !== state.foregroundAlarmKey) {
    state.foregroundAlarmKey = key;
    state.lastAlertAt = Date.now();
    const title = `${state.route.routeName}번 ${approximate ? '약 ' : ''}${locationNo}정거장 전`;
    const body = `${state.origin.stationName}에 곧 도착합니다.`;
    playConfiguredAlert();
    showLocalNotification(title, body);
    toast(body, 5000);
  }
  if (locationNo > lead || locationNo <= 0) state.foregroundAlarmKey = '';
}

function startPolling() {
  clearInterval(state.poller);
  state.poller = setInterval(() => {
    if (!document.hidden) loadLive(false, { silent: true });
  }, 30000);
}

async function initFirebase() {
  try {
    const configResponse = await withTimeout(
      fetch('/api/config', { cache: 'no-store' }),
      8000,
      'Firebase 설정을 불러오는 시간이 초과되었습니다.'
    );
    state.firebaseConfig = await configResponse.json();

    if ('serviceWorker' in navigator) {
      try {
        state.swRegistration = await withTimeout(
          navigator.serviceWorker.register('/api/firebase-messaging-sw?v=2.8.0', { scope: '/' }),
          8000,
          '서비스워커 연결 시간이 초과되었습니다.'
        );
      } catch (swError) {
        state.swRegistration = null;
        console.warn('service worker registration failed', swError);
      }
    }

    if (!state.firebaseConfig.backgroundPushConfigured) {
      els.pushState.textContent = '화면 켤 때만';
      els.alertInfo.textContent = 'Firebase 환경변수가 없어 현재는 앱을 열어둔 동안의 알림만 동작합니다.';
      return;
    }

    const app = initializeApp(state.firebaseConfig.firebase);
    const auth = getAuth(app);
    const firestore = getFirestore(app);
    state.firebase = { app, auth, user: null, firestore, messaging: null };

    // Firebase Web Messaging SDK는 iOS/iPadOS Safari를 공식 지원 대상으로 두지 않는다.
    // Apple 모바일에서는 토큰 발급을 시도하지 않아 무한 대기 UI를 방지한다.
    let messagingSupported = false;
    if (!isAppleMobileBrowser()) {
      try {
        messagingSupported = await withTimeout(isSupported(), 3500, '푸시 지원 확인 시간이 초과되었습니다.');
      } catch (supportError) {
        console.warn('messaging support check failed', supportError);
      }
    }

    if (messagingSupported) {
      state.firebase.messaging = getMessaging(app);
      onMessage(state.firebase.messaging, payload => {
        const title = payload.notification?.title || payload.data?.title || '우리 버스 알림';
        const body = payload.notification?.body || payload.data?.body || '버스가 곧 도착합니다.';
        const duplicateOfLocalAlarm = Date.now() - state.lastAlertAt < 90000;
        if (!duplicateOfLocalAlarm) playConfiguredAlert({ alertMode: payload.data?.alertMode || 'push', alertSound: payload.data?.alertSound || 'standard' });
        state.lastAlertAt = Date.now();
        toast(`${title} · ${body}`, 5000);
      });
    }

    try {
      const credential = await withTimeout(
        signInAnonymously(auth),
        10000,
        'Firebase 로그인 시간이 초과되었습니다.'
      );
      state.firebase.user = credential.user;
      state.firebaseAuthError = null;

      if (isAppleMobileBrowser()) {
        els.pushState.textContent = '기기 저장';
        els.pushState.classList.add('good');
        els.alertInfo.textContent = isStandaloneWebApp()
          ? 'iPhone·iPad에서는 현재 Firebase 웹 푸시 대신 앱 실행 중 자동 감시가 동작합니다. 알림 설정은 기기에 정상 저장됩니다.'
          : 'iPhone·iPad에서는 홈 화면에 추가한 앱으로 실행해야 웹 알림을 사용할 수 있습니다. 현재 설정은 기기에 저장됩니다.';
      } else {
        els.pushState.textContent = state.firebase.messaging ? '푸시 준비됨' : '로컬 알림';
        els.pushState.classList.toggle('good', Boolean(state.firebase.messaging));
      }
    } catch (authError) {
      state.firebaseAuthError = authError;
      console.warn('Firebase anonymous auth unavailable', authError);
      els.pushState.textContent = '설정 1단계 필요';
      els.pushState.classList.remove('good');
      const configurationMissing = String(authError?.code || '').includes('configuration-not-found');
      els.alertInfo.textContent = configurationMissing
        ? 'Firebase 콘솔에서 Authentication → 로그인 방법 → 익명(Anonymous)을 사용 설정하면 서버 저장이 활성화됩니다. 현재는 앱을 열어둔 동안 알림이 동작합니다.'
        : `Firebase 익명 로그인 실패: ${authError.message}. 현재는 앱을 열어둔 동안 알림이 동작합니다.`;
    }
  } catch (error) {
    console.warn('Firebase init failed', error);
    els.pushState.textContent = '로컬 알림';
    els.alertInfo.textContent = `푸시 초기화 실패: ${error.message}. 앱을 열어둔 동안의 알림은 계속 사용할 수 있습니다.`;
  }
}

async function saveAlert() {
  if (state.alertSaveBusy) return;
  if (!state.route || !state.origin) return toast('먼저 버스 노선을 선택해 주세요.');
  if (!selectedDays().length) return toast('알림 요일을 하나 이상 선택해 주세요.');

  const button = $('saveAlert');
  const originalText = button.textContent;
  const localPayload = buildAlertPayload('');
  state.alertSaveBusy = true;
  button.disabled = true;
  button.textContent = '기기에 저장 중…';

  try {
    // 네트워크와 푸시 상태에 관계없이 기기 저장을 먼저 확정한다.
    upsertSavedAlert(localPayload);
    button.textContent = '기기 저장 완료';
    els.pushState.textContent = '기기 저장됨';
    els.pushState.classList.add('good');
    els.alertInfo.textContent = `${localPayload.routeName}번 알림이 이 기기에 저장되었습니다.`;
    toast(`${localPayload.routeName}번 알림을 기기에 저장했습니다.`);

    let notificationPermission = 'unsupported';
    if ('Notification' in window) {
      notificationPermission = Notification.permission;
      if (notificationPermission === 'default') {
        try {
          notificationPermission = await withTimeout(
            Notification.requestPermission(),
            8000,
            '알림 권한 요청 시간이 초과되었습니다.'
          );
        } catch (permissionError) {
          console.warn('notification permission request failed', permissionError);
        }
      }
    }

    // iPhone/iPad에서 Firebase getToken을 호출하면 응답 없이 대기할 수 있어 시도 자체를 생략한다.
    if (isAppleMobileBrowser()) {
      els.pushState.textContent = '기기 저장됨';
      els.pushState.classList.add('good');
      els.alertInfo.textContent = isStandaloneWebApp()
        ? `기기 저장 완료 · iPhone·iPad에서는 앱이 열려 있을 때 ${localPayload.routeName}번을 자동 감시합니다.`
        : '기기 저장 완료 · 홈 화면에 추가한 앱으로 실행하면 기기 알림을 사용할 수 있습니다.';
      button.textContent = '기기 저장 완료';
      return;
    }

    const remoteReady = Boolean(
      notificationPermission === 'granted' &&
      state.firebase?.firestore &&
      state.firebase?.messaging &&
      state.firebase?.user &&
      state.swRegistration
    );

    if (!remoteReady) {
      const reason = notificationPermission === 'denied'
        ? '브라우저 알림 권한이 차단되어 있습니다.'
        : notificationPermission === 'unsupported'
          ? '이 브라우저에서는 푸시를 지원하지 않습니다.'
          : state.firebaseAuthError
            ? 'Firebase 익명 로그인 연결이 필요합니다.'
            : '푸시 연결이 아직 준비되지 않았습니다.';
      els.pushState.textContent = '화면 켤 때 감시';
      els.pushState.classList.remove('good');
      els.alertInfo.textContent = `기기 저장 완료 · ${reason} 앱을 열어둔 동안 저장된 노선을 자동 확인합니다.`;
      button.textContent = '기기 저장 완료';
      return;
    }

    if (Date.now() < state.pushRetryAfter) {
      els.pushState.textContent = '기기 저장됨';
      els.pushState.classList.add('good');
      els.alertInfo.textContent = '기기 저장 완료 · 직전 푸시 연결이 지연되어 잠시 후 다시 시도할 수 있습니다.';
      button.textContent = '기기 저장 완료';
      return;
    }

    try {
      button.textContent = '푸시 연결 확인 중…';
      const token = await withTimeout(
        getToken(state.firebase.messaging, {
          vapidKey: state.firebaseConfig.vapidKey,
          serviceWorkerRegistration: state.swRegistration
        }),
        PUSH_CONNECT_TIMEOUT_MS,
        '푸시 토큰 연결 시간이 초과되었습니다.'
      );
      if (!token) throw new Error('푸시 토큰을 발급받지 못했습니다.');

      const payload = buildAlertPayload(token);
      const id = `${state.firebase.user.uid}_${state.route.routeId}_${state.origin.stationId}`;
      await withTimeout(
        setDoc(doc(state.firebase.firestore, 'busAlerts', id), {
          ...payload,
          uid: state.firebase.user.uid,
          armed: true,
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp()
        }, { merge: true }),
        10000,
        '푸시 설정 서버 저장 시간이 초과되었습니다.'
      );
      upsertSavedAlert({ ...payload, _docId: id });
      state.pushRetryAfter = 0;
      els.pushState.textContent = '자동 감시 중';
      els.pushState.classList.add('good');
      els.alertInfo.textContent = `${payload.routeName}번 저장 완료 · ${payload.startTime}~${payload.endTime} · ${payload.leadStops}정거장 전 · ${alertSoundLabel(payload.alertSound)}`;
      button.textContent = '푸시까지 저장 완료';
      toast(`${payload.routeName}번 알림을 기기와 푸시에 저장했습니다.`, 3800);
    } catch (remoteError) {
      console.warn('remote alert save failed; local save retained', remoteError);
      state.pushRetryAfter = Date.now() + 2 * 60 * 1000;
      const friendly = friendlyPushError(remoteError);
      els.pushState.textContent = '기기 저장됨';
      els.pushState.classList.add('good');
      els.alertInfo.textContent = `기기 저장은 완료했습니다. ${friendly} 앱을 열어둔 동안의 자동 감시는 계속 동작합니다.`;
      button.textContent = '기기 저장 완료';
      toast(`기기 저장 완료 · ${friendly}`, 4800);
    }
  } catch (error) {
    els.pushState.textContent = '저장 실패';
    els.pushState.classList.remove('good');
    els.alertInfo.textContent = `알림 저장 실패: ${error.message}`;
    toast(`알림 저장 실패: ${error.message}`, 4500);
  } finally {
    setTimeout(() => {
      button.textContent = state.route ? `${state.route.routeName}번 알림 저장` : originalText;
      button.disabled = false;
      state.alertSaveBusy = false;
    }, 600);
  }
}

function buildAlertPayload(fcmToken) {
  const topology = routeTopology();
  return {
    enabled: $('alertEnabled').checked,
    routeId: String(state.route.routeId),
    routeName: String(state.route.routeName),
    stationId: String(state.origin.stationId),
    stationName: String(state.origin.stationName),
    stationRegionName: String(state.origin.regionName || ''),
    stationMobileNo: String(state.origin.mobileNo || ''),
    stationX: number(state.origin.x, 0),
    stationY: number(state.origin.y, 0),
    staOrder: number(state.route.originStaOrder),
    routeDestId: String(state.route.routeDestId || ''),
    routeDestName: String(state.route.routeDestName || ''),
    routeMinSeq: topology.minSeq,
    routeMaxSeq: topology.maxSeq,
    routeStationCount: topology.count,
    originRouteIndex: topology.originIndex,
    turnSeq: number(topology.turnSeq, 0),
    turnRouteIndex: topology.turnIndex,
    loopCapable: topology.loopCapable,
    originAtStart: topology.originAtStart,
    destinationStationId: String(state.route?.destinationStationId || state.destination?.stationId || ''),
    destinationStationName: String(state.route?.destinationStationName || state.destination?.stationName || ''),
    destinationRegionName: String(state.destination?.regionName || ''),
    destinationMobileNo: String(state.destination?.mobileNo || ''),
    destinationX: number(state.destination?.x, 0),
    destinationY: number(state.destination?.y, 0),
    destinationStaOrder: number(state.route?.destinationStaOrder, 0),
    leadStops: number($('leadStops').value, 3),
    startTime: $('startTime').value,
    endTime: $('endTime').value,
    days: selectedDays(),
    alertMode: $('alertMode').value,
    alertSound: $('alertSound').value,
    fcmToken,
    timeZone: 'Asia/Seoul'
  };
}

function setupEvents() {
  $('originSearch').addEventListener('click', () => searchStations('origin'));
  els.nearbyOrigin.addEventListener('click', findNearbyOriginStations);
  $('destinationSearch').addEventListener('click', () => searchStations('destination'));
  $('findRoutes').addEventListener('click', findRoutes);
  $('refreshLive').addEventListener('click', () => loadLive(true, { manual: true }));
  $('saveAlert').addEventListener('click', saveAlert);
  $('testAlert').addEventListener('click', testConfiguredAlert);
  els.toggleDestinationFavorite?.addEventListener('click', toggleDestinationFavorite);
  document.querySelectorAll('[data-map-scope]').forEach(button => button.addEventListener('click', () => {
    state.mapScope = button.dataset.mapScope;
    document.querySelectorAll('[data-map-scope]').forEach(item => item.classList.toggle('active', item === button));
    if (state.route) renderMap(true);
  }));
  document.querySelectorAll('[data-vehicle-scope]').forEach(button => button.addEventListener('click', () => {
    state.vehicleScope = button.dataset.vehicleScope;
    document.querySelectorAll('[data-vehicle-scope]').forEach(item => item.classList.toggle('active', item === button));
    if (state.route) renderMap(true);
  }));
  $('swapStops').addEventListener('click', () => {
    resetActiveRoute();
    [state.origin, state.destination] = [state.destination, state.origin];
    if (state.origin) renderSelectedStation('origin', state.origin);
    if (state.destination) renderSelectedStation('destination', state.destination);
    updateDestinationFavoriteControl();
    els.routeResults.innerHTML = '';
    writeLastJourney();
  });
  document.querySelectorAll('.preset').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    resetActiveRoute();
    els.destinationInput.value = button.dataset.destination;
    state.destination = null;
    els.destinationSelected.textContent = '목적지 정류장을 선택하세요.';
    els.destinationSelected.classList.remove('ready');
    updateDestinationFavoriteControl();
    writeLastJourney();
    searchStations('destination');
  }));
  document.querySelectorAll('.day').forEach(button => button.addEventListener('click', () => button.classList.toggle('active')));
  document.querySelectorAll('.bottom-nav button').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    const target = document.querySelector(`.${button.dataset.scroll}`) || $(button.dataset.scroll);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  [els.originInput, els.destinationInput].forEach((input, index) => input.addEventListener('keydown', event => {
    if (event.key === 'Enter') searchStations(index === 0 ? 'origin' : 'destination');
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      writeLastJourney();
      return;
    }
    if (state.route) loadLive(false, { silent: true });
    else void restoreSavedStateIfNeeded();
  });
  window.addEventListener('pageshow', event => {
    state.savedAlerts = readSavedAlerts();
    renderSavedAlerts();
    if (state.route) {
      if (event.persisted) loadLive(true, { manual: true });
    } else {
      void restoreSavedStateIfNeeded();
    }
  });
  window.addEventListener('pagehide', writeLastJourney);
  window.addEventListener('beforeunload', writeLastJourney);
}


async function boot() {
  state.savedAlerts = readSavedAlerts();
  state.destinationFavorites = readDestinationFavorites();
  const storedJourney = readLastJourney();
  const savedJourney = journeyFromSelectedAlert()
    || (storedJourney?.route ? storedJourney : null)
    || journeyFromNewestAlert()
    || storedJourney;
  if (savedJourney?.origin) {
    state.origin = savedJourney.origin;
    renderSelectedStation('origin', state.origin);
  }
  if (savedJourney?.destination) {
    state.destination = savedJourney.destination;
    renderSelectedStation('destination', state.destination);
  }

  renderSavedAlerts();
  renderDestinationFavorites();
  updateDestinationFavoriteControl();
  startSavedAlertPolling();
  setupEvents();
  // 첫 사용자 제스처에서는 실제 노래를 재생하지 않고 Web Audio 권한만 무음으로 준비한다.
  const primeAudio = event => {
    // 테스트 버튼은 click 핸들러에서 선택한 알림음을 직접 재생한다.
    if (event?.target?.closest?.('#testAlert')) return;
    void unlockAudioFromGesture();
  };
  document.addEventListener('pointerdown', primeAudio, { once: true, capture: true, passive: true });
  document.addEventListener('keydown', primeAudio, { once: true, capture: true });
  initFirebase();
  try {
    await api('stationSearch', { keyword: '호계현대홈타운.e편한세상아파트' });
    updateApiState();
  } catch (error) {
    updateApiState(error);
  }

  const restoredPair = savedJourney?.route && state.origin && state.destination
    ? pairFromStoredJourney(savedJourney)
    : null;
  if (restoredPair) {
    els.routeResults.innerHTML = '<div class="route-result-summary">마지막으로 보던 버스 노선을 복원했습니다.</div>';
    try {
      await chooseRoute(restoredPair, { restore: true });
      toast(`${state.route.routeName}번 노선을 다시 불러왔습니다.`);
    } catch (error) {
      console.warn('journey restore failed', error);
      resetActiveRoute();
      renderSavedAlerts();
      els.routeResults.innerHTML = `<div class="empty error">마지막 노선 복원에 실패했습니다. 아래 저장 알림에서 ‘불러오기’를 눌러 주세요.<br><small>${esc(error.message)}</small></div>`;
    }
    return;
  }

  if (state.origin && state.destination) {
    els.routeResults.innerHTML = '<div class="route-result-summary">마지막 출발·도착 정류장을 복원했습니다. 직행 버스 찾기를 눌러 주세요.</div>';
  } else {
    if (!state.origin) setTimeout(() => searchStations('origin'), 250);
    if (!state.destination) setTimeout(() => searchStations('destination'), 500);
  }
}

boot();
