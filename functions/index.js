const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const GBIS_SERVICE_KEY = defineSecret('GBIS_SERVICE_KEY');

const SUCCESS_CODES = new Set(['0', '00', '0000']);
const NO_RESULT_CODES = new Set(['4', '04', '0004']);

function normalizeServiceKey(rawValue) {
  let value = String(rawValue || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\s+/g, '');
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeXmlEntities(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function readXmlTag(xml, tagName) {
  const match = String(xml).match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')) : '';
}

function xmlBlockToObject(block) {
  const result = {};
  const childPattern = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = childPattern.exec(block)) !== null) {
    if (/<[A-Za-z_][\w.-]*(?:\s[^>]*)?>/.test(match[2])) continue;
    result[match[1]] = decodeXmlEntities(match[2]);
  }
  return result;
}

function parseXmlItems(text, dataKey) {
  const values = [];
  const itemPattern = new RegExp(`<${dataKey}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${dataKey}>`, 'gi');
  let match;
  while ((match = itemPattern.exec(text)) !== null) values.push(xmlBlockToObject(match[1]));
  return values;
}

function findDeep(value, key, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return undefined;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findDeep(child, key, depth + 1, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function extractJsonPayload(json, dataKey) {
  const root = json?.response || json;
  const commonHeader = root?.comMsgHeader || json?.comMsgHeader || findDeep(json, 'comMsgHeader') || {};
  const header = root?.msgHeader || root?.header || json?.msgHeader || findDeep(json, 'msgHeader') || {};
  let value = root?.msgBody?.[dataKey] ?? root?.body?.[dataKey] ?? json?.msgBody?.[dataKey] ?? root?.[dataKey] ?? json?.[dataKey];
  if (value === undefined) value = findDeep(json, dataKey);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = value.item ?? value.items?.item ?? value.items ?? value;
  }
  return {
    code: String(header?.resultCode ?? header?.headerCode ?? commonHeader?.returnReasonCode ?? '0'),
    message: header?.resultMessage || header?.headerMsg || commonHeader?.returnAuthMsg || commonHeader?.errMsg || '',
    value
  };
}

async function fetchGbis(serviceKey, endpoint, params, dataKey, { single = false, apiName = '경기도 버스 API' } = {}) {
  const url = new URL(endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('serviceKey', normalizeServiceKey(serviceKey));
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

  const response = await fetch(url, {
    headers: { Accept: 'application/json, application/xml;q=0.9', 'User-Agent': 'hogye-bus-alert-functions/2.1' },
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let code = String(response.ok ? '0' : response.status);
  let message = '';
  let values = [];

  try {
    const parsed = extractJsonPayload(JSON.parse(trimmed), dataKey);
    code = parsed.code;
    message = parsed.message;
    values = asArray(parsed.value);
  } catch {
    code = readXmlTag(trimmed, 'resultCode') || readXmlTag(trimmed, 'returnReasonCode') || code;
    message = readXmlTag(trimmed, 'resultMessage') || readXmlTag(trimmed, 'returnAuthMsg') || readXmlTag(trimmed, 'errMsg');
    values = parseXmlItems(trimmed, dataKey);
  }

  if (response.ok && NO_RESULT_CODES.has(String(code))) return single ? null : [];
  if (!response.ok || !SUCCESS_CODES.has(String(code))) {
    const upper = `${message} ${trimmed}`.toUpperCase();
    if (response.status === 403 || upper.includes('SERVICE ACCESS DENIED')) {
      throw new Error(`공공데이터포털에서 “${apiName}” 활용신청 또는 인증키를 확인해 주세요.`);
    }
    throw new Error(message || `${apiName} 요청에 실패했습니다. (${response.status || code})`);
  }
  return single ? (values[0] || null) : values;
}

function koreaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[parts.weekday], hhmm: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function withinTime(now, start, end) {
  if (!start || !end) return true;
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

function normalizeName(value = '') {
  return String(value).replace(/[\s.·,()\-]/g, '').toLowerCase();
}

function hasVehicle(arrival, index = 1) {
  return Boolean(arrival?.[`vehId${index}`] || arrival?.[`plateNo${index}`] || String(arrival?.[`locationNo${index}`] ?? '').trim());
}

function selectArrivalForAlert(items, alert) {
  const routeId = String(alert.routeId || '');
  const expectedDestId = String(alert.routeDestId || '');
  const expectedDestName = normalizeName(alert.routeDestName || '');
  const expectedOrder = Number(alert.staOrder || 0);
  return items
    .filter(item => String(item?.routeId || '') === routeId)
    .map(item => {
      const destId = String(item?.routeDestId || '');
      const destName = normalizeName(item?.routeDestName || '');
      const staOrder = Number(item?.staOrder || 0);
      let score = 0;
      if (expectedDestId && destId && expectedDestId === destId) score += 120;
      if (expectedDestName && destName) {
        if (expectedDestName === destName) score += 100;
        else if (expectedDestName.includes(destName) || destName.includes(expectedDestName)) score += 50;
      }
      if (expectedOrder && staOrder) {
        if (expectedOrder === staOrder) score += 60;
        score -= Math.min(80, Math.abs(expectedOrder - staOrder) * 2);
      }
      if (hasVehicle(item, 1)) score += 30;
      if (['RUN', 'PASS', 'WAIT'].includes(String(item?.flag || '').toUpperCase())) score += 8;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.item || null;
}

async function fetchArrivalList(serviceKey, stationId) {
  return fetchGbis(
    serviceKey,
    'https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalListv2',
    { stationId },
    'busArrivalList',
    { apiName: '경기도_버스도착정보 조회' }
  );
}

async function fetchArrivalItem(serviceKey, alert) {
  return fetchGbis(
    serviceKey,
    'https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalItemv2',
    { stationId: alert.stationId, routeId: alert.routeId, staOrder: alert.staOrder },
    'busArrivalItem',
    { single: true, apiName: '경기도_버스도착정보 조회' }
  );
}

async function fetchBusLocations(serviceKey, routeId) {
  return fetchGbis(
    serviceKey,
    'https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2',
    { routeId },
    'busLocationList',
    { apiName: '경기도_버스위치정보 조회' }
  );
}

async function fetchRouteStations(serviceKey, routeId) {
  return fetchGbis(
    serviceKey,
    'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteStationListv2',
    { routeId },
    'busRouteStationList',
    { apiName: '경기도_버스노선 조회' }
  );
}

function deriveTopology(alert, routeStations = []) {
  const sequences = routeStations.map(item => Number(item?.stationSeq)).filter(Number.isFinite);
  const minSeq = Number(alert.routeMinSeq || (sequences.length ? Math.min(...sequences) : 1));
  const maxSeq = Number(alert.routeMaxSeq || (sequences.length ? Math.max(...sequences) : 0));
  const count = Number(alert.routeStationCount || (sequences.length || (maxSeq >= minSeq ? maxSeq - minSeq + 1 : 0)));
  const turnFromStations = routeStations.map(item => Number(item?.turnSeq)).find(Number.isFinite);
  const turnSeq = Number(alert.turnSeq || turnFromStations || 0);
  const originSeq = Number(alert.staOrder || 0);
  const originAtStart = typeof alert.originAtStart === 'boolean'
    ? alert.originAtStart
    : Boolean(originSeq && originSeq - minSeq <= Math.max(1, Math.floor(count * .06)));
  const loopCapable = typeof alert.loopCapable === 'boolean'
    ? alert.loopCapable
    : Boolean(turnSeq && maxSeq > turnSeq);
  return { minSeq, maxSeq, count, turnSeq, originSeq, originAtStart, loopCapable };
}

function remainingStopsFromLocation(location, alert, topology) {
  const seq = Number(location?.stationSeq);
  const originSeq = Number(topology.originSeq || alert.staOrder);
  if (!Number.isFinite(seq) || !Number.isFinite(originSeq)) return NaN;
  const stateCd = Number(location?.stateCd);
  const sameStation = String(location?.stationId || '') && String(location.stationId) === String(alert.stationId || '');
  if (sameStation && stateCd !== 2) return 0;
  if (seq < originSeq) return originSeq - seq;
  if (seq === originSeq) {
    if (stateCd !== 2) return 0;
    return topology.loopCapable && topology.count ? topology.count : NaN;
  }
  if (!topology.loopCapable || !topology.maxSeq) return NaN;
  return Math.max(0, topology.maxSeq - seq) + Math.max(0, originSeq - topology.minSeq) + 1;
}

function nearestLocationBus(locations, alert, topology) {
  return locations
    .map(location => ({ location, remaining: remainingStopsFromLocation(location, alert, topology) }))
    .filter(entry => Number.isFinite(entry.remaining) && entry.remaining > 0)
    .sort((a, b) => a.remaining - b.remaining)[0] || null;
}

exports.watchBusAlerts = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Asia/Seoul',
  region: 'asia-northeast3',
  secrets: [GBIS_SERVICE_KEY],
  retryCount: 0,
  memory: '256MiB',
  timeoutSeconds: 50
}, async () => {
  const now = koreaParts();
  const snapshot = await db.collection('busAlerts').where('enabled', '==', true).limit(300).get();
  if (snapshot.empty) return;

  const arrivalListCache = new Map();
  const arrivalItemCache = new Map();
  const locationCache = new Map();
  const routeStationCache = new Map();
  const writes = [];
  const serviceKey = GBIS_SERVICE_KEY.value();

  for (const document of snapshot.docs) {
    const alert = document.data();
    if (!Array.isArray(alert.days) || !alert.days.includes(now.day)) continue;
    if (!withinTime(now.hhmm, alert.startTime || '00:00', alert.endTime || '23:59')) continue;
    if (!alert.fcmToken || !alert.routeId || !alert.stationId || !alert.staOrder) continue;

    try {
      const stationKey = String(alert.stationId);
      if (!arrivalListCache.has(stationKey)) {
        arrivalListCache.set(stationKey, fetchArrivalList(serviceKey, stationKey).catch(error => {
          console.warn('arrival list failed; location fallback will be used', stationKey, error?.message || error);
          return [];
        }));
      }
      const arrivals = await arrivalListCache.get(stationKey);
      let arrival = selectArrivalForAlert(arrivals, alert);

      if (!arrival) {
        const itemKey = `${alert.routeId}:${alert.stationId}:${alert.staOrder}`;
        if (!arrivalItemCache.has(itemKey)) {
          arrivalItemCache.set(itemKey, fetchArrivalItem(serviceKey, alert).catch(error => {
            console.warn('arrival item failed; location fallback will be used', itemKey, error?.message || error);
            return null;
          }));
        }
        arrival = await arrivalItemCache.get(itemKey);
      }

      let locationNo = Number(arrival?.locationNo1 || 0);
      let plateNo = String(arrival?.plateNo1 || '');
      let vehicleId = String(arrival?.vehId1 || '');
      let approximate = false;
      let routeStations = [];

      const topologyMissing = !Number(alert.routeMaxSeq) || !Number(alert.routeStationCount);
      if (topologyMissing) {
        const routeKey = String(alert.routeId);
        if (!routeStationCache.has(routeKey)) {
          routeStationCache.set(routeKey, fetchRouteStations(serviceKey, routeKey).catch(error => {
            console.warn('route station fallback failed', routeKey, error?.message || error);
            return [];
          }));
        }
        routeStations = await routeStationCache.get(routeKey);
      }
      const topology = deriveTopology(alert, routeStations);

      if (locationNo <= 0) {
        const routeKey = String(alert.routeId);
        if (!locationCache.has(routeKey)) {
          locationCache.set(routeKey, fetchBusLocations(serviceKey, routeKey).catch(error => {
            console.warn('bus location fallback failed', routeKey, error?.message || error);
            return [];
          }));
        }
        const locations = await locationCache.get(routeKey);
        const nearest = nearestLocationBus(locations, alert, topology);
        if (nearest) {
          locationNo = nearest.remaining;
          plateNo = String(nearest.location?.plateNo || '');
          vehicleId = String(nearest.location?.vehId || '');
          approximate = true;
        }
      }

      const leadStops = Number(alert.leadStops || 3);
      const vehicleKey = plateNo || vehicleId;
      const flag = String(arrival?.flag || '').toUpperCase();
      const flagAllowsAlert = approximate || !flag || ['RUN', 'PASS'].includes(flag);
      const approaching = locationNo > 0 && locationNo <= leadStops && flagAllowsAlert;

      const correction = {};
      const correctedOrder = Number(arrival?.staOrder || 0);
      if (correctedOrder && correctedOrder !== Number(alert.staOrder)) correction.staOrder = correctedOrder;
      if (arrival?.routeDestId && String(arrival.routeDestId) !== String(alert.routeDestId || '')) correction.routeDestId = String(arrival.routeDestId);
      if (arrival?.routeDestName && String(arrival.routeDestName) !== String(alert.routeDestName || '')) correction.routeDestName = String(arrival.routeDestName);
      if (topology.minSeq && topology.minSeq !== Number(alert.routeMinSeq || 0)) correction.routeMinSeq = topology.minSeq;
      if (topology.maxSeq && topology.maxSeq !== Number(alert.routeMaxSeq || 0)) correction.routeMaxSeq = topology.maxSeq;
      if (topology.count && topology.count !== Number(alert.routeStationCount || 0)) correction.routeStationCount = topology.count;
      if (topology.turnSeq && topology.turnSeq !== Number(alert.turnSeq || 0)) correction.turnSeq = topology.turnSeq;
      if (typeof alert.loopCapable !== 'boolean') correction.loopCapable = topology.loopCapable;
      if (typeof alert.originAtStart !== 'boolean') correction.originAtStart = topology.originAtStart;

      if (!approaching) {
        const busMovedOutsideThreshold = locationNo > leadStops;
        const nextBusDetected = Boolean(vehicleKey) && vehicleKey !== String(alert.lastNotifiedVehicle || alert.lastNotifiedPlate || '');
        if (Object.keys(correction).length || (alert.armed === false && (busMovedOutsideThreshold || nextBusDetected))) {
          writes.push(document.ref.update({
            ...correction,
            ...(alert.armed === false && (busMovedOutsideThreshold || nextBusDetected) ? { armed: true } : {}),
            lastObservedLocationNo: Number.isFinite(locationNo) ? locationNo : null,
            updatedAt: FieldValue.serverTimestamp()
          }));
        }
        continue;
      }

      if (alert.armed === false && (!vehicleKey || String(alert.lastNotifiedVehicle || alert.lastNotifiedPlate || '') === vehicleKey)) continue;

      const title = `${alert.routeName || '버스'} ${approximate ? '약 ' : ''}${locationNo}정거장 전`;
      const body = `${alert.stationName || '탑승 정류장'}에 곧 도착합니다. 지금 출발하세요.`;
      await getMessaging().send({
        token: alert.fcmToken,
        data: {
          title,
          body,
          tag: `bus-${alert.routeId}-${alert.stationId}`,
          url: '/?from=push',
          alertMode: String(alert.alertMode || 'push'),
          alertSound: String(alert.alertSound || 'standard')
        },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: '/' }
        }
      });

      writes.push(document.ref.update({
        ...correction,
        armed: false,
        lastNotifiedVehicle: vehicleKey,
        lastNotifiedPlate: plateNo,
        lastNotifiedDate: now.date,
        lastNotifiedAt: FieldValue.serverTimestamp(),
        lastLocationNo: locationNo,
        lastLocationApproximate: approximate,
        lastError: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }));
    } catch (error) {
      console.error('alert failed', document.id, error);
      writes.push(document.ref.update({ lastError: String(error?.message || error).slice(0, 300), updatedAt: FieldValue.serverTimestamp() }));
    }
  }

  await Promise.allSettled(writes);
});
