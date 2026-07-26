const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const GBIS_SERVICE_KEY = defineSecret('GBIS_SERVICE_KEY');

function normalizeServiceKey(rawValue) {
  let value = String(rawValue || '').trim();
  if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

function readXmlTag(xml, tagName) {
  const match = String(xml).match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
}


function koreaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[parts.weekday], hhmm: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function withinTime(now, start, end) {
  if (!start || !end) return true;
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

async function fetchArrival(serviceKey, alert) {
  const url = new URL('https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalItemv2');
  url.searchParams.set('format', 'json');
  url.searchParams.set('serviceKey', normalizeServiceKey(serviceKey));
  url.searchParams.set('stationId', String(alert.stationId));
  url.searchParams.set('routeId', String(alert.routeId));
  url.searchParams.set('staOrder', String(alert.staOrder));

  const response = await fetch(url, {
    headers: { Accept: 'application/json, application/xml;q=0.9', 'User-Agent': 'hogye-bus-alert-functions/1.1' },
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* XML/HTML 오류는 아래에서 처리 */ }

  if (!json) {
    const apiMessage = readXmlTag(text, 'returnAuthMsg') || readXmlTag(text, 'errMsg') || readXmlTag(text, 'resultMessage');
    const upper = `${apiMessage} ${text}`.toUpperCase();
    if (response.status === 403 || upper.includes('SERVICE ACCESS DENIED')) {
      throw new Error('공공데이터포털에서 “경기도_버스도착정보 조회” 활용신청이 필요합니다.');
    }
    throw new Error(apiMessage || `도착정보 API가 올바르지 않은 응답을 반환했습니다. (${response.status})`);
  }

  const root = json.response || json;
  const commonHeader = root.comMsgHeader || json.comMsgHeader || {};
  const header = root.msgHeader || {};
  const code = String(header.resultCode ?? commonHeader.returnReasonCode ?? (response.ok ? '0' : response.status));
  const message = header.resultMessage || commonHeader.returnAuthMsg || commonHeader.errMsg || '도착정보 조회 실패';
  if (response.ok && ['4', '04', '0004'].includes(code)) return null;
  if (!response.ok || !['0', '00', '0000'].includes(code)) throw new Error(message);
  return root.msgBody?.busArrivalItem || null;
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

  const cache = new Map();
  const writes = [];

  for (const doc of snapshot.docs) {
    const alert = doc.data();
    if (!Array.isArray(alert.days) || !alert.days.includes(now.day)) continue;
    if (!withinTime(now.hhmm, alert.startTime || '00:00', alert.endTime || '23:59')) continue;
    if (!alert.fcmToken || !alert.routeId || !alert.stationId || !alert.staOrder) continue;

    const key = `${alert.routeId}:${alert.stationId}:${alert.staOrder}`;
    try {
      if (!cache.has(key)) cache.set(key, fetchArrival(GBIS_SERVICE_KEY.value(), alert));
      const arrival = await cache.get(key);
      const locationNo = Number(arrival?.locationNo1 || 0);
      const leadStops = Number(alert.leadStops || 3);
      const plateNo = String(arrival?.plateNo1 || '');
      const flag = String(arrival?.flag || '');
      const approaching = locationNo > 0 && locationNo <= leadStops && ['RUN', 'PASS'].includes(flag);

      if (!approaching) {
        const busMovedOutsideThreshold = locationNo > leadStops;
        const nextBusDetected = Boolean(plateNo) && plateNo !== String(alert.lastNotifiedPlate || '');
        if (alert.armed === false && (busMovedOutsideThreshold || nextBusDetected)) {
          writes.push(doc.ref.update({ armed: true, updatedAt: FieldValue.serverTimestamp() }));
        }
        continue;
      }

      if (alert.armed === false && (!plateNo || alert.lastNotifiedPlate === plateNo)) continue;

      const title = `${alert.routeName || '버스'} ${locationNo}정거장 전`;
      const body = `${alert.stationName || '탑승 정류장'}에 곧 도착합니다. 지금 출발하세요.`;
      await getMessaging().send({
        token: alert.fcmToken,
        data: {
          title,
          body,
          tag: `bus-${alert.routeId}-${alert.stationId}`,
          url: '/?from=push',
          alertMode: String(alert.alertMode || 'push')
        },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: '/' }
        }
      });

      writes.push(doc.ref.update({
        armed: false,
        lastNotifiedPlate: plateNo,
        lastNotifiedDate: now.date,
        lastNotifiedAt: FieldValue.serverTimestamp(),
        lastLocationNo: locationNo,
        updatedAt: FieldValue.serverTimestamp()
      }));
    } catch (error) {
      console.error('alert failed', doc.id, error);
      writes.push(doc.ref.update({ lastError: String(error?.message || error).slice(0, 300), updatedAt: FieldValue.serverTimestamp() }));
    }
  }

  await Promise.allSettled(writes);
});
