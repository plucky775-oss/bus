const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const GBIS_SERVICE_KEY = defineSecret('GBIS_SERVICE_KEY');

function decodeKey(value) {
  try { return decodeURIComponent(value); } catch { return value; }
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
  url.searchParams.set('serviceKey', decodeKey(serviceKey));
  url.searchParams.set('format', 'json');
  url.searchParams.set('stationId', String(alert.stationId));
  url.searchParams.set('routeId', String(alert.routeId));
  url.searchParams.set('staOrder', String(alert.staOrder));
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const json = await response.json();
  const root = json.response || json;
  const header = root.msgHeader || {};
  const code = String(header.resultCode ?? '0');
  if (!response.ok || !['0', '00', '0000'].includes(code)) throw new Error(header.resultMessage || '도착정보 조회 실패');
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
