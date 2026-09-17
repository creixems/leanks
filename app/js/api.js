/**
 * Thin fetch wrapper around YOURLS' admin-ajax.php (stock actions: add / edit_save / delete)
 * and the Leanks plugin's own actions (registered as yourls_ajax_leanks_*, reached the same way
 * via admin-ajax.php?action=leanks_xxx).
 */
const Api = (function () {
  const AJAX_URL = '../admin/admin-ajax.php';

  let boot = null;

  async function call(action, params, method) {
    method = method || 'GET';
    const url = new URL(AJAX_URL, window.location.href);
    let opts = { credentials: 'same-origin' };

    if (method === 'GET') {
      url.searchParams.set('action', action);
      for (const k in params || {}) url.searchParams.set(k, params[k]);
      opts.method = 'GET';
    } else {
      opts.method = 'POST';
      const body = new URLSearchParams({ action, ...(params || {}) });
      opts.body = body;
    }

    const res = await fetch(url, opts);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Unexpected server response');
    }
  }

  return {
    async bootstrap() {
      if (boot) return boot;
      boot = await call('leanks_bootstrap');
      return boot;
    },

    async checkAuth() {
      const r = await fetch('auth.php?check=1', { credentials: 'same-origin' });
      const data = await r.json();
      return !!data.authenticated;
    },

    async logout() {
      await fetch('auth.php', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams({ logout: '1' }) });
    },

    async listLinks(params) {
      return call('leanks_list', params);
    },

    async stats(keyword) {
      return call('leanks_stats', { keyword });
    },

    async createLink(fields) {
      const b = await this.bootstrap();
      // YOURLS' stock "add" action requires a rowid (used server-side to build a discarded HTML
      // snippet we never render) -- any value works, it's just a DOM-id counter in stock admin.
      return call('add', { ...fields, rowid: 1, nonce: b.nonce_add }, 'POST');
    },

    async saveMeta(fields) {
      const b = await this.bootstrap();
      return call('leanks_save_meta', { ...fields, nonce: b.nonce_meta }, 'POST');
    },

    async editLink(row, fields) {
      return call('edit_save', { id: row.keyword, url: fields.url, keyword: row.keyword, newkeyword: fields.keyword, title: fields.title, nonce: row.nonce_edit }, 'POST');
    },

    async deleteLink(row) {
      return call('delete', { id: row.keyword, keyword: row.keyword, nonce: row.nonce_delete }, 'POST');
    },
  };
})();
