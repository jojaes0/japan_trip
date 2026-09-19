// 구글맵 저장 리스트 → data/places.js 동기화
//   node scripts/sync.mjs
// 분류 우선순위: 구글맵 코멘트의 #해시태그/@지역  >  data/overrides.json  >  자동 추론
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const readJSON = async (p, fallback) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fallback; } };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const TYPE_TAGS = {
  food: ['음식점', '맛집', '식당'], cafe: ['카페', '디저트'], shop: ['쇼핑'],
  stay: ['숙소', '호텔', '료칸'], sight: ['관광지', '관광'], tour: ['투어'],
};
// 해시태그가 없을 때 이름·코멘트로 종류 추론 (위에서부터 먼저 맞는 것)
const TYPE_HINTS = [
  ['stay', /호텔|hotel|료칸|旅館|숙소|게스트하우스|hostel|호스텔|도미 ?인|\binn\b| 인$/i],
  ['shop', /쇼핑|굿즈|피규어|books|서점|스토어|드럭|돈키|화장|백화점|야마야|기념품|마트/i],
  ['cafe', /카페|cafe|café|coffee|커피|디저트|아이스크림|bread|베이커리|빙수|파르페/i],
  ['sight', /신사|神社|寺|사원|공원|전망|박물관|미술관|타워|정원|城/i],
];
const TAG_HINTS = [
  ['스시', /스시|초밥|鮨|寿司|sushi/i], ['라멘', /라멘|ramen|ラーメン/i], ['야키토리', /야키토리|焼鳥|yakitori/i],
  ['이자카야', /이자카야|居酒屋/], ['로바다야키', /로바다야[끼키]|炉ばた/], ['우동', /우동|うどん/],
  ['오코노미야키', /오코노미야[끼키]/], ['야키니쿠', /야키니쿠|焼肉/], ['장어덮밥', /장어/], ['모츠나베', /모츠나베/],
  ['카이세키', /카이세키/], ['사시미', /사시미/], ['교자', /교자|餃子/], ['돈카츠', /돈[카까]츠/], ['온천', /온천|온센|hot spring/i],
  ['호텔', /호텔|hotel/i], ['료칸', /료칸|旅館/],
];
const CITIES = [
  ['오사카', /osaka|大阪/i], ['교토', /kyoto|京都/i], ['고베', /kobe|神戸/i], ['나라', /\bnara\b|奈良/i], ['도쿄', /tokyo|東京/i],
  ['요코하마', /yokohama|横浜/i], ['후쿠오카', /fukuoka|福岡/i], ['삿포로', /sapporo|札幌/i], ['나고야', /nagoya|名古屋/i],
  ['오키나와', /okinawa|沖縄/i], ['히로시마', /hiroshima|広島/i],
];
const AREA_RADIUS = 700, CITY_RADIUS = 30000; // m

const meters = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
};

async function fetchList(url) {
  let id = (url.match(/!2s([\w-]{20,})/) || url.match(/placelists\/list\/([\w-]+)/) || [])[1];
  if (!id) {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    id = ((res.url + (await res.text())).match(/!2s([\w-]{20,})/) || [])[1];
  }
  if (!id) throw new Error(`리스트 ID를 찾지 못함: ${url}`);
  const api = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=ko&gl=kr&pb=!1m4!1s${id}!2e1!3m1!1e1!2e2!3e2!4i500!16b1`;
  const text = await (await fetch(api, { headers: { 'user-agent': UA } })).text();
  const rows = JSON.parse(text.replace(/^\)\]\}'\s*/, ''))[0][8] || [];
  return rows.map((it) => {
    const p = it[1];
    const cid = BigInt.asUintN(64, BigInt(p[6][1]));
    return { id: cid.toString(36), name: it[2], note: it[3] || '', address: p[4] || '', lat: +p[5][2].toFixed(6), lng: +p[5][3].toFixed(6), map: `https://www.google.com/maps?cid=${cid}` };
  });
}

