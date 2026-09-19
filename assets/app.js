(() => {
  const PLACES = window.PLACES || [];
  const TYPES = {
    food: { label: '음식점', tip: '추천 메뉴 · 코멘트', color: '#F2542D' },
    cafe: { label: '카페·디저트', tip: '추천 메뉴 · 코멘트', color: '#F5A524' },
    shop: { label: '쇼핑', tip: '쇼핑 팁', color: '#D6409F' },
    stay: { label: '숙소', tip: '숙소 메모', color: '#5B5BD6' },
    sight: { label: '관광지', tip: '관광 팁', color: '#1FA971' },
    tour: { label: '투어', tip: '투어 팁', color: '#12A5B8' },
    etc: { label: '기타', tip: '메모', color: '#8E8E93' },
  };
  const WALK_NEAR = 800, NEAR = 3000; // m

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = (a) => [...new Set(a)];

  const state = { city: '', area: '', type: '', tag: '', q: '', p: '', view: 'list', me: null };

  // ── URL ↔ state (필터 상태와 열린 장소가 그대로 공유 링크가 됨)
  const readHash = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    for (const k of ['city', 'area', 'type', 'tag', 'p']) state[k] = h.get(k) || '';
    state.view = h.get('view') === 'map' ? 'map' : 'list';
  };
  const hashFor = (s) => {
    const h = new URLSearchParams();
    for (const k of ['city', 'area', 'type', 'tag', 'p']) if (s[k]) h.set(k, s[k]);
    if (s.view === 'map') h.set('view', 'map');
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

  // ── 필터
  // skip: 무시할 필터 (범례·태그 칩은 자기 자신의 필터를 빼고 후보를 계산)
  const filtered = (skip = '') => {
    const q = state.q.trim().toLowerCase();
    let out = PLACES.filter((p) =>
      (!state.city || p.city === state.city) &&
      (!state.area || p.area === state.area) &&
      (skip === 'type' || !state.type || p.type === state.type) &&
      (skip === 'tag' || !state.tag || (p.tags || []).includes(state.tag)) &&
      (!q || [p.name, p.tip, p.area, p.city, p.address, ...(p.tags || [])].join(' ').toLowerCase().includes(q)));
    if (state.me) {
      out = out.map((p) => ({ ...p, d: meters(state.me, p) })).sort((a, b) => a.d - b.d);
    }
    return out;
  };

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
    $('tags').innerHTML = tags.map((t) => `<button type="button" data-tag="${esc(t)}" class="${t === state.tag ? 'on' : ''}">${esc(t)}</button>`).join('');

    $('types').innerHTML = ['', ...types].map((t) => `<button type="button" data-type="${t}" class="${t === state.type ? 'on' : ''}">${t ? TYPES[t].label : '모든 종류'}</button>`).join('');
  };

  // ── 목록
  let grouped = false;
  const itemHTML = (p, i) => `
    <button type="button" class="item" data-id="${esc(p.id)}" style="animation-delay:${Math.min(i, 12) * 25}ms">
      <span class="name">${esc(p.name)}</span>
      ${p.d != null ? `<span class="dist">${fmtDist(p.d)}${p.d < NEAR ? `<small>도보 ${walkMin(p.d)}분</small>` : ''}</span>` : ''}
      ${p.tip ? `<span class="tip">${esc(p.tip)}</span>` : ''}
      <span class="meta"><b>${esc((TYPES[p.type] || {}).label || '')}</b>${esc(['', ...(grouped ? [] : [p.area]), ...(p.tags || [])].join(' · '))}</span>
    </button>`;

  const renderList = () => {
    const items = filtered();
    $('count').textContent = state.me ? `${items.length}곳 · 가까운 순` : `${items.length}곳`;
    if (!items.length) { $('list').innerHTML = '<p class="empty">조건에 맞는 장소가 없어요.</p>'; return items; }

    let html = '';
    grouped = !state.me && !state.area;
    if (state.me) {
      const groups = [['걸어서 10분 안쪽', (p) => p.d <= WALK_NEAR], ['3km 이내', (p) => p.d > WALK_NEAR && p.d <= NEAR], ['조금 먼 곳', (p) => p.d > NEAR]];
      let n = 0;
      for (const [title, test] of groups) {
        const g = items.filter(test);
        if (g.length) html += `<h2 class="group">${title}</h2>` + g.map((p) => itemHTML(p, n++)).join('');
      }
    } else if (!state.area) {
      // 지역별로 묶어 보여주기
      const key = (p) => (state.city ? p.area : `${p.city} · ${p.area}`);
      let n = 0;
      for (const k of uniq(items.map(key))) html += `<h2 class="group">${esc(k)}</h2>` + items.filter((p) => key(p) === k).map((p) => itemHTML(p, n++)).join('');
    } else {
      html = items.map(itemHTML).join('');
    }
    $('list').innerHTML = html;
    return items;
  };

  // ── 지도 (처음 열 때만 MapLibre 로드 · OpenFreeMap 벡터 타일 · 지명은 한국어 우선)
  const DARK = matchMedia('(prefers-color-scheme: dark)').matches; // 지도도 페이지와 같은 모드로
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
        paint: { 'text-color': DARK ? '#8ab4f8' : '#2f5d9e', 'text-halo-color': DARK ? '#111' : '#fff', 'text-halo-width': 1.6 },
      });
    } catch {}
  };
  // 라벨이 다른 핀이나 앞 순서 라벨을 가리면 숨기고 점만 남김 (확대하면 나타남)
  const declutter = () => {
    const pts = markers.map((m) => map.project(m.getLngLat()));
    const taken = pts.map((pt, i) => [pt.x - 9, pt.y - 9, pt.x + 9, pt.y + 9, i]);
    markers.forEach((m, i) => {
      if (!m.label) return;
      const w = m.label.offsetWidth / 2 + 3, h = m.label.offsetHeight;
      const r = [pts[i].x - w, pts[i].y - h - 15, pts[i].x + w, pts[i].y - 11];
      const hit = taken.some((t) => t[4] !== i && r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
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
        container: 'map', style: `https://tiles.openfreemap.org/styles/${DARK ? 'dark' : 'positron'}`,
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
      map.on('style.load', koreanize);
      map.on('move', declutter);
      legend = Object.assign(document.createElement('div'), { className: 'legend' });
      legend.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        state.type = state.type === b.dataset.type ? '' : b.dataset.type;
        render();
      });
      $('map').append(legend);
    }
    map.resize();
    markers.forEach((m) => { m.remove(); if (m.labelMarker) m.labelMarker.remove(); });
    markers = [];

    // 범례는 종류 필터와 무관하게 이 지역에 있는 모든 종류를 보여주고, 누르면 그 종류만 남김
    const inScope = uniq(filtered('type').map((p) => p.type));
    legend.innerHTML = Object.keys(TYPES).filter((t) => inScope.includes(t)).map((t) =>
      `<button type="button" data-type="${t}" class="${state.type && state.type !== t ? 'dim' : ''}" style="--c:${TYPES[t].color}"><i></i>${TYPES[t].label}</button>`).join('');

    const box = new maplibregl.LngLatBounds();
    for (const p of items) {
      const t = TYPES[p.type] || TYPES.etc;
      const make = (cls, html) => {
        const el = Object.assign(document.createElement('button'), { type: 'button', className: cls, title: p.name, innerHTML: html });
        el.style.setProperty('--c', t.color);
        el.addEventListener('click', (e) => { e.stopPropagation(); openSheet(p.id); });
        return el;
      };
      const m = new maplibregl.Marker({ element: make('pin', '') }).setLngLat([p.lng, p.lat]).addTo(map);
      m.label = make('mk-label', `<small>${esc([t.label, (p.tags || [])[0]].filter(Boolean).join(' / '))}</small>${esc(p.name)}`);
      m.labelMarker = new maplibregl.Marker({ element: m.label, anchor: 'bottom', offset: [0, -13] }).setLngLat([p.lng, p.lat]).addTo(map);
      markers.push(m);
      box.extend([p.lng, p.lat]);
    }
    showHere();
    if (quiet) { declutter(); return; } // 위치만 갱신된 경우엔 보던 화면을 유지
    if (state.me && items[0] && items[0].d < 30000) map.jumpTo({ center: [state.me.lng, state.me.lat], zoom: 15 });
    else if (items.length) map.fitBounds(box, { padding: { top: 110, bottom: 64, left: 64, right: 64 }, maxZoom: 16, duration: 0 });
    declutter();
  };

  let quiet = false; // true: 위치 갱신으로 인한 조용한 다시 그리기 (애니메이션·지도 이동 없음)
  const render = () => {
    $('list').classList.toggle('still', quiet);
    renderFilters();
    const items = renderList();
    for (const b of $('view').children) b.classList.toggle('on', b.dataset.v === state.view);
    $('list').hidden = state.view !== 'list';
    $('map').hidden = state.view !== 'map';
    if (state.view === 'map') renderMap(items);
    document.querySelectorAll('.chips').forEach(edges);
    writeHash();
  };

  // ── 상세 시트
  const openSheet = (id) => {
    const p = PLACES.find((x) => x.id === id);
    if (!p) return;
    state.p = id; writeHash();
    const t = TYPES[p.type] || { label: '', tip: '팁' };
    const d = state.me ? meters(state.me, p) : null;
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}${d != null && d < NEAR ? '&travelmode=walking' : ''}`;
    $('sheet').innerHTML = `
      <div class="grab"></div>
      <button type="button" class="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5 5 19"/></svg></button>
      <p class="kind">${esc(t.label)}</p>
      <h2>${esc(p.name)}</h2>
      <p class="where">${esc(p.city)} · ${esc(p.area)}${d != null ? ` · 여기서 ${fmtDist(d)}` : ''}</p>
      ${(p.tags || []).length ? `<div class="tags">${p.tags.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      ${p.tip ? `<h3>${esc(t.tip)}</h3><p class="tiptext">${esc(p.tip)}</p>` : ''}
      ${p.address ? `<h3>주소</h3><p class="addr">${esc(p.address)}</p>` : ''}
      <div class="actions">
        <a class="primary" href="${esc(p.map)}" target="_blank" rel="noopener">Google 지도에서 열기</a>
        <a href="${esc(dir)}" target="_blank" rel="noopener">길찾기</a>
        <button type="button" data-share>공유</button>
      </div>`;
    $('sheet').hidden = $('scrim').hidden = false;
    $('sheet').scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => { $('sheet').classList.add('open'); $('scrim').classList.add('open'); }));
    document.body.classList.add('locked');
  };
  const closeSheet = () => {
    if (!state.p) return;
    state.p = ''; writeHash();
    $('sheet').classList.remove('open'); $('scrim').classList.remove('open');
    document.body.classList.remove('locked');
    setTimeout(() => { if (!state.p) $('sheet').hidden = $('scrim').hidden = true; }, 500);
  };

  let toastTimer;
  const toast = (msg) => {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('open'); setTimeout(() => (el.hidden = true), 400); }, 1800);
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
  $('near').addEventListener('click', locate);
  $('q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  $('cities').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.city = b.dataset.city; state.area = ''; render(); } });
  $('areas').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.area = b.dataset.area; render(); } });
  $('types').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.type = b.dataset.type; render(); } });
  $('tags').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.tag = state.tag === b.dataset.tag ? '' : b.dataset.tag; render(); } });
  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.view = b.dataset.v;
    render();
  });
  $('list').addEventListener('click', (e) => { const b = e.target.closest('.item'); if (b) openSheet(b.dataset.id); });
  $('scrim').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target.closest('.close')) return closeSheet();
    if (e.target.closest('[data-share]')) {
      const p = PLACES.find((x) => x.id === state.p);
      share(`${p.name} — 일본 여행 정보`, location.origin + location.pathname + '#p=' + encodeURIComponent(p.id));
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  window.addEventListener('hashchange', () => { readHash(); render(); if (state.p) openSheet(state.p); });
  new IntersectionObserver(([en]) => $('bar').classList.toggle('stuck', en.intersectionRatio < 1), { threshold: [1], rootMargin: '-1px 0px 0px 0px' }).observe($('bar'));

  // ── 시작
  $('total').textContent = `${uniq(PLACES.map((p) => p.city)).join(' · ')}, ${PLACES.length}곳.`;
  readHash();
  render();
  if (state.p) openSheet(state.p);
})();
