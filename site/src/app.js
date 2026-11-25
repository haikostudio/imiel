/* Vitrine getimiel.com : theme, langue, bouton de telechargement selon l'appareil,
   ecrans du haut qui defilent, et l'avion du logo qui suit le fil au defilement.
   Sans dependance. Les mouvements s'arretent si l'appareil demande moins d'animations. */
(function () {
  'use strict';
  var d = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var store = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* navigation privee */ } };

  // ---------- theme ----------
  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var next = d.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      d.setAttribute('data-theme', next);
      store('imiel-theme', next);
    });
  });

  // ---------- langue : le choix explicite l'emporte ensuite ----------
  document.querySelectorAll('[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () { store('imiel-lang', a.getAttribute('data-lang')); });
  });
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.langsel[open]').forEach(function (el) { if (!el.contains(e.target)) el.removeAttribute('open'); });
  });

  // ---------- menu du telephone ----------
  var burger = document.querySelector('[data-burger]');
  if (burger) burger.addEventListener('click', function () {
    var nav = document.querySelector('[data-nav]');
    var open = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ---------- appareil du visiteur ----------
  var ua = navigator.userAgent || '';
  var os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iphone'
    : /Mac OS X|Macintosh/.test(ua) ? 'mac'
    : /Windows/.test(ua) ? 'windows'
    : /Android/.test(ua) ? 'other'
    : /Linux|X11|CrOS/.test(ua) ? 'linux' : 'other';
  var OS_ICON = { mac: 'apple', windows: 'win', linux: 'linux', iphone: 'phone', other: 'arrow' };
  document.querySelectorAll('[data-os-cta]').forEach(function (a) {
    var labels = JSON.parse(a.getAttribute('data-labels'));
    a.querySelector('[data-os-label]').textContent = labels[os];
    a.setAttribute('href', a.getAttribute('data-base') + (os === 'other' ? '' : '#' + os));
    var ic = a.querySelector('.os-ico');
    if (ic && os !== 'mac') ic.style.display = 'none';
  });
  document.querySelectorAll('[data-os-note]').forEach(function (n) {
    n.textContent = JSON.parse(n.getAttribute('data-notes'))[os];
  });
  var mine = document.querySelector('[data-dl="' + os + '"]');
  if (mine) mine.classList.add('mine');
  void OS_ICON;

  // ---------- ecrans du haut : un service apres l'autre ----------
  var car = document.querySelector('[data-carousel]');
  if (car) {
    var figs = car.querySelectorAll('[data-screen]');
    var pills = document.querySelectorAll('[data-svc]');
    var capT = document.querySelector('[data-cap-text]');
    var capN = document.querySelector('[data-cap-n]');
    var capName = document.querySelector('[data-cap-name]');
    var caps = JSON.parse(capT.getAttribute('data-caps'));
    var names = JSON.parse(capT.getAttribute('data-names'));
    var cur = 0, timer = null;
    var show = function (i) {
      cur = i;
      figs.forEach(function (f, k) { f.classList.toggle('on', k === i); });
      pills.forEach(function (p, k) {
        p.classList.toggle('gold', k === i); p.classList.toggle('glass', k !== i);
        p.setAttribute('aria-pressed', k === i ? 'true' : 'false');
      });
      capT.textContent = caps[i]; capN.textContent = String(i + 1); capName.textContent = names[i];
    };
    var start = function () { if (reduced || timer) return; timer = setInterval(function () { show((cur + 1) % figs.length); }, 4200); };
    var stop = function () { clearInterval(timer); timer = null; };
    pills.forEach(function (p) {
      p.addEventListener('click', function () { stop(); show(+p.getAttribute('data-svc')); start(); });
    });
    car.addEventListener('mouseenter', stop);
    car.addEventListener('mouseleave', start);
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    start();
  }

  // ---------- le fil et l'avion ----------
  var stage = document.querySelector('[data-stage]');
  var plane = document.querySelector('[data-plane]');
  if (!stage || !plane) return;
  var stations = Array.prototype.slice.call(document.querySelectorAll('[data-station]'));
  var desk = window.matchMedia('(min-width: 1100px)');
  var S = null; // echantillons du fil courant

  function sample(path) {
    var L = path.getTotalLength(), n = Math.max(2, Math.ceil(L / 6)), xs = [], ys = [], ss = [];
    for (var i = 0; i <= n; i++) { var s = (L * i) / n, p = path.getPointAtLength(s); xs.push(p.x); ys.push(p.y); ss.push(s); }
    return { L: L, x: xs, y: ys, s: ss };
  }

  // Avancement monotone : le fil sert de rail, l'avion avance avec la lecture.
  // v(s) suit la hauteur atteinte ; les passages a plat ou qui remontent avancent
  // quand meme (pente minimale) pour ne jamais sauter d'un bord a l'autre.
  // offset : au depart, l'avion vole plus bas que la ligne de lecture (l'arc du
  // haut est sous les titres) ; l'ecart s'efface sur les 800 px suivants.
  function progressMap(smp, startT, startS, endT, offset) {
    var v = new Array(smp.y.length), cm = smp.y[0], g = 0.3, y0 = smp.y[0];
    offset = offset || 0;
    for (var i = 0; i < smp.y.length; i++) {
      if (i === 0) { v[0] = startT - g * startS; continue; }
      cm = Math.max(cm, smp.y[i]);
      var off = offset * Math.max(0, Math.min(1, 1 - (cm - y0) / 800));
      v[i] = Math.max(v[i - 1] + g * (smp.s[i] - smp.s[i - 1]), cm - off);
    }
    var over = v[v.length - 1] - endT;
    if (over > 0) for (var k = 0; k < v.length; k++) v[k] -= over * Math.pow(smp.s[k] / smp.L, 2);
    smp.v = v;
  }

  // marge pour que l'avion atteigne bien x=262 au chargement malgre la pente minimale
  function g0(smp, i0) { return 0.3 * smp.s[i0] + 4; }

  function buildDesk() {
    var svg = stage.querySelector('[data-thread="desk"]');
    var path = svg.querySelector('[data-path]');
    var smp = sample(path);
    smp.mask = svg.querySelector('[data-mask]');
    smp.scale = parseFloat(getComputedStyle(d).getPropertyValue('--z')) || 1;
    // au chargement, l'avion est deja un peu parti de Mail (maquette validee)
    var s0 = 0, i0 = 0;
    for (var i = 0; i < smp.x.length; i++) { if (smp.x[i] >= 262) { s0 = smp.s[i]; i0 = i; break; } }
    var vh = innerHeight / smp.scale;
    var endT = (stage.offsetHeight - innerHeight / smp.scale) + vh * 0.55;
    progressMap(smp, vh * 0.55, s0, endT, Math.max(0, smp.y[0] - vh * 0.55 + g0(smp, i0)));
    smp.stationS = stations.map(function (st) {
      var tx = parseFloat(st.style.getPropertyValue('--l')), ty = parseFloat(st.style.getPropertyValue('--t'));
      var best = 0, bd = Infinity;
      for (var k = 0; k < smp.x.length; k++) { var dd = (smp.x[k] - tx) * (smp.x[k] - tx) + (smp.y[k] - ty) * (smp.y[k] - ty); if (dd < bd) { bd = dd; best = smp.s[k]; } }
      return best;
    });
    plane.style.width = '63px'; plane.style.height = '65px';
    return smp;
  }

  function buildMob() {
    var svg = stage.querySelector('[data-thread="mob"]');
    var top = document.getElementById('services').getBoundingClientRect().top - stage.getBoundingClientRect().top + 40;
    var fin = stage.querySelector('[data-final-logo]');
    var bottom = fin.getBoundingClientRect().top - stage.getBoundingClientRect().top + 20;
    var W = stage.offsetWidth, H = stage.offsetHeight, pts = [], i = 0;
    for (var y = top; y < bottom; y += 150, i++) pts.push([20 + 8 * Math.sin(i * 1.3) + 4 * Math.sin(i * 2.9 + 1), y]);
    pts.push([W / 2, bottom]);
    var dpath = 'M ' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var k = 0; k < pts.length - 1; k++) {
      var p0 = pts[k - 1] || pts[k], p1 = pts[k], p2 = pts[k + 1], p3 = pts[k + 2] || p2;
      dpath += ' C ' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ', ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ', ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.querySelectorAll('path').forEach(function (p) { p.setAttribute('d', dpath); });
    var smp = sample(svg.querySelector('[data-path]'));
    smp.mask = svg.querySelector('[data-mask]');
    smp.scale = 1;
    var endT = H - innerHeight + innerHeight * 0.55;
    progressMap(smp, Math.max(top, innerHeight * 0.55), 0, endT);
    smp.stationS = [];
    plane.style.width = '34px'; plane.style.height = '35px';
    return smp;
  }

  function place(sv) {
    var smp = S, n = smp.v.length, lo = 0, hi = n - 1;
    if (sv <= smp.v[0]) hi = 0; else if (sv >= smp.v[n - 1]) lo = hi = n - 1;
    else { while (hi - lo > 1) { var m = (lo + hi) >> 1; if (smp.v[m] <= sv) lo = m; else hi = m; } }
    var f = hi === lo ? 0 : (sv - smp.v[lo]) / (smp.v[hi] - smp.v[lo]);
    var s = smp.s[lo] + f * (smp.s[hi] - smp.s[lo]);
    var i = Math.min(n - 2, Math.max(1, Math.round((s / smp.L) * (n - 1))));
    var x = smp.x[lo] + f * (smp.x[hi] - smp.x[lo]), y = smp.y[lo] + f * (smp.y[hi] - smp.y[lo]);
    var a = Math.atan2(smp.y[i + 1] - smp.y[i - 1], smp.x[i + 1] - smp.x[i - 1]) * 180 / Math.PI + 90;
    var w = plane.offsetWidth, h = plane.offsetHeight;
    plane.style.transform = 'translate(' + (x - w / 2).toFixed(1) + 'px,' + (y - h * 0.47).toFixed(1) + 'px) rotate(' + a.toFixed(1) + 'deg)';
    smp.mask.setAttribute('stroke-dasharray', s.toFixed(1) + ' 999999');
    for (var k = 0; k < smp.stationS.length; k++) {
      var on = s >= smp.stationS[k] - 2;
      stations[k].classList.toggle('gold', on); stations[k].classList.toggle('glass', !on);
    }
  }

  var ticking = false;
  function onScroll() {
    if (ticking || !S) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var top = stage.getBoundingClientRect().top; // deja a l'echelle
      var T = (-top + innerHeight * 0.55) / S.scale;
      place(reduced ? S.v[0] : T);
    });
  }

  function rebuild() {
    S = desk.matches ? buildDesk() : buildMob();
    onScroll();
  }
  var rt = null;
  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(rebuild, 150); });
  if (desk.addEventListener) desk.addEventListener('change', rebuild);
  addEventListener('scroll', onScroll, { passive: true });
  if (document.readyState === 'complete') rebuild(); else addEventListener('load', rebuild);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S) rebuild(); });
})();
