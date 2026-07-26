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
  firebaseAuthError: null
};

const els = {
  apiState: $('apiState'), originInput: $('originInput'), destinationInput: $('destinationInput'),
  originSuggestions: $('originSuggestions'), destinationSuggestions: $('destinationSuggestions'),
  originSelected: $('originSelected'), destinationSelected: $('destinationSelected'),
  routeResults: $('routeResults'), liveSection: $('liveSection'), alertSection: $('alertSection'),
  chosenRoute: $('chosenRoute'), arrivalGrid: $('arrivalGrid'), pushState: $('pushState'),
  busCount: $('busCount'), mapNote: $('mapNote'), nearbyOrigin: $('nearbyOrigin'),
  toast: $('toast'), alarmAudio: $('alarmAudio'), alertInfo: $('alertInfo'),
  refreshLive: $('refreshLive'), refreshLiveLabel: $('refreshLiveLabel')
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

function routeStationSequence(item) {
  return number(item?.stationSeq ?? item?.staOrder ?? item?.stationOrder, NaN);
}

function normalizeRouteStation(item) {
  return {
    ...item,
    stationId: String(item?.stationId ?? item?.stationID ?? '').trim(),
    stationSeq: routeStationSequence(item),
    stationName: item?.stationName || item?.stationNm || '',
    x: item?.x ?? item?.gpsX ?? item?.longitude,
    y: item?.y ?? item?.gpsY ?? item?.latitude
  };
}

function normalizeRouteShapePoint(item) {
  return {
    ...item,
    lineSeq: number(item?.lineSeq ?? item?.seq ?? item?.shapeSeq, NaN),
    x: item?.x ?? item?.gpsX ?? item?.longitude,
    y: item?.y ?? item?.gpsY ?? item?.latitude
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
    stationId,
    stationSeq,
    vehId: String(item?.vehId ?? item?.vehicleId ?? '').trim(),
    plateNo: item?.plateNo || item?.plateNumber || '',
    stateCd: item?.stateCd ?? item?.stateCode
  };
}

function reconcileRouteOrders() {
  const stations = state.routeStations || [];
  if (!stations.length || !state.route || !state.origin || !state.destination) return;

  const originMatches = stations.filter(stop => sameId(stop.stationId, state.origin.stationId));
  const destinationMatches = stations.filter(stop => sameId(stop.stationId, state.destination.stationId));
  const previousOrigin = number(state.route.originStaOrder, 0);
  const previousDestination = number(state.route.destinationStaOrder, 0);
  const pairs = [];

  originMatches.forEach(originStop => destinationMatches.forEach(destinationStop => {
    const originSeq = routeStationSequence(originStop);
    const destinationSeq = routeStationSequence(destinationStop);
    if (!Number.isFinite(originSeq) || !Number.isFinite(destinationSeq) || destinationSeq <= originSeq) return;
    const score = Math.abs(originSeq - previousOrigin) + Math.abs(destinationSeq - previousDestination)
      + Math.max(0, destinationSeq - originSeq) * .001;
    pairs.push({ originSeq, destinationSeq, score });
  }));

  if (pairs.length) {
    pairs.sort((a, b) => a.score - b.score);
    state.route.originStaOrder = pairs[0].originSeq;
    state.route.destinationStaOrder = pairs[0].destinationSeq;
    return;
  }

  // 일부 순환·분기 노선은 동일 정류소가 중복되므로 이름까지 보조 비교한다.
  const nameMatch = (station, selected) => String(station.stationName || '').replace(/\s/g, '')
    === String(selected.stationName || '').replace(/\s/g, '');
  const fallbackOrigin = stations.find(stop => nameMatch(stop, state.origin));
  const fallbackDestination = stations.find(stop => nameMatch(stop, state.destination)
    && routeStationSequence(stop) > routeStationSequence(fallbackOrigin));
  if (fallbackOrigin && fallbackDestination) {
    state.route.originStaOrder = routeStationSequence(fallbackOrigin);
    state.route.destinationStaOrder = routeStationSequence(fallbackDestination);
  }
}

async function api(action, params = {}) {
  const url = new URL('/api/gbis', location.origin);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.message || '버스정보를 가져오지 못했습니다.');
    error.code = data.code || '';
    error.requiredApi = data.requiredApi || '';
    throw error;
  }
  return data;
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

