/**
 * Drives the dashboard's Analytics view: a range picker, a filter popover, a hand-built inline
 * SVG chart, and four tabbed breakdown cards. No charting library -- the project has no build
 * step/framework and none is vendored, so this extends the same vanilla-DOM approach the
 * per-link mini bar chart (app.js's showStats()) already uses.
 *
 * Does not perform auth/bootstrap itself -- app.js stays the single entry point and calls
 * Analytics.init() once, then Analytics.show() the first time the Analytics tab is opened.
 */
const Analytics = (function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const RANGE_OPTIONS = [
    { key: '24h', label: 'Last 24 hours' },
    { key: '7d', label: 'Last 7 days' },
    { key: '30d', label: 'Last 30 days' },
    { key: '3m', label: 'Last 3 months' },
    { key: '12m', label: 'Last 12 months' },
    { key: 'mtd', label: 'Month to Date' },
    { key: 'qtd', label: 'Quarter to Date' },
    { key: 'ytd', label: 'Year to Date' },
    { key: 'custom', label: 'Custom range' },
  ];

  // Fixed vocabulary -- coupled to leanks_analytics_parse_ua() / leanks_analytics_continent_map()
  // in user/plugins/leanks/includes/analytics.php. Keep both in sync if it ever changes.
  const DEVICE_OPTIONS = ['Desktop', 'Mobile', 'Tablet'];
  const BROWSER_OPTIONS = ['Chrome', 'Safari', 'Firefox', 'Edge', 'Samsung Internet', 'Opera', 'Other'];
  const OS_OPTIONS = ['iOS', 'macOS', 'Windows', 'ChromeOS', 'Android', 'Linux', 'Other'];
  const CONTINENT_OPTIONS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];

  // Icon paths sourced from Tabler Icons (MIT) -- see licenses/TABLER-ICONS.LICENSE. Samsung
  // Internet and Other (browsers), and Linux and Other (OS), have no real brand mark in Tabler's
  // free set, so they fall back to a generic globe/terminal/help-circle icon; ChromeOS reuses
  // the Chrome logo itself, since Chrome OS is Google's Chrome-centric platform and there's no
  // separate ChromeOS mark available either.
  const DEVICE_ICON_PATHS = {
    Desktop: '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10" /><path d="M7 20h10" /><path d="M9 16v4" /><path d="M15 16v4" />',
    Mobile: '<path d="M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14" /><path d="M11 4h2" /><path d="M12 17v.01" />',
    Tablet: '<path d="M5 4a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v16a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1v-16" /><path d="M11 17a1 1 0 1 0 2 0a1 1 0 0 0 -2 0" />',
  };
  const BROWSER_ICON_PATHS = {
    Chrome: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M12 9h8.4" /><path d="M14.598 13.5l-4.2 7.275" /><path d="M9.402 13.5l-4.2 -7.275" />',
    Safari: '<path d="M8 16l2 -6l6 -2l-2 6l-6 2" /><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />',
    Firefox: '<path d="M4.028 7.82a9 9 0 1 0 12.823 -3.4c-1.636 -1.02 -3.064 -1.02 -4.851 -1.02h-1.647" /><path d="M4.914 9.485c-1.756 -1.569 -.805 -5.38 .109 -6.17c.086 .896 .585 1.208 1.111 1.685c.88 -.275 1.313 -.282 1.867 0c.82 -.91 1.694 -2.354 2.628 -2.093c-1.082 1.741 -.07 3.733 1.371 4.173c-.17 .975 -1.484 1.913 -2.76 2.686c-1.296 .938 -.722 1.85 0 2.234c.949 .506 3.611 -1 4.545 .354c-1.698 .102 -1.536 3.107 -3.983 2.727c2.523 .957 4.345 .462 5.458 -.34c1.965 -1.52 2.879 -3.542 2.879 -5.557c-.014 -1.398 .194 -2.695 -1.26 -4.75" />',
    Edge: '<path d="M20.978 11.372a9 9 0 1 0 -1.593 5.773" /><path d="M20.978 11.372c.21 2.993 -5.034 2.413 -6.913 1.486c1.392 -1.6 .402 -4.038 -2.274 -3.851c-1.745 .122 -2.927 1.157 -2.784 3.202c.28 3.99 4.444 6.205 10.36 4.79" /><path d="M3.022 12.628c-.283 -4.043 8.717 -7.228 11.248 -2.688" /><path d="M12.628 20.978c-2.993 .21 -5.162 -4.725 -3.567 -9.748" />',
    'Samsung Internet': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M3.6 9h16.8" /><path d="M3.6 15h16.8" /><path d="M11.5 3a17 17 0 0 0 0 18" /><path d="M12.5 3a17 17 0 0 1 0 18" />',
    Opera: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M9 12a3 5 0 1 0 6 0a3 5 0 1 0 -6 0" />',
    Other: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 16v.01" /><path d="M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483" />',
  };
  const OS_ICON_PATHS = {
    iOS: '<path d="M8.286 7.008c-3.216 0 -4.286 3.23 -4.286 5.92c0 3.229 2.143 8.072 4.286 8.072c1.165 -.05 1.799 -.538 3.214 -.538c1.406 0 1.607 .538 3.214 .538s4.286 -3.229 4.286 -5.381c-.03 -.011 -2.649 -.434 -2.679 -3.23c-.02 -2.335 2.589 -3.179 2.679 -3.228c-1.096 -1.606 -3.162 -2.113 -3.75 -2.153c-1.535 -.12 -3.032 1.077 -3.75 1.077c-.729 0 -2.036 -1.077 -3.214 -1.077" /><path d="M12 4a2 2 0 0 0 2 -2a2 2 0 0 0 -2 2" />',
    macOS: '<path d="M8.286 7.008c-3.216 0 -4.286 3.23 -4.286 5.92c0 3.229 2.143 8.072 4.286 8.072c1.165 -.05 1.799 -.538 3.214 -.538c1.406 0 1.607 .538 3.214 .538s4.286 -3.229 4.286 -5.381c-.03 -.011 -2.649 -.434 -2.679 -3.23c-.02 -2.335 2.589 -3.179 2.679 -3.228c-1.096 -1.606 -3.162 -2.113 -3.75 -2.153c-1.535 -.12 -3.032 1.077 -3.75 1.077c-.729 0 -2.036 -1.077 -3.214 -1.077" /><path d="M12 4a2 2 0 0 0 2 -2a2 2 0 0 0 -2 2" />',
    Windows: '<path d="M17.8 20l-12 -1.5c-1 -.1 -1.8 -.9 -1.8 -1.9v-9.2c0 -1 .8 -1.8 1.8 -1.9l12 -1.5c1.2 -.1 2.2 .8 2.2 1.9v12.1c0 1.2 -1.1 2.1 -2.2 1.9l0 .1" /><path d="M12 5l0 14" /><path d="M4 12l16 0" />',
    ChromeOS: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M12 9h8.4" /><path d="M14.598 13.5l-4.2 7.275" /><path d="M9.402 13.5l-4.2 -7.275" />',
    Android: '<path d="M4 10l0 6" /><path d="M20 10l0 6" /><path d="M7 9h10v8a1 1 0 0 1 -1 1h-8a1 1 0 0 1 -1 -1v-8a5 5 0 0 1 10 0" /><path d="M8 3l1 2" /><path d="M16 3l-1 2" /><path d="M9 18l0 3" /><path d="M15 18l0 3" />',
    Linux: '<path d="M8 9l3 3l-3 3" /><path d="M13 15l3 0" /><path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12" />',
    Other: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 16v.01" /><path d="M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483" />',
  };

  let state = {
    range: '7d',
    start: '',
    end: '',
    filters: { link: '', country: '', continent: '', device: '', browser: '', os: '', referrer: '' },
    data: null,
    initialized: false,
  };
  let filterOptionsCache = null;
  let activeTab = {
    'an-rows-links': 'short_links',
    'an-rows-referrers': 'referrers',
    'an-rows-geo': 'countries',
    'an-rows-devices': 'devices',
  };
  let activeUtmField = 'source';

  // ---------- range picker ----------
  function updateRangeButtonLabel() {
    const opt = RANGE_OPTIONS.find((o) => o.key === state.range);
    let label = opt ? opt.label : 'Last 7 days';
    if (state.range === 'custom' && state.start && state.end) {
      label = state.start + ' – ' + state.end;
    }
    $('#an-range-btn').textContent = label;
  }

  function openRangePopover() {
    const rows = RANGE_OPTIONS.map((o) => `<button type="button" class="popover-item${o.key === state.range ? ' active' : ''}" data-range="${o.key}">${o.label}</button>`).join('');
    const customFields = state.range === 'custom' ? `
      <div class="popover-custom-range">
        <input type="date" id="an-range-start" value="${escAttr(state.start)}">
        <input type="date" id="an-range-end" value="${escAttr(state.end)}">
        <button type="button" class="btn btn-primary btn-sm" id="an-range-apply">Apply</button>
      </div>` : '';
    UI.openPopover($('#an-range-btn'), `<div class="popover-list">${rows}</div>${customFields}`, 'range');

    $$('.popover-item[data-range]').forEach((btn) => btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      if (state.range !== 'custom') {
        UI.closePopover();
        updateRangeButtonLabel();
        load();
      } else {
        openRangePopover();
      }
    }));
    $('#an-range-apply')?.addEventListener('click', () => {
      state.start = $('#an-range-start').value;
      state.end = $('#an-range-end').value;
      if (!state.start || !state.end) return;
      UI.closePopover();
      updateRangeButtonLabel();
      load();
    });
  }

  // ---------- filter picker ----------
  function updateFilterButtonLabel() {
    const count = Object.values(state.filters).filter(Boolean).length;
    $('#an-filter-btn').textContent = count > 0 ? `Filter (${count})` : 'Filter';
  }

  async function ensureFilterOptionsLoaded() {
    if (filterOptionsCache) return filterOptionsCache;
    try {
      const res = await Api.analyticsFilterOptions();
      filterOptionsCache = { countries: res.countries || [], referrers: res.referrers || [] };
    } catch (e) {
      filterOptionsCache = { countries: [], referrers: [] };
    }
    return filterOptionsCache;
  }

  function selectOptionsHtml(list, current, labelFn) {
    labelFn = labelFn || ((v) => v);
    return '<option value="">Any</option>' + list.map((v) => `<option value="${escAttr(v)}"${v === current ? ' selected' : ''}>${escHtml(labelFn(v))}</option>`).join('');
  }

  async function openFilterPopover() {
    UI.reserveKind('filter');
    const opts = await ensureFilterOptionsLoaded();
    if (UI.popoverKind() !== 'filter') return; // popover was closed while options were loading
    renderFilterPopoverBody(opts);
  }

  function renderFilterPopoverBody(opts) {
    const html = `
      <div class="filter-form">
        <div class="field">
          <label>Link</label>
          <input type="text" id="fl-link" placeholder="Search short link…" value="${escAttr(state.filters.link)}" autocomplete="off">
          <div class="popover-suggestions" id="fl-link-suggestions"></div>
        </div>
        <div class="field"><label>Country</label><select id="fl-country">${selectOptionsHtml(opts.countries, state.filters.country)}</select></div>
        <div class="field"><label>Continent</label><select id="fl-continent">${selectOptionsHtml(CONTINENT_OPTIONS, state.filters.continent)}</select></div>
        <div class="field"><label>Device</label><select id="fl-device">${selectOptionsHtml(DEVICE_OPTIONS, state.filters.device)}</select></div>
        <div class="field"><label>Browser</label><select id="fl-browser">${selectOptionsHtml(BROWSER_OPTIONS, state.filters.browser)}</select></div>
        <div class="field"><label>OS</label><select id="fl-os">${selectOptionsHtml(OS_OPTIONS, state.filters.os)}</select></div>
        <div class="field"><label>Referrer</label><select id="fl-referrer">${selectOptionsHtml(opts.referrers, state.filters.referrer, (v) => v || '(direct)')}</select></div>
        <div class="popover-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="fl-clear">Clear</button>
          <button type="button" class="btn btn-primary btn-sm" id="fl-apply">Apply</button>
        </div>
      </div>`;
    UI.openPopover($('#an-filter-btn'), html, 'filter');

    let linkSearchTimer;
    $('#fl-link').addEventListener('input', (e) => {
      clearTimeout(linkSearchTimer);
      const q = e.target.value.trim();
      const box = $('#fl-link-suggestions');
      if (!q) { box.innerHTML = ''; return; }
      linkSearchTimer = setTimeout(async () => {
        const res = await Api.listLinks({ search: q, page: 1, perpage: 8 });
        box.innerHTML = (res.items || []).map((it) => `<div class="popover-item" data-kw="${escAttr(it.keyword)}">${escHtml(it.keyword)}</div>`).join('');
        box.querySelectorAll('[data-kw]').forEach((el) => el.addEventListener('click', () => {
          $('#fl-link').value = el.dataset.kw;
          box.innerHTML = '';
        }));
      }, 250);
    });

    $('#fl-apply').addEventListener('click', () => {
      state.filters = {
        link: $('#fl-link').value.trim(),
        country: $('#fl-country').value,
        continent: $('#fl-continent').value,
        device: $('#fl-device').value,
        browser: $('#fl-browser').value,
        os: $('#fl-os').value,
        referrer: $('#fl-referrer').value,
      };
      UI.closePopover();
      updateFilterButtonLabel();
      load();
    });
    $('#fl-clear').addEventListener('click', () => {
      state.filters = { link: '', country: '', continent: '', device: '', browser: '', os: '', referrer: '' };
      UI.closePopover();
      updateFilterButtonLabel();
      load();
    });
  }

  function bindTopControls() {
    $('#an-range-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (UI.popoverKind() === 'range') { UI.closePopover(); return; }
      openRangePopover();
    });
    $('#an-filter-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (UI.popoverKind() === 'filter') { UI.closePopover(); return; }
      openFilterPopover();
    });
  }

  // ---------- data loading ----------
  async function load() {
    const params = { range: state.range };
    if (state.range === 'custom') {
      params.start = state.start;
      params.end = state.end;
    }
    Object.entries(state.filters).forEach(([k, v]) => { if (v) params[k] = v; });

    $('#an-chart').innerHTML = '<div class="skeleton" style="height:220px;"></div>';

    let data;
    try {
      data = await Api.analyticsOverview(params);
    } catch (e) {
      $('#an-chart').innerHTML = '<div class="chart-empty">Could not load analytics.</div>';
      return;
    }
    if (!data.success) {
      $('#an-chart').innerHTML = '<div class="chart-empty">Could not load analytics.</div>';
      return;
    }

    state.data = data;
    $('#an-clicks-value').textContent = data.clicks.toLocaleString();

    const cappedEl = $('#an-capped-note');
    if (data.capped) {
      cappedEl.textContent = 'This filter combination scanned more clicks than could be processed in one pass -- these numbers may be an undercount for the selected range.';
      cappedEl.classList.remove('hidden');
    } else {
      cappedEl.classList.add('hidden');
    }

    renderChart(data.timeseries, data.range.bucket);
    renderBreakdownCards(data);
  }

  // ---------- chart ----------
  function formatBucketLabel(t, bucket) {
    const d = new Date(t.replace(' ', 'T'));
    if (isNaN(d)) return t;
    if (bucket === 'hour') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
    if (bucket === 'week') return 'Week of ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderChart(timeseries, bucket) {
    const container = $('#an-chart');
    if (!timeseries || !timeseries.length) {
      container.innerHTML = '<div class="chart-empty">No clicks in this range</div>';
      return;
    }

    const width = container.clientWidth || 800;
    const height = 220;
    const padL = 36, padR = 12, padT = 16, padB = 8;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;

    const values = timeseries.map((p) => p.c);
    const max = Math.max(1, ...values);
    const n = timeseries.length;

    const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const yAt = (v) => padT + innerH - (v / max) * innerH;

    const linePoints = timeseries.map((p, i) => `${xAt(i)},${yAt(p.c)}`).join(' ');
    const areaPoints = `${xAt(0)},${padT + innerH} ${linePoints} ${xAt(n - 1)},${padT + innerH}`;

    const yTicks = 4;
    let gridLines = '';
    for (let i = 0; i <= yTicks; i++) {
      const v = Math.round((max / yTicks) * i);
      const yy = yAt(v);
      gridLines += `<line x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" class="chart-grid"/><text x="${padL - 8}" y="${yy + 4}" class="chart-axis-label" text-anchor="end">${v}</text>`;
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" id="an-chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="an-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <polygon points="${areaPoints}" fill="url(#an-chart-fill)" stroke="none"/>
        <polyline points="${linePoints}" fill="none" stroke="var(--blue)" stroke-width="2"/>
        <rect x="${padL}" y="${padT}" width="${Math.max(0, innerW)}" height="${Math.max(0, innerH)}" fill="transparent" id="an-chart-overlay" style="cursor:crosshair;"/>
      </svg>
      <div class="chart-tooltip hidden" id="an-chart-tooltip"></div>`;

    const overlay = $('#an-chart-overlay');
    const tooltip = $('#an-chart-tooltip');
    overlay.addEventListener('mousemove', (e) => {
      const rect = container.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const scaleX = width / rect.width;
      const svgX = relX * scaleX;
      let idx = Math.round(((svgX - padL) / innerW) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      const point = timeseries[idx];
      tooltip.textContent = `${formatBucketLabel(point.t, bucket)}: ${point.c.toLocaleString()}`;
      tooltip.classList.remove('hidden');
      tooltip.style.left = Math.min(Math.max(relX, 4), rect.width - 4) + 'px';
    });
    overlay.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  }

  // ---------- breakdown cards ----------
  function truncateMiddle(s, max) {
    if (!s) return '';
    if (s.length <= max) return s;
    const half = Math.floor((max - 1) / 2);
    return s.slice(0, half) + '…' + s.slice(s.length - half);
  }

  function flagEmoji(code) {
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
  }

  function faviconUrl(url) {
    try {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32`;
    } catch (e) {
      return '';
    }
  }

  function faviconIconHtml(url) {
    const src = url ? faviconUrl(url) : '';
    return src ? `<img class="row-icon-favicon" src="${escAttr(src)}" alt="" onerror="this.style.visibility='hidden'">` : '';
  }

  function pathIconSvg(paths) {
    if (!paths) return '';
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="row-icon-glyph">${paths}</svg>`;
  }

  function iconForRow(kind, row) {
    switch (kind) {
      case 'short_links': return faviconIconHtml(row.dest);
      case 'destination_urls': return faviconIconHtml(row.url);
      case 'referrers': return row.referrer ? faviconIconHtml(row.referrer) : '';
      case 'countries': return row.code ? `<span class="row-icon-flag">${flagEmoji(row.code)}</span>` : '';
      case 'devices': return pathIconSvg(DEVICE_ICON_PATHS[row.name]);
      case 'browsers': return pathIconSvg(BROWSER_ICON_PATHS[row.name] || BROWSER_ICON_PATHS.Other);
      case 'os': return pathIconSvg(OS_ICON_PATHS[row.name] || OS_ICON_PATHS.Other);
      default: return ''; // continents, utm -- no natural icon
    }
  }

  function labelForRow(kind, row) {
    switch (kind) {
      case 'short_links':
        return `<a href="${escAttr(row.shorturl)}" target="_blank" rel="noopener">${escHtml(row.keyword)}</a>`;
      case 'destination_urls':
        return `<span title="${escAttr(row.url)}">${escHtml(truncateMiddle(row.url, 48))}</span>`;
      case 'referrers':
        return escHtml(row.referrer || 'Direct');
      case 'utm':
        return escHtml(row.value);
      case 'countries':
        return escHtml(row.name || row.code);
      default: // continents, devices, browsers, os
        return escHtml(row.name);
    }
  }

  function getRowsForTab(data, tab) {
    if (tab === 'utm') return data.utm[activeUtmField] || [];
    return data[tab] || [];
  }

  // Short links/destination URLs keep the original blue (the default, no modifier class needed);
  // the other three breakdown-card pairs each get their own bar color to visually group the four
  // cards at a glance.
  const BAR_COLOR_BY_KIND = {
    countries: 'bar-green', continents: 'bar-green',
    devices: 'bar-yellow', browsers: 'bar-yellow', os: 'bar-yellow',
    referrers: 'bar-purple', utm: 'bar-purple',
  };

  function renderRows(mountId, rows, kind) {
    const el = $('#' + mountId);
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="mini-row"><span>No data yet</span></div>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.c));
    const barClass = BAR_COLOR_BY_KIND[kind] || '';
    el.innerHTML = rows.map((r) => {
      const icon = iconForRow(kind, r);
      return `
      <div class="breakdown-row ${barClass}">
        <div class="breakdown-row-bar" style="width:${Math.max(4, (r.c / max) * 100)}%"></div>
        ${icon ? `<span class="breakdown-row-icon">${icon}</span>` : ''}
        <span class="breakdown-row-label">${labelForRow(kind, r)}</span>
        <span class="breakdown-row-count">${r.c.toLocaleString()}</span>
      </div>`;
    }).join('');
  }

  function renderCardBody(mountId, tab) {
    if (!state.data) return;
    renderRows(mountId, getRowsForTab(state.data, tab), tab);
  }

  function renderBreakdownCards(data) {
    Object.keys(activeTab).forEach((mountId) => renderCardBody(mountId, activeTab[mountId]));
  }

  function bindBreakdownTabs() {
    $$('.breakdown-card').forEach((card) => {
      const mountId = card.querySelector('.breakdown-rows').id;
      const subtabs = card.querySelector('.breakdown-subtabs');

      card.querySelectorAll('.breakdown-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          card.querySelectorAll('.breakdown-tab').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const tab = btn.dataset.tab;
          activeTab[mountId] = tab;
          if (subtabs) subtabs.classList.toggle('hidden', tab !== 'utm');
          renderCardBody(mountId, tab);
        });
      });

      card.querySelectorAll('.breakdown-subtab').forEach((btn) => {
        btn.addEventListener('click', () => {
          card.querySelectorAll('.breakdown-subtab').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          activeUtmField = btn.dataset.utm;
          renderCardBody(mountId, 'utm');
        });
      });
    });
  }

  // ---------- utils ----------
  function escHtml(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escAttr(s) { return escHtml(s); }

  return {
    init() {
      bindTopControls();
      bindBreakdownTabs();
      updateRangeButtonLabel();
      updateFilterButtonLabel();
    },
    show() {
      if (!state.initialized) {
        state.initialized = true;
        load();
      }
    },
  };
})();
