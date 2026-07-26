import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { getFirestore, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
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
  lastLiveUpdatedAt: 0
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
  nearbyStatus: $('nearbyStatus'), liveVehicles: $('liveVehicles'), liveUpdated: $('liveUpdated')
};

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

  const allOriginMatches = stations.filter(stop => sameId(stop.stationId, state.origin.stationId));
  const destinationMatches = stations.filter(stop => sameId(stop.stationId, state.destination.stationId));
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
    const fallbackDestination = stations.find(stop => nameMatch(stop, state.destination)
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
  return state.routeStations.some(stop => sameId(stop.stationId, state.destination?.stationId)
    && routeStationSequence(stop) > originSeq);
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


async function resolveUserPosition() {
  let quickPosition = null;
  let quickError = null;
  try {
    quickPosition = await getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 7000,
      maximumAge: 120000
    });
  } catch (error) {
    quickError = error;
  }

  if (quickPosition && number(quickPosition.coords.accuracy, 9999) <= 70) return quickPosition;

  try {
    const precisePosition = await watchBestPosition(9000);
    if (!quickPosition) return precisePosition;
    return number(precisePosition.coords.accuracy, 9999) < number(quickPosition.coords.accuracy, 9999)
      ? precisePosition
      : quickPosition;
  } catch (error) {
    if (quickPosition) return quickPosition;
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
    .filter(station => number(station.distance, 999999) <= 1100)
    .sort((a, b) => number(a.distance, 999999) - number(b.distance, 999999));
}

async function fetchNearbyStations(latitude, longitude, signal) {
  const queryPoint = async (lat, lng) => api('stationAround', {
    x: Number(lng).toFixed(7),
    y: Number(lat).toFixed(7)
  }, { signal, fresh: true, timeout: 15000 });

  // GBIS 주변 검색 반경 경계와 모바일 GPS 오차를 모두 보완하기 위해
  // 현재 좌표와 약 320m 떨어진 동·서·남·북을 함께 조회한다.
  const latOffset = 0.0029;
  const lngOffset = 0.0036;
  const primaryPoints = [
    [latitude, longitude],
    [latitude + latOffset, longitude],
    [latitude - latOffset, longitude],
    [latitude, longitude + lngOffset],
    [latitude, longitude - lngOffset]
  ];
  const primary = await Promise.allSettled(primaryPoints.map(([lat, lng]) => queryPoint(lat, lng)));
  let items = primary.flatMap(result => result.status === 'fulfilled' ? (result.value.items || []) : []);
  let normalized = normalizeNearbyStations(items, latitude, longitude);

  if (normalized.length < 6) {
    const diagonals = await Promise.allSettled([
      queryPoint(latitude + latOffset, longitude + lngOffset),
      queryPoint(latitude + latOffset, longitude - lngOffset),
      queryPoint(latitude - latOffset, longitude + lngOffset),
      queryPoint(latitude - latOffset, longitude - lngOffset)
    ]);
    items = items.concat(diagonals.flatMap(result => result.status === 'fulfilled' ? (result.value.items || []) : []));
    normalized = normalizeNearbyStations(items, latitude, longitude);
  }

  const firstFailure = [...primary].find(result => result.status === 'rejected');
  if (!normalized.length && firstFailure) throw firstFailure.reason;
  return normalized;
}

