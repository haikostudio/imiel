/* Vitrine getimiel.com : theme, langue, bouton de telechargement selon l'appareil,
   demo au curseur, apparitions au defilement, FAQ animee, et l'avion du logo qui
   suit le fil (arrondi, sans angle droit) au defilement. Sans dependance.
   Les mouvements s'arretent si l'appareil demande moins d'animations. */
(function () {
  'use strict';
  var d = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var store = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* navigation privee */ } };
  var q = function (s, r) { return (r || document).querySelector(s); };
  var qa = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---------- theme ----------
  qa('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var next = d.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      d.setAttribute('data-theme', next);
      store('imiel-theme', next);
    });
  });

  // ---------- langue : le choix explicite l'emporte ensuite ----------
  qa('[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () { store('imiel-lang', a.getAttribute('data-lang')); });
  });
  document.addEventListener('click', function (e) {
    qa('details.langsel[open]').forEach(function (el) { if (!el.contains(e.target)) el.removeAttribute('open'); });
  });

  // ---------- menu du telephone ----------
  // Panneau pose par-dessus la page : il se ferme au toucher d'un lien, en dehors, ou sur Echap.
  var burger = q('[data-burger]'), navEl = q('[data-nav]'), panel = q('[data-mpanel]');
  var setMenu = function (open) {
    if (!burger || !panel) return;
    navEl.classList.toggle('open', open);
    panel.hidden = !open;
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  if (burger && panel) {
    burger.addEventListener('click', function () { setMenu(panel.hidden); });
    qa('a', panel).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    document.addEventListener('click', function (e) { if (!panel.hidden && !navEl.contains(e.target)) setMenu(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) { setMenu(false); burger.focus(); } });
    window.matchMedia('(min-width: 1100px)').addEventListener('change', function (m) { if (m.matches) setMenu(false); });
  }

  // ---------- appareil du visiteur ----------
  var ua = navigator.userAgent || '';
  var os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iphone'
    : /Mac OS X|Macintosh/.test(ua) ? 'mac'
    : /Windows/.test(ua) ? 'windows'
    : /Android/.test(ua) ? 'other'
    : /Linux|X11|CrOS/.test(ua) ? 'linux' : 'other';
  qa('[data-os-cta]').forEach(function (a) {
    var labels = JSON.parse(a.getAttribute('data-labels'));
    qa('[data-os-label]', a).forEach(function (l) { l.textContent = labels[os]; });
    a.setAttribute('href', a.getAttribute('data-base') + (os === 'other' ? '' : '#' + os));
    var ic = q('.os-ico', a);
    if (ic && os !== 'mac') ic.style.display = 'none';
  });
  qa('[data-os-note]').forEach(function (n) { n.textContent = JSON.parse(n.getAttribute('data-notes'))[os]; });
  var mine = q('[data-dl="' + os + '"]');
  if (mine) mine.classList.add('mine');

  // ---------- FAQ : l'ouverture pousse la suite, en douceur ----------
  qa('.flist details').forEach(function (det) {
    var sum = q('summary', det), ans = q('.ans', det);
    sum.addEventListener('click', function (e) {
      e.preventDefault();
      if (det.classList.contains('shown')) {
        det.classList.remove('shown');
        var close = function () { if (!det.classList.contains('shown')) det.open = false; };
        if (reduced) close(); else setTimeout(close, 480);
      } else {
        det.open = true;
        void ans.offsetHeight;
        det.classList.add('shown');
      }
    });
  });

  // ---------- apparitions : par le bas en descendant, par le haut en remontant ----------
  if (!reduced && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var el = e.target;
        if (e.isIntersecting) el.classList.add('in');
        else {
          // Sorti par le haut : il reviendra par le haut ; sorti par le bas : par le bas.
          el.style.setProperty('--rvy', e.boundingClientRect.top < 0 ? '-28px' : '34px');
          el.classList.remove('in');
        }
      });
    }, { rootMargin: '0px 0px -5% 0px' });
    qa('[data-rv]').forEach(function (el) { io.observe(el); });
  } else qa('[data-rv]').forEach(function (el) { el.classList.add('in'); });

  // ---------- demo : un curseur clique d'un service a l'autre ----------
  var demo = q('[data-demo]');
  var shownSvc = 0;
  if (demo) {
    var figs = qa('[data-screen]', demo);
    var cursor = q('[data-cursor]', demo);
    var capT = q('[data-cap-text]'), capN = q('[data-cap-n]'), capName = q('[data-cap-name]');
    var caps = JSON.parse(capT.getAttribute('data-caps')), names = JSON.parse(capT.getAttribute('data-names'));
    // Point a cliquer dans chaque capture (fraction de l'ecran) : menu lateral, puis le volet de l'assistant.
    var TARGETS = [[0.068, 0.348], [0.068, 0.678], [0.068, 0.724], [0.068, 0.815], [0.068, 0.770], [0.75, 0.052]];
    // Le calque du curseur couvre exactement l'ecran, sans le rogner : le curseur peut venir du dehors.
    var layer = document.createElement('div');
    layer.className = 'cur-layer';
    q('.lid', demo).appendChild(layer);
    layer.appendChild(cursor);
    var show = function (i) {
      shownSvc = i;
      figs.forEach(function (f, k) { f.classList.toggle('on', k === i); });
      capT.textContent = caps[i]; capN.textContent = String(i + 1); capName.textContent = names[i];
      qa('[data-svc]').forEach(function (s) { q('.bub', s).classList.toggle('goldb', +s.getAttribute('data-svc') === i); });
      qa('[data-chip]').forEach(function (c) {
        var k = +c.getAttribute('data-chip');
        q('.bub', c).classList.toggle('goldb', k === i);
        if (k === i) c.classList.add('on');
      });
    };
    var place = function (x, y) { cursor.style.left = (x * 100).toFixed(2) + '%'; cursor.style.top = (y * 100).toFixed(2) + '%'; };
    var timers = [], running = false, visible = false;
    var later = function (fn, ms) { timers.push(setTimeout(fn, ms)); };
    var stop = function () { running = false; timers.forEach(clearTimeout); timers = []; };
    var step = function () {
      if (!running) return;
      var next = (shownSvc + 1) % TARGETS.length;
      place(TARGETS[next][0], TARGETS[next][1]);
      later(function () {
        cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click');
        show(next);
        later(step, 2700);
      }, 1050);
    };
    var start = function () {
      if (reduced || running || !visible || document.hidden) return;
      running = true;
      if (!cursor.classList.contains('vis')) {
        // Premiere entree : le curseur arrive de l'exterieur de l'ecran.
        cursor.style.transition = 'none'; place(1.06, 0.8); void cursor.offsetWidth; cursor.style.transition = '';
        cursor.classList.add('vis');
      }
      later(step, 900);
    };
    show(0);
    if (!reduced) {
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (en) { visible = en[0].isIntersecting; if (visible) start(); else stop(); }, { threshold: 0.25 }).observe(demo);
      } else { visible = true; start(); }
      document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    }
  }

  // ---------- le fil et l'avion ----------
  var svg = q('[data-thread]');
  var plane = q('[data-plane]');
  var main = q('[data-stage]');
  if (!svg || !plane || !main) return;
  var compact = window.matchMedia('(max-width: 1099.98px)');
  var S = null, stations = [], nodes = [], links = qa('.lk2');
  var READ = 0.55; // la ligne de lecture : 55 % de la hauteur de la fenetre

  // Position de mise en page (sans les decalages des apparitions ni des etats animes).
  function lay(el) {
    var x = 0, y = 0, e = el;
    while (e) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    var w = el.offsetWidth, h = el.offsetHeight;
    return { l: x, t: y, r: x + w, b: y + h, w: w, h: h, cx: x + w / 2, cy: y + h / 2 };
  }

  // Polyligne de passage -> chaque coin devient un arc (rayon <= RMAX) -> lissage.
  // Resultat : aucun angle droit, aucun coude, quel que soit le passage.
  // RMAX : 230 sur ordinateur, 150 sur tablette et telephone (traversees plus courtes).
  function rounded(P, RMAX) {
    var n = P.length, len = [], dir = [], i;
    for (i = 0; i < n - 1; i++) {
      var dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], l = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      len.push(l); dir.push([dx / l, dy / l]);
    }
    var th = [0], t = [0];
    for (i = 1; i < n - 1; i++) {
      var a = dir[i - 1], b = dir[i], c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])), ang = Math.acos(c);
      th.push(ang); t.push(RMAX * Math.tan(ang / 2));
    }
    th.push(0); t.push(0);
    // deux arcs qui se disputent un segment se partagent sa longueur
    for (var it = 0; it < 6; it++) for (i = 0; i < n - 1; i++) {
      var s = t[i] + t[i + 1];
      if (s > len[i] * 0.98) { var k = len[i] * 0.98 / s; t[i] *= k; t[i + 1] *= k; }
    }
    var out = [P[0].slice()];
    for (i = 1; i < n - 1; i++) {
      var A = dir[i - 1], B = dir[i];
      if (th[i] < 1e-3 || t[i] < 0.5) { out.push(P[i].slice()); continue; }
      var r = t[i] / Math.tan(th[i] / 2), S0 = [P[i][0] - A[0] * t[i], P[i][1] - A[1] * t[i]];
      var cr = A[0] * B[1] - A[1] * B[0], nrm = cr > 0 ? [-A[1], A[0]] : [A[1], -A[0]], C = [S0[0] + nrm[0] * r, S0[1] + nrm[1] * r];
      var a0 = Math.atan2(S0[1] - C[1], S0[0] - C[0]), sg = cr > 0 ? 1 : -1, steps = Math.max(4, Math.ceil(r * th[i] / 6));
      for (var k2 = 0; k2 <= steps; k2++) { var an = a0 + sg * th[i] * k2 / steps; out.push([C[0] + r * Math.cos(an), C[1] + r * Math.sin(an)]); }
    }
    out.push(P[n - 1].slice());
    var res = [out[0]];
    for (i = 1; i < out.length; i++) {
      var p0 = res[res.length - 1], qq = out[i], dd = Math.sqrt((qq[0] - p0[0]) * (qq[0] - p0[0]) + (qq[1] - p0[1]) * (qq[1] - p0[1]));
      while (dd >= 4) {
        var f = 4 / dd; p0 = [p0[0] + (qq[0] - p0[0]) * f, p0[1] + (qq[1] - p0[1]) * f]; res.push(p0);
        dd = Math.sqrt((qq[0] - p0[0]) * (qq[0] - p0[0]) + (qq[1] - p0[1]) * (qq[1] - p0[1]));
      }
    }
    res.push(out[out.length - 1]);
    var sig = 12, W = 36, sm = [];
    for (i = 0; i < res.length; i++) {
      var sx = 0, sy = 0, sw = 0, h = Math.min(W, i, res.length - 1 - i);
      for (var j = -h; j <= h; j++) { var w = Math.exp(-(j * j) / (2 * sig * sig)); sx += res[i + j][0] * w; sy += res[i + j][1] * w; sw += w; }
      sm.push([sx / sw, sy / sw]);
    }
    return sm;
  }

  // Trace allege pour le dessin (les echantillons denses restent pour l'avion).
  function simplify(p, eps) {
    var keep = new Uint8Array(p.length), stack = [[0, p.length - 1]];
    keep[0] = keep[p.length - 1] = 1;
    while (stack.length) {
      var se = stack.pop(), a = p[se[0]], b = p[se[1]], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.sqrt(dx * dx + dy * dy) || 1e-6, best = -1, bi = -1;
      for (var i = se[0] + 1; i < se[1]; i++) { var dist = Math.abs(dy * p[i][0] - dx * p[i][1] + b[0] * a[1] - b[1] * a[0]) / L; if (dist > best) { best = dist; bi = i; } }
      if (best > eps) { keep[bi] = 1; stack.push([se[0], bi], [bi, se[1]]); }
    }
    var d = '';
    for (var k = 0; k < p.length; k++) if (keep[k]) d += (d ? ' L ' : 'M ') + p[k][0].toFixed(1) + ' ' + p[k][1].toFixed(1);
    return d;
  }

  function nearestIdx(x, y) {
    var bi = 0, bd = Infinity;
    for (var i = 0; i < S.x.length; i++) { var dx = S.x[i] - x, dy = S.y[i] - y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; bi = i; } }
    return bi;
  }

  // Avancement monotone : le fil sert de rail, l'avion avance avec la lecture.
  // Les traversees a plat avancent quand meme (pente minimale g) ; au depart,
  // l'avion vole plus bas que la ligne de lecture, ecart efface sur 800 px.
  function progressMap(startT, startS, endT, offset) {
    var n = S.y.length, v = new Array(n), cm = S.y[0], g = 0.3, y0 = S.y[0];
    for (var i = 0; i < n; i++) {
      if (i === 0) { v[0] = startT - g * startS; continue; }
      cm = Math.max(cm, S.y[i]);
      var off = offset * Math.max(0, Math.min(1, 1 - (cm - y0) / 800));
      v[i] = Math.max(v[i - 1] + g * (S.c[i] - S.c[i - 1]), cm - off);
    }
    var over = v[n - 1] - endT;
    if (over > 0) for (var k = 0; k < n; k++) v[k] -= over * Math.pow(S.c[k] / S.L, 2);
    S.v = v;
  }

  function buildPoints() {
    var docW = d.clientWidth;
    var st = lay(q('[data-stats]'));
    var lg = lay(q('[data-final-logo]'));
    if (compact.matches) return compactPoints(docW, st, lg);
    var off = Math.max(50, Math.min(110, (docW - st.w) / 2 - 40)), L = st.l - off, R = st.r + off;
    var hvEl = q('[data-hv]'), hb = hvEl.getBoundingClientRect(), z = hb.width / 1440;
    var hl = hb.left + scrollX, ht = hb.top + scrollY;
    var arcY = function (x) { return 620 - 0.0003 * (x - 720) * (x - 720); };
    var H = function (x) { return [hl + x * z, ht + arcY(Math.max(x, -200)) * z]; };
    var pts = [];
    pts.push(H((-40 - hl) / z));
    [-60, 60, 170, 360, 560, 720, 880, 1080, 1270].forEach(function (x) { pts.push(H(x)); });
    pts.push([R, H(1270)[1] + 40 * z]);
    var rows = qa('[data-row]'), gs = rows.map(function (r) { return lay(q('.st', r)); }), r0 = lay(rows[0]);
    pts.push([R, r0.t - 80], [gs[0].l + 10, r0.t - 80]);
    gs.forEach(function (g) { pts.push([g.l, g.t]); });
    var r5 = lay(rows[rows.length - 1]), ap = lay(q('[data-apps]')), yA = (r5.b + ap.t) / 2;
    pts.push([gs[gs.length - 1].l, yA], [L, yA]);
    var ph = q('[data-privhead]'), h2 = lay(q('h2', ph)), pp = lay(q('.p', ph)), kk = lay(q('.kick', ph));
    var PHr = Math.max(h2.r, pp.r), nd = qa('[data-node]').map(lay);
    var yT = (ap.b + kk.t) / 2, yB = pp.b + 55;
    pts.push([L, yT], [PHr + 120, yT], [PHr + 120, yB], [nd[0].l - 140, yB], [nd[0].l - 140, nd[0].cy]);
    nd.forEach(function (n) { pts.push([n.l, n.cy], [n.r, n.cy]); });
    var tc = lay(q('.tarifs2')), wk = lay(q('[data-why] .kick')), code = lay(q('[data-code]')), fk = lay(q('[data-faq] .kick'));
    var yW = (tc.b + wk.t) / 2, yF = (code.b + fk.t) / 2;
    pts.push([R, nd[nd.length - 1].cy], [R, yW], [L, yW], [L, yF], [R, yF], [R, lg.cy], [lg.r + 6, lg.cy]);
    return { pts: pts, start: H(236), z: z, rmax: 230 };
  }

  // Tablette et telephone : le fil longe un bord (couloir de 46 px de chaque cote)
  // et change de bord dans l'espace vide ENTRE deux blocs, en diagonale douce.
  // Les coins sont poses a OFF px du bloc dans le vide : l'arc (rayon 150) ne
  // mord jamais sur le contenu. Les espaces verticaux sont regles dans site.css.
  function compactPoints(docW, st, lg) {
    var L = 22, R = docW - 22, OFF = 75, side = L;
    var el = function (s) { return q(s); };
    var rows = qa('[data-row]');
    var seq = [el('[data-stats]')].concat(rows, [el('[data-apps]'), el('.privacy2'), el('[data-tarifs]'), el('[data-why]'), el('[data-code]'), el('[data-faq]')]);
    var pts = [[L, st.t - 60]];
    for (var i = 0; i < seq.length - 1; i++) {
      // stats -> titre des services : on traverse au-dessus du titre (pas de la 1re rangee)
      var a = lay(seq[i]), b = i === 0 ? lay(el('#services')) : lay(seq[i + 1]);
      var other = side === L ? R : L;
      pts.push([side, a.b + OFF], [other, b.t - OFF]);
      side = other;
    }
    // arrivee : un S qui se pose sur le logo par le haut (une arrivee de cote serait trop serree sur un petit ecran)
    var fq = lay(el('[data-faq]'));
    pts.push([side, fq.b + OFF], [lg.cx, lg.t - 150], [lg.cx, lg.t - 4]);
    return { pts: pts, start: null, rmax: 150 };
  }

  var cur = 0, vel = 0, ang = null, raf = 0, lastT = 0, target = 0;

  function build() {
    var B = buildPoints();
    var sm = rounded(B.pts, B.rmax);
    var n = sm.length, xs = new Float64Array(n), ys = new Float64Array(n), c = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      xs[i] = sm[i][0]; ys[i] = sm[i][1];
      if (i) c[i] = c[i - 1] + Math.sqrt((xs[i] - xs[i - 1]) * (xs[i] - xs[i - 1]) + (ys[i] - ys[i - 1]) * (ys[i] - ys[i - 1]));
    }
    S = { x: xs, y: ys, c: c, L: c[n - 1] };
    var path = simplify(sm, 0.25);
    var W = d.scrollWidth, Hh = document.body.scrollHeight;
    svg.setAttribute('width', W); svg.setAttribute('height', Hh); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Hh);
    qa('path', svg).forEach(function (p) { p.setAttribute('d', path); });
    S.mask = q('[data-mask]', svg);
    // Les points des services se posent exactement sur la courbe lissee.
    stations = [];
    qa('.st[data-st]').forEach(function (el) {
      if (el.offsetParent === null) return; // cache (telephone)
      el.style.translate = '';
      var inHv = !!el.closest('[data-hv]'), z = inHv ? (B.z || 1) : 1, p;
      if (inHv) { var hb = q('[data-hv]').getBoundingClientRect(); p = [hb.left + scrollX + parseFloat(el.style.left) * z, hb.top + scrollY + parseFloat(el.style.top) * z]; }
      else { var lb = lay(el); p = [lb.l, lb.t]; }
      var k = nearestIdx(p[0], p[1]);
      el.style.translate = ((xs[k] - p[0]) / z).toFixed(1) + 'px ' + ((ys[k] - p[1]) / z).toFixed(1) + 'px';
      stations.push({ el: el, s: c[k] });
    });
    nodes = qa('[data-node]').map(function (el) { var b = lay(el); return { el: el, s: c[nearestIdx(b.l, b.cy)] }; });
    var vh = innerHeight;
    var startS = 0, i0 = 0;
    if (B.start) { i0 = nearestIdx(B.start[0], B.start[1]); startS = c[i0]; }
    var endT = (Hh - vh) + vh * READ;
    progressMap(vh * READ, startS, endT, Math.max(0, ys[0] - vh * READ + 0.3 * startS + 4));
    plane.classList.add('ready');
    target = targetS();
    if (ang === null || reduced) { cur = target; vel = 0; }
    draw();
  }

  function targetS() {
    var T = scrollY + innerHeight * READ, v = S.v, n = v.length, lo = 0, hi = n - 1;
    if (T <= v[0]) return S.c[0];
    if (T >= v[n - 1]) return S.L;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (v[m] <= T) lo = m; else hi = m; }
    var f = (T - v[lo]) / (v[hi] - v[lo] || 1);
    return S.c[lo] + f * (S.c[hi] - S.c[lo]);
  }

  function idxAt(s) {
    var c = S.c, lo = 0, hi = c.length - 1;
    if (s <= 0) return 0;
    if (s >= S.L) return hi;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    return lo;
  }

  function draw() {
    var n = S.x.length, i = idxAt(cur), j = Math.min(n - 1, i + 1);
    var f = (cur - S.c[i]) / ((S.c[j] - S.c[i]) || 1);
    var x = S.x[i] + f * (S.x[j] - S.x[i]), y = S.y[i] + f * (S.y[j] - S.y[i]);
    var a0 = Math.max(0, i - 8), a1 = Math.min(n - 1, i + 8);
    var a = Math.atan2(S.y[a1] - S.y[a0], S.x[a1] - S.x[a0]) * 180 / Math.PI + 90;
    if (ang === null) ang = a;
    var da = ((a - ang + 540) % 360) - 180;
    ang += reduced ? da : da * 0.18;
    var w = plane.offsetWidth, h = plane.offsetHeight;
    plane.style.transform = 'translate(' + (x - w / 2).toFixed(1) + 'px,' + (y - h * 0.47).toFixed(1) + 'px) rotate(' + ang.toFixed(1) + 'deg)';
    S.mask.setAttribute('stroke-dasharray', cur.toFixed(1) + ' 999999');
    for (var k = 0; k < stations.length; k++) if (cur >= stations[k].s - 2) stations[k].el.classList.add('on');
    var firstOff = true;
    nodes.forEach(function (nd, idx) {
      var on = cur >= nd.s - 2;
      nd.el.classList.toggle('on', on);
      nd.el.classList.toggle('coming', !on && firstOff && cur > nd.s - 260);
      nd.el.classList.toggle('ghost', !on && !(firstOff && cur > nd.s - 260));
      if (!on) firstOff = false;
      if (idx > 0 && links[idx - 1]) links[idx - 1].classList.toggle('later', cur < nd.s - 260);
    });
    return Math.abs(da);
  }

  // Ressort amorti : l'avion accelere, freine et se rattrape (leger rebond).
  function tick(now) {
    raf = 0;
    if (!S) return;
    var dt = Math.min(0.05, (now - (lastT || now)) / 1000) || 0.016;
    lastT = now;
    target = targetS();
    if (reduced) { cur = target; vel = 0; }
    else {
      var k = 55, damp = 2 * 0.62 * Math.sqrt(k);
      vel += ((target - cur) * k - vel * damp) * dt;
      cur += vel * dt;
      cur = Math.max(0, Math.min(S.L, cur));
    }
    var da = draw();
    if (!reduced && (Math.abs(target - cur) > 0.3 || Math.abs(vel) > 0.3 || da > 0.2)) raf = requestAnimationFrame(tick);
    else lastT = 0;
  }
  function kick() { if (!raf && S) raf = requestAnimationFrame(tick); }

  var rt = 0;
  function rebuild() { clearTimeout(rt); rt = setTimeout(function () { build(); kick(); }, 120); }
  addEventListener('scroll', kick, { passive: true });
  addEventListener('resize', rebuild);
  if (compact.addEventListener) compact.addEventListener('change', rebuild);
  if ('ResizeObserver' in window) new ResizeObserver(rebuild).observe(main);
  if (document.readyState === 'complete') build(); else addEventListener('load', function () { build(); kick(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S) rebuild(); });

  // Point d'essai : rend la geometrie du fil pour les controles automatiques.
  window.__imielFil = function () {
    if (!S) return null;
    var minR = Infinity, at = null;
    for (var i = 6; i < S.x.length - 6; i++) {
      var ax = S.x[i - 6], ay = S.y[i - 6], bx = S.x[i], by = S.y[i], cx = S.x[i + 6], cy = S.y[i + 6];
      var ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(cx - bx, cy - by), ca = Math.hypot(ax - cx, ay - cy);
      var area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
      if (area < 1e-6) continue;
      var R = ab * bc * ca / (4 * area);
      if (R < minR) { minR = R; at = [bx, by]; }
    }
    return { L: S.L, minR: minR, at: at, x: Array.prototype.slice.call(S.x), y: Array.prototype.slice.call(S.y), cur: cur, stations: stations.length };
  };
})();
