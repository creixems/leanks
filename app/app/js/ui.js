/**
 * Generic anchored popover, shared by the Analytics range/filter pickers (app/js/analytics.js)
 * and the links-list Filter/Display pickers (app/js/app.js). Positions itself against a trigger
 * element's bounding rect into the single `#popover` mount div in index.html, and closes itself
 * on an outside click or Escape.
 */
const UI = (function () {
  const $ = (sel) => document.querySelector(sel);

  let currentKind = null;
  let currentAnchor = null;

  /**
   * Marks a popover "kind" as pending before an async fetch that will fill its content (e.g.
   * loading filter option lists). Callers should check `UI.popoverKind() === kind` once the fetch
   * resolves, before rendering, so a stale response can't render into a popover the user has since
   * closed or replaced with a different one.
   */
  function reserveKind(kind) {
    currentKind = kind;
  }

  function openPopover(anchorEl, html, kind) {
    currentKind = kind != null ? kind : currentKind;
    currentAnchor = anchorEl;
    const pop = $('#popover');
    pop.innerHTML = html;
    pop.classList.remove('hidden');
    const rect = anchorEl.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    pop.style.left = (rect.left + window.scrollX) + 'px';
  }

  function closePopover() {
    currentKind = null;
    currentAnchor = null;
    const pop = $('#popover');
    if (!pop) return;
    pop.classList.add('hidden');
    pop.innerHTML = '';
  }

  function popoverKind() {
    return currentKind;
  }

  document.addEventListener('click', (e) => {
    const pop = $('#popover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    if (currentAnchor && currentAnchor.contains(e.target)) return;
    closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });

  return { openPopover, closePopover, popoverKind, reserveKind };
})();