async function findNearbyOriginStations() {
  if (!window.isSecureContext) return toast('현재 위치는 HTTPS 주소에서만 사용할 수 있습니다.', 4000);
  if (!navigator.geolocation) return toast('이 브라우저는 현재 위치 기능을 지원하지 않습니다.', 4000);
  const requestId = ++state.nearbyRequestId;
  const listEl = els.originSuggestions;
  const button = els.nearbyOrigin;
  button.disabled = true;
  button.classList.add('loading');
  if (els.nearbyStatus) els.nearbyStatus.textContent = 'GPS 위치를 확인하고 있습니다…';
  listEl.innerHTML = '<div class="empty">현재 위치를 확인하는 중…</div>';

  try {
    const position = await resolveUserPosition();
    if (requestId !== state.nearbyRequestId) return;
    const { latitude, longitude, accuracy } = position.coords;
    state.userLocation = { lat: latitude, lng: longitude, accuracy: number(accuracy, 0) };
    if (els.nearbyStatus) els.nearbyStatus.textContent = `위치 확인 완료 · 정확도 약 ${Math.round(number(accuracy, 0))}m · 주변 검색 중…`;
    if (state.map) renderMap(false);

    listEl.innerHTML = '<div class="empty">현재 좌표 주변 정류장을 넓게 찾는 중…</div>';
    const nearby = (await fetchNearbyStations(latitude, longitude)).slice(0, 24);
    if (requestId !== state.nearbyRequestId) return;
    renderStationSuggestions('origin', nearby, { nearby: true });

    if (nearby.length) {
      if (els.nearbyStatus) els.nearbyStatus.textContent = `현재 위치 기준 ${nearby.length}개 정류장 · 가까운 순서`;
      toast(`현재 위치 주변에서 ${nearby.length}개 정류장을 찾았습니다.`);
    } else {
      if (els.nearbyStatus) els.nearbyStatus.textContent = '1.1km 안에서 조회되는 경기버스 정류장이 없습니다.';
      listEl.innerHTML = '<div class="empty">현재 위치 1.1km 안에 조회되는 경기버스 정류장이 없습니다. 위치 권한의 “정확한 위치”를 켜거나 정류장 이름 검색을 이용해 주세요.</div>';
    }
  } catch (error) {
    if (requestId !== state.nearbyRequestId) return;
    const message = geolocationMessage(error);
    if (els.nearbyStatus) els.nearbyStatus.textContent = message;
    listEl.innerHTML = `<div class="empty error">${esc(message)}</div>`;
    if (error?.code && ![1, 2, 3].includes(error.code)) updateApiState(error);
  } finally {
    if (requestId === state.nearbyRequestId) {
      button.disabled = false;
      button.classList.remove('loading');
    }
  }
}

function selectStation(kind, station) {
  state[kind] = station;
  const selected = kind === 'origin' ? els.originSelected : els.destinationSelected;
  const suggestions = kind === 'origin' ? els.originSuggestions : els.destinationSuggestions;
  const input = kind === 'origin' ? els.originInput : els.destinationInput;
  input.value = station.stationName;
  selected.textContent = stationLabel(station);
  selected.classList.add('ready');
  suggestions.innerHTML = '';
  toast(`${kind === 'origin' ? '탑승' : '도착'} 정류장을 선택했습니다.`);
}

