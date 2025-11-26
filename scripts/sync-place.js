import { Client as Notion } from '@notionhq/client';
import OpenAI from 'openai';

// ───── ENV (양쪽 이름 지원 + SKIP_KAKAO 고려)
const NOTION_TOKEN = process.env.NOTION_TOKEN || process.env.NOTION_KEY || '';
const DB_ID = process.env.NOTION_DATABASE_ID || '';
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_API || '';
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_PROJECT = (process.env.OPENAI_PROJECT || '').trim();
const isProjectKey = OPENAI_KEY.startsWith('sk-proj-');
const openaiUnavailableReason = !OPENAI_KEY
  ? 'NO_KEY'
  : isProjectKey && !OPENAI_PROJECT
  ? 'MISSING_PROJECT'
  : null;
const canUseOpenAI = !openaiUnavailableReason;
const GOOGLE_KEY = (process.env.GOOGLE_API_KEY || '').trim();

const asBoolean = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const SKIP_KAKAO = asBoolean(process.env.SKIP_KAKAO);
const VERBOSE = asBoolean(process.env.VERBOSE);
const FORCE_SUMMARY = asBoolean(process.env.FORCE_SUMMARY);
const FORCE_GOOGLE = asBoolean(process.env.FORCE_GOOGLE);

const COMPANY = { latitude: 37.529036, longitude: 126.966855 };

if (!GOOGLE_KEY) {
  console.warn('⚠️ GOOGLE_API_KEY 가 비어있습니다. 구글 관련 필드는 건너뜁니다.');
} else if (VERBOSE) {
  console.log('[ENV] GOOGLE_KEY length =', GOOGLE_KEY.length);
}

if (!NOTION_TOKEN) {
  console.error('❌ Missing NOTION_TOKEN (or NOTION_KEY)');
  process.exit(1);
}
if (!DB_ID) {
  console.error('❌ Missing NOTION_DATABASE_ID');
  process.exit(1);
}
if (!SKIP_KAKAO && !KAKAO_KEY) {
  console.error('❌ Missing KAKAO_REST_API_KEY (or KAKAO_REST_API). 서버용 REST 키가 필요합니다.');
  process.exit(1);
}
if (isProjectKey && !OPENAI_PROJECT) {
  console.warn(
    '⚠️ Project key detected but OPENAI_PROJECT is missing. OpenAI summary generation will be skipped.',
  );
}

// ───── Utils
const toLatLng = (loc = {}) => ({
  latitude:
    'latitude' in loc
      ? loc.latitude
      : 'lat' in loc
      ? loc.lat
      : null,
  longitude:
    'longitude' in loc
      ? loc.longitude
      : 'lng' in loc
      ? loc.lng
      : null,
});

const notion = new Notion({ auth: NOTION_TOKEN });
const openai = canUseOpenAI
  ? new OpenAI(
      OPENAI_PROJECT ? { apiKey: OPENAI_KEY, project: OPENAI_PROJECT } : { apiKey: OPENAI_KEY },
    )
  : null;

const looksLikeKey = typeof OPENAI_KEY === 'string' && /^sk-/.test(OPENAI_KEY);
if (!looksLikeKey) {
  console.warn('⚠️ OPENAI_API_KEY looks unusual (no sk- prefix). Will try anyway.');
}

function extractGoogleAttribution(photo) {
  const a = photo?.authorAttributions?.[0];
  if (!a) return null;
  const name = a.displayName || 'Google Maps';
  const url = a.url || 'https://maps.google.com';
  return `${name} (${url})`;
}

// priceRange → min/max/cap 추출
function extractPriceFromRange(priceRange) {
  if (!priceRange) return null;

  const startUnits = Number(priceRange.startPrice?.units ?? NaN);
  const endUnits = Number(priceRange.endPrice?.units ?? NaN);

  const prices = [startUnits, endUnits].filter((v) => Number.isFinite(v));
  if (!prices.length) return null;

  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return {
    min,
    max,
    cap: max,
  };
}

