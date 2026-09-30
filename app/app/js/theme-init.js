// Runs synchronously in <head>, before app.css is applied, so the saved light/dark override and
// accent color (both set via the Settings modal, see app.js's setTheme()/setAccent()) take effect
// on first paint instead of flashing the defaults first. "system" theme is stored as the absence
// of a saved value.
(function () {
  try {
    var theme = localStorage.getItem('leanks-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) { /* private mode / storage blocked -- falls back to OS preference */ }

  try {
    // {"id":"blue","h":264,"c":0.21} -- hue (degrees) and chroma of the accent in OKLCH.
    var accent = JSON.parse(localStorage.getItem('leanks-accent') || 'null');
    if (accent && isFinite(accent.h) && isFinite(accent.c)) {
      document.documentElement.style.setProperty('--accent-h', String(accent.h));
      document.documentElement.style.setProperty('--accent-c', String(accent.c));
    }
  } catch (e) { /* unparsable / blocked -- keeps the stylesheet's default accent */ }
})();
