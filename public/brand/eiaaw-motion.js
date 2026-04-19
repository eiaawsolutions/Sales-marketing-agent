/* ============================================================
   EIAAW SOLUTIONS — Shared motion layer v1.0
   Respects prefers-reduced-motion. Source: landing.html
   ============================================================ */
(function(){
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Kinetic type: split .kinetic .line into word spans ---
  document.querySelectorAll('.kinetic').forEach((el) => {
    const lines = el.querySelectorAll('.line');
    lines.forEach((line) => {
      const frag = document.createDocumentFragment();
      line.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const parts = node.textContent.split(/(\s+)/);
          parts.forEach(p => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); return; }
            const s = document.createElement('span'); s.className = 'word'; s.textContent = p;
            frag.appendChild(s);
          });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const wrap = document.createElement('span');
          wrap.className = 'word';
          wrap.appendChild(node.cloneNode(true));
          frag.appendChild(wrap);
        }
      });
      line.innerHTML = '';
      line.appendChild(frag);
    });
  });

  window.addEventListener('load', () => {
    const words = document.querySelectorAll('.kinetic .word');
    if (reduce) { words.forEach(w => w.classList.add('in')); return; }
    words.forEach((w, i) => { setTimeout(() => w.classList.add('in'), 120 + i * 70); });
  });

  // --- Scroll reveal ---
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.rvl').forEach(el => io.observe(el));

  // --- Nav scrolled state ---
  const nav = document.getElementById('siteNav');
  const onNavScroll = () => { if (nav) nav.classList.toggle('scrolled', window.scrollY > 12); };
  window.addEventListener('scroll', onNavScroll, { passive: true });
  onNavScroll();

  // --- Count-up numbers ---
  const countEls = document.querySelectorAll('.count');
  const countIO = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const target = parseInt(el.dataset.to || '0', 10);
      if (reduce) { el.textContent = target; countIO.unobserve(el); return; }
      const dur = 1400; const start = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased);
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      countIO.unobserve(el);
    });
  }, { threshold: 0.4 });
  countEls.forEach(el => countIO.observe(el));

  // --- Magnetic buttons ---
  if (!reduce) {
    document.querySelectorAll('.magnetic').forEach((btn) => {
      let raf = null;
      const strength = 0.28;
      btn.addEventListener('mousemove', (e) => {
        const r = btn.getBoundingClientRect();
        const x = e.clientX - (r.left + r.width / 2);
        const y = e.clientY - (r.top + r.height / 2);
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { btn.style.transform = `translate(${x * strength}px, ${y * strength}px)`; });
      });
      btn.addEventListener('mouseleave', () => { if (raf) cancelAnimationFrame(raf); btn.style.transform = ''; });
    });
  }

  // --- Parallax on [data-parallax] images ---
  if (!reduce) {
    const pxEls = document.querySelectorAll('[data-parallax]');
    let ticking = false;
    const onScrollPx = () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => {
        pxEls.forEach((el) => {
          const r = el.getBoundingClientRect();
          const vh = window.innerHeight;
          const center = r.top + r.height / 2;
          const delta = (center - vh / 2) / vh;
          const y = Math.max(-40, Math.min(40, -delta * 28));
          const img = el.matches('img') ? el : el.querySelector('img');
          if (img) img.style.transform = `translateY(${y}px) scale(1.05)`;
        });
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScrollPx, { passive: true });
    onScrollPx();
  }
})();
