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
  locations: [],
  arrival: null,
  map: null,
  routeLayer: null,
  markerLayer: null,
  poller: null,
  firebase: null,
  firebaseConfig: null,
  swRegistration: null,
  foregroundAlarmKey: '',
  lastAlertAt: 0
};

const els = {
  apiState: $('apiState'), originInput: $('originInput'), destinationInput: $('destinationInput'),
  originSuggestions: $('originSuggestions'), destinationSuggestions: $('destinationSuggestions'),
  originSelected: $('originSelected'), destinationSelected: $('destinationSelected'),
  routeResults: $('routeResults'), liveSection: $('liveSection'), alertSection: $('alertSection'),
  chosenRoute: $('chosenRoute'), arrivalGrid: $('arrivalGrid'), pushState: $('pushState'),
  toast: $('toast'), alarmAudio: $('alarmAudio'), alertInfo: $('alertInfo')
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
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  if (!error) {
    els.apiState.textContent = 'API 연결됨';
    return;
  }
  if (error.code === 'MISSING_SERVICE_KEY') els.apiState.textContent = 'API 키 필요';
  else if (error.code === 'API_ACCESS_DENIED') els.apiState.textContent = 'API 권한 필요';
  else if (error.code === 'INVALID_SERVICE_KEY') els.apiState.textContent = 'API 키 확인';
  else if (error.code === 'API_QUOTA_EXCEEDED') els.apiState.textContent = '호출량 초과';
  else els.apiState.textContent = '연결 오류';
}

function stationLabel(station) {
  return `${station.stationName} · ${station.regionName || ''}${station.mobileNo ? ` · ${station.mobileNo}` : ''}`;
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
      .slice(0, 12);
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
      return;
    }
    listEl.innerHTML = filtered.map((station, index) => `
      <button class="suggestion" data-kind="${kind}" data-index="${index}">
        <strong>${esc(station.stationName)}</strong>
        <span>${esc(station.regionName || '')}${station.mobileNo ? ` · 정류소 ${esc(station.mobileNo)}` : ''}</span>
      </button>`).join('');
    listEl.querySelectorAll('.suggestion').forEach(button => {
      button.addEventListener('click', () => selectStation(kind, filtered[Number(button.dataset.index)]));
    });
  } catch (error) {
    listEl.innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
    updateApiState(error);
  }
}

function selectStation(kind, station) {
  state[kind] = station;
  const selected = kind === 'origin' ? els.originSelected : els.destinationSelected;
  const suggestions = kind === 'origin' ? els.originSuggestions : els.destinationSuggestions;
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
  state.locations = [];
  state.arrival = null;
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
  els.chosenRoute.innerHTML = `<strong>${esc(state.route.routeName)}번 · ${esc(state.route.routeDestName || '')} 방면</strong><p>${esc(state.origin.stationName)} → ${esc(state.destination.stationName)}</p>`;
  els.liveSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await loadLive(true);
  startPolling();
}

async function loadLive(fit = false) {
  if (!state.route || !state.origin) return;
  try {
    const [stationsData, locationData, arrivalData] = await Promise.all([
      state.routeStations.length ? Promise.resolve({ items: state.routeStations }) : api('routeStations', { routeId: state.route.routeId }),
      api('busLocations', { routeId: state.route.routeId }),
      api('arrival', {
        stationId: state.origin.stationId,
        routeId: state.route.routeId,
        staOrder: state.route.originStaOrder
      })
    ]);
    state.routeStations = stationsData.items.sort((a, b) => number(a.stationSeq) - number(b.stationSeq));
    state.locations = locationData.items;
    state.arrival = arrivalData.item || {};
    renderArrival();
    renderMap(fit);
    checkForegroundAlarm();
    els.apiState.textContent = '실시간 연결됨';
  } catch (error) {
    updateApiState(error);
    toast(error.message);
  }
}

function renderArrival() {
  const a = state.arrival || {};
  const cards = [1, 2].map(index => {
    const min = number(a[`predictTime${index}`], -1);
    const stops = number(a[`locationNo${index}`], 0);
    const plate = a[`plateNo${index}`] || '';
    return `<div class="arrival-card">
      <div class="arrival-label">${index === 1 ? '가장 가까운 버스' : '다음 버스'}</div>
      <div class="arrival-time">${min >= 0 ? `${min}분` : '정보 없음'}</div>
      <div class="arrival-stops">${stops > 0 ? `${stops}정거장 전` : '운행정보 확인 중'}</div>
      <div class="arrival-label">${esc(plate)}</div>
    </div>`;
  }).join('');
  els.arrivalGrid.innerHTML = cards;
}

