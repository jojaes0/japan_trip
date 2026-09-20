/**
 * 구글맵 링크 → 장소 정보 중계기 (Google Apps Script)
 *
 * "내 여행"에서 구글맵 링크를 붙여넣으면 이름 · 종류 · 주소 · 좌표를 자동으로 채우기 위한 것.
 * 브라우저는 보안 정책(CORS) 때문에 구글맵 링크를 직접 읽지 못하므로, 구글 서버에서 대신 읽어 준다.
 *
 * 안전장치
 *  - 구글맵 주소만 받는다 (다른 사이트를 대신 읽어 주는 용도로 쓸 수 없음)
 *  - 내 계정의 어떤 데이터(드라이브 · 메일 · 시트)도 읽거나 쓰지 않는다. 외부 주소 읽기 권한만 쓴다
 *  - 하루 DAILY_LIMIT 회를 넘으면 그날은 거절한다 (누가 마구 호출해도 구글의 무료 한도 2만 회/일에 닿지 않음)
 *  - 같은 링크는 6시간 동안 기억해 두고 다시 읽지 않는다
 *  - Apps Script 는 결제 수단이 연결되지 않는 무료 서비스라, 한도를 넘어도 요금이 나오지 않고 그날 동작만 멈춘다
 *
 * 설치 (한 번, 5분)
 *  1. https://script.google.com → 새 프로젝트 → 이 파일 내용을 통째로 붙여넣기 → 저장
 *  2. 오른쪽 위 [배포] → [새 배포] → 유형: 웹 앱
 *       실행 사용자: 나 / 액세스 권한: 모든 사용자  → [배포] (처음엔 권한 승인 창이 뜸)
 *  3. 나온 "웹 앱 URL"(https://script.google.com/macros/s/…/exec)을 assets/app.js 맨 위 RESOLVER 에 넣기
 *
 * 코드를 고친 뒤에는: [배포] → [배포 관리] → 연필 아이콘 → 버전: "새 버전" → [배포]  (URL 은 그대로 유지됨)
 */
var DAILY_LIMIT = 2000;
var ALLOWED = /^https:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps\/|(www\.)?google\.(com|co\.kr|co\.jp)\/maps[\/?]|maps\.google\.(com|co\.kr|co\.jp)\/)/;

function doGet(e) {
  var out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  try {
    var url = String((e.parameter && e.parameter.url) || '').slice(0, 600);
    if (!ALLOWED.test(url)) return out({ error: '구글맵 링크가 아닙니다' });

    var cache = CacheService.getScriptCache(), key = 'u:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, url));
    var hit = cache.get(key);
    if (hit) return out(JSON.parse(hit));

    // 하루 호출 수 제한 (대략적인 집계면 충분)
    var day = 'n:' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd'), used = Number(cache.get(day) || 0);
    if (used >= DAILY_LIMIT) return out({ error: '오늘 사용량을 넘었습니다' });
    cache.put(day, String(used + 1), 21600); // 캐시는 최대 6시간 — 6시간 동안 조용하면 집계가 초기화되지만, 그래도 하루 최대 8천 회라 무료 한도 안쪽

    var opt = { followRedirects: true, muteHttpExceptions: true, headers: { 'Accept-Language': 'ko' } };
    var html = UrlFetchApp.fetch(url, opt).getContentText();
    var pv = (html.match(/\/maps\/preview\/place\?[^"\\]+/) || [])[0];
    if (!pv) return out({ error: '장소 정보를 찾지 못했습니다' });
    var text = UrlFetchApp.fetch('https://www.google.com' + pv.replace(/&amp;/g, '&'), opt).getContentText();
    var j = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
    var p = j[6] || [];
    var at = (p[9] && p[9][2] != null) ? [p[9][2], p[9][3]] : [j[4][0][2], j[4][0][1]];
    var res = { name: p[11] || '', lat: at[0], lng: at[1], category: (p[13] || []).join(', '), address: p[39] || p[18] || '' };
    cache.put(key, JSON.stringify(res), 21600);
    return out(res);
  } catch (err) {
    return out({ error: String(err) });
  }
}