// 코멘트에서 #태그 / @지역 을 떼어내고 나머지를 팁으로
function parseNote(note) {
  const tags = [], out = { tip: '' };
  out.tip = note.replace(/(^|\s)([#@])([^\s#@]+)/g, (_, sp, mark, word) => {
    if (mark === '@') out.area = word.replace(/_/g, ' ');
    else {
      const type = Object.keys(TYPE_TAGS).find((t) => TYPE_TAGS[t].includes(word));
      if (type) out.type = type; else tags.push(word.replace(/_/g, ' '));
    }
    return sp;
  }).replace(/[ \t]+\n/g, '\n').trim();
  if (tags.length) out.tags = tags;
  return out;
}

const lists = await readJSON('data/lists.json', []);
const overrides = await readJSON('data/overrides.json', {});
const manual = await readJSON('data/manual.json', []);

let prevIds = new Set();
try {
  const ctx = { window: {} };
  vm.runInNewContext(await readFile(new URL('data/places.js', ROOT), 'utf8'), ctx);
  prevIds = new Set(ctx.window.PLACES.map((p) => p.id));
} catch {}

const raw = new Map();
for (const list of lists) {
  const rows = await fetchList(list.url);
  console.log(`${list.url} → ${rows.length}곳`);
  for (const r of rows) if (!raw.has(r.id)) raw.set(r.id, { ...r, defaultType: list.defaultType });
}
// 구글 쪽 응답이 이상하면 기존 데이터를 지키기 위해 중단
if (lists.length && raw.size === 0) throw new Error('가져온 장소가 0곳 — 기존 데이터를 유지하고 중단합니다.');

// 지역 추론의 기준점: 분류가 확정된 장소들 (overrides.json + 코멘트에 @지역 을 단 장소)
const anchors = [...raw.values()].filter((r) => overrides[r.id]?.area).map((r) => ({ ...r, ...overrides[r.id] }));
const nearest = (r, max) => anchors.map((a) => [meters(r, a), a]).filter(([d]) => d <= max).sort((x, y) => x[0] - y[0])[0]?.[1];

// "@난바" 처럼 일부만 적어도 기존 지역 "난바·도톤보리" 로 맞춰 줌 (같은 도시 우선, 없으면 새 지역으로)
const squash = (s) => s.replace(/[·\s()]/g, '');
const matchArea = (word, city) => {
  const known = anchors.filter((a) => squash(a.area).includes(squash(word)));
  return (known.find((a) => a.area === word) || known.find((a) => a.city === city) || known[0])?.area || word;
};

const cityOf = (r) => CITIES.find(([, re]) => re.test(r.address))?.[0] || nearest(r, CITY_RADIUS)?.city;
for (const r of raw.values()) {
  const word = parseNote(r.note).area;
  if (!word || overrides[r.id]?.area) continue;
  const city = overrides[r.id]?.city || cityOf(r);
  anchors.push({ ...r, city, area: matchArea(word, city) });
}

const places = [], review = [];
for (const r of raw.values()) {
  const o = overrides[r.id] || {}, n = parseNote(r.note);
  if (o.hide) continue;
  const text = `${r.name} ${r.note}`, guessed = [];
  const guess = (field, value) => { guessed.push(field); return value; };

  const type = n.type || o.type || guess('종류', TYPE_HINTS.find(([, re]) => re.test(text))?.[0] || r.defaultType || 'etc');
  const city = o.city || cityOf(r) || guess('도시', '기타');
  const area = (n.area && matchArea(n.area, city)) || o.area || guess('지역', nearest(r, AREA_RADIUS)?.area || '기타');
  const tags = n.tags || o.tags || guess('태그', TAG_HINTS.filter(([, re]) => re.test(text)).map(([t]) => t));

  places.push({ id: r.id, name: o.name || r.name, city, area, type, tags, tip: o.tip ?? n.tip, address: r.address, lat: r.lat, lng: r.lng, map: r.map });
  if (guessed.length && !prevIds.has(r.id)) review.push({ id: r.id, name: r.name, city, area, type, tags, guessed });
}
places.push(...manual);

const head = `/*
  자동 생성 파일 — 직접 고치지 마세요. (node scripts/sync.mjs)
  · 장소 추가/삭제/코멘트 : 구글맵 리스트에서
  · 분류 고치기           : 구글맵 코멘트에 #스시 #야식 @우메다  또는  data/overrides.json
  · 구글맵에 없는 항목(투어 등) : data/manual.json
*/
`;
await writeFile(new URL('data/places.js', ROOT), `${head}window.PLACES = ${JSON.stringify(places, null, 2)};\n`);
console.log(`총 ${places.length}곳 저장, 새로 자동 분류된 장소 ${review.length}곳`);

if (review.length) {
  const md = [
    '새로 추가된 장소를 자동으로 분류했습니다. 맞으면 이 이슈를 닫으면 되고, 틀린 곳만 고치면 됩니다.', '',
    '| 장소 | 도시 › 지역 | 종류 | 태그 | 추론한 항목 |', '|---|---|---|---|---|',
    ...review.map((r) => `| ${r.name} | ${r.city} › ${r.area} | ${r.type} | ${r.tags.join(', ') || '-'} | ${r.guessed.join(', ')} |`), '',
    '**고치는 법** (둘 중 편한 쪽)',
    '1. 구글맵 코멘트에 `#음식점 #스시 #야식 @우메다` 처럼 적기 → 다음 동기화 때 반영',
    '2. `data/overrides.json` 에 아래 블록을 붙여넣고 값 수정', '', '```json',
    review.map((r) => `"${r.id}": ${JSON.stringify({ name: r.name, city: r.city, area: r.area, type: r.type, tags: r.tags })}`).join(',\n'), '```',
  ].join('\n');
  await writeFile(new URL('sync-report.md', ROOT), md);
}