async function resolveUserPosition() {
  let quickPosition = null;
  let quickError = null;
  try {
    quickPosition = await getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 300000
    });
  } catch (error) {
    quickError = error;
  }

  if (quickPosition && number(quickPosition.coords.accuracy, 9999) <= 120) return quickPosition;

  try {
    const precisePosition = await getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 18000,
      maximumAge: 0
    });
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
  items.forEach(station => {
    const lat = number(station.y, NaN);
    const lng = number(station.x, NaN);
    const measuredDistance = Number.isFinite(lat) && Number.isFinite(lng)
      ? distanceMeters(latitude, longitude, lat, lng)
      : number(station.distance, 999999);
    const normalized = { ...station, distance: Math.round(measuredDistance) };
    const key = String(station.stationId || `${station.stationName}:${station.x}:${station.y}`);
    const previous = unique.get(key);
    if (!previous || number(normalized.distance, 999999) < number(previous.distance, 999999)) unique.set(key, normalized);
  });
  return [...unique.values()].sort((a, b) => number(a.distance, 999999) - number(b.distance, 999999));
}

async function fetchNearbyStations(latitude, longitude) {
  const queryPoint = async (lat, lng) => api('stationAround', {
    x: lng.toFixed(7),
    y: lat.toFixed(7)
  });

  const primary = await queryPoint(latitude, longitude);
  let items = primary.items || [];
  if (items.length) return normalizeNearbyStations(items, latitude, longitude);

  // GBIS 주변정류소 API의 검색 반경 경계에 걸리는 경우를 위해
  // 약 220m 떨어진 네 지점을 보조 조회해 실제 위치 기준 가까운 순으로 다시 계산한다.
  const latOffset = 0.0020;
  const lngOffset = 0.0025;
  const results = await Promise.allSettled([
    queryPoint(latitude + latOffset, longitude),
    queryPoint(latitude - latOffset, longitude),
    queryPoint(latitude, longitude + lngOffset),
    queryPoint(latitude, longitude - lngOffset)
  ]);
  items = results.flatMap(result => result.status === 'fulfilled' ? (result.value.items || []) : []);
  return normalizeNearbyStations(items, latitude, longitude).filter(station => number(station.distance, 999999) <= 900);
}

async function findNearbyOriginStations() {
  if (!navigator.geolocation) return toast('이 브라우저는 현재 위치 기능을 지원하지 않습니다.', 4000);
  const listEl = els.originSuggestions;
  const button = els.nearbyOrigin;
  button.disabled = true;
  button.classList.add('loading');
  listEl.innerHTML = '<div class="empty">현재 위치를 확인하는 중…</div>';

  try {
    const position = await resolveUserPosition();
    const { latitude, longitude, accuracy } = position.coords;
    state.userLocation = { lat: latitude, lng: longitude, accuracy: number(accuracy, 0) };
    if (state.map) renderMap(false);

    listEl.innerHTML = '<div class="empty">가까운 정류장을 찾는 중…</div>';
    const nearby = (await fetchNearbyStations(latitude, longitude)).slice(0, 20);
    renderStationSuggestions('origin', nearby, { nearby: true });

    if (nearby.length) {
      toast(`현재 위치 주변에서 ${nearby.length}개 정류장을 찾았습니다.`);
    } else {
      listEl.innerHTML = '<div class="empty">현재 위치 가까이에 조회되는 경기버스 정류장이 없습니다. 정류장 이름 검색을 이용해 주세요.</div>';
    }
  } catch (error) {
    listEl.innerHTML = `<div class="empty error">${esc(geolocationMessage(error))}</div>`;
    if (error?.code && ![1, 2, 3].includes(error.code)) updateApiState(error);
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
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
  state.routeStations = [];
  state.routeShape = [];
  state.locations = [];
  state.arrival = null;
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
    originStaOrder: number(pair.originRoute.staOrder),
    destinationStaOrder: number(pair.destRoute.staOrder)
  };
  els.liveSection.classList.remove('hidden');
  els.alertSection.classList.remove('hidden');
  els.chosenRoute.innerHTML = `<div class="chosen-route-main"><span class="chosen-route-number">${esc(state.route.routeName)}</span><span><strong>${esc(state.route.routeDestName || '선택 노선')} 방면</strong><p>${esc(state.origin.stationName)} → ${esc(state.destination.stationName)}</p></span></div><small class="chosen-route-hint">노선 전체와 현재 운행 중인 모든 차량을 지도에 표시합니다.</small>`;
  els.liveSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await loadLive(true);
  startPolling();
}

