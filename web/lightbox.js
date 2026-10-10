(function () {
  var dlg = document.getElementById("lightbox");
  if (!dlg || typeof dlg.showModal !== "function") return;

  var shots = [].slice.call(document.querySelectorAll(".shot img, .gallery img"));
  var big = dlg.querySelector(".lb-img");
  var cap = dlg.querySelector(".lb-cap");
  var current = 0;

  function show(n) {
    current = (n + shots.length) % shots.length;
    var src = shots[current];
    var fig = src.closest("figure");
    var fc = fig && fig.querySelector("figcaption");
    big.src = src.currentSrc || src.src;
    big.alt = src.alt;
    cap.textContent = fc ? fc.textContent : "";
    var next = new Image();
    next.src = (shots[(current + 1) % shots.length].currentSrc) || "";
  }

  function open(n) {
    show(n);
    if (!dlg.open) dlg.showModal();
  }

  shots.forEach(function (img, n) {
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-haspopup", "dialog");
    img.addEventListener("click", function () { open(n); });
    img.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(n); }
    });
  });

  dlg.querySelector(".lb-close").addEventListener("click", function () { dlg.close(); });
  dlg.querySelector(".lb-prev").addEventListener("click", function () { show(current - 1); });
  dlg.querySelector(".lb-next").addEventListener("click", function () { show(current + 1); });

  dlg.addEventListener("click", function (e) {
    if (!e.target.closest(".lb-img, .lb-btn, .lb-cap")) dlg.close();
  });

  dlg.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") show(current - 1);
    else if (e.key === "ArrowRight") show(current + 1);
  });

  dlg.addEventListener("close", function () { big.removeAttribute("src"); });

  var startX = null;
  dlg.addEventListener("touchstart", function (e) { startX = e.changedTouches[0].clientX; }, { passive: true });
  dlg.addEventListener("touchend", function (e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 60) show(current + (dx < 0 ? 1 : -1));
  }, { passive: true });
})();
