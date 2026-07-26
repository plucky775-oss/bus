const ENDPOINTS = {
  stationSearch: {
    url: 'https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationListv2',
    params: ['keyword'],
    dataKey: 'busStationList',
    cache: 300,
    apiName: '경기도_정류소 조회',
    keyEnv: 'GBIS_STATION_SERVICE_KEY'
  },
  stationAround: {
    url: 'https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationAroundListv2',
    params: ['x', 'y'],
    dataKey: 'busStationList',
    cache: 30,
    apiName: '경기도_정류소 조회',
    keyEnv: 'GBIS_STATION_SERVICE_KEY'
  },
  stationRoutes: {
    url: 'https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationViaRouteListv2',
    params: ['stationId'],
    dataKey: 'busRouteList',
    cache: 300,
    apiName: '경기도_정류소 조회',
    keyEnv: 'GBIS_STATION_SERVICE_KEY'
  },
  routeSearch: {
    url: 'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteListv2',
    params: ['keyword'],
    dataKey: 'busRouteList',
    cache: 300,
    apiName: '경기도_버스노선 조회',
    keyEnv: 'GBIS_ROUTE_SERVICE_KEY'
  },
  routeStations: {
    url: 'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteStationListv2',
    params: ['routeId'],
    dataKey: 'busRouteStationList',
    cache: 300,
    apiName: '경기도_버스노선 조회',
    keyEnv: 'GBIS_ROUTE_SERVICE_KEY'
  },
  routeLines: {
    url: 'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteLineListv2',
    params: ['routeId'],
    dataKey: 'busRouteLineList',
    cache: 300,
    apiName: '경기도_버스노선 조회',
    keyEnv: 'GBIS_ROUTE_SERVICE_KEY'
  },
  busLocations: {
    url: 'https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2',
    params: ['routeId'],
    dataKey: 'busLocationList',
    cache: 0,
    apiName: '경기도_버스위치정보 조회',
    keyEnv: 'GBIS_LOCATION_SERVICE_KEY'
  },
  arrival: {
    url: 'https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalItemv2',
    params: ['stationId', 'routeId', 'staOrder'],
    dataKey: 'busArrivalItem',
    cache: 0,
    single: true,
    apiName: '경기도_버스도착정보 조회',
    keyEnv: 'GBIS_ARRIVAL_SERVICE_KEY'
  }
};

const SUCCESS_CODES = new Set(['0', '00', '0000']);
const NO_RESULT_CODES = new Set(['4', '04', '0004']);

function normalizeServiceKey(rawValue) {
  let value = String(rawValue || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\s+/g, '');

  // Vercel에 Encoding 키(%2B, %2F, %3D) 또는 Decoding 키를 넣어도
  // URLSearchParams가 최종적으로 딱 한 번 인코딩하도록 먼저 원문으로 정규화한다.
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

function getServiceKey(spec) {
  return normalizeServiceKey(process.env[spec.keyEnv] || process.env.GBIS_SERVICE_KEY || '');
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

function parseXmlResponse(text, spec) {
  const header = {
    queryTime: readXmlTag(text, 'queryTime'),
    resultCode: readXmlTag(text, 'resultCode') || readXmlTag(text, 'returnReasonCode'),
    resultMessage:
      readXmlTag(text, 'resultMessage') ||
      readXmlTag(text, 'returnAuthMsg') ||
      readXmlTag(text, 'errMsg')
  };

  const values = [];
  const itemPattern = new RegExp(`<${spec.dataKey}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${spec.dataKey}>`, 'gi');
  let match;
  while ((match = itemPattern.exec(text)) !== null) values.push(xmlBlockToObject(match[1]));

  return {
    format: 'xml',
    header,
    value: spec.single ? (values[0] || null) : values
  };
}

function extractJsonPayload(json, dataKey) {
  const response = json?.response || json;
  const commonHeader = response?.comMsgHeader || json?.comMsgHeader || json?.OpenAPI_ServiceResponse?.cmmMsgHeader || {};
  const header = response?.msgHeader || response?.header || json?.msgHeader || {};
  const body = response?.msgBody || response?.body || json?.msgBody || {};
  const value = body?.[dataKey] ?? response?.[dataKey] ?? json?.[dataKey] ?? null;

  return {
    format: 'json',
    header: {
      ...header,
      resultCode: header?.resultCode ?? header?.headerCode ?? commonHeader?.returnReasonCode,
      resultMessage:
        header?.resultMessage ||
        header?.headerMsg ||
        commonHeader?.returnAuthMsg ||
        commonHeader?.errMsg ||
        ''
    },
    value
  };
}

function parseUpstream(text, contentType, spec) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { format: 'empty', header: {}, value: null };

  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return extractJsonPayload(JSON.parse(trimmed), spec.dataKey);
    } catch {
      // 일부 공공데이터 오류 응답은 JSON Content-Type으로 XML/HTML을 돌려준다.
    }
  }

  if (contentType.includes('xml') || trimmed.startsWith('<')) return parseXmlResponse(trimmed, spec);
  return { format: 'text', header: {}, value: null };
}

