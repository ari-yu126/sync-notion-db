// scripts/sync-place.js
import { Client as Notion } from '@notionhq/client';
import OpenAI from 'openai';

// ───── ENV (양쪽 이름 지원 + SKIP_KAKAO 고려)
const NOTION_TOKEN = process.env.NOTION_TOKEN || process.env.NOTION_KEY || '';
const DB_ID        = process.env.NOTION_DATABASE_ID || '';
const KAKAO_KEY    = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_API || '';
const OPENAI_KEY   = process.env.OPENAI_API_KEY || '';
const SKIP_KAKAO   = process.env.SKIP_KAKAO === 'true';
const VERBOSE      = process.env.VERBOSE === 'true';
const FORCE_SUMMARY= process.env.FORCE_SUMMARY === 'true';

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

const notion = new Notion({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ───── Kakao
async function kakaoSearch(keyword) {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(keyword)}&size=5`;
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
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
    case 'title': return p.title?.map(t=>t.plain_text).join('') || '';
    case 'rich_text': return p.rich_text?.map(t=>t.plain_text).join('') || '';
    case 'select': return p.select?.name || '';
    case 'multi_select': return p.multi_select?.map(x=>x.name) || [];
    case 'url': return p.url || null;
    default: return undefined;
  }
}

async function updateNotion(pageId, { Kakao, Summary, Status }) {
  const props = {
    Kakao:   Kakao   ? { url: Kakao } : undefined,
    Summary: Summary ? { rich_text: [{ text: { content: Summary } }] } : undefined,
    Status:  Status  ? { select: { name: Status } } : undefined,
  };
  Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);
  if (Object.keys(props).length) {
    await notion.pages.update({ page_id: pageId, properties: props });
  }
}

// ───── OpenAI summary
function safeParseJSON(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function buildPlaceTagline({ name, location, status }) {
  const loc = (location && String(location).trim()) || '용산구';
  const nm  = (name && String(name).trim()) || '이름미정';
  const st  = (status && String(status).trim()) || '';
  const mid = st ? `${st}맛집` : '맛집';
  return `${loc}의 숨겨진 ${mid} ${nm}`;
}

function isWeakSummary(text) {
  if (!text) return true;
  const t = text.trim();
  // “정보 없음/부족/찾을 수 없음/데이터 없음” 류 방어
  const bad = /(정보\s*(없음|부족)|데이터\s*없음|찾을\s*수\s*없음|no\s*info|not\s*enough)/i;
  // 한글/영문 글자수 너무 짧은 경우(예: “좋아요”, “무난” 등)
  const tooShort = t.replace(/\s/g, '').length < 6;
  return bad.test(t) || tooShort;
}

async function createSummary({ name, location, mood, service, status: cuisineStatus }) {
  if (!OPENAI_KEY) {
    if (VERBOSE) console.warn('[OPENAI] no API key → fallback');
    return buildPlaceTagline({ name, location, status: cuisineStatus });
  }

  try {
    const prompt = [
      '다음 정보를 바탕으로 1문장 요약을 만들어 JSON으로만 반환하세요.',
      '규칙:',
      '- 과장 금지, 담백하고 짧게(10~15자)',
      '- 이모지/특수문자/해시태그 금지',
      '- 한국어 문장',
      '- 친근한 구어체 말투',
      '- 반드시 아래 형식의 순수 JSON만 반환: {"summary": "<문장>"}',
      '',
      `이름: ${name}`,
      `지역: ${location || '-'}`,
      `분위기: ${Array.isArray(mood) ? mood.join(', ') : (mood || '-')}`,
      `서비스: ${Array.isArray(service) ? service.join(', ') : (service || '-')}`,
    ].join('\n');

    const resp = await openai.responses.create({
      model: 'gpt-4o-mini-2024-07-18',
      input: prompt,
    });

    const raw = resp.output_text?.trim()
              ?? resp.output?.[0]?.content?.[0]?.text?.trim()
              ?? '';

    if (VERBOSE) {
      console.log('[OPENAI] output_text length =', raw.length);
      if (!raw) console.warn('[OPENAI] empty output_text');
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = JSON.parse(`{"summary": ${JSON.stringify(raw)}}`);
      if (VERBOSE) console.log('[OPENAI] wrapped plain text to JSON');
    }

    const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
    const sanitized = summary.replace(/[#*_\[\]`~<>]/g, '').slice(0, 60).trim();

    if (!sanitized || isWeakSummary(sanitized)) {
      return buildPlaceTagline({ name, location, status: cuisineStatus });
    }
    return sanitized;
  } catch (e) {
    if (VERBOSE) console.warn('[OPENAI] error → fallback:', e?.status || '', e?.message || e);
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
        { or: [
            { property: 'Kakao',   url: { is_empty: true } },
            { property: 'Summary', rich_text: { is_empty: true } },
            { property: 'Status',  select: { is_empty: true } }
          ]
        }
      ]
    },
    page_size: 50
  });
  return r.results;
}

// ───── MAIN
(async () => {
  const pages = await getTargets();
  if (!pages.length) { console.log('업데이트 대상 없음'); return; }

  for (const p of pages) {
    const id        = p.id;
    const name      = readProp(p,'Name');
    const location  = readProp(p,'Location');
    const mood      = readProp(p,'Mood');
    const service   = readProp(p,'Service');
    const hasKakao  = readProp(p,'Kakao');
    const hasSummary= readProp(p,'Summary');
    const hasStatus = readProp(p,'Status');

    if (!name) continue;

    try {
      let Kakao = hasKakao;
      let Status = hasStatus;

      if ((!Kakao && !SKIP_KAKAO) || !Status) {
        const q = [name, location].filter(Boolean).join(' ');
        const docs = SKIP_KAKAO ? [] : await kakaoSearch(q);
        if (docs.length) {
          const ranked = docs.map(d => ({ ...d, _s: scoreKakao(d, name, location) }))
                             .sort((a,b)=> b._s - a._s);
          const best = ranked[0];
          if (!Kakao)  Kakao = best.place_url || null;
          if (!Status) Status = mapCuisineFromCategoryName(best.category_name, best.category_group_code) || '기타';
        } else if (!Status) {
          Status = '기타';
        }
      }
      if (!Status) Status = '기타';

      let Summary = hasSummary;
      if (!Summary || FORCE_SUMMARY) {
        Summary = await createSummary({ name, location, mood, service, status: Status });
      }

      await updateNotion(id, { Kakao: SKIP_KAKAO ? undefined : Kakao, Summary, Status });
      console.log(`✅ ${name} → Kakao:${SKIP_KAKAO ? 'skip' : !!Kakao}, Status:${Status || '-'}, Summary:${!!Summary}`);
    } catch (e) {
      console.error(`🚨 ${name} - ${e.message}`);
    }
  }
})();
