(function () {
  const TAG_COLORS = ['red', 'yellow', 'green', 'blue', 'purple', 'brown', 'gray']; // keep in sync with leanks_tag_colors() in tags.php
  const LINKS_STATE_KEY = 'leanks-links-state';

  function loadPersistedListState() {
    try {
      const raw = localStorage.getItem(LINKS_STATE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  function persistListState() {
    try {
      localStorage.setItem(LINKS_STATE_KEY, JSON.stringify({
        page: state.page, perpage: state.perpage, search: state.search,
        sort: state.sort, order: state.order, tag_id: state.tag_id,
        view: state.view, columns: state.columns,
      }));
    } catch (e) { /* private mode / quota -- persistence is a nicety, not required */ }
  }

  let state = Object.assign(
    {
      page: 1, perpage: 50, search: '', sort: 'timestamp', order: 'DESC', tag_id: 0, total: 0, total_clicks: 0, items: [],
      view: 'rows', // 'rows' | 'cards'
      columns: { clicks: true, created: true, tags: true },
    },
    loadPersistedListState()
  );
  state.selected = new Set(); // never persisted -- selection is page-scoped and ephemeral
  let editingRow = null; // the row currently open in the edit modal (never null while it's open)
  let selectedTagIds = []; // tags picked in the edit modal
  let createSelectedTagIds = []; // tags picked in the always-visible inline create section --
  // kept separate from selectedTagIds so opening the edit modal mid-draft can't clobber an
  // in-progress create (the two forms can coexist since create is never itself a modal)
  let tagsCache = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- auth guard ----------
  Api.checkAuth().then((ok) => {
    if (!ok) {
      window.location.replace('login.html');
      return;
    }
    init();
  });

  async function init() {
    const boot = await Api.bootstrap();
    $('#current-user').textContent = boot.user;
    $('#f-keyword-domain').textContent = '(' + boot.site_url.replace(/^https?:\/\//, '') + '/)';
    $('#c-keyword').placeholder = boot.site_url.replace(/^https?:\/\//, '') + '/ (auto)';
    bindEvents();
    loadLinks();
    checkForUpdate();
    Analytics.init();
  }

  // ---------- toasts ----------
  function toast(msg, isError) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' toast-error' : '');
    el.textContent = msg;
    $('#toast-stack').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------- modal helpers ----------
  function openModal(id) { $('#' + id).classList.remove('hidden'); }
  function closeModal(id) { $('#' + id).classList.add('hidden'); }

  // ---------- view switching (Links / Analytics) ----------
  function switchView(view) {
    $$('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('#view-links').classList.toggle('hidden', view !== 'links');
    $('#view-analytics').classList.toggle('hidden', view !== 'analytics');
    // Tags/Import are Links-view-only actions; the toolbar (incl. search) and the inline create
    // section live inside #view-links itself, so they're already hidden/shown with that view.
    [$('#tags-btn'), $('#import-btn')].forEach((el) => {
      el.classList.toggle('hidden', view !== 'links');
    });
    if (view === 'analytics') Analytics.show();
  }

  // Delegated so it also covers buttons injected later (e.g. the import modal's dynamic footer).
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      $$('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
    }
  });
  $$('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.add('hidden'); });
  });

  // ---------- list rendering ----------
  async function loadLinks() {
    const tbody = $('#links-tbody');
    tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;"><div class="skeleton" style="height:40px;"></div></td></tr>';

    const params = { search: state.search, page: state.page, perpage: state.perpage, sort: state.sort, order: state.order };
    if (state.tag_id) params.tag_id = state.tag_id;
    const data = await Api.listLinks(params);

    // A restored page can come back empty if the list shrank since the last visit -- reset to
    // page 1 once rather than leaving the table permanently empty.
    if (data.items.length === 0 && state.page > 1) {
      state.page = 1;
      persistListState();
      return loadLinks();
    }

    state.items = data.items;
    state.total = data.total;
    state.total_clicks = data.total_clicks;
    state.selected.clear();

    $('#stat-total-links').textContent = data.total;
    $('#stat-total-clicks').textContent = data.total_clicks;

    renderCurrentView();
    renderPagination();
    updateSortHeaderUI();
    persistListState();
  }

  // Re-renders the links list from already-fetched state.items -- used both after a fresh
  // Api.listLinks() call and after a purely client-side display change (view mode, column
  // visibility) that doesn't need a refetch.
  function renderCurrentView() {
    const isEmpty = state.items.length === 0;
    $('#empty-state').classList.toggle('hidden', !isEmpty);
    $('#links-rows-view').classList.toggle('hidden', state.view !== 'rows');
    $('#links-cards-view').classList.toggle('hidden', state.view !== 'cards');
    applyColumnVisibility();

    if (state.view === 'cards') {
      $('#links-cards-view').innerHTML = isEmpty ? '' : state.items.map(renderCard).join('');
    } else {
      $('#links-tbody').innerHTML = isEmpty ? '' : state.items.map(renderRow).join('');
    }

    renderBulkBar();
    bindItemEvents();
  }

  function applyColumnVisibility() {
    $('#links-rows-view').classList.toggle('hide-clicks', !state.columns.clicks);
    $('#links-rows-view').classList.toggle('hide-created', !state.columns.created);
    $('#links-rows-view').classList.toggle('hide-tags', !state.columns.tags);
  }

  function faviconUrl(url) {
    try {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32`;
    } catch (e) {
      return '';
    }
  }

  // Link metadata badges (password/expiry/limit/UTM) shown inline under the link itself, in
  // both Rows and Cards view. Tags are separate -- see tagBadges() -- since Rows view puts them
  // in their own column instead of inline.
  function metaBadges(row) {
    const badges = [];
    if (row.has_password) badges.push('<span class="badge badge-blue">🔒 Password</span>');
    if (row.is_expired) badges.push('<span class="badge badge-red">Expired</span>');
    else if (row.expires_at) badges.push('<span class="badge badge-amber">Expires ' + formatDate(row.expires_at) + '</span>');
    if (row.max_clicks) badges.push('<span class="badge badge-gray">Limit ' + row.max_clicks + '</span>');
    if (row.utm && (row.utm.source || row.utm.campaign)) badges.push('<span class="badge badge-gray">UTM</span>');
    return badges;
  }

  function tagBadges(row) {
    if (!state.columns.tags) return [];
    return (row.tags || []).map((t) => `<span class="badge badge-${escAttr(t.color)}">${escHtml(t.name)}</span>`);
  }

  function faviconHtml(row) {
    const favicon = faviconUrl(row.url);
    return favicon
      ? `<img class="favicon" src="${escAttr(favicon)}" alt="" onerror="this.style.visibility='hidden'">`
      : '<span class="favicon"></span>';
  }

  function linkCellTextHtml(row, badges) {
    return `
      <div class="link-cell-text">
        <div class="short">
          <a href="${escAttr(row.shorturl)}" target="_blank" rel="noopener">${escHtml(row.shorturl.replace(/^https?:\/\//, ''))}</a>
          <button class="copy-btn" data-copy="${escAttr(row.shorturl)}" title="Copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" /></svg>
          </button>
        </div>
        <div class="dest" title="${escAttr(row.url)}">${escHtml(row.url)}</div>
        ${badges.length ? '<div class="badge-row">' + badges.join('') + '</div>' : ''}
      </div>`;
  }

  function rowActionsHtml() {
    return `
      <div class="row-actions">
        <button class="btn btn-ghost btn-icon" data-action="qr" title="QR code">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M7 17l0 .01" /><path d="M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M7 7l0 .01" /><path d="M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M17 7l0 .01" /><path d="M14 14l3 0" /><path d="M20 14l0 .01" /><path d="M14 14l0 3" /><path d="M14 20l3 0" /><path d="M17 17l3 0" /><path d="M20 17l0 3" /></svg>
        </button>
        <button class="btn btn-ghost btn-icon" data-action="stats" title="Stats">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l16 0" /><path d="M4 15l4 -6l4 2l4 -5l4 4" /></svg>
        </button>
        <button class="btn btn-ghost btn-icon" data-action="edit" title="Edit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" /><path d="M13.5 6.5l4 4" /></svg>
        </button>
        <button class="btn btn-ghost btn-icon" data-action="delete" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>
        </button>
      </div>`;
  }

  function renderRow(row) {
    const badges = metaBadges(row);
    const tags = tagBadges(row);
    const checked = state.selected.has(row.keyword) ? ' checked' : '';

    return `
      <tr data-keyword="${escAttr(row.keyword)}">
        <td class="checkbox-cell"><input type="checkbox" class="row-checkbox"${checked}></td>
        <td class="link-cell">
          ${faviconHtml(row)}
          ${linkCellTextHtml(row, badges)}
        </td>
        <td class="col-tags">${tags.length ? '<div class="badge-row">' + tags.join('') + '</div>' : ''}</td>
        <td class="clicks-cell col-clicks">${row.clicks}</td>
        <td class="col-created" style="color:var(--text-dim);font-size:0.82rem;">${formatDate(row.timestamp)}</td>
        <td>${rowActionsHtml()}</td>
      </tr>`;
  }

  function renderCard(row) {
    const badges = [...metaBadges(row), ...tagBadges(row)];
    const checked = state.selected.has(row.keyword) ? ' checked' : '';
    const footerParts = [];
    if (state.columns.clicks) footerParts.push(`${row.clicks} click${row.clicks === 1 ? '' : 's'}`);
    if (state.columns.created) footerParts.push(formatDate(row.timestamp));

    return `
      <div class="link-card" data-keyword="${escAttr(row.keyword)}">
        <div class="link-card-top">
          <input type="checkbox" class="row-checkbox"${checked}>
          ${faviconHtml(row)}
          ${linkCellTextHtml(row, badges)}
        </div>
        <div class="link-card-actions">${rowActionsHtml()}</div>
        ${footerParts.length ? `<div class="link-card-footer"><span>${footerParts.join(' · ')}</span></div>` : ''}
      </div>`;
  }

  function bindItemEvents() {
    const items = state.view === 'cards' ? $$('#links-cards-view .link-card') : $$('#links-tbody tr[data-keyword]');
    items.forEach((el) => {
      const keyword = el.dataset.keyword;
      const row = state.items.find((r) => r.keyword === keyword);

      el.querySelector('.row-checkbox')?.addEventListener('change', (e) => {
        if (e.target.checked) state.selected.add(keyword);
        else state.selected.delete(keyword);
        renderBulkBar();
        updateSelectAllCheckbox();
      });

      el.querySelector('[data-copy]')?.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(row.shorturl).then(() => toast('Copied to clipboard'));
      });
      el.querySelector('[data-action="qr"]')?.addEventListener('click', () => showQr(row));
      el.querySelector('[data-action="stats"]')?.addEventListener('click', () => showStats(row));
      el.querySelector('[data-action="edit"]')?.addEventListener('click', () => openEdit(row));
      el.querySelector('[data-action="delete"]')?.addEventListener('click', () => confirmDelete(row));
    });
    updateSelectAllCheckbox();
  }

  function updateSelectAllCheckbox() {
    const scope = state.view === 'cards' ? '#links-cards-view' : '#links-tbody';
    const boxes = $$(`${scope} .row-checkbox`);
    const checkedCount = boxes.filter((b) => b.checked).length;
    const el = $('#select-all-checkbox');
    el.checked = boxes.length > 0 && checkedCount === boxes.length;
    el.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  }

  // ---------- batch select / bulk delete ----------
  function renderBulkBar() {
    const n = state.selected.size;
    $('#bulk-bar').classList.toggle('hidden', n === 0);
    if (n > 0) $('#bulk-count').textContent = `${n} link${n === 1 ? '' : 's'} selected`;
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(state.total / state.perpage));
    const el = $('#pagination');
    if (state.total <= state.perpage) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <span>${state.total} link${state.total === 1 ? '' : 's'} · page ${state.page} of ${pages}</span>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" id="page-prev" ${state.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button class="btn btn-secondary btn-sm" id="page-next" ${state.page >= pages ? 'disabled' : ''}>Next</button>
      </div>`;
    $('#page-prev')?.addEventListener('click', () => { state.page--; loadLinks(); });
    $('#page-next')?.addEventListener('click', () => { state.page++; loadLinks(); });
  }

  // ---------- search ----------
  let searchTimer;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value;
      state.page = 1;
      loadLinks();
    }, 300);
  });

  // ---------- links-list toolbar: Filter (tag) + Display (sort/rows-per-page) ----------
  async function ensureTagsLoaded(force) {
    if (tagsCache && !force) return tagsCache;
    try {
      const res = await Api.listTags();
      tagsCache = res.tags || [];
    } catch (e) {
      tagsCache = [];
    }
    return tagsCache;
  }

  function updateLinksFilterButtonLabel() {
    $('#links-filter-btn').textContent = state.tag_id ? 'Filter (1)' : 'Filter';
  }

  function bindListToolbar() {
    $('#links-filter-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (UI.popoverKind() === 'links-filter') { UI.closePopover(); return; }
      UI.reserveKind('links-filter');
      const tags = await ensureTagsLoaded();
      if (UI.popoverKind() !== 'links-filter') return;
      renderLinksFilterPopover(tags);
    });
    $('#links-display-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (UI.popoverKind() === 'links-display') { UI.closePopover(); return; }
      renderLinksDisplayPopover();
    });
  }

  // Clicking a sortable column header sorts by that field, defaulting to descending; clicking
  // the already-active field flips its direction instead. Kept in sync with the Display
  // popover's Ordering dropdown, which sets the same state.sort/state.order.
  function bindSortHeaders() {
    $$('.th-sort').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.sortField;
        if (state.sort === field) {
          state.order = state.order === 'ASC' ? 'DESC' : 'ASC';
        } else {
          state.sort = field;
          state.order = 'DESC';
        }
        state.page = 1;
        loadLinks();
      });
    });
  }

  function updateSortHeaderUI() {
    $$('.th-sort').forEach((btn) => {
      const active = btn.dataset.sortField === state.sort;
      btn.classList.toggle('active', active);
      btn.classList.toggle('asc', active && state.order === 'ASC');
      btn.classList.toggle('desc', active && state.order === 'DESC');
    });
  }

  function renderLinksFilterPopover(tags) {
    const options = tags.map((t) => `<option value="${t.id}"${t.id === state.tag_id ? ' selected' : ''}>${escHtml(t.name)}</option>`).join('');
    const html = `
      <div class="filter-form">
        <div class="field"><label>Tag</label><select id="lf-tag"><option value="0">Any</option>${options}</select></div>
        <div class="popover-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="lf-clear">Clear</button>
          <button type="button" class="btn btn-primary btn-sm" id="lf-apply">Apply</button>
        </div>
      </div>`;
    UI.openPopover($('#links-filter-btn'), html, 'links-filter');
    $('#lf-apply').addEventListener('click', () => {
      state.tag_id = parseInt($('#lf-tag').value, 10) || 0;
      state.page = 1;
      UI.closePopover();
      updateLinksFilterButtonLabel();
      loadLinks();
    });
    $('#lf-clear').addEventListener('click', () => {
      state.tag_id = 0;
      state.page = 1;
      UI.closePopover();
      updateLinksFilterButtonLabel();
      loadLinks();
    });
  }

  const SORT_OPTIONS = [
    { sort: 'timestamp', order: 'DESC', label: 'Date created (newest)' },
    { sort: 'timestamp', order: 'ASC', label: 'Date created (oldest)' },
    { sort: 'clicks', order: 'DESC', label: 'Clicks (most)' },
    { sort: 'clicks', order: 'ASC', label: 'Clicks (fewest)' },
    { sort: 'keyword', order: 'ASC', label: 'Alphabetical (A-Z)' },
    { sort: 'keyword', order: 'DESC', label: 'Alphabetical (Z-A)' },
  ];

  function renderLinksDisplayPopover() {
    const sortOptions = SORT_OPTIONS.map((o) => `<option value="${o.sort}:${o.order}"${o.sort === state.sort && o.order === state.order ? ' selected' : ''}>${o.label}</option>`).join('');
    const perpageOptions = [10, 20, 50, 100].map((n) => `<option value="${n}"${n === state.perpage ? ' selected' : ''}>${n}</option>`).join('');
    const html = `
      <div class="filter-form">
        <div class="view-toggle">
          <button type="button" class="${state.view === 'rows' ? 'active' : ''}" data-view-mode="rows">Rows</button>
          <button type="button" class="${state.view === 'cards' ? 'active' : ''}" data-view-mode="cards">Cards</button>
        </div>
        <div class="field"><label>Ordering</label><select id="ld-sort">${sortOptions}</select></div>
        <div class="field"><label>Rows per page</label><select id="ld-perpage">${perpageOptions}</select></div>
        <div class="field">
          <label>Display properties</label>
          <div class="display-properties">
            <label><input type="checkbox" id="ld-col-clicks"${state.columns.clicks ? ' checked' : ''}> Clicks</label>
            <label><input type="checkbox" id="ld-col-created"${state.columns.created ? ' checked' : ''}> Created date</label>
            <label><input type="checkbox" id="ld-col-tags"${state.columns.tags ? ' checked' : ''}> Tags</label>
          </div>
        </div>
      </div>`;
    UI.openPopover($('#links-display-btn'), html, 'links-display');

    $$('[data-view-mode]').forEach((btn) => btn.addEventListener('click', () => {
      state.view = btn.dataset.viewMode;
      $$('[data-view-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      renderCurrentView();
      persistListState();
    }));
    $('#ld-sort').addEventListener('change', (e) => {
      const [sort, order] = e.target.value.split(':');
      state.sort = sort;
      state.order = order;
      state.page = 1;
      loadLinks();
    });
    $('#ld-perpage').addEventListener('change', (e) => {
      state.perpage = parseInt(e.target.value, 10) || 50;
      state.page = 1;
      loadLinks();
    });
    [['ld-col-clicks', 'clicks'], ['ld-col-created', 'created'], ['ld-col-tags', 'tags']].forEach(([id, key]) => {
      $('#' + id).addEventListener('change', (e) => {
        state.columns[key] = e.target.checked;
        renderCurrentView();
        persistListState();
      });
    });
  }

  // ---------- edit modal ----------
  function bindEvents() {
    bindCreateSection();
    $('#logout-btn').addEventListener('click', async () => { await Api.logout(); window.location.replace('login.html'); });

    $$('.nav-tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

    $('#f-password-toggle').addEventListener('change', (e) => {
      $('#f-password-wrap').classList.toggle('hidden', !e.target.checked);
    });

    ['f-url', 'f-utm-source', 'f-utm-medium', 'f-utm-campaign', 'f-utm-term', 'f-utm-content'].forEach((id) => {
      $('#' + id).addEventListener('input', updateUtmPreview);
    });

    $('#f-tags-btn').addEventListener('click', (e) => { e.stopPropagation(); openTagPicker(); });

    $('#link-form').addEventListener('submit', onSubmitLinkForm);
    $('#confirm-delete-btn').addEventListener('click', onConfirmDelete);
    $('#qr-download').addEventListener('click', downloadQr);

    $('#import-btn').addEventListener('click', openImport);
    $('#tags-btn').addEventListener('click', openTagsModal);
    $('#settings-btn').addEventListener('click', openSettingsModal);
    $('#settings-save-btn').addEventListener('click', onSaveSettings);
    $('#s-check-update-btn').addEventListener('click', () => refreshUpdateStatus(true));
    $$('#s-theme-toggle button').forEach((btn) => btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeMode);
      updateThemeToggleUI();
    }));

    bindListToolbar();
    bindSortHeaders();
    updateLinksFilterButtonLabel();

    $('#select-all-checkbox').addEventListener('change', (e) => {
      $$('#links-tbody .row-checkbox').forEach((box) => {
        box.checked = e.target.checked;
        const keyword = box.closest('tr').dataset.keyword;
        if (e.target.checked) state.selected.add(keyword);
        else state.selected.delete(keyword);
      });
      renderBulkBar();
    });
    $('#bulk-cancel-btn').addEventListener('click', () => {
      state.selected.clear();
      $$('#links-tbody .row-checkbox').forEach((b) => { b.checked = false; });
      $('#select-all-checkbox').checked = false;
      $('#select-all-checkbox').indeterminate = false;
      renderBulkBar();
    });
    $('#bulk-delete-btn').addEventListener('click', confirmBulkDelete);

    $('#update-banner-view').addEventListener('click', () => {
      if (latestUpdateInfo && latestUpdateInfo.html_url) window.open(latestUpdateInfo.html_url, '_blank', 'noopener');
    });
    $('#update-banner-update').addEventListener('click', openUpdateModal);
    $('#update-banner-dismiss').addEventListener('click', () => {
      if (latestUpdateInfo) localStorage.setItem('leanks-update-dismissed', latestUpdateInfo.latest);
      $('#update-banner').classList.add('hidden');
    });
  }

  function resetForm() {
    $('#link-form').reset();
    $('#f-password-wrap').classList.add('hidden');
    $('#advanced-section').removeAttribute('open');
    $('#utm-preview').style.display = 'none';
    selectedTagIds = [];
    renderSelectedTagChips();
  }

  function openEdit(row) {
    editingRow = row;
    resetForm();

    $('#f-url').value = stripUtmParams(row.url);
    $('#f-keyword').value = row.keyword;
    $('#f-title').value = row.title || '';

    if (row.has_password) {
      $('#f-password-toggle').checked = true;
      $('#f-password-wrap').classList.remove('hidden');
      $('#f-password').placeholder = 'Leave blank to keep current password';
    }
    if (row.expires_at) $('#f-expires').value = row.expires_at.replace(' ', 'T').slice(0, 16);
    if (row.max_clicks) $('#f-max-clicks').value = row.max_clicks;

    const u = row.utm || {};
    $('#f-utm-source').value = u.source || '';
    $('#f-utm-medium').value = u.medium || '';
    $('#f-utm-campaign').value = u.campaign || '';
    $('#f-utm-term').value = u.term || '';
    $('#f-utm-content').value = u.content || '';

    selectedTagIds = (row.tags || []).map((t) => t.id);
    renderSelectedTagChips();

    if (row.has_password || row.expires_at || row.max_clicks || u.source || u.campaign || selectedTagIds.length) {
      $('#advanced-section').setAttribute('open', '');
    }

    updateUtmPreview();
    openModal('link-modal-backdrop');
  }

  // ---------- tag picker (inside the create/edit link form) ----------
  function renderSelectedTagChips() {
    const tags = tagsCache || [];
    $('#f-selected-tags').innerHTML = selectedTagIds.map((id) => {
      const t = tags.find((x) => x.id === id);
      if (!t) return '';
      return `<span class="badge badge-${escAttr(t.color)} tag-chip-removable" data-remove-tag="${t.id}">${escHtml(t.name)} &times;</span>`;
    }).join('');
    $$('#f-selected-tags [data-remove-tag]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.removeTag, 10);
        selectedTagIds = selectedTagIds.filter((x) => x !== id);
        renderSelectedTagChips();
      });
    });
  }

  async function openTagPicker() {
    if (UI.popoverKind() === 'tag-picker') { UI.closePopover(); return; }
    UI.reserveKind('tag-picker');
    const tags = await ensureTagsLoaded(true); // refresh -- a tag may have just been added/removed elsewhere
    if (UI.popoverKind() !== 'tag-picker') return;
    renderTagPickerPopover(tags);
    renderSelectedTagChips(); // labels/colors may have changed since selectedTagIds was set
  }

  function renderTagPickerPopover(tags) {
    const rows = tags.length ? tags.map((t) => `
      <label class="tag-picker-row">
        <input type="checkbox" value="${t.id}"${selectedTagIds.includes(t.id) ? ' checked' : ''}>
        <span class="badge badge-${escAttr(t.color)}">${escHtml(t.name)}</span>
      </label>`).join('') : '<div class="mini-row"><span>No tags yet</span></div>';

    const html = `
      <div class="filter-form">
        ${rows}
        <div class="tag-picker-new">
          <input type="text" id="tp-new-name" placeholder="New tag name">
          <button type="button" class="btn btn-secondary btn-sm" id="tp-new-add">Add</button>
        </div>
      </div>`;
    UI.openPopover($('#f-tags-btn'), html, 'tag-picker');

    $$('.tag-picker-row input[type=checkbox]').forEach((box) => {
      box.addEventListener('change', (e) => {
        const id = parseInt(e.target.value, 10);
        if (e.target.checked) selectedTagIds.push(id);
        else selectedTagIds = selectedTagIds.filter((x) => x !== id);
        renderSelectedTagChips();
      });
    });

    $('#tp-new-add').addEventListener('click', async () => {
      const name = $('#tp-new-name').value.trim();
      if (!name) return;
      const res = await Api.createTag(name, 'gray');
      if (!res.success) { toast(res.message || 'Could not create tag', true); return; }
      selectedTagIds.push(res.id);
      const tags2 = await ensureTagsLoaded(true);
      renderTagPickerPopover(tags2);
      renderSelectedTagChips();
    });
  }

  function stripUtmParams(url) {
    try {
      const u = new URL(url);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((p) => u.searchParams.delete(p));
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function buildUtmFields() {
    return {
      utm_source: $('#f-utm-source').value.trim(),
      utm_medium: $('#f-utm-medium').value.trim(),
      utm_campaign: $('#f-utm-campaign').value.trim(),
      utm_term: $('#f-utm-term').value.trim(),
      utm_content: $('#f-utm-content').value.trim(),
    };
  }

  function appendUtmParams(baseUrl, utm) {
    let u;
    try { u = new URL(baseUrl); } catch (e) { return baseUrl; }
    Object.keys(utm).forEach((k) => {
      if (utm[k]) u.searchParams.set(k, utm[k]);
    });
    return u.toString();
  }

  function updateUtmPreview() {
    const base = $('#f-url').value.trim();
    const utm = buildUtmFields();
    const hasAny = Object.values(utm).some(Boolean);
    const preview = $('#utm-preview');
    if (!base || !hasAny) { preview.style.display = 'none'; return; }
    preview.style.display = 'block';
    preview.textContent = appendUtmParams(base, utm);
  }

  async function onSubmitLinkForm(e) {
    e.preventDefault();
    const submitBtn = $('#link-form-submit');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const utm = buildUtmFields();
      const finalUrl = appendUtmParams($('#f-url').value.trim(), utm);
      const title = $('#f-title').value.trim();
      const keyword = $('#f-keyword').value.trim();

      const passwordEnabled = $('#f-password-toggle').checked;
      const passwordValue = $('#f-password').value;
      const expires = $('#f-expires').value; // yyyy-MM-ddTHH:mm
      const maxClicks = $('#f-max-clicks').value;

      const newKeyword = keyword || editingRow.keyword;
      // Stock YOURLS' edit_save reports "fail" when its UPDATE affects 0 rows -- which MySQL
      // does whenever url/keyword/title are all unchanged (e.g. this edit only touches tags,
      // UTM, expiration or password). Skip the call entirely in that case rather than treating
      // a no-op as an error.
      if (finalUrl !== editingRow.url || newKeyword !== editingRow.keyword || title !== (editingRow.title || '')) {
        const editRes = await Api.editLink(editingRow, { url: finalUrl, keyword: newKeyword, title });
        if (editRes.status && editRes.status !== 'success') throw new Error(editRes.message || 'Could not save link');
      }

      const metaFields = { keyword: newKeyword, expires_at: expires ? expires.replace('T', ' ') : '', max_clicks: maxClicks || '', tag_ids: selectedTagIds.join(','), ...utm };
      if (passwordEnabled && passwordValue) metaFields.password = passwordValue;
      else if (!passwordEnabled) metaFields.remove_password = '1';
      await Api.saveMeta(metaFields);
      toast('Link updated');

      closeModal('link-modal-backdrop');
      loadLinks();
    } catch (err) {
      toast(err.message || 'Something went wrong', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  // ---------- inline create-link section ----------
  // A standalone counterpart to the edit modal above (same fields, c- prefixed IDs) rather than
  // a shared/parameterized implementation -- the two forms are never open "for the same reason"
  // at the same time (create is always visible, edit is a modal), so keeping them independent
  // avoids the edit modal's resetForm()/editingRow bookkeeping leaking into the always-on form.
  function resetCreateForm() {
    $('#c-form').reset();
    $('#c-password-wrap').classList.add('hidden');
    $('#c-advanced-section').removeAttribute('open');
    $('#c-utm-preview').style.display = 'none';
    createSelectedTagIds = [];
    renderCreateSelectedTagChips();
  }

  function renderCreateSelectedTagChips() {
    const tags = tagsCache || [];
    $('#c-selected-tags').innerHTML = createSelectedTagIds.map((id) => {
      const t = tags.find((x) => x.id === id);
      if (!t) return '';
      return `<span class="badge badge-${escAttr(t.color)} tag-chip-removable" data-remove-tag="${t.id}">${escHtml(t.name)} &times;</span>`;
    }).join('');
    $$('#c-selected-tags [data-remove-tag]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.removeTag, 10);
        createSelectedTagIds = createSelectedTagIds.filter((x) => x !== id);
        renderCreateSelectedTagChips();
      });
    });
  }

  async function openCreateTagPicker() {
    if (UI.popoverKind() === 'create-tag-picker') { UI.closePopover(); return; }
    UI.reserveKind('create-tag-picker');
    const tags = await ensureTagsLoaded(true);
    if (UI.popoverKind() !== 'create-tag-picker') return;
    renderCreateTagPickerPopover(tags);
    renderCreateSelectedTagChips();
  }

  function renderCreateTagPickerPopover(tags) {
    const rows = tags.length ? tags.map((t) => `
      <label class="tag-picker-row">
        <input type="checkbox" value="${t.id}"${createSelectedTagIds.includes(t.id) ? ' checked' : ''}>
        <span class="badge badge-${escAttr(t.color)}">${escHtml(t.name)}</span>
      </label>`).join('') : '<div class="mini-row"><span>No tags yet</span></div>';

    const html = `
      <div class="filter-form">
        ${rows}
        <div class="tag-picker-new">
          <input type="text" id="ctp-new-name" placeholder="New tag name">
          <button type="button" class="btn btn-secondary btn-sm" id="ctp-new-add">Add</button>
        </div>
      </div>`;
    UI.openPopover($('#c-tags-btn'), html, 'create-tag-picker');

    $$('.tag-picker-row input[type=checkbox]').forEach((box) => {
      box.addEventListener('change', (e) => {
        const id = parseInt(e.target.value, 10);
        if (e.target.checked) createSelectedTagIds.push(id);
        else createSelectedTagIds = createSelectedTagIds.filter((x) => x !== id);
        renderCreateSelectedTagChips();
      });
    });

    $('#ctp-new-add').addEventListener('click', async () => {
      const name = $('#ctp-new-name').value.trim();
      if (!name) return;
      const res = await Api.createTag(name, 'gray');
      if (!res.success) { toast(res.message || 'Could not create tag', true); return; }
      createSelectedTagIds.push(res.id);
      const tags2 = await ensureTagsLoaded(true);
      renderCreateTagPickerPopover(tags2);
      renderCreateSelectedTagChips();
    });
  }

  function updateCreateUtmPreview() {
    const base = $('#c-url').value.trim();
    const utm = {
      utm_source: $('#c-utm-source').value.trim(),
      utm_medium: $('#c-utm-medium').value.trim(),
      utm_campaign: $('#c-utm-campaign').value.trim(),
      utm_term: $('#c-utm-term').value.trim(),
      utm_content: $('#c-utm-content').value.trim(),
    };
    const hasAny = Object.values(utm).some(Boolean);
    const preview = $('#c-utm-preview');
    if (!base || !hasAny) { preview.style.display = 'none'; return; }
    preview.style.display = 'block';
    preview.textContent = appendUtmParams(base, utm);
  }

  function bindCreateSection() {
    $('#c-password-toggle').addEventListener('change', (e) => {
      $('#c-password-wrap').classList.toggle('hidden', !e.target.checked);
    });
    ['c-url', 'c-utm-source', 'c-utm-medium', 'c-utm-campaign', 'c-utm-term', 'c-utm-content'].forEach((id) => {
      $('#' + id).addEventListener('input', updateCreateUtmPreview);
    });
    $('#c-tags-btn').addEventListener('click', (e) => { e.stopPropagation(); openCreateTagPicker(); });
    $('#c-form').addEventListener('submit', onSubmitCreateForm);
  }

  async function onSubmitCreateForm(e) {
    e.preventDefault();
    const submitBtn = $('#c-submit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const utm = {
        utm_source: $('#c-utm-source').value.trim(),
        utm_medium: $('#c-utm-medium').value.trim(),
        utm_campaign: $('#c-utm-campaign').value.trim(),
        utm_term: $('#c-utm-term').value.trim(),
        utm_content: $('#c-utm-content').value.trim(),
      };
      const finalUrl = appendUtmParams($('#c-url').value.trim(), utm);
      const title = $('#c-title').value.trim();
      const keyword = $('#c-keyword').value.trim();
      const passwordEnabled = $('#c-password-toggle').checked;
      const passwordValue = $('#c-password').value;
      const expires = $('#c-expires').value;
      const maxClicks = $('#c-max-clicks').value;

      const res = await Api.createLink({
        url: finalUrl,
        keyword,
        title,
        password: passwordEnabled ? passwordValue : '',
        expires_at: expires ? expires.replace('T', ' ') : '',
        max_clicks: maxClicks || '',
        tag_ids: createSelectedTagIds.join(','),
        ...utm,
      });
      if (res.status !== 'success') throw new Error(res.message || 'Could not create link');

      toast('Link created');
      resetCreateForm();
      loadLinks();
    } catch (err) {
      toast(err.message || 'Something went wrong', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '+ Create link';
    }
  }

  // ---------- import CSV ----------
  const IMPORT_MAX_ROWS = 2000; // keep in sync with LEANKS_IMPORT_MAX_ROWS in the plugin's import.php

  function importModalForm() {
    $('#import-body').innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-dim);margin-top:0;">
        Works with dub.co's own CSV export/import format (Destination URL, Short link, Title,
        Creation date, Clicks, Tags) -- or any CSV with similarly named columns. A Clicks column
        sets each link's starting click count; a Tags column (comma-separated) creates/assigns
        tags. Imported click counts won't have Analytics breakdowns for clicks before the import.
      </p>
      <div class="field">
        <label for="import-file">CSV file</label>
        <input type="file" id="import-file" accept=".csv,text/csv">
      </div>`;
    $('#import-footer').innerHTML = `
      <button type="button" class="btn btn-secondary" data-close>Cancel</button>
      <button type="button" class="btn btn-primary" id="import-submit">Import</button>`;
    $('#import-submit').addEventListener('click', onSubmitImport);
  }

  function openImport() {
    importModalForm();
    openModal('import-modal-backdrop');
  }

  async function onSubmitImport() {
    const file = $('#import-file').files[0];
    if (!file) { toast('Choose a CSV file first', true); return; }

    const submitBtn = $('#import-submit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const res = await Api.importCsv(file);
      if (!res.success) throw new Error(res.message || 'Import failed');

      const errorRows = (res.errors || []).map((e) => `<div class="mini-row"><span>Row ${e.row}${e.url ? ' · ' + escHtml(e.url) : ''}</span><span style="color:var(--red);">${escHtml(e.message)}</span></div>`).join('');

      $('#import-body').innerHTML = `
        <div class="stat-row" style="margin-bottom:14px;">
          <div class="stat-card"><div class="stat-label">Imported</div><div class="stat-value" style="color:var(--green);">${res.imported}</div></div>
          <div class="stat-card"><div class="stat-label">Skipped</div><div class="stat-value" style="color:${res.skipped ? 'var(--red)' : 'var(--text)'};">${res.skipped}</div></div>
        </div>
        ${res.truncated ? `<div class="badge badge-amber" style="margin-bottom:10px;">File has more than ${IMPORT_MAX_ROWS} rows -- only the first batch was imported. Re-upload the rest in a second pass.</div>` : ''}
        ${errorRows ? '<div class="section-label">Skipped rows</div><div class="mini-list">' + errorRows + '</div>' : ''}`;
      $('#import-footer').innerHTML = '<button type="button" class="btn btn-primary" data-close id="import-done">Done</button>';
      $('#import-done').addEventListener('click', () => { closeModal('import-modal-backdrop'); loadLinks(); });

      if (res.imported > 0) toast(`Imported ${res.imported} link${res.imported === 1 ? '' : 's'}`);
    } catch (err) {
      toast(err.message || 'Import failed', true);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Import';
    }
  }

  // ---------- update engine ----------
  let latestUpdateInfo = null;

  async function checkForUpdate() {
    try {
      const info = await Api.checkUpdate();
      if (!info || !info.update_available) return;
      latestUpdateInfo = info;
      if (localStorage.getItem('leanks-update-dismissed') === info.latest) return;
      $('#update-banner-text').textContent = `Leanks v${info.latest} is available (you're on v${info.current}).`;
      $('#update-banner').classList.remove('hidden');
    } catch (e) {
      // A flaky GitHub API must never break the dashboard -- fail silently.
    }
  }

  function openUpdateModal() {
    renderUpdatePreview();
    openModal('update-modal-backdrop');
    Api.listBackups().then((data) => renderBackupsList(data.backups || [])).catch(() => renderBackupsList([]));
  }

  function renderUpdatePreview() {
    const info = latestUpdateInfo;
    $('#update-modal-title').textContent = info ? `Update to v${info.latest}` : 'Update Leanks';
    $('#update-body').innerHTML = `
      ${info ? `<p style="font-size:0.85rem;color:var(--text-dim);margin-top:0;">You're on v${escHtml(info.current)}. This downloads v${escHtml(info.latest)}, verifies its checksum, backs up the files it's about to change, then applies it in place.</p>` : ''}
      ${info && info.changelog ? '<div class="section-label">What\'s new</div><pre class="update-changelog">' + escHtml(info.changelog) + '</pre>' : ''}
      <div id="update-result"></div>
      <div class="section-label">Backups</div>
      <div id="update-backups-list" class="mini-list"><div class="mini-row"><span>Loading…</span></div></div>`;
    $('#update-footer').innerHTML = `
      <button type="button" class="btn btn-secondary" data-close>Cancel</button>
      <button type="button" class="btn btn-primary" id="update-confirm">Update now</button>`;
    $('#update-confirm').addEventListener('click', onConfirmUpdate);
  }

  function formatBytes(n) {
    if (!n) return '0 KB';
    const kb = n / 1024;
    return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  }

  function renderBackupsList(backups) {
    const el = $('#update-backups-list');
    if (!el) return;
    if (!backups.length) {
      el.innerHTML = '<div class="mini-row"><span>No backups yet</span></div>';
      return;
    }
    el.innerHTML = backups.map((b) => `
      <div class="mini-row">
        <span>${escHtml(b.created)} · ${formatBytes(b.size)}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-restore="${escAttr(b.file)}">Restore</button>
      </div>`).join('');
    el.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.confirming) {
          onRestoreBackup(btn.dataset.restore, btn);
        } else {
          btn.dataset.confirming = '1';
          btn.textContent = 'Confirm?';
          setTimeout(() => { delete btn.dataset.confirming; btn.textContent = 'Restore'; }, 3000);
        }
      });
    });
  }

  async function onRestoreBackup(file, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await Api.restoreBackup(file);
      if (!res.success) throw new Error(res.message || 'Restore failed');
      toast('Backup restored — reloading…');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast(err.message || 'Restore failed', true);
      btn.disabled = false;
      btn.textContent = 'Restore';
    }
  }

  async function onConfirmUpdate() {
    const btn = $('#update-confirm');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    $('#update-result').innerHTML = '<p style="font-size:0.85rem;color:var(--text-dim);">Downloading, verifying and applying the update…</p>';

    try {
      const res = await Api.runUpdate();
      if (!res.success) throw new Error(res.message || 'Update failed');

      $('#update-result').innerHTML = `
        <div class="stat-row" style="margin-bottom:14px;">
          <div class="stat-card"><div class="stat-label">Updated</div><div class="stat-value">${res.updated}</div></div>
          <div class="stat-card"><div class="stat-label">Added</div><div class="stat-value">${res.added}</div></div>
          <div class="stat-card"><div class="stat-label">Removed</div><div class="stat-value">${res.removed}</div></div>
        </div>
        <p style="font-size:0.85rem;color:var(--text-dim);">Updated from v${escHtml(res.from_version)} to v${escHtml(res.to_version)} in ${res.duration}s. A backup was saved as <code>${escHtml(res.backup)}</code>.</p>
        ${res.htaccess_note ? '<div class="badge badge-amber" style="margin-bottom:10px;">' + escHtml(res.htaccess_note) + '</div>' : ''}`;
      $('#update-footer').innerHTML = '<button type="button" class="btn btn-primary" id="update-reload">Reload dashboard</button>';
      $('#update-reload').addEventListener('click', () => window.location.reload());
      $('#update-banner').classList.add('hidden');
      toast(`Updated to v${res.to_version}`);
    } catch (err) {
      $('#update-result').innerHTML = '';
      toast(err.message || 'Update failed', true);
      btn.disabled = false;
      btn.textContent = 'Update now';
    }
  }

  // ---------- delete (single row or, via the bulk-action bar, multiple rows at once) ----------
  let pendingDelete = null;
  let pendingBulkKeywords = null;

  function confirmDelete(row) {
    pendingDelete = row;
    pendingBulkKeywords = null;
    $('#delete-modal-title').textContent = 'Delete link?';
    $('#delete-modal-text').textContent = "This can't be undone. The short link will stop working immediately.";
    openModal('delete-modal-backdrop');
  }

  function confirmBulkDelete() {
    const n = state.selected.size;
    if (n === 0) return;
    pendingDelete = null;
    pendingBulkKeywords = Array.from(state.selected);
    $('#delete-modal-title').textContent = `Delete ${n} link${n === 1 ? '' : 's'}?`;
    $('#delete-modal-text').textContent = "This can't be undone. All selected short links will stop working immediately.";
    openModal('delete-modal-backdrop');
  }

  async function onConfirmDelete() {
    const btn = $('#confirm-delete-btn');
    btn.disabled = true;
    try {
      if (pendingBulkKeywords) {
        const rows = pendingBulkKeywords.map((kw) => state.items.find((r) => r.keyword === kw)).filter(Boolean);
        await Promise.all(rows.map((row) => Api.deleteLink(row)));
        toast(`Deleted ${rows.length} link${rows.length === 1 ? '' : 's'}`);
      } else if (pendingDelete) {
        await Api.deleteLink(pendingDelete);
        toast('Link deleted');
      }
      closeModal('delete-modal-backdrop');
      loadLinks();
    } catch (err) {
      toast('Could not delete', true);
    }
    btn.disabled = false;
    pendingDelete = null;
    pendingBulkKeywords = null;
  }

  // ---------- stats ----------
  async function showStats(row) {
    $('#stats-modal-title').textContent = 'Stats · ' + row.keyword;
    $('#stats-body').innerHTML = 'Loading…';
    openModal('stats-modal-backdrop');

    const data = await Api.stats(row.keyword);
    if (!data.success) { $('#stats-body').innerHTML = 'Could not load stats.'; return; }

    const days = Object.keys(data.timeseries);
    const max = Math.max(1, ...Object.values(data.timeseries));
    const bars = days.map((d) => `<div class="bar" style="height:${Math.max(4, (data.timeseries[d] / max) * 90)}px" title="${d}: ${data.timeseries[d]}"></div>`).join('');

    const referrerRows = Object.entries(data.referrers).map(([r, c]) => `<div class="mini-row"><span>${escHtml(r || 'direct')}</span><span>${c}</span></div>`).join('') || '<div class="mini-row"><span>No data yet</span></div>';
    const countryRows = Object.entries(data.countries).map(([c, n]) => `<div class="mini-row"><span>${escHtml(c)}</span><span>${n}</span></div>`).join('') || '<div class="mini-row"><span>No data yet</span></div>';

    $('#stats-body').innerHTML = `
      <div class="stat-card" style="margin-bottom:14px;"><div class="stat-label">Total clicks</div><div class="stat-value">${data.clicks}</div></div>
      <div class="section-label">Last 30 days</div>
      <div class="stat-bars">${bars || '<span style="color:var(--text-faint);font-size:0.8rem;">No clicks yet</span>'}</div>
      <div class="section-label">Top referrers</div>
      <div class="mini-list">${referrerRows}</div>
      <div class="section-label">Top countries</div>
      <div class="mini-list">${countryRows}</div>
    `;
  }

  // ---------- QR ----------
  let currentQrRow = null;
  function showQr(row) {
    currentQrRow = row;
    const holder = $('#qr-canvas-holder');
    holder.innerHTML = '';
    new QRCode(holder, { text: row.shorturl, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
    openModal('qr-modal-backdrop');
  }
  function downloadQr() {
    const img = $('#qr-canvas-holder img') || $('#qr-canvas-holder canvas');
    if (!img) return;
    const link = document.createElement('a');
    link.download = (currentQrRow ? currentQrRow.keyword : 'qrcode') + '.png';
    link.href = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
    link.click();
  }

  // ---------- tags management modal ----------
  function colorLabel(c) { return c.charAt(0).toUpperCase() + c.slice(1); }

  function colorPillsHtml(activeColor) {
    return TAG_COLORS.map((c) => `<button type="button" class="color-pill pill-${c}${c === activeColor ? ' active' : ''}" data-color="${c}">${colorLabel(c)}</button>`).join('');
  }

  async function openTagsModal() {
    $('#tags-body').innerHTML = 'Loading…';
    openModal('tags-modal-backdrop');
    await renderTagsModalBody();
  }

  async function renderTagsModalBody() {
    const tags = await ensureTagsLoaded(true);

    const rows = tags.length ? tags.map((t) => `
      <div class="tag-row">
        <span class="badge badge-${escAttr(t.color)}">${escHtml(t.name)}</span>
        <span class="tag-row-count">${t.link_count} link${t.link_count === 1 ? '' : 's'}</span>
        <div class="tag-row-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-edit="${t.id}">Rename</button>
          <button type="button" class="btn btn-ghost btn-sm" data-delete="${t.id}">Delete</button>
        </div>
      </div>`).join('') : '<div class="mini-row"><span>No tags yet</span></div>';

    $('#tags-body').innerHTML = `
      <div class="tags-list-header">
        <button type="button" class="btn btn-primary btn-sm" id="tag-new-btn">+ New tag</button>
      </div>
      <div class="tag-list">${rows}</div>`;

    $('#tag-new-btn').addEventListener('click', () => openTagEditModal(null));
    $$('[data-edit]').forEach((btn) => {
      const tag = tags.find((t) => t.id === parseInt(btn.dataset.edit, 10));
      btn.addEventListener('click', () => openTagEditModal(tag));
    });
    $$('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      if (btn.dataset.confirming) {
        const res = await Api.deleteTag(btn.dataset.delete);
        if (res.success) { toast('Tag deleted'); await renderTagsModalBody(); loadLinks(); }
      } else {
        btn.dataset.confirming = '1';
        btn.textContent = 'Confirm?';
        setTimeout(() => { delete btn.dataset.confirming; btn.textContent = 'Delete'; }, 3000);
      }
    }));
  }

  // Shared "New tag" / "Edit tag" dialog -- pass null to create, or an existing tag to rename/recolor it.
  function openTagEditModal(tag) {
    closeModal('tags-modal-backdrop');
    $('#tag-edit-modal-title').textContent = tag ? 'Edit tag' : 'New tag';
    $('#te-name').value = tag ? tag.name : '';
    let selectedColor = tag ? tag.color : 'gray';
    $('#te-colors').innerHTML = colorPillsHtml(selectedColor);
    $$('#te-colors .color-pill').forEach((pill) => pill.addEventListener('click', () => {
      selectedColor = pill.dataset.color;
      $$('#te-colors .color-pill').forEach((p) => p.classList.toggle('active', p === pill));
    }));

    const saveBtn = $('#te-save');
    const onSave = async () => {
      const name = $('#te-name').value.trim();
      if (!name) { toast('Tag name is required', true); return; }
      const res = tag
        ? await Api.updateTag(tag.id, { name, color: selectedColor })
        : await Api.createTag(name, selectedColor);
      if (!res.success) { toast(res.message || 'Could not save tag', true); return; }
      toast(tag ? 'Tag updated' : 'Tag created');
      closeModal('tag-edit-modal-backdrop');
      openModal('tags-modal-backdrop');
      await renderTagsModalBody();
      loadLinks();
    };
    saveBtn.replaceWith(saveBtn.cloneNode(true)); // drop any listener from a previous open
    $('#te-save').addEventListener('click', onSave);

    openModal('tag-edit-modal-backdrop');
    $('#te-name').focus();
  }

  // The edit dialog is always opened from the tags list (never standalone), so cancelling it --
  // via the × icon, the Cancel button, or a backdrop click -- should return to that list rather
  // than just closing everything. These bypass the generic [data-close] delegated handler (which
  // indiscriminately hides *every* modal-backdrop) on purpose, since re-showing the list has to
  // happen *after* this modal is hidden, not race it.
  function cancelTagEditModal() {
    closeModal('tag-edit-modal-backdrop');
    openModal('tags-modal-backdrop');
  }
  $('#tag-edit-close').addEventListener('click', cancelTagEditModal);
  $('#tag-edit-cancel').addEventListener('click', cancelTagEditModal);
  $('#tag-edit-modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#tag-edit-modal-backdrop')) cancelTagEditModal();
  });

  // ---------- theme ----------
  // "system" is stored as the absence of a saved value, not the literal string -- keeps
  // getTheme() and the early inline script in index.html's <head> (js/theme-init.js) agreeing
  // on what "no preference set" means.
  const THEME_KEY = 'leanks-theme';

  function getTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function setTheme(theme) {
    try {
      if (theme === 'light' || theme === 'dark') localStorage.setItem(THEME_KEY, theme);
      else localStorage.removeItem(THEME_KEY);
    } catch (e) { /* private mode / quota -- theme just won't persist across reloads */ }
    applyTheme(theme);
  }

  function updateThemeToggleUI() {
    const current = getTheme();
    $$('#s-theme-toggle button').forEach((btn) => btn.classList.toggle('active', btn.dataset.themeMode === current));
  }

  // ---------- settings modal ----------
  async function openSettingsModal() {
    $('#s-default-redirect').value = '';
    openModal('settings-modal-backdrop');
    updateThemeToggleUI();
    try {
      const res = await Api.getSettings();
      $('#s-default-redirect').value = res.default_redirect || '';
    } catch (e) { /* leave blank -- not fatal */ }
    refreshUpdateStatus(false);
  }

  // Bypasses the 24h server-side throttle on `force` -- lets an admin check right after
  // publishing a release instead of waiting for the cached "no update" result to expire.
  async function refreshUpdateStatus(force) {
    const statusEl = $('#s-update-status');
    const btn = $('#s-check-update-btn');
    statusEl.textContent = force ? 'Checking for updates…' : 'Loading…';
    btn.disabled = true;
    try {
      const info = await Api.checkUpdate(force);
      if (!info) throw new Error();
      if (info.update_available) {
        latestUpdateInfo = info;
        statusEl.innerHTML = `Leanks v${escHtml(info.latest)} is available (you're on v${escHtml(info.current)}). <a href="#" id="s-update-view-link">View update</a>`;
        $('#s-update-view-link').addEventListener('click', (e) => {
          e.preventDefault();
          closeModal('settings-modal-backdrop');
          openUpdateModal();
        });
        $('#update-banner-text').textContent = `Leanks v${info.latest} is available (you're on v${info.current}).`;
        $('#update-banner').classList.remove('hidden');
      } else {
        statusEl.textContent = `You're up to date (v${info.current}).`;
      }
    } catch (e) {
      statusEl.textContent = 'Could not check for updates.';
    } finally {
      btn.disabled = false;
    }
  }

  async function onSaveSettings() {
    const btn = $('#settings-save-btn');
    btn.disabled = true;
    try {
      const res = await Api.saveSettings({ default_redirect: $('#s-default-redirect').value.trim() });
      if (!res.success) throw new Error(res.message || 'Could not save settings');
      toast('Settings saved');
      closeModal('settings-modal-backdrop');
    } catch (err) {
      toast(err.message || 'Could not save settings', true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- utils ----------
  function escHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escAttr(s) { return escHtml(s); }
  function formatDate(s) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T'));
    if (isNaN(d)) return s;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
})();