async function loadLive(fit = false, { manual = false, silent = false } = {}) {
  if (!state.route || !state.origin) return;
  if (state.liveLoading) {
    if (manual) toast('실시간 정보를 갱신하고 있습니다.');
    return;
  }

  state.liveLoading = true;
  if (els.refreshLive) {
    els.refreshLive.disabled = true;
    els.refreshLive.classList.add('is-loading');
  }
  if (els.refreshLiveLabel) els.refreshLiveLabel.textContent = '갱신 중';

  const errors = [];
  try {
    if (!state.routeStations.length) {
      const stationsData = await api('routeStations', { routeId: state.route.routeId });
      state.routeStations = (stationsData.items || [])
        .map(normalizeRouteStation)
        .filter(stop => Number.isFinite(routeStationSequence(stop)))
        .sort((a, b) => routeStationSequence(a) - routeStationSequence(b));
    }

    if (!state.routeStations.length) throw new Error('선택한 버스의 경유 정류소 정보를 찾지 못했습니다.');
    reconcileRouteOrders();

    const [shapeResult, locationResult, arrivalResult] = await Promise.allSettled([
      state.routeShape.length ? Promise.resolve({ items: state.routeShape }) : api('routeLines', { routeId: state.route.routeId }),
      api('busLocations', { routeId: state.route.routeId }),
      api('arrival', {
        stationId: state.origin.stationId,
        routeId: state.route.routeId,
        staOrder: state.route.originStaOrder
      })
    ]);

    if (shapeResult.status === 'fulfilled') {
      state.routeShape = (shapeResult.value.items || [])
        .map(normalizeRouteShapePoint)
        .filter(point => Number.isFinite(number(point.x, NaN)) && Number.isFinite(number(point.y, NaN)))
        .sort((a, b) => number(a.lineSeq) - number(b.lineSeq));
    }

    if (locationResult.status === 'fulfilled') {
      state.locations = (locationResult.value.items || [])
        .map(normalizeBusLocation)
        .filter(bus => Number.isFinite(number(bus.stationSeq, NaN)) || bus.stationId);
    } else {
      state.locations = [];
      errors.push(locationResult.reason);
    }

    if (arrivalResult.status === 'fulfilled') {
      state.arrival = arrivalResult.value.item || {};
    } else {
      state.arrival = {};
      errors.push(arrivalResult.reason);
    }

    renderArrival();
    renderMap(fit || manual);
    checkForegroundAlarm();

    if (locationResult.status === 'fulfilled') {
      updateApiState();
      els.apiState.textContent = '실시간 연결됨';
      els.apiState.closest('.live-pill')?.classList.add('is-good');
    } else if (errors[0]) {
      updateApiState(errors[0]);
    }

    if (manual && !silent) {
      const actualCount = state.locations.length;
      const arrivalCount = [arrivalMetadata(1), arrivalMetadata(2)].filter(Boolean).length;
      toast(actualCount
        ? `실시간 버스 ${actualCount}대와 노선을 새로 불러왔습니다.`
        : arrivalCount
          ? '위치 API 차량은 없지만 도착 예정 버스를 지도에 표시했습니다.'
          : '현재 운행 차량 정보가 없습니다. 노선은 정상적으로 표시했습니다.', 3800);
    }
  } catch (error) {
    updateApiState(error);
    if (!silent) toast(error.message, 4200);
    if (state.routeStations.length) {
      renderArrival();
      renderMap(fit || manual);
    }
  } finally {
    state.liveLoading = false;
    if (els.refreshLive) {
      els.refreshLive.disabled = false;
      els.refreshLive.classList.remove('is-loading');
    }
    if (els.refreshLiveLabel) els.refreshLiveLabel.textContent = '새로고침';
  }
}

