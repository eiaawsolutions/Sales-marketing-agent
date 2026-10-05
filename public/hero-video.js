/* ============================================================
   EIAAW hero film
   - Autoplays a silent 32s loop on load for every visitor (muted autoplay is the only autoplay browsers allow).
   - "Play with sound" switches to the 52s narrated film from the start; the button becomes Mute / Unmute.
   - Pause / Play controls whichever video is showing (WCAG 2.2.2). A visitor's pause sticks:
     scrolling away and back, or rotating the phone, never restarts it.
   - When the film ends it returns to the silent loop. Scrolling the hero away pauses it.
   - <=720px gets the 4:5 files, larger screens 16:9.
   ============================================================ */
(function () {
  var root = document.querySelector('[data-hero-video]');
  if (!root) return;
  var loop = root.querySelector('.hv-loop'), film = root.querySelector('.hv-film');
  var btn = root.querySelector('.hv-sound'), label = root.querySelector('.hv-label');
  var pauseBtn = root.querySelector('.hv-pause');
  var bar = root.querySelector('.hv-progress span');
  var mobile = window.matchMedia('(max-width: 720px)');
  var mode = 'ambient', pausedByScroll = false, pausedByUser = false;

  function active() { return mode === 'sound' ? film : loop; }
  function pick(kind) { return root.getAttribute('data-' + kind + (mobile.matches ? '-mobile' : '-desktop')); }
  function play(v) { v.play().catch(function () { render(); }); }
  function render() {
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-muted', String(film.muted));
    var paused = active().paused && !pausedByScroll;
    root.setAttribute('data-paused', String(paused));
    pauseBtn.setAttribute('aria-label', paused ? 'Play video' : 'Pause video');
    if (mode === 'ambient') { label.textContent = 'Play with sound'; btn.setAttribute('aria-pressed', 'false'); }
    else { label.textContent = film.muted ? 'Unmute' : 'Mute'; btn.setAttribute('aria-pressed', String(!film.muted)); }
  }
  function loadLoop() {
    var src = pick('loop');
    if (loop.getAttribute('data-current') === src) return;
    loop.setAttribute('data-current', src);
    loop.poster = pick('poster'); loop.src = src; loop.load();
    if (mode === 'ambient' && !pausedByUser) play(loop);
  }
  function toAmbient() {
    mode = 'ambient'; film.pause(); film.hidden = true; bar.style.width = '0';
    pausedByUser = false;
    loadLoop();
    play(loop);
    render();
  }

  btn.addEventListener('click', function () {
    if (mode === 'ambient') {
      var src = pick('film');
      if (film.getAttribute('data-current') !== src) { film.setAttribute('data-current', src); film.src = src; }
      mode = 'sound'; pausedByUser = false; film.muted = false; film.volume = 1;
      try { film.currentTime = 0; } catch (e) {}
      film.hidden = false; loop.pause();
      film.play().catch(function () { toAmbient(); });
      if (window.gtag) { try { window.gtag('event', 'hero_play_with_sound'); } catch (e) {} }
    } else {
      film.muted = !film.muted;
    }
    render();
  });
  pauseBtn.addEventListener('click', function () {
    var v = active();
    pausedByScroll = false;
    if (v.paused) { pausedByUser = false; play(v); }
    else { pausedByUser = true; v.pause(); }
    render();
  });
  film.addEventListener('ended', toAmbient);
  film.addEventListener('volumechange', render);
  film.addEventListener('timeupdate', function () {
    if (film.duration) bar.style.width = (film.currentTime / film.duration * 100) + '%';
  });
  [loop, film].forEach(function (v) {
    v.addEventListener('play', render);
    v.addEventListener('pause', render);
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = active();
        if (!e.isIntersecting && !v.paused) { pausedByScroll = true; v.pause(); }
        else if (e.isIntersecting && pausedByScroll) {
          pausedByScroll = false;
          if (!pausedByUser) play(v);
        }
      });
    }, { threshold: 0.25 }).observe(root);
  }
  var onBp = function () { if (mode === 'ambient') loadLoop(); };
  if (mobile.addEventListener) mobile.addEventListener('change', onBp); else if (mobile.addListener) mobile.addListener(onBp);

  loadLoop();
  render();
})();