// ───── Google Places (v1)
async function googleSearchText({
  query,
  locationBias = COMPANY,
  radiusMeters = 10000,
  language = 'ko',
}) {
  if (!GOOGLE_KEY) return null;

  const url = 'https://places.googleapis.com/v1/places:searchText';
  const body = {
    textQuery: query,
    languageCode: language,
    locationBias: {
      circle: { center: toLatLng(locationBias), radius: radiusMeters },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.rating',
        'places.userRatingCount',
        'places.priceLevel', // 참고용
        'places.priceRange', // 🔹 실제 금액 범위
        'places.primaryType',
        'places.types',
        'places.nationalPhoneNumber',
        'places.websiteUri',
        'places.photos',
      ].join(','),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Google searchText ${res.status} :: ${t || 'no body'}`);
  }
  const j = await res.json();
  return j.places || [];
}

async function googleShareUrl(placeId) {
  if (!placeId) return null;
  // places v1에서는 direct url을 안 주므로 place_id 딥링크 사용
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}

function scoreGoogleCandidate(p, name, location) {
  // 아주 단순한 랭킹: 이름 유사 + 평점 + 주소에 지역 포함
  let s = 0;
  const nm = (name || '').toLowerCase();
  const dn = (p.displayName?.text || '').toLowerCase();
  if (dn.includes(nm)) s += 3;
  if (p.rating) s += Math.min(2, p.rating / 2);
  const addr = p.formattedAddress || '';
  if (location && addr.includes(location)) s += 1.5;
  return s;
}

// ───── Kakao
async function kakaoSearch(keyword) {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(
    keyword,
  )}&size=5`;
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
  });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Kakao API ${res.status} :: ${body || 'no body'}`);
  }
  const j = await res.json();
  return j.documents || [];
}

function scoreKakao(doc, name, areaText) {
  let s = 0;
  const n = (name || '').toLowerCase();
  if (doc.place_name?.toLowerCase().includes(n)) s += 3;
  const addr = `${doc.road_address_name || ''} ${doc.address_name || ''}`;
  if (areaText && addr.includes(areaText)) s += 2;
  if (doc.phone) s += 0.5;
  return s;
}

// ✅ 세부 분류 매핑
function mapCuisineFromCategoryName(category_name = '', group_code = '') {
  if (group_code === 'CE7') return '카페';
  if (group_code && group_code !== 'FD6') return '기타';

  const c = category_name;
  if (c.includes('중식')) return '중식';
  if (c.includes('일식')) return '일식';
  if (c.includes('양식')) return '양식';
  if (c.includes('한식')) return '한식';
  if (c.includes('분식')) return '분식';
  if (c.includes('치킨')) return '치킨';
  if (c.includes('패스트푸드')) return '패스트푸드';
  if (c.includes('고기') || c.includes('육류')) return '고기/구이';
  if (c.includes('술집') || c.includes('포장마차') || c.includes('바')) return '주점';
  return '기타';
}

// ───── Notion helpers
function readProp(page, key) {
  const p = page.properties[key];
  if (!p) return undefined;
  switch (p.type) {
    case 'title':
      return p.title?.map((t) => t.plain_text).join('') || '';
    case 'rich_text':
      return p.rich_text?.map((t) => t.plain_text).join('') || '';
    case 'select':
      return p.select?.name || '';
    case 'multi_select':
      return p.multi_select?.map((x) => x.name) || [];
    case 'url':
      return p.url || null;
    case 'number':
      return p.number ?? null;
    default:
      return undefined;
  }
}

async function updateNotion(pageId, {
  Kakao,
  Summary,
  Status,
  Score,
  GoogleMap,
  GooglePlaceID,
  Image,
  Copyright,
  PriceCap,
}) {
  const props = {
    Kakao: Kakao ? { url: Kakao } : undefined,
    Summary: Summary
      ? { rich_text: [{ text: { content: Summary } }] }
      : undefined,
    Status: Status ? { select: { name: Status } } : undefined,
    GoogleMap: GoogleMap ? { url: GoogleMap } : undefined,
    Score:
      typeof Score === 'number'
        ? { number: Score }
        : undefined,
    GooglePlaceID: GooglePlaceID
      ? { rich_text: [{ text: { content: GooglePlaceID } }] }
      : undefined,
    Image: Image
      ? { rich_text: [{ text: { content: Image } }] }
      : undefined,
    Copyright: Copyright
      ? { rich_text: [{ text: { content: Copyright } }] }
      : undefined,
    PriceCap:
      typeof PriceCap === 'number'
        ? { number: PriceCap }
        : undefined,
  };

  Object.keys(props).forEach((k) => {
    if (props[k] === undefined) delete props[k];
  });

  if (Object.keys(props).length) {
    await notion.pages.update({ page_id: pageId, properties: props });
  }
}

// ───── OpenAI summary
function buildPlaceTagline({ name, location, status }) {
  const loc = (location && String(location).trim()) || '용산구';
  const nm = (name && String(name).trim()) || '이름미정';
  const st = (status && String(status).trim()) || '';
  const mid = st ? `${st}맛집` : '맛집';
  return `${loc}의 숨겨진 ${mid} ${nm}`;
}

function isWeakSummary(text) {
  if (!text) return true;
  const t = text.trim();
  const bad =
    /(정보\s*(없음|부족)|데이터\s*없음|찾을\s*수\s*없음|no\s*info|not\s*enough)/i;
  const tooShort = t.replace(/\s/g, '').length < 4;
  return bad.test(t) || tooShort;
}

async function createSummary({ name, location, mood, service, status: cuisineStatus }) {
  if (!openai) {
    if (VERBOSE) {
      const reason =
        openaiUnavailableReason === 'MISSING_PROJECT'
          ? 'OPENAI_PROJECT 없음'
          : 'OPENAI_KEY 없음';
      console.log(`[OPENAI] ${reason} → tagline fallback 사용`);
    }
    return buildPlaceTagline({ name, location, status: cuisineStatus });
  }

  try {
    const prompt = [
      '다음 정보를 바탕으로 1문장 요약을 만들어 JSON으로만 반환하세요.',
      '규칙:',
      '- 과장 금지, 담백하고 짧게(30자~50자)',
      '- 이모지/특수문자/해시태그 금지',
      '- **반드시 명사구로 작성** (종결어미 ~요/~야/~다/~니다 금지)',
      '- 한국어 문장',
      '- 예시: "용산면가 찐맛집", "담백한 국물 우동", "한적한 브런치 카페"',
      '- 반드시 아래 형식의 순수 JSON만 반환: {"summary": "<문장>"}',
      '',
      `이름: ${name}`,
      `지역: ${location || '-'}`,
      `분위기: ${
        Array.isArray(mood) ? mood.join(', ') : mood || '-'
      }`,
      `서비스: ${
        Array.isArray(service) ? service.join(', ') : service || '-'
      }`,
    ].join('\n');

    const resp = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: prompt,
    });

    let raw = '';
    raw = resp.output_text?.trim?.() || raw;

    if (!raw && Array.isArray(resp.output)) {
      const c = resp.output[0]?.content?.[0];
      if (c?.type === 'output_text' && c?.text) raw = c.text.trim();
      if (c?.type === 'json' && c?.json) raw = JSON.stringify(c.json);
    }

    if (VERBOSE) {
      console.log('[OPENAI][RAW]', raw);
      if (!raw) console.warn('[OPENAI] empty output_text');
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { summary: raw };
    }

    const summary =
      typeof data.summary === 'string' ? data.summary.trim() : '';
    const sanitized = summary
      .replace(/[#*_\[\]`~<>]/g, '')
      .slice(0, 60)
      .trim();

    if (!sanitized || isWeakSummary(sanitized)) {
      if (VERBOSE) console.log('[OPENAI][WEAK] → fallback');
      return buildPlaceTagline({ name, location, status: cuisineStatus });
    }
    return sanitized;
  } catch (e) {
    if (VERBOSE) {
      console.warn('[OPENAI][ERROR] → fallback:', e?.status || '', e?.message || e);
    }
    return buildPlaceTagline({ name, location, status: cuisineStatus });
  }
}

