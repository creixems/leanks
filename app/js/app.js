(function () {
  let state = { page: 1, perpage: 20, search: '', total: 0, items: [] };
  let editingRow = null; // null = create mode, otherwise the row object being edited

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
    // Search/Import/Create are Links-view-only actions.
    [$('#search-input').closest('.topbar-search'), $('#import-btn'), $('#create-btn')].forEach((el) => {
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
    tbody.innerHTML = '<tr><td colspan="4" style="padding:24px;"><div class="skeleton" style="height:40px;"></div></td></tr>';

    const data = await Api.listLinks({ search: state.search, page: state.page, perpage: state.perpage, sort: 'timestamp', order: 'DESC' });
    state.items = data.items;
    state.total = data.total;

    $('#stat-total-links').textContent = data.total;
    $('#stat-total-clicks').textContent = data.items.reduce((s, r) => s + r.clicks, 0) + (data.total > data.items.length ? '+' : '');

    if (data.items.length === 0) {
      tbody.innerHTML = '';
      $('#empty-state').classList.remove('hidden');
    } else {
      $('#empty-state').classList.add('hidden');
      tbody.innerHTML = data.items.map(renderRow).join('');
    }

    renderPagination();
    bindRowEvents();
  }

  function renderRow(row) {
    const badges = [];
    if (row.has_password) badges.push('<span class="badge badge-blue">🔒 Password</span>');
    if (row.is_expired) badges.push('<span class="badge badge-red">Expired</span>');
    else if (row.expires_at) badges.push('<span class="badge badge-amber">Expires ' + formatDate(row.expires_at) + '</span>');
    if (row.max_clicks) badges.push('<span class="badge badge-gray">Limit ' + row.max_clicks + '</span>');
    if (row.utm && (row.utm.source || row.utm.campaign)) badges.push('<span class="badge badge-gray">UTM</span>');

    return `
      <tr data-keyword="${escAttr(row.keyword)}">
        <td class="link-cell">
          <div class="short">
            <a href="${escAttr(row.shorturl)}" target="_blank" rel="noopener">${escHtml(row.shorturl.replace(/^https?:\/\//, ''))}</a>
            <button class="copy-btn" data-copy="${escAttr(row.shorturl)}" title="Copy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
          <div class="dest" title="${escAttr(row.url)}">${escHtml(row.url)}</div>
          ${badges.length ? '<div class="badge-row">' + badges.join('') + '</div>' : ''}
        </td>
        <td class="clicks-cell">${row.clicks}</td>
        <td style="color:var(--text-dim);font-size:0.82rem;">${formatDate(row.timestamp)}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-ghost btn-icon" data-action="qr" title="QR code">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM17 17h4v4h-4zM14 21h3M21 14v3"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon" data-action="stats" title="Stats">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-6 4 3 5-8"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon" data-action="edit" title="Edit">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon" data-action="delete" title="Delete">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
  }

  function bindRowEvents() {
    $$('#links-tbody tr[data-keyword]').forEach((tr) => {
      const keyword = tr.dataset.keyword;
      const row = state.items.find((r) => r.keyword === keyword);

      tr.querySelector('[data-copy]')?.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(row.shorturl).then(() => toast('Copied to clipboard'));
      });
      tr.querySelector('[data-action="qr"]')?.addEventListener('click', () => showQr(row));
      tr.querySelector('[data-action="stats"]')?.addEventListener('click', () => showStats(row));
      tr.querySelector('[data-action="edit"]')?.addEventListener('click', () => openEdit(row));
      tr.querySelector('[data-action="delete"]')?.addEventListener('click', () => confirmDelete(row));
    });
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

  // ---------- create / edit modal ----------
  function bindEvents() {
    $('#create-btn').addEventListener('click', openCreate);
    $('#logout-btn').addEventListener('click', async () => { await Api.logout(); window.location.replace('login.html'); });

    $$('.nav-tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

    $('#f-password-toggle').addEventListener('change', (e) => {
      $('#f-password-wrap').classList.toggle('hidden', !e.target.checked);
    });

    ['f-url', 'f-utm-source', 'f-utm-medium', 'f-utm-campaign', 'f-utm-term', 'f-utm-content'].forEach((id) => {
      $('#' + id).addEventListener('input', updateUtmPreview);
    });

    $('#link-form').addEventListener('submit', onSubmitLinkForm);
    $('#confirm-delete-btn').addEventListener('click', onConfirmDelete);
    $('#qr-download').addEventListener('click', downloadQr);

    $('#import-btn').addEventListener('click', openImport);

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
  }

  function openCreate() {
    editingRow = null;
    resetForm();
    $('#link-modal-title').textContent = 'Create link';
    $('#link-form-submit').textContent = 'Create link';
    $('#f-keyword').disabled = false;
    openModal('link-modal-backdrop');
    $('#f-url').focus();
  }

  function openEdit(row) {
    editingRow = row;
    resetForm();
    $('#link-modal-title').textContent = 'Edit link';
    $('#link-form-submit').textContent = 'Save changes';

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

    if (row.has_password || row.expires_at || row.max_clicks || u.source || u.campaign) {
      $('#advanced-section').setAttribute('open', '');
    }

    updateUtmPreview();
    openModal('link-modal-backdrop');
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

      if (!editingRow) {
        const res = await Api.createLink({
          url: finalUrl,
          keyword,
          title,
          password: passwordEnabled ? passwordValue : '',
          expires_at: expires ? expires.replace('T', ' ') : '',
          max_clicks: maxClicks || '',
          ...utm,
        });
        if (res.status !== 'success') throw new Error(res.message || 'Could not create link');
        toast('Link created');
      } else {
        const editRes = await Api.editLink(editingRow, { url: finalUrl, keyword: keyword || editingRow.keyword, title });
        if (editRes.status && editRes.status !== 'success') throw new Error(editRes.message || 'Could not save link');

        const metaFields = { keyword: keyword || editingRow.keyword, expires_at: expires ? expires.replace('T', ' ') : '', max_clicks: maxClicks || '', ...utm };
        if (passwordEnabled && passwordValue) metaFields.password = passwordValue;
        else if (!passwordEnabled) metaFields.remove_password = '1';
        await Api.saveMeta(metaFields);
        toast('Link updated');
      }

      closeModal('link-modal-backdrop');
      loadLinks();
    } catch (err) {
      toast(err.message || 'Something went wrong', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  // ---------- import CSV ----------
  const IMPORT_MAX_ROWS = 2000; // keep in sync with LEANKS_IMPORT_MAX_ROWS in the plugin's import.php

  function importModalForm() {
    $('#import-body').innerHTML = `
      <p style="font-size:0.85rem;color:var(--text-dim);margin-top:0;">
        Works with dub.co's own CSV export/import format (Destination URL, Short link, Title,
        Creation date) -- or any CSV with similarly named columns.
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

  // ---------- delete ----------
  let pendingDelete = null;
  function confirmDelete(row) {
    pendingDelete = row;
    openModal('delete-modal-backdrop');
  }
  async function onConfirmDelete() {
    if (!pendingDelete) return;
    try {
      await Api.deleteLink(pendingDelete);
      toast('Link deleted');
      closeModal('delete-modal-backdrop');
      loadLinks();
    } catch (err) {
      toast('Could not delete link', true);
    }
    pendingDelete = null;
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
