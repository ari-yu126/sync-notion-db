import { Client as Notion } from '@notionhq/client';
import OpenAI from 'openai';

// ───── ENV
['NOTION_KEY','NOTION_DATABASE_ID','KAKAO_REST_API'].forEach(k=>{
  if (!process.env[k]) {
    console.error(`❌ Missing ${k} (use .env.local locally / GitHub Secrets in Actions)`);
    process.exit(1);
  }
});
const notion = new Notion({ auth: process.env.NOTION_KEY });
const DB_ID  = process.env.NOTION_DATABASE_ID;
const KAKAO  = process.env.KAKAO_REST_API;

// ───── Kakao
async function kakaoSearch(keyword) {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(keyword)}&size=5`;
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO}` } });
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
  // 조금 더 느슨하게 매칭
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
    // 🔥 대/소문자 Notion 속성명 맞추기
    Kakao:   Kakao   ? { url: Kakao } : undefined,
    Summary: Summary ? { rich_text: [{ text: { content: Summary } }] } : undefined,
    Status:  Status  ? { select: { name: Status } } : undefined,
  };
  Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);
  if (Object.keys(props).length) {
    await notion.pages.update({ page_id: pageId, properties: props });
  }
}

// ───── OpenAI summary (JS 버전)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

function safeParseJSON(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

async function createSummary({ name, location, mood, service }) {
  // 키 없으면 즉시 기본 문구
  if (!openai.apiKey) return `‘${name}’ 담백한 한 끼에 적합.`;

  const schema = {
    type: "object",
    properties: { summary: { type: "string", maxLength: 180 } },
    required: ["summary"]
  };

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input:
        `다음 정보를 바탕으로 1문장 감상. 과장금지, 담백(10~20자), 이모지/특수문자/해시태그 금지:
- 이름:${name}
- 지역:${location || "-"}
- 분위기:${Array.isArray(mood)?mood.join(', '):mood||"-"}
- 서비스:${Array.isArray(service)?service.join(', '):service||"-"}`,
      // ✅ response_format → text.format 로 변경
      text: {
        format: {
          type: "json_schema",
          json_schema: { name: "Summary", schema, strict: true }
        }
      }
    });

    // ✅ Responses API 파싱 (여러 경로 대비)
    const raw = resp.output_text ?? resp.output?.[0]?.content?.[0]?.text ?? "";

    const data = safeParseJSON(raw);
    const summary = data && typeof data.summary === 'string' ? data.summary.trim() : '';

    return summary || `‘${name}’ 담백한 한 끼에 적합.`;
  } catch (e) {
    // 실패 시 기본 문구로 폴백
    return `‘${name}’ 담백한 한 끼에 적합.`;
  }
}

// ───── 대상 조회: Name 있고, Kakao/Summary/Status 중 비어있는 행
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
    const hasKakao  = readProp(p,'Kakao');   // 🔥 대문자
    const hasSummary= readProp(p,'Summary'); // 🔥 대문자
    const hasStatus = readProp(p,'Status');  // 🔥 대문자

    if (!name) continue;

    try {
      // 1) Kakao 검색 → URL + 세부 분류(status)
      let Kakao = hasKakao;
      let Status = hasStatus;

      if (!Kakao || !Status) {
        const q = [name, location].filter(Boolean).join(' ');
        const docs = await kakaoSearch(q);
        if (docs.length) {
          const ranked = docs.map(d => ({ ...d, _s: scoreKakao(d, name, location) }))
                             .sort((a,b)=> b._s - a._s);
          const best = ranked[0];

          if (!Kakao)  Kakao = best.place_url || null;
          if (!Status) Status = mapCuisineFromCategoryName(best.category_name, best.category_group_code) || '기타';
        }
      }

      // 2) summary (비어 있으면 생성)
      let Summary = hasSummary;
      if (!Summary) {
        Summary = await createSummary({ name, location, mood, service });
      }

      await updateNotion(id, { Kakao, Summary, Status });
      console.log(`✅ ${name} → Kakao:${!!Kakao}, Status:${Status || '-'}, Summary:${!!Summary}`);
    } catch (e) {
      console.error(`🚨 ${name} - ${e.message}`);
    }
  }
})();