async function findRoutes() {
  if (!state.origin || !state.destination) return toast('출발·도착 정류장을 먼저 선택해 주세요.');
  els.routeResults.innerHTML = '<div class="empty">직행 노선을 확인 중…</div>';
  try {
    const [originData, destData] = await Promise.all([
      api('stationRoutes', { stationId: state.origin.stationId }),
      api('stationRoutes', { stationId: state.destination.stationId })
    ]);
    const destinationGroups = destData.items.reduce((map, item) => {
      const key = String(item.routeId);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
      return map;
    }, new Map());

    const seen = new Set();
    const candidates = originData.items
      .map(originRoute => {
        const destinationOptions = destinationGroups.get(String(originRoute.routeId)) || [];
        const destRoute = destinationOptions
          .filter(item => number(item.staOrder) > number(originRoute.staOrder))
          .sort((a, b) => number(a.staOrder) - number(b.staOrder))[0];
        return { originRoute, destRoute };
      })
      .filter(pair => pair.destRoute)
      .filter(pair => {
        const key = `${pair.originRoute.routeId}:${pair.originRoute.staOrder}:${pair.destRoute.staOrder}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (number(a.destRoute.staOrder) - number(a.originRoute.staOrder)) - (number(b.destRoute.staOrder) - number(b.originRoute.staOrder)));

    if (!candidates.length) {
      els.routeResults.innerHTML = '<div class="empty">선택한 방향의 직행 노선이 없습니다. 반대편 정류장이나 다른 목적지 정류장을 선택해 보세요.</div>';
      return;
    }

    els.routeResults.innerHTML = candidates.map((pair, index) => {
      const stops = number(pair.destRoute.staOrder) - number(pair.originRoute.staOrder);
      return `<button class="route-option" data-index="${index}">
        <span class="route-number">${esc(pair.originRoute.routeName)}</span>
        <span><strong>${esc(pair.originRoute.routeDestName || '진행 방향')}</strong><small>${stops}개 정류장 이동 · ${esc(pair.originRoute.routeTypeName || '')}</small></span>
        <span class="route-arrow">›</span>
      </button>`;
    }).join('');

    els.routeResults.querySelectorAll('.route-option').forEach(button => {
      button.addEventListener('click', () => chooseRoute(candidates[Number(button.dataset.index)]));
    });
  } catch (error) {
    els.routeResults.innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
  }
}

async function chooseRoute(pair) {
  state.liveAbortController?.abort();
  state.routeStations = [];
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
  state.route = {
    routeId: pair.originRoute.routeId,
    routeName: pair.originRoute.routeName,
    routeTypeName: pair.originRoute.routeTypeName,
    routeDestName: pair.originRoute.routeDestName,
    routeDestId: pair.originRoute.routeDestId || '',
    originStaOrder: number(pair.originRoute.staOrder),
    destinationStaOrder: number(pair.destRoute.staOrder)
  };
  els.liveSection.classList.remove('hidden');
  els.alertSection.classList.remove('hidden');
  els.chosenRoute.innerHTML = `<div class="chosen-route-main"><span class="chosen-route-number">${esc(state.route.routeName)}</span><span><strong>${esc(state.route.routeDestName || '선택 노선')} 방면</strong><p>${esc(state.origin.stationName)} → ${esc(state.destination.stationName)}</p></span></div><small class="chosen-route-hint">실제 노선 전체와 운행 차량을 먼저 표시하고, 공식 도착정보가 없으면 다음 회차에 가까운 차량도 따로 안내합니다.</small>`;
  if (els.liveVehicles) els.liveVehicles.innerHTML = '<div class="empty">노선과 운행 차량을 불러오는 중…</div>';
  els.liveSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function renderMap(fit = false) {
  const map = ensureMap();
  state.routeLayer.clearLayers();
  state.markerLayer.clearLayers();

  const ordered = [...state.routeStations].sort((a, b) => number(a.stationSeq) - number(b.stationSeq));
  const routeShapeLatlngs = (state.routeShape || []).map(stationPosition).filter(Boolean);
  const routeShapeSegments = splitRoutePath(routeShapeLatlngs);
  routeShapeSegments.forEach(segment => {
    L.polyline(segment, { color: '#062d66', weight: 10, opacity: .84, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
    L.polyline(segment, { color: '#36b9ff', weight: 4, opacity: .92, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
  });
  const stationRouteLatlngs = drawPolyline(ordered, {
    color: '#123f78', weight: routeShapeSegments.length ? 3 : 8,
    opacity: routeShapeSegments.length ? .30 : .84, lineCap: 'round', lineJoin: 'round'
  });
  const allLatlngs = routeShapeSegments.length ? routeShapeSegments.flat() : stationRouteLatlngs;
  const approachSegments = approachStopSegments(ordered);
  const journeyStops = ordered.filter(stop => {
    const seq = number(stop.stationSeq);
    return seq >= state.route.originStaOrder && seq <= state.route.destinationStaOrder;
  });
  const afterStops = ordered.filter(stop => number(stop.stationSeq) >= state.route.destinationStaOrder);

  const approachLatlngs = [];
  approachSegments.forEach(segment => {
    approachLatlngs.push(...drawPolyline(segment, { color: '#24c8f2', weight: 6, opacity: .96, dashArray: '10 8', lineCap: 'round' }));
  });
  const journeyLatlngs = drawPolyline(journeyStops, { color: '#1975ff', weight: 8, opacity: .98, lineCap: 'round', lineJoin: 'round' });
  drawPolyline(afterStops, { color: '#8b98aa', weight: 4, opacity: .32, dashArray: '4 9' });

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
      ? '공식 도착정보와 실시간 위치를 함께 사용하며, 출발 종점에서는 회차 후 돌아오는 차량도 오는 버스로 표시합니다.'
      : predictedCount
        ? '공식 도착 예정 차량이 없어, 현재 노선 위 차량 중 다음 회차에 가장 먼저 올 가능성이 높은 차량을 주황색으로 표시합니다.'
        : '현재 탑승 정류장에 접근 중인 차량이 확인되지 않습니다. “전체 차량”에서 모든 운행 위치를 볼 수 있습니다.';
  } else {
    els.mapNote.textContent = allCount
      ? '선택한 실제 노선 전체와 모든 운행 차량을 표시합니다. 각 마커에는 노선번호와 차량번호 끝자리가 표시됩니다.'
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

function selectedDays() {
  return [...document.querySelectorAll('.day.active')].map(btn => Number(btn.dataset.day));
}

function withinLocalSchedule() {
  const now = new Date();
  const day = now.getDay();
  const hhmm = now.toTimeString().slice(0, 5);
  const start = $('startTime').value || '00:00';
  const end = $('endTime').value || '23:59';
  const timeOk = start <= end ? hhmm >= start && hhmm <= end : hhmm >= start || hhmm <= end;
  return selectedDays().includes(day) && timeOk && $('alertEnabled').checked;
}

function playAlarm() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const sequence = [0, .45, .9];
  sequence.forEach((offset, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = index === 1 ? 880 : 740;
    gain.gain.setValueAtTime(.0001, ctx.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(.35, ctx.currentTime + offset + .03);
    gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + offset + .35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + offset);
    osc.stop(ctx.currentTime + offset + .38);
  });
  navigator.vibrate?.([300, 120, 300, 120, 500]);
}

async function showLocalNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && state.swRegistration) {
    await state.swRegistration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      tag: `foreground-${state.route?.routeId || 'bus'}`, requireInteraction: true,
      silent: $('alertMode').value === 'pushOnly',
      vibrate: $('alertMode').value === 'pushOnly' ? [] : [300, 120, 300, 120, 500], data: { url: '/' }
    });
  }
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
  if (locationNo > 0 && locationNo <= lead && key !== state.foregroundAlarmKey) {
    state.foregroundAlarmKey = key;
    state.lastAlertAt = Date.now();
    const title = `${state.route.routeName}번 ${approximate ? '약 ' : ''}${locationNo}정거장 전`;
    const body = `${state.origin.stationName}에 곧 도착합니다.`;
    if ($('alertMode').value === 'push') playAlarm();
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
    const configResponse = await fetch('/api/config', { cache: 'no-store' });
    state.firebaseConfig = await configResponse.json();
    state.swRegistration = await navigator.serviceWorker.register('/api/firebase-messaging-sw?v=1.7.0', { scope: '/' });

    if (!state.firebaseConfig.backgroundPushConfigured) {
      els.pushState.textContent = '화면 켤 때만';
      els.alertInfo.textContent = 'Firebase 환경변수가 없어 현재는 앱을 열어둔 동안의 알림만 동작합니다.';
      return;
    }

    const app = initializeApp(state.firebaseConfig.firebase);
    const auth = getAuth(app);
    const firestore = getFirestore(app);
    state.firebase = { app, auth, user: null, firestore, messaging: null };

    if (await isSupported()) {
      state.firebase.messaging = getMessaging(app);
      onMessage(state.firebase.messaging, payload => {
        const title = payload.notification?.title || payload.data?.title || '우리 버스 알림';
        const body = payload.notification?.body || payload.data?.body || '버스가 곧 도착합니다.';
        const duplicateOfLocalAlarm = Date.now() - state.lastAlertAt < 90000;
        if (!duplicateOfLocalAlarm && payload.data?.alertMode !== 'pushOnly') playAlarm();
        state.lastAlertAt = Date.now();
        toast(`${title} · ${body}`, 5000);
      });
    }

    try {
      const credential = await signInAnonymously(auth);
      state.firebase.user = credential.user;
      state.firebaseAuthError = null;
      els.pushState.textContent = state.firebase.messaging ? '푸시 준비됨' : '로컬 알림';
      els.pushState.classList.toggle('good', Boolean(state.firebase.messaging));
    } catch (authError) {
      state.firebaseAuthError = authError;
      console.warn('Firebase anonymous auth unavailable', authError);
      els.pushState.textContent = '설정 1단계 필요';
      els.pushState.classList.remove('good');
      const configurationMissing = String(authError?.code || '').includes('configuration-not-found');
      els.alertInfo.textContent = configurationMissing
        ? 'Firebase 콘솔에서 Authentication → 로그인 방법 → 익명(Anonymous)을 사용 설정하면 백그라운드 알림 저장이 활성화됩니다. 현재는 앱을 열어둔 동안 알림이 동작합니다.'
        : `Firebase 익명 로그인 실패: ${authError.message}. 현재는 앱을 열어둔 동안 알림이 동작합니다.`;
    }
  } catch (error) {
    console.warn('Firebase init failed', error);
    els.pushState.textContent = '로컬 알림';
    els.alertInfo.textContent = `푸시 초기화 실패: ${error.message}. 앱을 열어둔 동안의 알림은 계속 사용할 수 있습니다.`;
  }
}

async function saveAlert() {
  if (!state.route || !state.origin) return toast('먼저 버스 노선을 선택해 주세요.');
  if (!selectedDays().length) return toast('알림 요일을 하나 이상 선택해 주세요.');
  try {
    if ('Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('알림 권한이 허용되지 않았습니다.');
    }

    if (!state.firebase?.firestore || !state.firebase?.messaging || !state.firebase?.user) {
      const localPayload = buildAlertPayload('');
      localStorage.setItem('hogyeBusAlert', JSON.stringify(localPayload));
      els.pushState.textContent = state.firebaseAuthError ? '설정 1단계 필요' : '화면 켤 때만';
      els.alertInfo.textContent = state.firebaseAuthError
        ? '로컬 알림은 저장했습니다. 화면이 꺼져도 받으려면 Firebase Authentication에서 익명 로그인을 사용 설정한 뒤 다시 저장해 주세요.'
        : '로컬 알림을 저장했습니다. 앱을 열어둔 동안 30초마다 버스 도착을 확인합니다.';
      toast(state.firebaseAuthError ? '로컬 알림 저장 완료 · Firebase 익명 로그인 설정이 필요합니다.' : '로컬 알림 설정을 저장했습니다.', 4500);
      return;
    }

    const token = await getToken(state.firebase.messaging, {
      vapidKey: state.firebaseConfig.vapidKey,
      serviceWorkerRegistration: state.swRegistration
    });
    if (!token) throw new Error('푸시 토큰을 발급받지 못했습니다.');

    const payload = buildAlertPayload(token);
    const id = `${state.firebase.user.uid}_${state.route.routeId}_${state.origin.stationId}`;
    await setDoc(doc(state.firebase.firestore, 'busAlerts', id), {
      ...payload,
      uid: state.firebase.user.uid,
      armed: true,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    }, { merge: true });
    localStorage.setItem('hogyeBusAlert', JSON.stringify(payload));
    els.pushState.textContent = '자동 감시 중';
    els.pushState.classList.add('good');
    els.alertInfo.textContent = `${payload.routeName}번을 ${payload.startTime}~${payload.endTime}, ${payload.leadStops}정거장 전부터 감시합니다.`;
    toast('백그라운드 버스 알림을 저장했습니다.');
  } catch (error) {
    toast(error.message, 4000);
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
    destinationStationId: String(state.destination?.stationId || ''),
    destinationStationName: String(state.destination?.stationName || ''),
    leadStops: number($('leadStops').value, 3),
    startTime: $('startTime').value,
    endTime: $('endTime').value,
    days: selectedDays(),
    alertMode: $('alertMode').value,
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
  $('testAlert').addEventListener('click', () => { playAlarm(); toast('알림 소리를 재생했습니다.'); });
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
    [state.origin, state.destination] = [state.destination, state.origin];
    [els.originInput.value, els.destinationInput.value] = [els.destinationInput.value, els.originInput.value];
    if (state.origin) { els.originSelected.textContent = stationLabel(state.origin); els.originSelected.classList.add('ready'); }
    if (state.destination) { els.destinationSelected.textContent = stationLabel(state.destination); els.destinationSelected.classList.add('ready'); }
    els.routeResults.innerHTML = '';
  });
  document.querySelectorAll('.preset').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    els.destinationInput.value = button.dataset.destination;
    state.destination = null;
    els.destinationSelected.textContent = '목적지 정류장을 선택하세요.';
    els.destinationSelected.classList.remove('ready');
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.route) loadLive(false, { silent: true }); });
  window.addEventListener('pageshow', event => { if (event.persisted && state.route) loadLive(true, { manual: true }); });
}

async function boot() {
  setupEvents();
  initFirebase();
  try {
    await api('stationSearch', { keyword: '호계현대홈타운.e편한세상아파트' });
    updateApiState();
  } catch (error) {
    updateApiState(error);
  }
  setTimeout(() => searchStations('origin'), 250);
  setTimeout(() => searchStations('destination'), 500);
}

boot();
