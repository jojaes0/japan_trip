// 구글맵 저장 리스트 → data/places.js 동기화
//   node scripts/sync.mjs
// 분류: 구글맵 코멘트의 #해시태그/@지역 이 있으면 그대로, 없으면 자동 추론 (틀리면 구글맵 코멘트에 해시태그로 보정)
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const readJSON = async (p, fallback) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch { return fallback; } };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const TYPE_TAGS = {
  food: ['음식점', '맛집', '식당'], cafe: ['카페', '디저트'], shop: ['쇼핑'],
  stay: ['숙소', '호텔', '료칸'], sight: ['관광지', '관광'], tour: ['투어'],
};
// 해시태그가 없을 때 종류 추론 (위에서부터 먼저 맞는 것). 숙소는 이름으로만 판단 — 코멘트의 "숙소 근처" 같은 말에 속지 않도록
const TYPE_HINTS = [
  ['stay', /호텔|hotel|료칸|旅館|숙소|게스트하우스|hostel|호스텔|도미 ?인|\binn\b| 인$/i],
  ['shop', /쇼핑|굿즈|피규어|books|서점|스토어|드럭|돈키|화장|백화점|야마야|기념품|마트|술 싸게/i],
  ['cafe', /카페|cafe|café|coffee|커피|디저트|아이스크림|bread|베이커리|빙수|파르페/i],
  ['sight', /신사|神社|寺|사원|공원|전망|박물관|미술관|타워|정원|城/i],
];
// 앞쪽일수록 대표 태그 (지도 라벨에는 첫 태그가 표시됨). 뒤쪽은 분위기·특징
const TAG_HINTS = [
  ['스시', /스시|초밥|鮨|寿司|sushi/i], ['라멘', /라멘|ramen|ラーメン/i], ['야키토리', /야키토리|焼鳥|yakitori|torito/i],
  ['로바다야키', /로바다야[끼키]|炉ばた/], ['사시미', /사시미/], ['이자카야', /이자카야|居酒屋/], ['우동', /우동|うどん/],
  ['오코노미야키', /오코노미야[끼키]/], ['야키니쿠', /야키니쿠|焼肉/], ['장어덮밥', /장어/], ['와규덮밥', /와규/], ['모츠나베', /모츠나베/],
  ['카이세키', /카이세키/], ['교자', /교자|餃子/], ['돈카츠', /돈[카까]츠/], ['톤테키', /톤테키/], ['함바그', /함바그|햄버그/],
  ['스파게티', /스파게티|파스타/], ['타마고야키', /타마고야[끼키]/], ['해산물', /해산물/], ['순두부찌개', /순두부/],
  ['메론빵', /메론빵|melon bread/i], ['아이스크림', /아이스크림/], ['카페', /카페|cafe|coffee/i],
  ['피규어', /피규어/], ['애니 굿즈', /굿즈|k-books/i], ['화장품', /화장|핸드크림/], ['주류', /술 싸게|사케노|리쿼/],
  ['료칸', /료칸|旅館/], ['호텔', /호텔|hotel|\binn\b| 인( |$)/i], ['온천', /온천|hot spring/i],
  ['술 한잔', /이자카야|居酒屋|야키토리|로바다야|술먹기|torito/i], ['가성비', /가성비|저렴|가격이 좋/], ['현지인 추천', /현지인/], ['혼밥 가능', /1인도|혼밥|혼자서/],
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
  const res = await fetch(api, { headers: { 'user-agent': UA } });
  const text = await res.text();
  // 구글이 일시적으로 막은 경우(429·403·5xx, 또는 JSON 대신 확인 페이지): 이번 회차만 건너뜀
  if (!res.ok || !text.startsWith(")]}'")) throw Object.assign(new Error(`구글 응답 ${res.status}`), { temporary: true });
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
const areaBook = await readJSON('data/areas.json', []); // 지역 사전: 동네별 중심 좌표와 반경
const manual = await readJSON('data/manual.json', []);

let prevIds = new Set();
try {
  const ctx = { window: {} };
  vm.runInNewContext(await readFile(new URL('data/places.js', ROOT), 'utf8'), ctx);
  prevIds = new Set(ctx.window.PLACES.map((p) => p.id));
} catch {}

const raw = new Map();
for (const list of lists) {
  let rows;
  try { rows = await fetchList(list.url); } catch (e) {
    if (!e.temporary && e.message !== 'fetch failed') throw e; // 응답 형식이 바뀐 경우 등은 진짜 실패로 알림
    // 일시적 차단·네트워크 오류는 기존 데이터를 그대로 두고 정상 종료 (5분마다 실패 메일이 쏟아지지 않게)
    console.log(`::warning::동기화 건너뜀 — ${e.message}. 기존 데이터를 유지합니다.`);
    process.exit(0);
  }
  console.log(`${list.url} → ${rows.length}곳`);
  for (const r of rows) if (!raw.has(r.id)) raw.set(r.id, { ...r, defaultType: list.defaultType });
}
// 구글 쪽 응답이 이상하면 기존 데이터를 지키기 위해 중단
if (lists.length && raw.size === 0) throw new Error('가져온 장소가 0곳 — 기존 데이터를 유지하고 중단합니다.');

const cityByAddress = (r) => CITIES.find(([, re]) => re.test(r.address))?.[0];
// 지역 사전 조회: 주소 키워드가 맞는 동네 우선, 없으면 반경 안에서 가장 가까운 동네
const inBook = (r, max) => (!max && areaBook.find((b) => (b.match || []).some((k) => r.address.includes(k)))) || areaBook.map((b) => [meters(r, b), b]).filter(([d, b]) => d <= (max || b.radius)).sort((x, y) => x[0] - y[0])[0]?.[1];

// "@난바" 처럼 일부만 적어도 알려진 지역 "난바·도톤보리" 로 맞춰 줌 (같은 도시 우선, 모르는 이름이면 새 지역으로)
const squash = (s) => s.replace(/[·\s()]/g, '');
const matchArea = (word, city, known) => {
  const hits = known.filter((k) => squash(k.area).includes(squash(word)));
  return (hits.find((k) => k.area === word) || hits.find((k) => k.city === city) || hits[0])?.area || word;
};

// 기준점: 코멘트에 @지역 을 단 장소. 새 동네라도 첫 장소에만 달면 근처 장소가 따라감
const anchors = [];
for (const r of raw.values()) {
  const word = parseNote(r.note).area;
  if (!word) continue;
  const city = cityByAddress(r) || inBook(r, CITY_RADIUS)?.city;
  anchors.push({ ...r, city, area: matchArea(word, city, areaBook) });
}
const nearAnchor = (r, max) => anchors.filter((a) => a.id !== r.id).map((a) => [meters(r, a), a]).filter(([d]) => d <= max).sort((x, y) => x[0] - y[0])[0]?.[1];

const places = [], review = [];
for (const r of raw.values()) {
  const n = parseNote(r.note), text = `${r.name} ${r.note}`, guessed = [];
  const guess = (field, value) => { guessed.push(field); return value; };

  const type = n.type || guess('종류', TYPE_HINTS.find(([t, re]) => re.test(t === 'stay' ? r.name : text))?.[0] || r.defaultType || 'etc');
  const city = cityByAddress(r) || nearAnchor(r, CITY_RADIUS)?.city || inBook(r, CITY_RADIUS)?.city || guess('도시', '기타');
  const area = (n.area && matchArea(n.area, city, [...areaBook, ...anchors])) || guess('지역', nearAnchor(r, AREA_RADIUS)?.area || inBook(r)?.area || '기타');
  const tags = n.tags || guess('태그', TAG_HINTS.filter(([, re]) => re.test(text)).map(([t]) => t));

  places.push({ id: r.id, name: r.name, city, area, type, tags, tip: n.tip, address: r.address, lat: r.lat, lng: r.lng, map: r.map });
  if (guessed.length && !prevIds.has(r.id)) review.push({ name: r.name, city, area, type, tags, guessed });
}
places.push(...manual);

const head = `/*
  자동 생성 파일 — 직접 고치지 마세요. (node scripts/sync.mjs)
  · 장소 추가/삭제/코멘트 : 구글맵 리스트에서
  · 분류 고치기           : 구글맵 코멘트에 #스시 #야식 @우메다
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
    '**고치는 법**: 구글맵에서 그 장소의 코멘트에 `#숙소 #온천 @우메다` 처럼 적으면 다음 동기화 때 반영됩니다. (종류: #음식점 #카페 #쇼핑 #숙소 #관광지 #투어)',
  ].join('\n');
  await writeFile(new URL('sync-report.md', ROOT), md);
}
