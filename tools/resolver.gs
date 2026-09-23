/**
 * 일본 또갈지도 — 중계기 (Google Apps Script)
 *
 * 두 가지 일을 한다.
 *  1. 구글맵 링크 → 장소 정보 (내 여행 "목록에 없는 장소 가져오기")
 *  2. 내 여행 일정 저장 · 조회 (짧은 공유 링크용) — 투어 시트의 "일정" 탭에 고유ID 별로 저장
 *
 * 안전장치
 *  - 구글맵 주소만 대신 읽는다. 내 계정의 다른 데이터(드라이브 · 메일)는 건드리지 않는다
 *  - 일정은 SHEET_ID 시트의 "일정" 탭에만 쓴다 (없으면 만든다). 탭 구조: 고유ID | 일정(JSON) | 갱신시각 | 생성시각
 *  - 일정 고유ID는 22자 난수라 추측할 수 없다. 같은 ID로 다시 저장하는 것만 가능 (남의 일정은 ID를 모르면 못 고침)
 *  - 하루 DAILY_LIMIT 회를 넘으면 그날은 거절한다. Apps Script 는 결제가 없어 요금이 나올 수 없다
 *
 * 설치 · 갱신
 *  - 처음: https://script.google.com → 새 프로젝트 → 붙여넣기 → [배포] → [새 배포] → 웹 앱 (실행: 나 / 액세스: 모든 사용자)
 *  - 코드를 고친 뒤: [배포] → [배포 관리] → 연필 → 버전 "새 버전" → [배포]  (URL 유지)
 *  - 일정 저장을 처음 켤 때는 시트 권한 승인 창이 한 번 더 뜬다
 */
var SHEET_ID = '1pVqDnp9qBkJyPdSGsv5_70IUaRjHG4WiqB4o55YrxkE';
var TAB = '일정';
var DAILY_LIMIT = 10000; // 저장 1회 ≈ 1초라 다 써도 실행 시간 무료 한도(하루 90분) 안쪽
var MAX_TRIP_CHARS = 60000; // 일정 하나의 최대 크기 (시트 셀 한도 5만 자 안쪽으로 나눠 저장)
var ALLOWED = /^https:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps\/|(www\.)?google\.(com|co\.kr|co\.jp)\/maps[\/?]|maps\.google\.(com|co\.kr|co\.jp)\/)/;

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function overLimit() {
  var cache = CacheService.getScriptCache(), day = 'n:' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var used = Number(cache.get(day) || 0);
  if (used >= DAILY_LIMIT) return true;
  cache.put(day, String(used + 1), 21600);
  return false;
}

// ── 1) 장소 정보
function resolvePlace(url) {
  url = String(url || '').slice(0, 600);
  if (!ALLOWED.test(url)) return { error: '구글맵 링크가 아닙니다' };
  var cache = CacheService.getScriptCache(), key = 'u:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, url));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  if (overLimit()) return { error: '오늘 사용량을 넘었습니다' };
  var opt = { followRedirects: true, muteHttpExceptions: true, headers: { 'Accept-Language': 'ko' } };
  var html = UrlFetchApp.fetch(url, opt).getContentText();
  var pv = (html.match(/\/maps\/preview\/place\?[^"\\]+/) || [])[0];
  if (!pv) return { error: '장소 정보를 찾지 못했습니다' };
  var text = UrlFetchApp.fetch('https://www.google.com' + pv.replace(/&amp;/g, '&'), opt).getContentText();
  var j = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  var p = j[6] || [];
  var at = (p[9] && p[9][2] != null) ? [p[9][2], p[9][3]] : [j[4][0][2], j[4][0][1]];
  var res = { name: p[11] || '', lat: at[0], lng: at[1], category: (p[13] || []).join(', '), address: p[39] || p[18] || '' };
  cache.put(key, JSON.stringify(res), 21600);
  return res;
}

// ── 2) 일정 저장 · 조회
function tab() {
  var ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName(TAB);
  if (!sh) { sh = ss.insertSheet(TAB); sh.appendRow(['고유ID', '일정', '갱신시각', '생성시각']); sh.setFrozenRows(1); }
  return sh;
}
function findRow(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}
function validId(id) { return /^[A-Za-z0-9_-]{16,32}$/.test(String(id || '')); }

function loadTrip(id) {
  if (!validId(id)) return { error: '잘못된 ID' };
  var sh = tab(), row = findRow(sh, id);
  if (!row) return { error: '없는 일정입니다' };
  var v = sh.getRange(row, 2, 1, 3).getValues()[0];
  return { id: id, trip: JSON.parse(v[0] || '[]'), updated: v[1] };
}

function saveTrip(id, tripJson) {
  if (!validId(id)) return { error: '잘못된 ID' };
  if (typeof tripJson !== 'string' || tripJson.length > MAX_TRIP_CHARS) return { error: '일정이 너무 큽니다' };
  var trip = JSON.parse(tripJson);
  if (!Array.isArray(trip)) return { error: '형식 오류' };
  if (overLimit()) return { error: '오늘 사용량을 넘었습니다' };
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = tab(), row = findRow(sh, id), now = new Date();
    if (row) sh.getRange(row, 2, 1, 2).setValues([[tripJson, now]]);
    else sh.appendRow([id, tripJson, now, now]);
  } finally { lock.releaseLock(); }
  return { ok: true, id: id };
}

function doGet(e) {
  try {
    var p = e.parameter || {};
    if (p.url) return out(resolvePlace(p.url));
    if (p.trip) return out(loadTrip(p.trip));
    return out({ error: '요청이 비어 있습니다' });
  } catch (err) { return out({ error: String(err) }); }
}

// 저장은 POST (본문: JSON {id, trip}). 브라우저의 CORS 사전 요청을 피하려고 text/plain 으로 보냄
function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    return out(saveTrip(body.id, typeof body.trip === 'string' ? body.trip : JSON.stringify(body.trip || [])));
  } catch (err) { return out({ error: String(err) }); }
}