// ───── 대상 조회
async function getTargets() {
  const r = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      and: [
        { property: 'Name', title: { is_not_empty: true } },
        {
          or: [
            { property: 'Kakao', url: { is_empty: true } },
            { property: 'Summary', rich_text: { is_empty: true } },
            { property: 'Status', select: { is_empty: true } },
            { property: 'Score', number: { is_empty: true } },
            { property: 'GoogleMap', url: { is_empty: true } },
            { property: 'GooglePlaceID', rich_text: { is_empty: true } },
            { property: 'Image', rich_text: { is_empty: true } },
            { property: 'Copyright', rich_text: { is_empty: true } },
            { property: 'PriceCap', number: { is_empty: true } },
          ],
        },
      ],
    },
    page_size: 50,
  });
  return r.results;
}

// ───── MAIN
(async () => {
  const pages = await getTargets();
  if (!pages.length) {
    console.log('업데이트 대상 없음');
    return;
  }

  for (const p of pages) {
    const id = p.id;
    const name = readProp(p, 'Name');
    const location = readProp(p, 'Location');
    const mood = readProp(p, 'Mood');
    const service = readProp(p, 'Service');

    const hasKakao = readProp(p, 'Kakao');
    const hasSummary = readProp(p, 'Summary');
    const hasStatus = readProp(p, 'Status');
    const hasScore = readProp(p, 'Score');
    const hasGoogleMap = readProp(p, 'GoogleMap');
    const hasGooglePlaceID = readProp(p, 'GooglePlaceID');
    const hasImage = readProp(p, 'Image');
    const hasCopyright = readProp(p, 'Copyright');
    const hasPriceCap = readProp(p, 'PriceCap');

    if (!name) continue;

    try {
      let Kakao = hasKakao;
      let Status = hasStatus;
      let Score = hasScore;
      let GoogleMap = hasGoogleMap;
      let GooglePlaceID = hasGooglePlaceID;
      let Image = hasImage;
      let Copyright = hasCopyright;
      let PriceCap = hasPriceCap;

      // Kakao + Status
      if ((!Kakao && !SKIP_KAKAO) || !Status) {
        const q = [name, location].filter(Boolean).join(' ');
        const docs = SKIP_KAKAO ? [] : await kakaoSearch(q);

        if (docs.length) {
          const ranked = docs
            .map((d) => ({ ...d, _s: scoreKakao(d, name, location) }))
            .sort((a, b) => b._s - a._s);
          const best = ranked[0];

          if (!Kakao) Kakao = best.place_url || null;
          if (!Status) {
            Status =
              mapCuisineFromCategoryName(
                best.category_name,
                best.category_group_code,
              ) || '기타';
          }
        } else if (!Status) {
          Status = '기타';
        }
      }
      if (!Status) Status = '기타';

      // Summary
      let Summary = hasSummary;
      if (!Summary || FORCE_SUMMARY) {
        const out = await createSummary({
          name,
          location,
          mood,
          service,
          status: Status,
        });
        Summary = out;

        if (VERBOSE) {
          const tag =
            out ===
            buildPlaceTagline({ name, location, status: Status })
              ? 'fallback'
              : 'openai';
          console.log(`[SUMMARY][${tag}]`, name, '→', out);
        }
      }

      // Google (Score / GoogleMap / GooglePlaceID / Image / PriceCap)
      if (
        GOOGLE_KEY &&
        (FORCE_GOOGLE ||
          !Score ||
          !GoogleMap ||
          !GooglePlaceID ||
          !PriceCap)
      ) {
        const query = [name, location].filter(Boolean).join(' ');

        if (VERBOSE) {
          console.log('\n[GOOGLE] 검색 시작:', name);
          console.log('  query:', query);
        }

        const cands = await googleSearchText({
          query,
          locationBias: COMPANY,
          radiusMeters: 10000,
          language: 'ko',
        });

        if (cands && cands.length) {
          const ranked = cands
            .map((pl) => ({ ...pl, _s: scoreGoogleCandidate(pl, name, location) }))
            .sort((a, b) => b._s - a._s);

          const best = ranked[0];

          if (VERBOSE) {
            console.log('[GOOGLE] raw price info', name);
            console.dir(
              {
                priceLevel: best.priceLevel,
                priceRange: best.priceRange,
              },
              { depth: 5 },
            );
          }

          // place ID
          GooglePlaceID = best.id || GooglePlaceID || null;

          // 평점
          if (typeof best.rating === 'number') {
            Score = Number(best.rating);
          }

          // priceRange → PriceCap
          const priceInfo = extractPriceFromRange(best.priceRange);
          if (priceInfo && (PriceCap == null || FORCE_GOOGLE)) {
            PriceCap = priceInfo.cap;
            if (VERBOSE) {
              console.log('  → priceRange parsed:', priceInfo);
            }
          }

          // 사진
          if (best.photos?.length) {
            const photoName = best.photos[0].name;
            Image = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&key=${GOOGLE_KEY}`;
            const attr = extractGoogleAttribution(best.photos[0]);
            if (attr) Copyright = attr;
          }

          // 공유 URL
          if (!GoogleMap && GooglePlaceID) {
            GoogleMap = await googleShareUrl(GooglePlaceID);
          }

          if (VERBOSE) {
            console.log('[GOOGLE] 최종 매핑값:', {
              GooglePlaceID,
              Score,
              PriceCap,
              GoogleMap,
              hasImage: !!Image,
            });
          }
        } else if (VERBOSE) {
          console.log('[GOOGLE] 후보 없음:', name);
        }
      }

      await updateNotion(id, {
        Kakao: SKIP_KAKAO ? undefined : Kakao,
        Summary,
        Status,
        Score,
        GoogleMap,
        GooglePlaceID,
        Image,
        Copyright,
        PriceCap,
      });

      console.log(
        `✅ ${name} → Kakao:${SKIP_KAKAO ? 'skip' : !!Kakao}, Status:${
          Status || '-'
        }, Score:${typeof Score === 'number' ? Score : '-'}, Summary:${!!Summary}`,
      );
    } catch (e) {
      console.error(`🚨 ${name} - ${e.message}`);
    }
  }
})();
