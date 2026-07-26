const ENDPOINTS = {
  stationSearch: {
    url: 'https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationListv2',
    params: ['keyword'],
    dataKey: 'busStationList',
    cache: 300
  },
  stationRoutes: {
    url: 'https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationViaRouteListv2',
    params: ['stationId'],
    dataKey: 'busRouteList',
    cache: 300
  },
  routeSearch: {
    url: 'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteListv2',
    params: ['keyword'],
    dataKey: 'busRouteList',
    cache: 300
  },
  routeStations: {
    url: 'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteStationListv2',
    params: ['routeId'],
    dataKey: 'busRouteStationList',
    cache: 300
  },
  busLocations: {
    url: 'https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2',
    params: ['routeId'],
    dataKey: 'busLocationList',
    cache: 0
  },
  arrival: {
    url: 'https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalItemv2',
    params: ['stationId', 'routeId', 'staOrder'],
    dataKey: 'busArrivalItem',
    cache: 0,
    single: true
  }
};

function decodeKey(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function extractPayload(json, dataKey) {
  const response = json?.response || json;
  const header = response?.msgHeader || response?.header || json?.msgHeader || {};
  const body = response?.msgBody || response?.body || json?.msgBody || {};
  const value = body?.[dataKey] ?? response?.[dataKey] ?? json?.[dataKey] ?? null;
  return { header, value };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, message: 'GET 요청만 지원합니다.' });
  }

  const serviceKeyRaw = process.env.GBIS_SERVICE_KEY;
  if (!serviceKeyRaw) {
    return res.status(503).json({
      ok: false,
      code: 'MISSING_SERVICE_KEY',
      message: 'Vercel 환경변수 GBIS_SERVICE_KEY를 설정해 주세요.'
    });
  }

  const action = String(req.query.action || '');
  const spec = ENDPOINTS[action];
  if (!spec) return res.status(400).json({ ok: false, message: '지원하지 않는 action입니다.' });

  for (const name of spec.params) {
    if (!req.query[name]) return res.status(400).json({ ok: false, message: `${name} 값이 필요합니다.` });
  }

  const url = new URL(spec.url);
  url.searchParams.set('serviceKey', decodeKey(serviceKeyRaw));
  url.searchParams.set('format', 'json');
  for (const name of spec.params) url.searchParams.set(name, String(req.query[name]));

  try {
    const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`공공 API가 JSON이 아닌 응답을 반환했습니다. (${upstream.status})`);
    }

    const { header, value } = extractPayload(json, spec.dataKey);
    const resultCode = String(header?.resultCode ?? header?.headerCode ?? '0');
    const resultMessage = header?.resultMessage || header?.headerMsg || '정상 처리';

    if (!upstream.ok || !['0', '00', '0000'].includes(resultCode)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(upstream.ok ? 502 : upstream.status).json({
        ok: false,
        resultCode,
        message: resultMessage,
        details: json
      });
    }

    res.setHeader('Cache-Control', spec.cache ? `s-maxage=${spec.cache}, stale-while-revalidate=600` : 'no-store');
    return res.status(200).json({
      ok: true,
      queryTime: header?.queryTime || null,
      resultCode,
      message: resultMessage,
      ...(spec.single ? { item: value || null } : { items: asArray(value) })
    });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ ok: false, message: error?.message || '버스 API 호출에 실패했습니다.' });
  }
}
