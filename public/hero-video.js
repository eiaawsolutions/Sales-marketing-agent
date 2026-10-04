/* ============================================================
   EIAAW hero film
   - Plays a silent 32s loop on load (muted autoplay is the only autoplay browsers allow).
   - "Play with sound" switches to the 52s narrated film from the start; the button becomes Mute / Unmute.
   - When the film ends it returns to the silent loop. Scrolling the hero away pauses it.
   - <=720px gets the 4:5 files, larger screens 16:9. Reduced-motion visitors see the poster.
   ============================================================ */
(function () {
  var root = document.querySelector('[data-hero-video]');
  if (!root) return;
  var loop = root.querySelector('.hv-loop'), film = root.querySelector('.hv-film');
  var btn = root.querySelector('.hv-sound'), label = root.querySelector('.hv-label');
  var bar = root.querySelector('.hv-progress span');
  var mobile = window.matchMedia('(max-width: 720px)');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mode = 'ambient', pausedByScroll = false;

  function pick(kind) { return root.getAttribute('data-' + kind + (mobile.matches ? '-mobile' : '-desktop')); }
  function render() {
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-muted', String(film.muted));
    if (mode === 'ambient') { label.textContent = 'Play with sound'; btn.setAttribute('aria-pressed', 'false'); }
    else { label.textContent = film.muted ? 'Unmute' : 'Mute'; btn.setAttribute('aria-pressed', String(!film.muted)); }
  }
  function loadLoop() {
    var src = pick('loop');
    if (loop.getAttribute('data-current') === src) return;
    loop.setAttribute('data-current', src);
    loop.poster = pick('poster'); loop.src = src; loop.load();
    if (!reduce && mode === 'ambient') loop.play().catch(function () {});
  }
  function toAmbient() {
    mode = 'ambient'; film.pause(); film.hidden = true; bar.style.width = '0';
    loadLoop();
    if (!reduce) loop.play().catch(function () {});
    render();
  }

  btn.addEventListener('click', function () {
    if (mode === 'ambient') {
      var src = pick('film');
      if (film.getAttribute('data-current') !== src) { film.setAttribute('data-current', src); film.src = src; }
      mode = 'sound'; film.muted = false; film.volume = 1;
      try { film.currentTime = 0; } catch (e) {}
      film.hidden = false; loop.pause();
      film.play().catch(function () { toAmbient(); });
      if (window.gtag) { try { window.gtag('event', 'hero_play_with_sound'); } catch (e) {} }
    } else {
      film.muted = !film.muted;
    }
    render();
  });
  film.addEventListener('ended', toAmbient);
  film.addEventListener('volumechange', render);
  film.addEventListener('timeupdate', function () {
    if (film.duration) bar.style.width = (film.currentTime / film.duration * 100) + '%';
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = mode === 'sound' ? film : loop;
        if (!e.isIntersecting && !v.paused) { pausedByScroll = true; v.pause(); }
        else if (e.isIntersecting && pausedByScroll) {
          pausedByScroll = false;
          if (!reduce || mode === 'sound') v.play().catch(function () {});
        }
      });
    }, { threshold: 0.25 }).observe(root);
  }
  var onBp = function () { if (mode === 'ambient') loadLoop(); };
  if (mobile.addEventListener) mobile.addEventListener('change', onBp); else if (mobile.addListener) mobile.addListener(onBp);

  loadLoop();
  render();
})();
