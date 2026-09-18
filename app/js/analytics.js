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

  let state = {
    range: '7d',
    start: '',
    end: '',
    filters: { link: '', country: '', continent: '', device: '', browser: '', os: '', referrer: '' },
    data: null,
    initialized: false,
  };
  let filterOptionsCache = null;
  let currentPopoverKind = null;
  let activeTab = {
    'an-rows-links': 'short_links',
    'an-rows-referrers': 'referrers',
    'an-rows-geo': 'countries',
    'an-rows-devices': 'devices',
  };
  let activeUtmField = 'source';

  // ---------- popover (generic, anchored -- reused by the range picker and filter picker) ----------
  function openPopover(anchorEl, html, kind) {
    currentPopoverKind = kind;
    const pop = $('#popover');
    pop.innerHTML = html;
    pop.classList.remove('hidden');
    const rect = anchorEl.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    pop.style.left = (rect.left + window.scrollX) + 'px';
  }
  function closePopover() {
    currentPopoverKind = null;
    const pop = $('#popover');
    if (!pop) return;
    pop.classList.add('hidden');
    pop.innerHTML = '';
  }
  document.addEventListener('click', (e) => {
    const pop = $('#popover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest('#an-range-btn') || e.target.closest('#an-filter-btn')) return;
    closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });

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
    openPopover($('#an-range-btn'), `<div class="popover-list">${rows}</div>${customFields}`, 'range');

    $$('.popover-item[data-range]').forEach((btn) => btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      if (state.range !== 'custom') {
        closePopover();
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
      closePopover();
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
    currentPopoverKind = 'filter';
    const opts = await ensureFilterOptionsLoaded();
    if (currentPopoverKind !== 'filter') return; // popover was closed while options were loading
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
    openPopover($('#an-filter-btn'), html, 'filter');

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
      closePopover();
      updateFilterButtonLabel();
      load();
    });
    $('#fl-clear').addEventListener('click', () => {
      state.filters = { link: '', country: '', continent: '', device: '', browser: '', os: '', referrer: '' };
      closePopover();
      updateFilterButtonLabel();
      load();
    });
  }

  function bindTopControls() {
    $('#an-range-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentPopoverKind === 'range') { closePopover(); return; }
      openRangePopover();
    });
    $('#an-filter-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentPopoverKind === 'filter') { closePopover(); return; }
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
        return `${flagEmoji(row.code)} ${escHtml(row.code)}`;
      default: // continents, devices, browsers, os
        return escHtml(row.name);
    }
  }

  function getRowsForTab(data, tab) {
    if (tab === 'utm') return data.utm[activeUtmField] || [];
    return data[tab] || [];
  }

  function renderRows(mountId, rows, kind) {
    const el = $('#' + mountId);
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="mini-row"><span>No data yet</span></div>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.c));
    el.innerHTML = rows.map((r) => `
      <div class="breakdown-row">
        <div class="breakdown-row-bar" style="width:${Math.max(4, (r.c / max) * 100)}%"></div>
        <span class="breakdown-row-label">${labelForRow(kind, r)}</span>
        <span class="breakdown-row-count">${r.c.toLocaleString()}</span>
      </div>`).join('');
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
