// Runs synchronously in <head>, before app.css is applied, so an explicit light/dark override
// (set via the Settings modal, see app.js's setTheme()) takes effect on first paint instead of
// flashing the OS-default theme first. "system" is stored as the absence of a saved value.
(function () {
  try {
    var theme = localStorage.getItem('leanks-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) { /* private mode / storage blocked -- falls back to OS preference */ }
})();
