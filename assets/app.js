(() => {
  const PLACES = window.PLACES || [];
  const TYPES = {
    food: { label: '음식점', tip: '추천 메뉴 · 코멘트', color: '#F2542D' },
    cafe: { label: '카페·디저트', tip: '추천 메뉴 · 코멘트', color: '#F5A524' },
    shop: { label: '쇼핑', tip: '쇼핑 팁', color: '#D6409F' },
    stay: { label: '숙소', tip: '숙소 메모', color: '#5B5BD6' },
    sight: { label: '관광지', tip: '관광 팁', color: '#1FA971' },
    tour: { label: '투어', tip: '투어 정보', color: '#12A5B8' },
    etc: { label: '기타', tip: '메모', color: '#8E8E93' },
  };
  const WALK_NEAR = 800, NEAR = 3000; // m
  // 구글맵 링크 → 장소 정보 중계기(tools/resolver.gs 를 배포한 웹 앱 URL). 비어 있으면 PC용 긴 링크만 자동, 나머지는 직접 입력
  const RESOLVER = 'https://script.google.com/macros/s/AKfycbzTd-PjfZUOjBvQG-EVo5MWPx_M9Qfm4pIIwtrcrMiMUqsM_cdYmZJACIyLh1frbmkj/exec';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = (a) => [...new Set(a)];

  const state = { city: '', area: '', type: '', tag: '', pick: false, route: '', q: '', p: '', view: 'list', me: null, plan: false, shared: null }; // plan: 지도에 내 여행 동선을 그리는 중 · shared: 공유 링크로 받은 여행(읽기 전용)

  // ── URL ↔ state (필터 상태와 열린 장소가 그대로 공유 링크가 됨)
  const readHash = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    for (const k of ['city', 'area', 'type', 'tag', 'route', 'p']) state[k] = h.get(k) || '';
    state.view = ['map', 'trip'].includes(h.get('view')) ? h.get('view') : 'list';
    state.plan = h.get('plan') === '1' && state.view === 'map';
    state.shared = h.get('trip') ? decodeTrip(h.get('trip')) : null;
    if (state.shared && !h.get('view')) state.view = 'trip'; // 공유 링크로 들어오면 받은 여행부터
    state.pick = h.get('pick') === '1';
  };
  const hashFor = (s) => {
    const h = new URLSearchParams();
    for (const k of ['city', 'area', 'type', 'tag', 'route', 'p']) if (s[k]) h.set(k, s[k]);
    if (s.pick) h.set('pick', '1');
    if (s.view !== 'list') h.set('view', s.view);
    if (s.plan) h.set('plan', '1');
    if (s.shared) h.set('trip', encodeTrip(s.shared));
    const str = h.toString();
    return str ? '#' + str : location.pathname + location.search;
  };
  const writeHash = () => history.replaceState(null, '', hashFor(state));

  // ── 거리
  const meters = (a, b) => {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : m < 10000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 1000)}km`);
  const walkMin = (m) => Math.max(1, Math.round((m * 1.25) / 75)); // 직선거리 보정 · 분속 75m

  const hasSpot = (p) => p.lat != null && p.lng != null; // 투어는 좌표가 없음
  // "42곳 · 투어 2개" — 투어는 장소가 아니므로 따로 셈
  const countText = (list) => { const s = list.filter(hasSpot).length, t = list.length - s; return [s ? `${s}곳` : '', t ? `투어 ${t}개` : ''].filter(Boolean).join(' · ') || '0곳'; };

  // ── 필터
  // skip: 무시할 필터 (범례·태그 칩은 자기 자신의 필터를 빼고 후보를 계산)
  const filtered = (skip = '') => {
    const q = state.q.trim().toLowerCase();
    let out = PLACES.filter((p) =>
      (!state.city || p.city === state.city) &&
      (!state.area || p.area === state.area) &&
      (skip === 'type' || !state.type || p.type === state.type) &&
      (skip === 'tag' || !state.tag || (p.tags || []).includes(state.tag)) &&
      (skip === 'pick' || !state.pick || p.pick) &&
      (!q || [p.name, p.tip, p.area, p.city, p.address, ...(p.tags || [])].join(' ').toLowerCase().includes(q)));
    if (state.me) { // 가까운 순 — 좌표가 없는 투어는 제외
      out = out.filter(hasSpot).map((p) => ({ ...p, d: meters(state.me, p) })).sort((a, b) => a.d - b.d);
    }
    return out;
  };

  const STAR = '<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.6 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z"/></svg>';

  // ── 필터 UI
  const renderFilters = () => {
    const cities = uniq(PLACES.map((p) => p.city));
    $('cities').innerHTML = '<span class="thumb"></span>' +
      ['', ...cities].map((c) => `<button type="button" role="tab" data-city="${esc(c)}" class="${c === state.city ? 'on' : ''}">${esc(c || '전체')}</button>`).join('');
    const i = ['', ...cities].indexOf(state.city), n = cities.length + 1;
    const thumb = $('cities').querySelector('.thumb');
    thumb.style.width = `calc((100% - 4px) / ${n})`;
    thumb.style.transform = `translateX(${Math.max(i, 0) * 100}%)`;

    const areas = state.city ? uniq(PLACES.filter((p) => p.city === state.city).map((p) => p.area)) : [];
    $('areas').innerHTML = areas.length > 1
      ? ['', ...areas].map((a) => `<button type="button" data-area="${esc(a)}" class="${a === state.area ? 'on' : ''}">${esc(a || state.city + ' 전체')}</button>`).join('')
      : '';

    const types = Object.keys(TYPES).filter((t) => PLACES.some((p) => p.type === t));
    // 태그: 지금 조건에 남아 있는 장소들의 태그를 많은 순으로
    const count = {};
    for (const p of filtered('tag')) for (const t of p.tags || []) count[t] = (count[t] || 0) + 1;
    if (state.tag && !count[state.tag]) state.tag = '';
    const tags = Object.keys(count).sort((x, y) => count[y] - count[x] || x.localeCompare(y, 'ko'));
    const hasPick = filtered('pick').some((p) => p.pick);
    if (!hasPick) state.pick = false;
    $('tags').innerHTML = (hasPick ? `<button type="button" data-pick class="pickchip ${state.pick ? 'on' : ''}">${STAR}추천</button>` : '') + tags.map((t) => `<button type="button" data-tag="${esc(t)}" class="${t === state.tag ? 'on' : ''}">${esc(t)}</button>`).join('');

    $('types').innerHTML = ['', ...types].map((t) => `<button type="button" data-type="${t}" class="${t === state.type ? 'on' : ''}">${t ? TYPES[t].label : '모든 종류'}</button>`).join('');
  };

  // ── 목록: 지역(또는 거리)별로 카드에 묶어 보여줌
  const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
  const itemHTML = (p, showArea, i) => `
    <button type="button" class="item${p.pick ? ' pick' : ''}" data-id="${esc(p.id)}" style="animation-delay:${Math.min(i, 12) * 25}ms">
      <span class="name">${p.pick ? STAR : ''}${esc(p.name)}</span>
      <span class="side">${p.d != null ? `<span class="dist">${fmtDist(p.d)}${p.d < NEAR ? `<small>도보 ${walkMin(p.d)}분</small>` : ''}</span>` : ''}${CHEVRON}</span>
      ${p.tip ? `<span class="tip">${esc(p.tip)}</span>` : ''}
      <span class="meta"><b>${esc((TYPES[p.type] || {}).label || '')}</b>${esc(['', ...(showArea ? [p.area] : []), ...(p.tags || [])].join(' · '))}</span>
    </button>`;

  const renderList = () => {
    const items = filtered();
    $('count').textContent = countText(items) + (state.me ? ' · 가까운 순' : '');
    if (!items.length) { $('list').innerHTML = '<p class="empty">조건에 맞는 장소가 없어요.</p>'; return items; }

    // [작은 머리말, 제목, 장소들]
    const groups = state.me
      ? [['', '걸어서 10분 안쪽', items.filter((p) => p.d <= WALK_NEAR)], ['', '3km 이내', items.filter((p) => p.d > WALK_NEAR && p.d <= NEAR)], ['', '조금 먼 곳', items.filter((p) => p.d > NEAR)]]
      : uniq(items.map((p) => `${p.city}|${p.area}`)).map((k) => [...k.split('|'), items.filter((p) => `${p.city}|${p.area}` === k)]);
    let n = 0;
    $('list').innerHTML = groups.filter((g) => g[2].length).map(([eyebrow, title, list]) => `
      <section class="grp">
        <header>${eyebrow ? `<small>${esc(eyebrow)}</small>` : ''}<h2>${esc(title)}</h2><span>${list.every(hasSpot) ? list.length + '곳' : list.length + '개'}</span></header>
        <div class="card">${(state.me ? list : [...list].sort((x, y) => !!y.pick - !!x.pick)).map((p) => itemHTML(p, !!state.me, n++)).join('')}</div>
      </section>`).join('');
    return items;
  };

  // ── 지도 (처음 열 때만 MapLibre 로드 · OpenFreeMap 벡터 타일 · 지명은 한국어 우선)
  // 테마: 우상단 토글로 고른 값이 우선, 없으면 기기 설정. 지도도 같은 모드로
  const isDark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const mapStyle = () => `https://tiles.openfreemap.org/styles/${isDark() ? 'dark' : 'positron'}`;
  let map, markers = [], glReady, legend, here = null, hereMarker, tracking = false;
  const KO_NAME = ['coalesce', ['get', 'name:ko'], ['get', 'name:latin'], ['get', 'name']];
  const loadGL = () => glReady || (glReady = new Promise((ok, fail) => {
    const base = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/';
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: base + 'maplibre-gl.css' });
    const js = Object.assign(document.createElement('script'), { src: base + 'maplibre-gl.js', onload: ok, onerror: fail });
    document.head.append(css, js);
  }));
  const koreanize = () => {
    for (const l of map.getStyle().layers) {
      if (l.type !== 'symbol') continue;
      const tf = map.getLayoutProperty(l.id, 'text-field');
      if (tf && JSON.stringify(tf).includes('name')) map.setLayoutProperty(l.id, 'text-field', KO_NAME);
    }
    // 길 찾을 때 기준이 되는 역 이름을 추가
    try {
      const font = map.getStyle().layers.find((l) => l.layout && l.layout['text-font']).layout['text-font'];
      if (!map.getLayer('stations')) map.addLayer({
        id: 'stations', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 12,
        filter: ['==', ['get', 'class'], 'railway'],
        layout: { 'text-field': KO_NAME, 'text-font': font, 'text-size': 12.5, 'text-padding': 6 },
        paint: { 'text-color': isDark() ? '#8ab4f8' : '#2f5d9e', 'text-halo-color': isDark() ? '#111' : '#fff', 'text-halo-width': 1.6 },
      });
    } catch {}
  };
  // 투어 코스: 방문 순서대로 점선으로 잇는다. 스타일을 바꾸면(다크/라이트) 레이어가 사라지므로 style.load 때 다시 그림
  const SIDE_COLORS = { 식사: TYPES.food.color, 간식: TYPES.cafe.color, 카페: TYPES.cafe.color, 쇼핑: TYPES.shop.color, 추천: TYPES.tour.color }; // 코스에 끼워 넣는 "간 김에 들를 곳"
  const ROUTE_COLORS = ['#12A5B8', '#8B5CF6', '#E0A100', '#E0529C', '#3B82F6', '#1FA971'];
  const tourColor = (t) => t.color || ROUTE_COLORS[Math.max(0, PLACES.filter((p) => p.stops).findIndex((p) => p.id === t.id)) % ROUTE_COLORS.length];
  let routeData = { type: 'FeatureCollection', features: [] }, shownRoutes = [];
  const drawRoutes = () => {
    if (!map) return;
    try {
      if (map.getSource('routes')) map.getSource('routes').setData(routeData);
      else {
        map.addSource('routes', { type: 'geojson', data: routeData });
        map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-dasharray': [0.6, 1.8] } });
      }
      $('map').dataset.routes = routeData.features.length; // 그려진 코스 수 (확인용)
    } catch { map.once('idle', drawRoutes); } // 스타일이 아직 로딩 중 — 준비되면 다시
  };
  // 라벨이 앞 순서의 핀·라벨을 가리면 숨기고 점만 남김 (확대하면 나타남). 앞 순서 = 추천 장소, 코스의 앞 번호
  const declutter = () => {
    const pts = markers.map((m) => map.project(m.getLngLat()));
    const taken = pts.map((pt, i) => [pt.x - 9, pt.y - 9, pt.x + 9, pt.y + 9, i]);
    markers.forEach((m, i) => {
      if (!m.label) return;
      const w = m.label.offsetWidth / 2 + 3, h = m.label.offsetHeight;
      const r = [pts[i].x - w, pts[i].y - h - 15, pts[i].x + w, pts[i].y - 11];
      const hit = taken.some((t) => (t[4] == null || t[4] < i) && r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
      m.label.classList.toggle('off', hit);
      if (!hit) taken.push(r);
    });
  };
  // 내 위치 점: "내 주변"으로 얻은 위치 또는 지도에서 직접 얻은 위치. 지도의 위치 버튼이 추적 중이면 그쪽 점을 씀
  const showHere = () => {
    if (hereMarker) { hereMarker.remove(); hereMarker = null; }
    const pos = state.me || here;
    if (!map || !pos || tracking) return;
    hereMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'me', title: '내 위치' }) }).setLngLat([pos.lng, pos.lat]).addTo(map);
  };
  const renderMap = async (items) => {
    try { await loadGL(); } catch { $('map').textContent = '지도를 불러오지 못했어요.'; return; }
    if (!map) {
      map = new maplibregl.Map({
        container: 'map', style: mapStyle(),
        center: [135.5, 34.69], zoom: 11, dragRotate: false, pitchWithRotate: false,
        localIdeographFontFamily: '"Pretendard Variable", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true, fitBoundsOptions: { maxZoom: 15 } });
      map.addControl(geo, 'top-right');
      geo.on('geolocate', (e) => { here = { lat: e.coords.latitude, lng: e.coords.longitude }; tracking = true; showHere(); });
      geo.on('trackuserlocationend', () => { tracking = false; showHere(); });
      // 이미 위치 권한을 허용한 기기라면 묻지 않고 바로 내 위치를 찍어 둠 (지도는 움직이지 않음)
      if (!state.me && navigator.permissions && navigator.geolocation) {
        navigator.permissions.query({ name: 'geolocation' }).then((r) => {
          if (r.state === 'granted') navigator.geolocation.getCurrentPosition((pos) => { here = { lat: pos.coords.latitude, lng: pos.coords.longitude }; showHere(); }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
        }).catch(() => {});
      }
      map.on('style.load', () => { koreanize(); drawRoutes(); });
      map.on('move', declutter);
      legend = Object.assign(document.createElement('div'), { className: 'legend' });
      legend.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.focus) { // 일차를 누르면 그 일차의 동선이 화면에 꽉 차게 이동
          const r = shownRoutes.find((t) => t.id === b.dataset.focus); if (!r) return;
          const bb = new maplibregl.LngLatBounds(); r.stops.forEach((s) => bb.extend([s.lng, s.lat]));
          return map.fitBounds(bb, { padding: { top: 110, bottom: 64, left: 64, right: 64 }, maxZoom: 16, duration: 700 });
        }
        if ('exitplan' in b.dataset) { state.plan = false; state.view = 'trip'; } // 동선 지도 → 내 여행 목록으로
        else if ('exit' in b.dataset) state.route = ''; // 코스 단독 보기 끝내기
        else if (b.dataset.route) state.route = b.dataset.route; // 여러 코스 중 하나만 보기
        else state.type = state.type === b.dataset.type ? '' : b.dataset.type;
        render();
      });
      $('map').append(legend);
    }
    map.resize();
    markers.forEach((m) => { m.remove(); if (m.labelMarker) m.labelMarker.remove(); });
    markers = [];

    // 범례는 종류 필터와 무관하게 이 지역에 있는 모든 종류를 보여주고, 누르면 그 종류만 남김
    // 코스는 투어만 볼 때(종류=투어) 또는 상세에서 "코스 지도로 보기"를 눌렀을 때만 그림 — 평소 지도가 선으로 어지럽지 않게
    const routed = state.plan ? tripRoutes() : state.route ? PLACES.filter((p) => p.id === state.route && p.stops) : state.type === 'tour' ? items.filter((p) => p.stops) : [];
    shownRoutes = routed;
    items = state.route || state.plan ? [] : items.filter(hasSpot);
    const inScope = uniq(filtered('type').filter(hasSpot).map((p) => p.type));
    if (state.plan) legend.innerHTML = `<button type="button" data-exitplan>${state.shared ? '공유받은 여행' : '내 여행'} ✕</button>` + routed.map((t) => `<button type="button" data-focus="${esc(t.id)}" style="--c:${t.color}"><i></i>${esc(t.name)}</button>`).join('');
    else if (routed.length && state.route) legend.innerHTML = `<button type="button" data-exit style="--c:${tourColor(routed[0])}"><i></i><span class="clip">${esc(routed[0].tags[0] || routed[0].name)}</span> ✕</button>`;
    else if (routed.length) legend.innerHTML = routed.map((t) => `<button type="button" data-route="${esc(t.id)}" style="--c:${tourColor(t)}"><i></i><span class="clip">${esc(t.tags[0] || t.name)}</span></button>`).join('');
    else legend.innerHTML = Object.keys(TYPES).filter((t) => inScope.includes(t)).map((t) =>
      `<button type="button" data-type="${t}" class="${state.type && state.type !== t ? 'dim' : ''}" style="--c:${TYPES[t].color}"><i></i>${TYPES[t].label}</button>`).join('');

    const box = new maplibregl.LngLatBounds();
    for (const p of [...items].sort((x, y) => !!y.pick - !!x.pick)) {
      const t = TYPES[p.type] || TYPES.etc;
      const make = (cls, html) => {
        const el = Object.assign(document.createElement('button'), { type: 'button', className: cls, title: p.name, innerHTML: html });
        el.style.setProperty('--c', t.color);
        el.addEventListener('click', (e) => { e.stopPropagation(); openSheet(p.id); });
        return el;
      };
      const m = new maplibregl.Marker({ element: make(p.pick ? 'pin pick' : 'pin', p.pick ? STAR : '') }).setLngLat([p.lng, p.lat]).addTo(map);
      m.label = make('mk-label', `<small>${p.pick ? STAR : ''}${esc([t.label, (p.tags || [])[0]].filter(Boolean).join(' / '))}</small>${esc(p.name)}`);
      m.labelMarker = new maplibregl.Marker({ element: m.label, anchor: 'bottom', offset: [0, -13] }).setLngLat([p.lng, p.lat]).addTo(map);
      markers.push(m);
      box.extend([p.lng, p.lat]);
    }
    for (const tour of routed) {
      // 같은 자리(출발지로 되돌아오는 도착 등)는 핀 하나로 합쳐 "출발·도착2" 처럼 표시
      let no = 0;
      const spots = [];
      for (const s of tour.stops) {
        const mark = s.role ? s.tag : String(++no);
        const same = s.role !== 'side' && spots.find((x) => x.role !== 'side' && meters(x, s) < 40);
        if (same) { same.marks.push(mark); if (!same.role) same.role = s.role; } else spots.push({ ...s, marks: [mark] });
      }
      spots.forEach((s, i) => {
        const mark = s.marks.join('·');
        const make = (cls, html) => {
          const el = Object.assign(document.createElement('button'), { type: 'button', className: cls, title: s.name, innerHTML: html });
          el.style.setProperty('--c', s.role === 'side' ? SIDE_COLORS[s.tag] || TYPES.tour.color : tourColor(tour));
          // 들를 곳이 내 저장 장소와 같은 곳이면 그 장소의 상세(팁)를 열어 줌
          const saved = s.role === 'side' && PLACES.find((p) => hasSpot(p) && meters(p, s) < 40);
          el.addEventListener('click', (e) => { e.stopPropagation(); openSheet(s.open || (saved || tour).id); });
          return el;
        };
        const wide = s.role || s.marks.length > 1; // 글자가 들어가는 핀은 알약 모양
        const m = new maplibregl.Marker({ element: make(`pin stop ${s.role || ''} ${wide ? 'wide' : ''}`, esc(mark)) }).setLngLat([s.lng, s.lat]).addTo(map);
        m.label = make('mk-label', `<small>${s.role === 'side' ? esc([s.tag, s.note].filter(Boolean).join(' · ')) : wide ? esc(mark) : (state.plan ? tour.name + ' · ' : '') + mark + '번째' + (s.tour ? ' · 투어' : '')}</small>${esc(s.name)}`);
        m.getElement().style.zIndex = 100 - i; m.label.style.zIndex = 200 - i; // 겹치면 앞 번호가 위로
        m.labelMarker = new maplibregl.Marker({ element: m.label, anchor: 'bottom', offset: [0, -15] }).setLngLat([s.lng, s.lat]).addTo(map);
        markers.push(m);
        box.extend([s.lng, s.lat]);
      });
    }
    routeData = { type: 'FeatureCollection', features: routed.map((t) => ({ type: 'Feature', properties: { color: tourColor(t) }, geometry: { type: 'LineString', coordinates: t.stops.filter((s) => s.role !== 'side').map((s) => [s.lng, s.lat]) } })) };
    drawRoutes();
    showHere();
    if (quiet) { declutter(); return; } // 위치만 갱신된 경우엔 보던 화면을 유지
    if (state.me && items[0] && items[0].d < 30000) map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 15 });
    else if (!box.isEmpty()) map.fitBounds(box, { padding: { top: 110, bottom: 64, left: 64, right: 64 }, maxZoom: 16, duration: 0 });
    declutter();
  };

  let quiet = false; // true: 위치 갱신으로 인한 조용한 다시 그리기 (애니메이션·지도 이동 없음)
  const render = () => {
    $('list').classList.toggle('still', quiet);
    renderFilters();
    const items = renderList();
    for (const b of $('view').children) b.classList.toggle('on', b.dataset.v === (state.plan ? 'trip' : state.view)); // 동선 지도는 내 여행의 일부
    if (state.view !== 'map') state.plan = false;
    document.body.classList.toggle('tripmode', state.view === 'trip' || state.plan);
    $('list').hidden = state.view !== 'list';
    $('map').hidden = state.view !== 'map';
    $('trip').hidden = state.view !== 'trip';
    if (state.view === 'trip') renderTrip();
    if (state.view === 'map') renderMap(items);
    document.querySelectorAll('.chips').forEach(edges);
    writeHash();
  };

  // 투어 코스 목록 (출발 · 번호 · 들를 곳 · 도착)
  const stopsHTML = (p, cls = '') => { let no = 0; return `<ol class="stops ${cls}">${p.stops.map((s) => `<li class="${s.role || ''}"><b class="${s.role || ''}"${s.role === 'side' ? ` style="--c:${SIDE_COLORS[s.tag] || TYPES.tour.color}"` : ''}>${s.role ? esc(s.tag) : ++no}</b>${esc(s.name)}${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('')}</ol>`; };

  // ── 내 여행: 담아 둔 장소. 이 기기의 localStorage 에만 저장. 항목 = { id, day(0=미정), time, end(투어의 도착 시간), memo }
  const TRIP_KEY = 'jt-trip';
  const cleanCustom = (c) => (c && typeof c === 'object' ? {
    name: String(c.name || '').slice(0, 80) || '이름 없는 장소', type: TYPES[c.type] && c.type !== 'tour' ? c.type : 'etc', city: String(c.city || '').slice(0, 20), area: String(c.area || '').slice(0, 30),
    lat: c.lat != null && isFinite(+c.lat) ? +c.lat : null, lng: c.lng != null && isFinite(+c.lng) ? +c.lng : null,
    map: /^https:\/\//.test(c.map) ? String(c.map).slice(0, 400) : '', address: String(c.address || '').slice(0, 160), category: String(c.category || '').slice(0, 80),
  } : null);
  const cleanTrip = (a) => (Array.isArray(a) ? a : []).filter((x) => x && typeof x.id === 'string').slice(0, 200)
    .map((x) => ({ ...(x.custom ? { custom: cleanCustom(x.custom) } : {}), id: x.id, day: Math.min(30, Math.max(0, parseInt(x.day, 10) || 0)), time: /^\d{2}:\d{2}$/.test(x.time) ? x.time : '', end: /^\d{2}:\d{2}$/.test(x.end) ? x.end : '', memo: String(x.memo || '').slice(0, 1000) }));
  let trip = (() => { try { return cleanTrip(JSON.parse(localStorage.getItem(TRIP_KEY) || '[]')); } catch { return []; } })();
  const tripBadge = () => { $('tripcount').textContent = trip.length || ''; };
  const saveTrip = () => { try { localStorage.setItem(TRIP_KEY, JSON.stringify(trip)); } catch {} tripBadge(); };
  const inTrip = (id) => trip.some((x) => x.id === id);
  // 공유 링크에 담는 형식: [[id, day, time, memo], …] → base64url
  const encodeTrip = (list) => {
    let bin = '';
    new TextEncoder().encode(JSON.stringify(list.map((x) => { // 직접 추가한 장소는 정보를 통째로 담아 받는 사람에게도 보이게
      const c = x.custom, row = [x.id, x.day, x.time, x.memo];
      if (x.end || c) row.push(x.end || '');
      if (c) row.push([c.name, c.type, c.city, c.area, c.lat, c.lng, c.map, c.address, c.category]);
      return row;
    }))).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const decodeTrip = (s) => {
    try {
      const bytes = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      return cleanTrip(JSON.parse(new TextDecoder().decode(bytes)).map(([id, day, time, memo, end, c]) => ({ id, day, time, memo, end, ...(Array.isArray(c) ? { custom: { name: c[0], type: c[1], city: c[2], area: c[3], lat: c[4], lng: c[5], map: c[6], address: c[7], category: c[8] } } : {}) })));
    } catch { return null; }
  };
  const curTrip = () => state.shared || trip; // 공유받은 여행을 보는 중이면 그것(읽기 전용)
  const dayLabel = (d) => (d ? `${d}일차` : '일차 미정');
  // 일차 순(미정은 맨 뒤), 같은 일차 안에서는 담은 순서
  const tripDays = (list) => uniq(list.map((x) => x.day)).sort((a, b) => (a || 99) - (b || 99)).map((d) => [d, list.filter((x) => x.day === d)]);
  // 동선 지도용: 일차마다 코스 하나. 투어는 첫 번째 관광지 자리에 핀 하나로만 표시 (코스 전체를 그리면 내 동선과 헷갈림)
  const tripRoutes = () => tripDays(curTrip()).map(([d, xs], i) => ({
    id: 'day' + d, name: dayLabel(d), tags: [dayLabel(d)], color: ROUTE_COLORS[i % ROUTE_COLORS.length],
    stops: xs.map(placeOf).filter(Boolean).map((p) => {
      if (hasSpot(p)) return { name: p.name, lat: p.lat, lng: p.lng, open: p.id };
      const first = (p.stops || []).find((s) => !s.role) || (p.stops || [])[0];
      return first && { name: (p.tags || [])[0] || p.name, lat: first.lat, lng: first.lng, open: p.id, tour: first.name };
    }).filter(Boolean),
  })).filter((r) => r.stops.length);

  // 드래그 앤 드롭: SortableJS (터치·마우스 공통). 내 여행을 처음 열 때만 불러옴
  let dragReady; // undefined: 아직 · true: 사용 가능 · false: 불러오기 실패(▲▼ 버튼으로 대체)
  const loadSortable = () => new Promise((ok, fail) => {
    if (window.Sortable) return ok();
    document.head.append(Object.assign(document.createElement('script'), { src: 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js', onload: ok, onerror: fail }));
  });
  const enableDrag = async () => {
    try { await loadSortable(); } catch { if (dragReady !== false) { dragReady = false; renderTrip(); } return; }
    dragReady = true;
    for (const el of document.querySelectorAll('#trip .tcard')) {
      new Sortable(el, {
        group: 'trip', handle: '.thandle', draggable: '.trow', animation: 180, forceFallback: true, fallbackOnBody: true, fallbackTolerance: 4,
        scroll: true, scrollSensitivity: 90, scrollSpeed: 14, ghostClass: 'tghost', chosenClass: 'tchosen', dragClass: 'tdrag',
        onStart: () => document.body.classList.add('dragging'),
        onEnd: () => { // 화면에 놓인 순서 그대로 내 여행을 다시 만듦 (놓인 칸의 일차로 바뀜)
          document.body.classList.remove('dragging');
          const next = [];
          for (const card of document.querySelectorAll('#trip .tcard')) for (const r of card.querySelectorAll('.trow')) {
            const x = trip.find((y) => y.id === r.dataset.id);
            if (x) next.push({ ...x, day: +card.dataset.day });
          }
          if (next.length === trip.length) { trip = next; saveTrip(); }
          renderTrip();
        },
      });
    }
  };

  // ── 내 여행에 직접 추가한 장소 (구글맵 링크로). 데이터는 항목의 custom 안에 통째로 들어 있어 공유 링크로도 그대로 전달됨
  const placeOf = (x) => (x.custom ? { id: x.id, tags: [], ...x.custom, custom: true } : PLACES.find((p) => p.id === x.id));
  const findPlace = (id) => PLACES.find((p) => p.id === id) || (() => { const x = [...curTrip(), ...trip].find((y) => y.id === id && y.custom); return x && placeOf(x); })();
  const CITY_WORDS = [['오사카', /osaka|오사카|大阪/i], ['교토', /kyoto|교토|京都/i], ['고베', /kobe|고베|神戸/i], ['나라', /\bnara\b|나라[현시]|奈良/i], ['도쿄', /tokyo|도쿄|東京/i], ['요코하마', /yokohama|요코하마|横浜/i],
    ['후쿠오카', /fukuoka|후쿠오카|福岡/i], ['삿포로', /sapporo|삿포로|札幌/i], ['나고야', /nagoya|나고야|名古屋/i], ['오키나와', /okinawa|오키나와|沖縄/i], ['히로시마', /hiroshima|히로시마|広島/i]];
  // 구글의 업종 이름(한국어) → 이 사이트의 종류. 위에서부터 먼저 맞는 것
  const CATEGORY_TYPES = [
    ['stay', /호텔|료칸|여관|게스트 ?하우스|호스텔|숙박|리조트|펜션|민박/],
    ['cafe', /카페|커피|디저트|베이커리|제과|아이스크림|찻집|빵집|도넛|케이크/],
    ['sight', /관광|명소|신사|사찰|사원|절$|성곽|^성$|공원|박물관|미술관|전망|타워|정원|온천|테마|유원지|랜드마크|다리|유적|수족관|동물원|해변|폭포/],
    ['shop', /상점|매장|쇼핑|백화점|마트|스토어|가게|쇼핑몰|시장|편의점|드러그|약국|서점|잡화|화장품|의류|기념품|완구|전자제품|면세/],
    ['food', /식당|음식|레스토랑|전문점|이자카야|라멘|스시|초밥|야키|우동|소바|술집|주점|비스트로|요리|고기|뷔페|푸드/],
  ];
  const guessCustom = (info, url) => {
    const at = info.lat != null && isFinite(+info.lat) ? { lat: +(+info.lat).toFixed(6), lng: +(+info.lng).toFixed(6) } : { lat: null, lng: null };
    const near = at.lat == null ? null : PLACES.filter(hasSpot).map((p) => [meters(p, at), p]).sort((a, b) => a[0] - b[0])[0];
    const text = `${info.category || ''} ${info.name || ''}`;
    return {
      name: info.name || '', type: (CATEGORY_TYPES.find(([, re]) => re.test(info.category || '')) || CATEGORY_TYPES.find(([, re]) => re.test(text)) || ['etc'])[0],
      city: (CITY_WORDS.find(([, re]) => re.test(info.address || '')) || [])[0] || (near && near[0] < 30000 ? near[1].city : ''),
      area: near && near[0] < 700 ? near[1].area : '', ...at, map: url, address: (info.address || '').replace(/^일본\s*/, ''), category: info.category || '',
    };
  };
  // PC 주소창의 긴 링크는 이름과 좌표가 주소 안에 있어 그대로 읽음
  const parseMapUrl = (url) => {
    const at = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const name = (url.match(/\/maps\/place\/([^/@?]+)/) || [])[1];
    if (!at || !name) return null;
    try { return { name: decodeURIComponent(name).replace(/\+/g, ' ').split(',')[0].trim(), lat: at[1], lng: at[2] }; } catch { return null; }
  };
  const customForm = (c) => `
    <label class="flabel">이름<input class="field" data-c="name" value="${esc(c.name)}" maxlength="80" placeholder="가게 · 장소 이름"></label>
    <label class="flabel">종류<select class="field" data-c="type">${Object.keys(TYPES).filter((t) => t !== 'tour').map((t) => `<option value="${t}"${t === c.type ? ' selected' : ''}>${TYPES[t].label}</option>`).join('')}</select></label>
    <div class="fcols"><label class="flabel">도시<input class="field" data-c="city" value="${esc(c.city)}" maxlength="20" placeholder="오사카" list="citylist"></label>
      <label class="flabel">지역<input class="field" data-c="area" value="${esc(c.area)}" maxlength="30" placeholder="난바·도톤보리" list="arealist"></label></div>
    <datalist id="citylist">${uniq(PLACES.map((p) => p.city)).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
    <datalist id="arealist">${uniq(PLACES.map((p) => p.area)).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  const readForm = () => Object.fromEntries([...$('sheet').querySelectorAll('[data-c]')].map((el) => [el.dataset.c, el.value.trim()]));

  const showImport = () => {
    showSheet(`<div class="grab"></div><button type="button" class="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5 5 19"/></svg></button>
      <p class="kind">내 여행에 장소 추가</p><h2>목록에 없는 장소 가져오기</h2>
      <p class="where">구글맵에서 장소를 열고 “공유 → 링크 복사”로 복사한 링크를 붙여넣어 주세요. 이름 · 종류 · 위치를 자동으로 가져오고, 담기 전에 고칠 수 있어요.</p>
      <form data-addlink>
        <label class="flabel">구글맵 링크<input class="field" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/…" autocomplete="off"></label>
        <div class="actions"><button type="submit" class="primary">가져오기</button></div>
      </form>`);
    setTimeout(() => { const i = $('sheet').querySelector('[data-addlink] input'); if (i) i.focus(); }, 350);
  };
  let draft = null; // 추가하려는 장소 (저장 전)
  const showDraft = (c, note) => {
    draft = c;
    showSheet(`<div class="grab"></div><button type="button" class="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5 5 19"/></svg></button>
      <p class="kind">내 여행에 장소 추가</p><h2>${c.lat != null ? '이 정보로 담을까요?' : '장소 정보를 입력해 주세요'}</h2>
      <p class="where">${esc(note)}</p>${customForm(c)}
      <div class="actions"><button type="button" class="primary" data-addcustom>내 여행에 담기</button></div>`);
  };
  const addByLink = async (raw, btn) => {
    const url = (raw.match(/https?:\/\/\S+/) || [])[0];
    if (!url || !/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\./.test(url)) return toast('구글맵 링크를 붙여넣어 주세요');
    let info = parseMapUrl(url);
    if (!info && RESOLVER) {
      btn.disabled = true; btn.innerHTML = '<span><i class="spin"></i>가져오는 중…</span>';
      try { const j = await (await fetch(`${RESOLVER}?url=${encodeURIComponent(url)}`)).json(); if (!j.error && j.name) info = j; } catch {}
      btn.disabled = false; btn.textContent = '가져오기';
    }
    if (info && info.lat != null) { // 이미 이 사이트에 있는 장소면 그걸 담음 (팁까지 보이도록)
      const saved = PLACES.filter(hasSpot).find((p) => meters(p, { lat: +info.lat, lng: +info.lng }) < 40);
      if (saved) { if (!inTrip(saved.id)) { trip = [...trip, { id: saved.id, day: 0, time: '', end: '', memo: '' }]; saveTrip(); } closeSheet(); render(); return toast(`“${saved.name}” — 저장된 장소로 담았어요`); }
    }
    const c = guessCustom(info || {}, url);
    showDraft(c, info ? [c.category, c.address].filter(Boolean).join(' · ') || '이름과 종류를 확인해 주세요. 고칠 수 있어요.'
      : '이 링크에서는 정보를 자동으로 가져오지 못했어요. 이름과 종류를 직접 입력해 주세요. (위치를 몰라 동선 지도에는 표시되지 않아요)');
  };

  // 직접 추가한 장소의 상세: 이름 · 종류 · 도시 · 지역을 고칠 수 있음 (공유받은 여행에서는 보기만)
  const openCustom = (p) => {
    state.p = p.id; writeHash();
    const mine = !state.shared && inTrip(p.id), t = TYPES[p.type] || TYPES.etc;
    const d = state.me && hasSpot(p) ? meters(state.me, p) : null;
    showSheet(`<div class="grab"></div><button type="button" class="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5 5 19"/></svg></button>
      <p class="kind">${esc(t.label)} · 직접 추가한 장소</p><h2>${esc(p.name)}</h2>
      <p class="where">${esc([p.city, p.area].filter(Boolean).join(' · ') || '지역 미정')}${d != null ? ` · 여기서 ${fmtDist(d)}` : ''}</p>
      ${p.category ? `<div class="tags">${p.category.split(',').map((x) => `<span>${esc(x.trim())}</span>`).join('')}</div>` : ''}
      ${p.address ? `<h3>주소</h3><p class="addr">${esc(p.address)}</p>` : ''}
      ${hasSpot(p) ? '' : '<p class="addr" style="margin-top:14px">위치 정보가 없어 지도에는 표시되지 않아요.</p>'}
      ${mine ? `<h3>정보 수정</h3>${customForm(p)}` : ''}
      <div class="actions">
        ${mine ? '<button type="button" class="primary" data-savecustom>수정 저장</button>' : ''}
        ${p.map ? `<a ${mine ? '' : 'class="primary"'} href="${esc(p.map)}" target="_blank" rel="noopener">Google 지도에서 열기</a>` : ''}
        ${hasSpot(p) ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">길찾기</a>` : ''}
        ${mine ? '<button type="button" data-trip class="tripadd on">내 여행에서 빼기</button>' : ''}
      </div>`);
  };

  const grow = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }; // 메모 칸은 내용만큼 늘어남
  const ICON = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-10.4A6.5 6.5 0 0 1 12 4a6.5 6.5 0 0 1 6.5 6.6C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.3"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M8 7l4-4 4 4M6 11.5H5a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 5 20.5h14a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5h-1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.600a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 11.400A1.7 1.7 0 0 0 9 20h6a1.7 1.7 0 0 0 1.7-1.600L17.5 7M10 11v5M14 11v5"/></svg>',
  };
  const IMPORT_BTN = '<button type="button" data-act="import"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span><span class="long">목록에 없는 </span>장소 가져오기</span></button>';
  let editing = false;
  const picked = new Set();
  const renderTrip = () => {
    const ro = !!state.shared, list = curTrip().filter(placeOf);
    const lost = curTrip().length - list.length;
    const dayOptions = (d) => Array.from({ length: 15 }, (_, i) => `<option value="${i}"${i === d ? ' selected' : ''}>${dayLabel(i)}</option>`).join('');
    const row = (x, n, first, last, color) => { // color: 동선 지도와 같은 일차별 색
      const p = placeOf(x), t = TYPES[p.type] || TYPES.etc, tour = p.type === 'tour';
      return `<div class="trow${editing && picked.has(x.id) ? ' sel' : ''}" data-id="${esc(x.id)}"${editing ? ` role="checkbox" aria-checked="${picked.has(x.id)}" tabindex="0"` : ''}>
        ${editing ? `<span class="tcheck">${ICON.trash}</span>` : `<span class="tno" style="--c:${color}">${n}</span>`}
        <div class="tmain">
          <button type="button" class="tname" data-open>${p.pick ? STAR : ''}${esc(p.name)}</button>
          <small>${esc([t.label, p.city, p.area].filter(Boolean).join(' · '))}</small>
          ${p.stops ? stopsHTML(p, 'sub') : ''}
          ${ro ? `${x.time || x.end ? `<p class="tnote"><b>${esc([x.time && (tour ? '출발 ' : '') + x.time, x.end && '도착 ' + x.end].filter(Boolean).join(' – '))}</b></p>` : ''}${x.memo ? `<p class="tmemo-ro">${esc(x.memo)}</p>` : ''}` : `<div class="tfields${tour ? ' tour' : ''}">
            <select data-day aria-label="일차">${dayOptions(x.day)}</select>
            ${tour ? `<label class="tlabel">출발<input type="time" data-time value="${esc(x.time)}" aria-label="출발 시간"></label><label class="tlabel">도착<input type="time" data-end value="${esc(x.end)}" aria-label="도착 시간"></label>` : `<input type="time" data-time value="${esc(x.time)}" aria-label="시간">`}
          </div>
          <textarea class="tmemo" data-memo rows="1" maxlength="1000" placeholder="메모" aria-label="메모">${esc(x.memo)}</textarea>`}
        </div>
        ${ro || editing ? '' : dragReady !== false ? `<button type="button" class="thandle" aria-label="끌어서 순서 · 일차 바꾸기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg></button>` : `<div class="tmove"><button type="button" data-up ${first ? 'disabled' : ''} aria-label="위로">▲</button><button type="button" data-down ${last ? 'disabled' : ''} aria-label="아래로">▼</button></div>`}
      </div>`;
    };
    $('trip').classList.toggle('editing', editing);
    $('trip').innerHTML = `
      <div class="triphead"><h2>${ro ? '공유받은 여행' : '내 여행'}</h2><span>${list.length ? countText(list.map(placeOf)) : ''}</span></div>
      ${ro ? `<div class="sharedbox"><p>공유 링크로 받은 여행 코스예요. 복사하면 일차 · 시간 · 메모까지 그대로 내 여행에 담기고, 자유롭게 고칠 수 있어요.</p>
        <div class="tripbar"><button type="button" class="fill" data-act="copy">내 여행으로 복사</button><button type="button" data-act="closeshared">닫기</button></div></div>` : ''}
      ${lost ? `<p class="status">목록에서 사라진 장소 ${lost}곳은 표시하지 않았어요.</p>` : ''}
      ${!list.length ? `<p class="empty">아직 담은 장소가 없어요.<br>장소를 열고 “내 여행에 담기”를 눌러보세요.</p>${ro ? '' : `<div class="tripbar center">${IMPORT_BTN}</div>`}` : `
        <div class="tripbar main">
          <button type="button" class="fill" data-act="map">${ICON.pin}동선 지도로 보기</button>
          ${ro ? '' : `<button type="button" data-act="share">${ICON.share}공유 링크</button>`}
        </div>
        ${ro ? '' : `<div class="tripbar sub">${IMPORT_BTN}<button type="button" role="switch" aria-checked="${editing}" data-act="edit" class="tswitch${editing ? ' on' : ''}">${ICON.trash}삭제 모드<i class="sw"></i></button></div>`}
        ${tripDays(list).map(([d, xs], di) => `<section class="grp"><header><h2>${dayLabel(d)}</h2><span>${countText(xs.map(placeOf))}</span></header>
          <div class="card tcard" data-day="${d}">${xs.map((x, i) => row(x, i + 1, i === 0, i === xs.length - 1, ROUTE_COLORS[di % ROUTE_COLORS.length])).join('')}</div></section>`).join('')}
        ${ro || editing || dragReady === false ? '' : (() => { const next = Math.min(14, Math.max(0, ...list.map((x) => x.day)) + 1); return list.some((x) => x.day === next) ? '' : `<section class="grp newday"><header><h2>${dayLabel(next)}</h2></header><div class="card tcard" data-day="${next}"><p class="drophint">여기로 끌어다 놓으면 ${dayLabel(next)}가 돼요</p></div></section>`; })()}
        ${editing ? `<div class="tripedit"><button type="button" data-act="delpicked" ${picked.size ? '' : 'disabled'}>선택 삭제${picked.size ? ` (${picked.size})` : ''}</button><button type="button" data-act="delall">전체 삭제</button></div>` : ''}`}`;
    $('trip').querySelectorAll('.tmemo').forEach(grow);
    if (!ro && !editing && list.length) enableDrag();
  };

  $('sheet').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target.closest('[data-addlink]'); if (f) addByLink(f.querySelector('input').value, f.querySelector('button[type=submit]')); });
  const tripItem = (el) => trip.find((x) => x.id === el.closest('.trow').dataset.id);
  $('trip').addEventListener('click', (e) => {
    const act = (e.target.closest('[data-act]') || {}).dataset?.act, rowEl = e.target.closest('.trow');
    if (act === 'map') { state.plan = true; state.view = 'map'; render(); return window.scrollTo({ top: $('bar').offsetTop, behavior: 'smooth' }); }
    if (act === 'share') return share('일본 여행 코스', location.origin + location.pathname + '#trip=' + encodeTrip(trip));
    if (act === 'import') return showImport();
    if (act === 'edit') { editing = !editing; picked.clear(); return renderTrip(); }
    if (act === 'delpicked') { trip = trip.filter((x) => !picked.has(x.id)); picked.clear(); if (!trip.length) editing = false; saveTrip(); return renderTrip(); }
    if (act === 'delall') { if (!confirm('내 여행에 담은 장소를 모두 삭제할까요?')) return; trip = []; picked.clear(); editing = false; saveTrip(); return renderTrip(); }
    if (act === 'closeshared') { state.shared = null; return render(); }
    if (act === 'copy') {
      if (!trip.length) return copyShared('replace');
      return showSheet(`<div class="grab"></div><button type="button" class="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5 5 19"/></svg></button>
        <p class="kind">내 여행으로 복사</p><h2>이미 담아 둔 여행이 있어요</h2><p class="where">내 여행에 ${trip.length}개가 담겨 있어요. 어떻게 할까요?</p>
        <div class="actions"><button type="button" class="primary" data-copy="append">기존 여행 뒤에 추가</button><button type="button" data-copy="replace" style="grid-column:1/-1">기존 여행을 지우고 이 코스로 대체</button></div>`);
    }
    if (!rowEl) return;
    if (editing) { const id = rowEl.dataset.id; picked.has(id) ? picked.delete(id) : picked.add(id); return renderTrip(); } // 삭제 모드: 항목 어디를 눌러도 삭제 대상으로 고르기/풀기
    if (e.target.closest('[data-open]')) return openSheet(rowEl.dataset.id);
    const dir = e.target.closest('[data-up]') ? -1 : e.target.closest('[data-down]') ? 1 : 0;
    if (dir) { // 같은 일차 안에서 앞뒤 항목과 자리를 바꿈
      const me = tripItem(e.target), same = trip.filter((x) => x.day === me.day), other = same[same.indexOf(me) + dir];
      if (!other) return;
      const a = trip.indexOf(me), b = trip.indexOf(other);
      [trip[a], trip[b]] = [trip[b], trip[a]];
      saveTrip(); renderTrip();
    }
  });
  $('trip').addEventListener('change', (e) => {
    const x = tripItem(e.target); if (!x) return;
    if (e.target.matches('[data-day]')) { x.day = +e.target.value; trip = [...trip.filter((y) => y !== x), x]; saveTrip(); return renderTrip(); } // 옮긴 일차의 맨 뒤로
    if (e.target.matches('[data-time]')) { x.time = e.target.value; saveTrip(); }
    if (e.target.matches('[data-end]')) { x.end = e.target.value; saveTrip(); }
  });
  $('trip').addEventListener('input', (e) => { if (e.target.matches('[data-memo]')) { tripItem(e.target).memo = e.target.value; saveTrip(); grow(e.target); } }); // 입력 중에는 다시 그리지 않음(포커스 유지)
  const copyShared = (mode) => {
    const add = state.shared || [];
    trip = cleanTrip(mode === 'replace' ? add : [...trip, ...add.filter((x) => !inTrip(x.id))]);
    state.shared = null; saveTrip(); closeSheet(); render(); toast('내 여행에 담았어요');
  };

  // ── 상세 시트
  let sheetOpen = false;
  const showSheet = (html) => {
    if (html != null) $('sheet').innerHTML = html;
    sheetOpen = true;
    $('sheet').hidden = $('scrim').hidden = false;
    $('sheet').scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => { $('sheet').classList.add('open'); $('scrim').classList.add('open'); }));
    document.body.classList.add('locked');
  };
  const openSheet = (id) => {
    const p = findPlace(id);
    if (!p) return;
    if (p.custom) return openCustom(p);
    state.p = id; writeHash();
    const t = TYPES[p.type] || { label: '', tip: '팁' };
    const d = state.me && hasSpot(p) ? meters(state.me, p) : null;
    const site = /myrealtrip/.test(p.link || '') ? '마이리얼트립' : /klook/.test(p.link || '') ? '클룩' : /kkday/.test(p.link || '') ? 'KKday' : '';
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}${d != null && d < NEAR ? '&travelmode=walking' : ''}`;
    $('sheet').innerHTML = `
      <div class="grab"></div>
      <button type="button" class="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5 5 19"/></svg></button>
      <p class="kind">${esc(t.label)}</p>
      <h2>${p.pick ? STAR : ''}${esc(p.name)}</h2>
      <p class="where">${esc(p.city)} · ${esc(p.area)}${p.by ? ' · ' + esc(p.by) : ''}${d != null ? ` · 여기서 ${fmtDist(d)}` : ''}</p>
      ${p.pick || (p.tags || []).length ? `<div class="tags">${p.pick ? `<span class="picktag">${STAR}추천</span>` : ''}${(p.tags || []).map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      ${p.tip ? `<h3>${esc(t.tip)}</h3><p class="tiptext">${esc(p.tip)}</p>` : ''}
      ${p.stops ? `<h3>코스</h3>${stopsHTML(p)}` : ''}
      ${p.address ? `<h3>주소</h3><p class="addr">${esc(p.address)}</p>` : ''}
      <div class="actions">
        ${hasSpot(p) ? `<a class="primary" href="${esc(p.map)}" target="_blank" rel="noopener">Google 지도에서 열기</a>
        <a href="${esc(dir)}" target="_blank" rel="noopener">길찾기</a>` : p.link ? `<a class="primary" href="${esc(p.link)}" target="_blank" rel="noopener">${site ? site + '에서 보기' : '투어 페이지 열기'}</a>` : ''}
        ${p.stops ? '<button type="button" data-route>코스 지도로 보기</button>' : ''}
        <button type="button" data-share${hasSpot(p) || p.stops ? '' : ' style="grid-column:1/-1"'}>공유</button>
        <button type="button" data-trip class="tripadd${inTrip(p.id) ? ' on' : ''}">${inTrip(p.id) ? '✓ 내 여행에 담김 · 빼기' : '내 여행에 담기'}</button>
      </div>`;
    showSheet();
  };
  const closeSheet = () => {
    if (!sheetOpen) return;
    sheetOpen = false;
    if (state.p) { state.p = ''; writeHash(); }
    $('sheet').classList.remove('open'); $('scrim').classList.remove('open');
    document.body.classList.remove('locked');
    setTimeout(() => { if (!sheetOpen) $('sheet').hidden = $('scrim').hidden = true; }, 500);
  };

  let toastTimer;
  const toast = (msg, ms = 1800) => {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('open'); setTimeout(() => (el.hidden = true), 400); }, ms);
  };
  const share = async (title, url) => {
    try {
      if (navigator.share) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); toast('링크를 복사했어요'); }
    } catch (e) { if (e.name !== 'AbortError') prompt('이 링크를 복사하세요', url); }
  };

  // ── 내 주변
  const setStatus = (msg) => { $('status').textContent = msg || ''; $('status').hidden = !msg; };
  // 위치는 한 번 받고 끝내지 않고 계속 지켜봄: 처음엔 대략적인 값이 오고 몇 초 뒤 GPS 값으로 좁혀지는 경우가 많음
  let watchId = null;
  const stopWatch = () => { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; };
  const locate = () => {
    const btn = $('near');
    if (state.me || watchId != null) { stopWatch(); state.me = null; btn.classList.remove('busy'); btn.setAttribute('aria-pressed', 'false'); setStatus(''); render(); return; }
    if (!navigator.geolocation) return setStatus('이 브라우저는 위치 기능을 지원하지 않아요.');
    btn.classList.add('busy');
    watchId = navigator.geolocation.watchPosition((pos) => {
      const me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      const first = !state.me;
      if (!first && meters(state.me, me) < 30 && me.acc > state.me.acc * 0.6) return; // 의미 있는 변화만 반영
      state.me = me;
      if (first) {
        btn.classList.remove('busy');
        btn.setAttribute('aria-pressed', 'true');
        state.city = state.area = ''; // 주변 추천은 전체 장소 기준이 자연스러우므로 지역 필터는 해제
      }
      quiet = !first; render(); quiet = false;
      const nearest = filtered()[0];
      if (nearest && nearest.d > 50000) setStatus(`저장한 장소 근처가 아니에요. 가장 가까운 ${nearest.name}까지 약 ${fmtDist(nearest.d)}. 일본에 도착하면 다시 눌러보세요.`);
      else if (me.acc > 300) setStatus(`지금 위치는 약 ${fmtDist(me.acc)}까지 틀릴 수 있어요. PC나 Wi-Fi로 잡은 위치는 부정확합니다. 휴대폰에서 GPS(정확한 위치)를 켜고 열면 정확해져요.`);
      else setStatus('');
      if (first) window.scrollTo({ top: $('bar').offsetTop, behavior: 'smooth' });
    }, (err) => {
      if (state.me) return; // 이미 위치를 받은 뒤의 일시적 오류는 무시
      stopWatch();
      btn.classList.remove('busy');
      setStatus(err.code === 1 ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 위치 접근을 허용한 뒤 다시 눌러주세요.' : '현재 위치를 찾지 못했어요. 잠시 후 다시 시도해주세요.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };

  // ── 칩 줄 가로 스크롤: 터치는 기본 동작, 마우스는 휠·드래그로. 더 있는 쪽 가장자리는 흐리게
  const edges = (el) => {
    el.classList.toggle('more-l', el.scrollLeft > 4);
    el.classList.toggle('more-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };
  for (const el of document.querySelectorAll('.chips')) {
    let startX = null, startLeft = 0, dragged = false;
    el.addEventListener('scroll', () => edges(el), { passive: true });
    el.addEventListener('wheel', (e) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { startX = e.clientX; startLeft = el.scrollLeft; dragged = false; } });
    window.addEventListener('pointermove', (e) => {
      if (startX == null) return;
      if (Math.abs(e.clientX - startX) > 5) dragged = true;
      if (dragged) el.scrollLeft = startLeft - (e.clientX - startX);
    });
    window.addEventListener('pointerup', () => { startX = null; });
    el.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true); // 드래그 끝의 클릭은 선택으로 치지 않음
  }
  window.addEventListener('resize', () => document.querySelectorAll('.chips').forEach(edges));

  // ── 이벤트
  $('theme').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('jt-theme', next); } catch {}
    syncThemeColor();
    if (map) map.setStyle(mapStyle()); // style.load 에서 한국어 지명·역 이름을 다시 입힘
  });
  $('near').addEventListener('click', locate);
  $('q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  $('cities').addEventListener('click', (e) => { state.route = ''; const b = e.target.closest('button'); if (b) { state.city = b.dataset.city; state.area = ''; render(); } });
  $('areas').addEventListener('click', (e) => { state.route = ''; const b = e.target.closest('button'); if (b) { state.area = b.dataset.area; render(); } });
  $('types').addEventListener('click', (e) => { state.route = ''; const b = e.target.closest('button'); if (b) { state.type = b.dataset.type; render(); } });
  $('tags').addEventListener('click', (e) => { state.route = ''; const b = e.target.closest('button'); if (!b) return; if ('pick' in b.dataset) state.pick = !state.pick; else state.tag = state.tag === b.dataset.tag ? '' : b.dataset.tag; render(); });
  $('view').addEventListener('click', (e) => { state.route = '';
    const b = e.target.closest('button'); if (!b) return;
    state.plan = false;
    state.view = b.dataset.v;
    render();
  });
  $('list').addEventListener('click', (e) => { const b = e.target.closest('.item'); if (b) openSheet(b.dataset.id); });
  $('scrim').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target.closest('.close')) return closeSheet();
    if (e.target.closest('[data-route]')) { state.route = state.p; state.view = 'map'; closeSheet(); render(); return window.scrollTo({ top: $('bar').offsetTop, behavior: 'smooth' }); }
    if (e.target.closest('[data-addcustom]') || e.target.closest('[data-savecustom]')) {
      const v = readForm();
      if (!v.name) return $('sheet').querySelector('[data-c=name]').focus();
      if (e.target.closest('[data-addcustom]')) {
        const c = cleanCustom({ ...draft, ...v });
        trip = [...trip, { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), day: 0, time: '', end: '', memo: '', custom: c }];
        draft = null; toast('내 여행에 담았어요');
      } else {
        const x = trip.find((y) => y.id === state.p); if (x) x.custom = cleanCustom({ ...x.custom, ...v });
        toast('수정했어요');
      }
      saveTrip(); closeSheet(); return render();
    }
    if (e.target.closest('[data-copy]')) return copyShared(e.target.closest('[data-copy]').dataset.copy);
    if (e.target.closest('[data-trip]')) {
      const id = state.p, had = inTrip(id);
      if (had && trip.find((x) => x.id === id).custom) { trip = trip.filter((x) => x.id !== id); saveTrip(); closeSheet(); toast('내 여행에서 뺐어요'); return render(); } // 직접 추가한 장소는 빼면 사라짐
      trip = had ? trip.filter((x) => x.id !== id) : [...trip, { id, day: 0, time: '', end: '', memo: '' }];
      saveTrip(); toast(had ? '내 여행에서 뺐어요' : '내 여행에 담았어요');
      const b = e.target.closest('[data-trip]'); b.classList.toggle('on', !had); b.textContent = had ? '내 여행에 담기' : '✓ 내 여행에 담김 · 빼기';
      if (state.view === 'trip') renderTrip();
      return;
    }
    if (e.target.closest('[data-share]')) {
      const p = findPlace(state.p);
      share(`${p.name} — 일본 여행 정보`, location.origin + location.pathname + '#p=' + encodeURIComponent(p.id));
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  window.addEventListener('hashchange', () => { readHash(); render(); if (state.p) openSheet(state.p); });
  new IntersectionObserver(([en]) => $('bar').classList.toggle('stuck', en.intersectionRatio < 1), { threshold: [1], rootMargin: '-1px 0px 0px 0px' }).observe($('bar'));

  const syncThemeColor = () => document.querySelector('meta[name="theme-color"]').setAttribute('content', isDark() ? '#000000' : '#ffffff');
  // 지역 제목이 붙을 위치 = 상단 고정 영역의 실제 높이
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px')).observe($('bar'));

  // ── 시작
  tripBadge();
  syncThemeColor();
  $('total').textContent = `${uniq(PLACES.map((p) => p.city)).join(' · ')}, ${countText(PLACES)}.`;
  readHash();
  render();
  if (state.p) openSheet(state.p);
})();