function compactText(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function classifyFailure({ upstreamStatus, resultCode, resultMessage, rawText, spec }) {
  const combined = `${resultMessage || ''} ${compactText(rawText)}`.toUpperCase();

  if (combined.includes('LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS') || combined.includes('트래픽')) {
    return {
      status: 429,
      code: 'API_QUOTA_EXCEEDED',
      message: `${spec.apiName} 개발계정 호출 한도를 초과했습니다. 공공데이터포털에서 트래픽을 확인해 주세요.`
    };
  }

  if (
    combined.includes('SERVICE KEY IS NOT REGISTERED') ||
    combined.includes('SERVICE_KEY_IS_NOT_REGISTERED') ||
    combined.includes('INVALID ACCESS KEY') ||
    combined.includes('등록되지 않은 인증키')
  ) {
    return {
      status: 403,
      code: 'INVALID_SERVICE_KEY',
      message: '공공데이터포털 인증키가 올바르지 않습니다. 일반 인증키(Encoding 또는 Decoding)를 다시 복사해 주세요.'
    };
  }

  if (
    upstreamStatus === 401 ||
    upstreamStatus === 403 ||
    combined.includes('SERVICE ACCESS DENIED') ||
    combined.includes('SERVICE_ACCESS_DENIED') ||
    combined.includes('ACCESS DENIED')
  ) {
    return {
      status: 403,
      code: 'API_ACCESS_DENIED',
      message: `공공데이터포털에서 “${spec.apiName}” 활용신청이 필요합니다. 버스앱은 노선·정류소·위치·도착정보 4개 API 승인이 모두 필요합니다.`
    };
  }

  return {
    status: upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502,
    code: 'UPSTREAM_API_ERROR',
    message: resultMessage || `경기도 버스 API 호출에 실패했습니다. (${upstreamStatus || resultCode || '응답 오류'})`
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'GET 요청만 지원합니다.' });
  }

  const action = String(req.query.action || '');
  const spec = ENDPOINTS[action];
  if (!spec) return res.status(400).json({ ok: false, code: 'INVALID_ACTION', message: '지원하지 않는 action입니다.' });

  const serviceKey = getServiceKey(spec);
  if (!serviceKey) {
    return res.status(503).json({
      ok: false,
      code: 'MISSING_SERVICE_KEY',
      message: `Vercel 환경변수 ${spec.keyEnv} 또는 GBIS_SERVICE_KEY를 설정해 주세요.`
    });
  }

  for (const name of spec.params) {
    if (req.query[name] === undefined || req.query[name] === null || String(req.query[name]).trim() === '') {
      return res.status(400).json({ ok: false, code: 'MISSING_PARAMETER', message: `${name} 값이 필요합니다.` });
    }
  }

  const url = new URL(spec.url);
  url.searchParams.set('format', 'json');
  url.searchParams.set('serviceKey', serviceKey);
  for (const name of spec.params) url.searchParams.set(name, String(req.query[name]).trim());

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json, application/xml;q=0.9, text/plain;q=0.5',
        'User-Agent': 'hogye-bus-alert/1.1'
      },
      signal: AbortSignal.timeout(12000)
    });
    const text = await upstream.text();
    const parsed = parseUpstream(text, upstream.headers.get('content-type') || '', spec);
    const resultCode = String(parsed.header?.resultCode ?? (upstream.ok ? '0' : upstream.status));
    const resultMessage = parsed.header?.resultMessage || (upstream.ok ? '정상 처리' : '공공 API 요청 실패');

    // GBIS 결과코드 4는 오류가 아니라 검색 결과 없음이다.
    if (upstream.ok && NO_RESULT_CODES.has(resultCode)) {
      res.setHeader('Cache-Control', spec.cache ? `s-maxage=${spec.cache}, stale-while-revalidate=600` : 'no-store');
      return res.status(200).json({
        ok: true,
        queryTime: parsed.header?.queryTime || null,
        resultCode,
        message: resultMessage,
        ...(spec.single ? { item: null } : { items: [] })
      });
    }

    if (!upstream.ok || !SUCCESS_CODES.has(resultCode)) {
      const failure = classifyFailure({
        upstreamStatus: upstream.status,
        resultCode,
        resultMessage,
        rawText: text,
        spec
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(failure.status).json({
        ok: false,
        code: failure.code,
        action,
        requiredApi: spec.apiName,
        resultCode,
        message: failure.message,
        upstreamStatus: upstream.status
      });
    }

    res.setHeader('Cache-Control', spec.cache ? `s-maxage=${spec.cache}, stale-while-revalidate=600` : 'no-store');
    return res.status(200).json({
      ok: true,
      queryTime: parsed.header?.queryTime || null,
      resultCode,
      message: resultMessage,
      ...(spec.single ? { item: parsed.value || null } : { items: asArray(parsed.value) })
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({
      ok: false,
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAILED',
      action,
      requiredApi: spec.apiName,
      message: timedOut ? '경기도 버스 API 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' : (error?.message || '버스 API 호출에 실패했습니다.')
    });
  }
}