function renderArrival() {
  const a = state.arrival || {};
  const cards = [1, 2].map(index => {
    const minRaw = a[`predictTime${index}`];
    const stopsRaw = a[`locationNo${index}`];
    const hasMinutes = minRaw !== null && minRaw !== undefined && String(minRaw).trim() !== '';
    const hasStops = stopsRaw !== null && stopsRaw !== undefined && String(stopsRaw).trim() !== '';
    const min = number(minRaw, -1);
    const stops = number(stopsRaw, -1);
    const plate = a[`plateNo${index}`] || '';
    const stationName = a[`stationNm${index}`] || '';
    const timeText = hasMinutes ? (min <= 0 ? '곧 도착' : `${min}분`) : '정보 없음';
    const stopText = hasStops
      ? (stops <= 0 ? '정류장 도착·통과 중' : `${stops}정거장 전`)
      : '운행정보 없음';
    return `<div class="arrival-card">
      <div class="arrival-label">${index === 1 ? '가장 가까운 버스' : '다음 버스'}</div>
      <div class="arrival-time">${timeText}</div>
      <div class="arrival-stops">${stopText}</div>
      <div class="arrival-label">${esc(stationName || plate || '')}</div>
    </div>`;
  }).join('');
  els.arrivalGrid.innerHTML = cards;
}

