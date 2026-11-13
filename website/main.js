// Strata site behaviour. No dependencies, no scroll listeners: IntersectionObserver and
// CSS scroll-driven animation do the scroll work.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const observe = (els, cb, opts) => {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => cb(e, io)), opts);
    [].concat(els).filter(Boolean).forEach((el) => io.observe(el));
    return io;
  };

  // Nav gets its hairline once the page has moved.
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:12px;pointer-events:none';
  document.body.prepend(sentinel);
  observe(sentinel, (e) => $('[data-nav]').classList.toggle('is-stuck', !e.isIntersecting));

  // Copy buttons.
  const icon = (id) => $(`#icon-${id}`).content.cloneNode(true);
  $$('[data-copy]').forEach((btn) => {
    btn.append(icon('copy'));
    const label = btn.getAttribute('aria-label');
    let timer;
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.replaceChildren(icon('check'));
      btn.classList.add('is-done');
      btn.setAttribute('aria-label', 'Copied');
      clearTimeout(timer);
      timer = setTimeout(() => {
        btn.replaceChildren(icon('copy'));
        btn.classList.remove('is-done');
        btn.setAttribute('aria-label', label);
      }, 1600);
    });
  });

  // Statement: one span per word, numbered, so CSS can sharpen them in order.
  const words = $('[data-words]');
  if (words) {
    let i = 0;
    const wrap = (text, cls) => text.split(/(\s+)/).map((part) => {
      if (!part.trim()) return document.createTextNode(part);
      const span = document.createElement('span');
      span.className = cls;
      span.style.setProperty('--i', i++);
      span.textContent = part;
      return span;
    });
    const out = [];
    words.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) out.push(...wrap(node.textContent, 'w'));
      else {
        const em = node.cloneNode(false);
        em.append(...wrap(node.textContent, 'w'));
        out.push(em);
      }
    });
    words.replaceChildren(...out);
    observe($('[data-statement]'), (e, io) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      io.disconnect();
    }, { threshold: 0.35 });
  }

  // Reveal on entry, staggered among siblings.
  $$('[data-reveal]').forEach((el) => {
    const siblings = $$(':scope > [data-reveal]', el.parentElement);
    el.style.setProperty('--d', siblings.indexOf(el));
  });
  observe($$('[data-reveal]'), (e, io) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('is-in');
    io.unobserve(e.target);
  }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });

  // Benchmark numbers count up once.
  if (!reduce) {
    observe($$('[data-count]'), (e, io) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const el = e.target;
      const end = Number(el.dataset.count);
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - start) / 1300);
        el.textContent = Math.round(end * (1 - (1 - p) ** 3));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // A throttled tab can stall the frames; the real figure must still land.
      setTimeout(() => { el.textContent = end; }, 1500);
    }, { threshold: 0.6 });
  }

  // Trust labels: a chip lights the lines of the pack that carry its label.
  const pack = $('[data-pack]');
  const chips = $$('[data-chips] .chip');
  chips.forEach((chip) => chip.addEventListener('click', () => {
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip && on)));
    if (on) pack.dataset.active = chip.dataset.label;
    else delete pack.dataset.active;
    $$('.ln', pack).forEach((ln) => ln.classList.toggle('is-on', on && (ln.dataset.l || '').split(' ').includes(chip.dataset.label)));
  }));

  // Copy bar steps aside while the hero, the install commands or the footer are on screen.
  const bar = $('[data-copybar]');
  const covering = new Set();
  observe([$('.hero'), $('#install'), $('.footer')], (e) => {
    if (e.isIntersecting) covering.add(e.target);
    else covering.delete(e.target);
    bar.classList.toggle('is-hidden', covering.size > 0);
  }, { threshold: 0.2 });

  // Hero stage: three layers that drift, and merge around the pointer.
  const stage = $('[data-stage]');
  if (stage) {
    const svg = $('svg', stage);
    const bands = $$('[data-band]', svg);
    const lens = $('[data-lens]', svg);
    const X0 = 110, X1 = 490, STEP = 19, H = 54;
    const centers = [190, 270, 350];
    const pointer = { x: 300, y: 270, tx: 300, ty: 270, r: 0, tr: 0 };

    const draw = (time) => {
      bands.forEach((band, i) => {
        const yc = centers[i];
        const near = Math.max(0, 1 - Math.abs(pointer.y - yc) / 130) * (pointer.r / 30);
        const top = [];
        const bottom = [];
        for (let x = X0; x <= X1; x += STEP) {
          const pull = near * Math.exp(-((x - pointer.x) ** 2) / 9800) * 11;
          const a = 4.5 * Math.sin(x * 0.017 + time * 0.9 + i * 1.9) + 2.5 * Math.sin(x * 0.043 - time * 0.6 + i);
          const b = 4.5 * Math.sin(x * 0.015 - time * 0.8 + i * 2.6) + 2.5 * Math.sin(x * 0.039 + time * 0.7 + i);
          top.push(`${x},${(yc - H / 2 + a - pull).toFixed(1)}`);
          bottom.unshift(`${x},${(yc + H / 2 + b + pull).toFixed(1)}`);
        }
        band.setAttribute('d', `M${top.join('L')}L${bottom.join('L')}Z`);
      });
      lens.setAttribute('cx', pointer.x.toFixed(1));
      lens.setAttribute('cy', pointer.y.toFixed(1));
      lens.setAttribute('r', Math.max(0, pointer.r).toFixed(1));
    };

    draw(0);
    if (!reduce) {
      let raf = 0;
      let visible = false;
      const loop = (now) => {
        pointer.x += (pointer.tx - pointer.x) * 0.14;
        pointer.y += (pointer.ty - pointer.y) * 0.14;
        pointer.r += (pointer.tr - pointer.r) * 0.12;
        draw(now / 1000);
        raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
      };
      const start = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(loop); };
      observe(stage, (e) => { visible = e.isIntersecting; start(); });
      document.addEventListener('visibilitychange', start);

      stage.addEventListener('pointermove', (e) => {
        const box = svg.getBoundingClientRect();
        pointer.tx = ((e.clientX - box.left) / box.width) * 600;
        pointer.ty = ((e.clientY - box.top) / box.height) * 540;
        pointer.tr = 30;
      });
      stage.addEventListener('pointerleave', () => { pointer.tr = 0; });
    }
  }
})();