function interpolateBusPosition(location) {
  const seq = number(location.stationSeq);
  const current = state.routeStations.find(s => number(s.stationSeq) === seq);
  const next = state.routeStations.find(s => number(s.stationSeq) === seq + 1);
  if (!current) return null;
  const y1 = number(current.y, NaN), x1 = number(current.x, NaN);
  if (!Number.isFinite(y1) || !Number.isFinite(x1)) return null;
  if (!next) return [y1, x1];
  const y2 = number(next.y, y1), x2 = number(next.x, x1);
  const ratio = number(location.stateCd) === 0 ? .55 : number(location.stateCd) === 2 ? .25 : 0;
  return [y1 + (y2 - y1) * ratio, x1 + (x2 - x1) * ratio];
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

function renderMap(fit = false) {
  const map = ensureMap();
  state.routeLayer.clearLayers();
  state.markerLayer.clearLayers();

  const segment = state.routeStations.filter(s => {
    const seq = number(s.stationSeq);
    return seq >= state.route.originStaOrder && seq <= state.route.destinationStaOrder;
  });
  const latlngs = segment.map(s => [number(s.y, NaN), number(s.x, NaN)]).filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
  if (latlngs.length > 1) L.polyline(latlngs, { color: '#1859d9', weight: 5, opacity: .8 }).addTo(state.routeLayer);

  segment.forEach(stop => {
    const pos = [number(stop.y, NaN), number(stop.x, NaN)];
    if (!pos.every(Number.isFinite)) return;
    const icon = L.divIcon({ className: '', html: '<div class="stop-marker"></div>', iconSize: [13,13], iconAnchor: [6,6] });
    L.marker(pos, { icon }).bindPopup(`<strong>${esc(stop.stationName)}</strong><br>${number(stop.stationSeq)}번째 정류장`).addTo(state.markerLayer);
  });

  state.locations.forEach(bus => {
    const seq = number(bus.stationSeq);
    if (seq < state.route.originStaOrder - 8 || seq > state.route.destinationStaOrder + 2) return;
    const pos = interpolateBusPosition(bus);
    if (!pos) return;
    const icon = L.divIcon({ className: '', html: '<div class="bus-marker">🚌</div>', iconSize: [34,34], iconAnchor: [17,17] });
    L.marker(pos, { icon, zIndexOffset: 1000 })
      .bindPopup(`<strong>${esc(state.route.routeName)}번</strong><br>${esc(bus.plateNo || '')}<br>${number(bus.stationSeq)}번째 정류장 부근`)
      .addTo(state.markerLayer);
  });

  if (fit && latlngs.length) map.fitBounds(latlngs, { padding: [28, 28] });
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
    if (!document.hidden) loadLive(false);
  }, 30000);
}

async function initFirebase() {
  try {
    const configResponse = await fetch('/api/config', { cache: 'no-store' });
    state.firebaseConfig = await configResponse.json();
    state.swRegistration = await navigator.serviceWorker.register('/api/firebase-messaging-sw', { scope: '/' });

    if (!state.firebaseConfig.backgroundPushConfigured) {
      els.pushState.textContent = '화면 켤 때만';
      els.alertInfo.textContent = 'Firebase 환경변수가 없어 현재는 앱을 열어둔 동안의 알림만 동작합니다. README의 Firebase 설정을 완료하면 백그라운드 푸시가 활성화됩니다.';
      return;
    }

    const app = initializeApp(state.firebaseConfig.firebase);
    const auth = getAuth(app);
    const credential = await signInAnonymously(auth);
    const firestore = getFirestore(app);
    state.firebase = { app, auth, user: credential.user, firestore, messaging: null };
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
    els.pushState.textContent = '푸시 준비됨';
    els.pushState.classList.add('good');
  } catch (error) {
    console.warn('Firebase init failed', error);
    els.pushState.textContent = '로컬 알림';
    els.alertInfo.textContent = `백그라운드 푸시 초기화 실패: ${error.message}. 앱을 열어둔 동안의 알림은 사용할 수 있습니다.`;
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

    if (!state.firebase?.firestore || !state.firebase?.messaging) {
      localStorage.setItem('hogyeBusAlert', JSON.stringify(buildAlertPayload('')));
      els.pushState.textContent = '화면 켤 때만';
      toast('로컬 알림 설정을 저장했습니다.');
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
  $('destinationSearch').addEventListener('click', () => searchStations('destination'));
  $('findRoutes').addEventListener('click', findRoutes);
  $('refreshLive').addEventListener('click', () => loadLive(false));
  $('saveAlert').addEventListener('click', saveAlert);
  $('testAlert').addEventListener('click', () => { playAlarm(); toast('알림 소리를 재생했습니다.'); });
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.route) loadLive(false); });
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