function interpolateBusPosition(location) {
  const directLat = number(location?.y ?? location?.gpsY ?? location?.latitude, NaN);
  const directLng = number(location?.x ?? location?.gpsX ?? location?.longitude, NaN);
  if (Number.isFinite(directLat) && Number.isFinite(directLng)) return [directLat, directLng];

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
  const lat = number(stop?.y, NaN);
  const lng = number(stop?.x, NaN);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
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

function syntheticArrivalBus(metadata) {
  const locationNo = Math.max(0, number(metadata._locationNo, 0));
  return {
    ...metadata,
    _synthetic: true,
    stationSeq: Math.max(1, number(state.route?.originStaOrder, 1) - locationNo)
  };
}

function busCollections() {
  const actual = (state.locations || []).map(bus => ({ ...bus, vehId: idText(bus.vehId) }));
  const actualByVehicle = new Map(actual.filter(bus => bus.vehId).map(bus => [bus.vehId, bus]));
  const actualByPlate = new Map(actual.filter(bus => bus.plateNo).map(bus => [String(bus.plateNo), bus]));
  const matchedIds = new Set();
  const matchedPlates = new Set();
  const exactArrivals = [1, 2].map(arrivalMetadata).filter(Boolean).map(metadata => {
    const match = (metadata.vehId ? actualByVehicle.get(metadata.vehId) : null)
      || (metadata.plateNo ? actualByPlate.get(String(metadata.plateNo)) : null);
    if (match) {
      if (metadata.vehId) matchedIds.add(metadata.vehId);
      if (metadata.plateNo) matchedPlates.add(String(metadata.plateNo));
      return mergeArrivalBus(match, metadata);
    }
    return syntheticArrivalBus(metadata);
  });

  const originOrder = number(state.route?.originStaOrder, 0);
  const otherApproaching = actual.filter(bus => {
    if (bus.vehId && matchedIds.has(bus.vehId)) return false;
    if (bus.plateNo && matchedPlates.has(String(bus.plateNo))) return false;
    return number(bus.stationSeq, 999999) <= originOrder;
  });

  const approaching = [...exactArrivals, ...otherApproaching]
    .filter((bus, index, array) => {
      const key = bus.vehId || `synthetic:${bus._arrivalRank || ''}:${bus.stationSeq}`;
      return array.findIndex(item => (item.vehId || `synthetic:${item._arrivalRank || ''}:${item.stationSeq}`) === key) === index;
    })
    .sort((a, b) => {
      if (a._arrivalRank && b._arrivalRank) return a._arrivalRank - b._arrivalRank;
      if (a._arrivalRank) return -1;
      if (b._arrivalRank) return 1;
      return number(b.stationSeq) - number(a.stationSeq);
    });

  const exactByVehicle = new Map(exactArrivals.filter(bus => bus.vehId && !bus._synthetic).map(bus => [bus.vehId, bus]));
  const all = actual.map(bus => exactByVehicle.get(bus.vehId) || bus);
  exactArrivals.filter(bus => bus._synthetic).forEach(bus => all.push(bus));
  return { approaching, all };
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
  if (seq === state.route.originStaOrder) return 'origin';
  if (seq === state.route.destinationStaOrder) return 'destination';
  if (seq < state.route.originStaOrder) return 'approach';
  if (seq > state.route.destinationStaOrder) return 'after';
  return 'journey';
}

function busMapStatus(bus) {
  const seq = number(bus.stationSeq);
  if (bus._arrivalRank) {
    const locationNo = number(bus._locationNo, -1);
    const arrivalLabel = bus._arrivalRank === 1 ? '첫 번째 도착 버스' : '두 번째 도착 버스';
    const distanceLabel = locationNo < 0 ? '위치 확인 중' : locationNo === 0 ? '곧 도착' : `${locationNo}정거장 전`;
    return {
      className: bus._arrivalRank === 1 ? 'arrival-first' : 'arrival-second',
      label: `${arrivalLabel} · ${distanceLabel}`
    };
  }
  if (seq <= state.route.originStaOrder) {
    const remaining = Math.max(0, state.route.originStaOrder - seq);
    return { className: 'approach', label: remaining ? `탑승 정류장까지 약 ${remaining}정거장` : '탑승 정류장 도착 중' };
  }
  if (seq <= state.route.destinationStaOrder) return { className: 'journey', label: '탑승 정류장을 지나 목적지 방향으로 운행 중' };
  return { className: 'after', label: '목적지 이후 구간 운행 중' };
}

function drawPolyline(stops, options) {
  const latlngs = stops.map(stationPosition).filter(Boolean);
  if (latlngs.length > 1) L.polyline(latlngs, options).addTo(state.routeLayer);
  return latlngs;
}

function renderMap(fit = false) {
  const map = ensureMap();
  state.routeLayer.clearLayers();
  state.markerLayer.clearLayers();

  const ordered = [...state.routeStations].sort((a, b) => number(a.stationSeq) - number(b.stationSeq));
  const routeShapeLatlngs = (state.routeShape || []).map(point => {
    const lat = number(point.y, NaN);
    const lng = number(point.x, NaN);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }).filter(Boolean);
  if (routeShapeLatlngs.length > 1) {
    L.polyline(routeShapeLatlngs, { color: '#062d66', weight: 9, opacity: .82, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
    L.polyline(routeShapeLatlngs, { color: '#36b9ff', weight: 4, opacity: .82, lineCap: 'round', lineJoin: 'round' }).addTo(state.routeLayer);
  }
  const stationRouteLatlngs = drawPolyline(ordered, { color: '#123f78', weight: routeShapeLatlngs.length ? 3 : 7, opacity: routeShapeLatlngs.length ? .24 : .78, lineCap: 'round', lineJoin: 'round' });
  const allLatlngs = routeShapeLatlngs.length ? routeShapeLatlngs : stationRouteLatlngs;
  const approachStops = ordered.filter(stop => number(stop.stationSeq) <= state.route.originStaOrder);
  const journeyStops = ordered.filter(stop => {
    const seq = number(stop.stationSeq);
    return seq >= state.route.originStaOrder && seq <= state.route.destinationStaOrder;
  });
  const afterStops = ordered.filter(stop => number(stop.stationSeq) >= state.route.destinationStaOrder);

  const approachLatlngs = drawPolyline(approachStops, { color: '#24c8f2', weight: 6, opacity: .96, dashArray: '10 8', lineCap: 'round' });
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
      html: `<div class="bus-marker ${status.className}"><span class="bus-route-number">${esc(state.route.routeName)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17h12M7 4h10a3 3 0 0 1 3 3v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a3 3 0 0 1 3-3Zm-1 9h12M8 8h8M7 21v-3m10 3v-3"/></svg><small>${esc(String(bus.plateNo || '').slice(-4))}</small></div>`,
      iconSize: bus._arrivalRank ? [68, 52] : [62, 48],
      iconAnchor: bus._arrivalRank ? [34, 26] : [31, 24]
    });
    const vehicleLabel = bus.plateNo || (bus.vehId ? `차량 ${bus.vehId}` : '차량정보 확인 중');
    const sourceLabel = bus._synthetic ? '<br><small>도착정보 기준 추정 위치</small>' : '';
    L.marker(pos, { icon, zIndexOffset: bus._arrivalRank ? 1300 : 1000 })
      .bindPopup(`<strong>${esc(state.route.routeName)}번</strong><br>${esc(vehicleLabel)}<br>${esc(status.label)}<br>${seq}번째 정류장 부근${sourceLabel}`)
      .addTo(state.markerLayer);
  });

  if (state.userLocation) {
    const userPos = [state.userLocation.lat, state.userLocation.lng];
    if (state.userLocation.accuracy > 0) {
      L.circle(userPos, {
        radius: Math.min(Math.max(state.userLocation.accuracy, 20), 250),
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

  const approachingCount = collections.approaching.length;
  const allCount = collections.all.length;
  els.busCount.textContent = `전체 ${allCount}대 · 접근 ${approachingCount}대`;
  if (state.vehicleScope === 'approaching') {
    els.mapNote.textContent = approachingCount
      ? '탑승 정류장으로 오는 차량만 표시합니다. 1·2 표시 차량은 도착정보 API가 지정한 실제 첫 번째·두 번째 도착 버스입니다.'
      : '현재 탑승 정류장으로 접근 중인 차량이 없습니다. “전체 차량”을 누르면 이미 지나간 차량도 확인할 수 있습니다.';
  } else {
    els.mapNote.textContent = allCount
      ? '선택한 노선 전체와 운행 중인 모든 차량을 표시합니다. 각 차량 위에 버스 번호가 함께 표시됩니다.'
      : '선택한 노선은 표시됐지만 현재 위치 API에 운행 차량이 없습니다. 잠시 후 새로고침해 주세요.';
  }

  if (fit) {
    let fitLatlngs = state.mapScope === 'journey' && journeyLatlngs.length ? journeyLatlngs : allLatlngs;
    if (state.vehicleScope === 'approaching' && state.mapScope === 'full' && approachLatlngs.length) {
      fitLatlngs = [...approachLatlngs, ...visibleBusPositions];
    }
    if (state.userLocation) fitLatlngs = [...fitLatlngs, [state.userLocation.lat, state.userLocation.lng]];
    if (fitLatlngs.length > 1) map.fitBounds(fitLatlngs, { padding: [32, 32], maxZoom: 16 });
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
  const locationNo = number(state.arrival?.locationNo1, 0);
  const lead = number($('leadStops').value, 3);
  const plate = String(state.arrival?.plateNo1 || '');
  const key = `${new Date().toDateString()}:${state.route.routeId}:${plate}`;
  if (locationNo > 0 && locationNo <= lead && key !== state.foregroundAlarmKey) {
    state.foregroundAlarmKey = key;
    state.lastAlertAt = Date.now();
    const title = `${state.route.routeName}번 ${locationNo}정거장 전`;
    const body = `${state.origin.stationName}에 곧 도착합니다.`;
    if ($('alertMode').value === 'push') playAlarm();
    showLocalNotification(title, body);
    toast(body, 5000);
  }
  if (locationNo > lead) state.foregroundAlarmKey = '';
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
    state.swRegistration = await navigator.serviceWorker.register('/api/firebase-messaging-sw?v=1.5.0', { scope: '/' });

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
  return {
    enabled: $('alertEnabled').checked,
    routeId: String(state.route.routeId),
    routeName: String(state.route.routeName),
    stationId: String(state.origin.stationId),
    stationName: String(state.origin.stationName),
    staOrder: number(state.route.originStaOrder),
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
