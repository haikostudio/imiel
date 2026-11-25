"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { shouldInterceptExternalLinks } from "@/lib/desktop";
import { openLinkInApp } from "@/lib/stores/link-viewer";

interface EmailBodyFrameProps {
  html: string;
  onMailto?: (email: string) => void;
  /** Clic sur une image du corps (hors lien) : ouvre la visionneuse. */
  onImageClick?: (src: string) => void;
  /** Fond du "papier" (defaut blanc). Ex. jaune pale pour un brouillon. */
  background?: string;
  /** Marge interieure du texte (CSS, ex. "8px 12px"). Defaut : aucune (mails recus). */
  padding?: string;
  /**
   * Mail mis en page affiche dans le fil, dans un bloc gris SANS marge :
   * efface le fond gris neutre des enveloppes pleine largeur du gabarit et
   * peint le papier de la couleur du bloc (`--muted` en clair, blanc en
   * sombre, sinon le texte noir du mail devient illisible). `background` et
   * la marge sombre (`dark:p-2`) sont alors ignores.
   */
  bare?: boolean;
}

// Couleur du papier d'un cadre `bare`. Une variable CSS ne traverse pas
// l'iframe : on lit la valeur concrete de `--muted` sur <html>, et le theme
// par la classe `.dark` (posee par app/layout.tsx), pas prefers-color-scheme.
function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => obs.disconnect();
}
function readBarePaper(): string {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "#ffffff";
  const muted = getComputedStyle(root).getPropertyValue("--muted").trim();
  return muted || "#f5f5f5";
}
function useBarePaper(enabled: boolean): string | null {
  const paper = useSyncExternalStore(subscribeTheme, readBarePaper, () => "#f5f5f5");
  return enabled ? paper : null;
}

export function EmailBodyFrame({ html, onMailto, onImageClick, background: backgroundProp = "#ffffff", padding, bare = false }: EmailBodyFrameProps) {
  const barePaper = useBarePaper(bare);
  const background = barePaper ?? backgroundProp;
  const reactId = useId();
  const frameId = useMemo(() => `email-frame-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`, [reactId]);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  // Faut-il capturer les liens externes pour les ouvrir dans le navigateur
  // systeme ? App de bureau (Tauri) ou PWA installee ; en onglet classique on
  // laisse target=_blank. Calcule DES le premier rendu (l'app est rendue cote
  // client, layout `(app)` en ssr:false) : un second srcDoc pose apres montage
  // ferait naviguer l'iframe (cf `key` plus bas).
  const [interceptExternal] = useState(
    () => typeof window !== "undefined" && shouldInterceptExternalLinks(),
  );

  const srcDoc = useMemo(
    () => buildSrcDoc(html, frameId, interceptExternal, background, padding, bare),
    [html, frameId, interceptExternal, background, padding, bare],
  );
  const ready = height > 0;

  // Resync height when srcDoc change (par ex. traduction) : repart d'une hauteur
  // basse pour ne pas garder une grosse iframe vide pendant le re-render.
  useEffect(() => {
    setHeight(0);
  }, [srcDoc]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data as unknown;
      if (!data || typeof data !== "object") return;
      const msg = data as { type?: unknown; id?: unknown; height?: unknown };
      if (msg.id !== frameId) return;
      if (msg.type === "email-frame:mailto") {
        const m = data as { email?: unknown };
        if (typeof m.email === "string" && m.email) onMailto?.(m.email);
        return;
      }
      if (msg.type === "email-frame:image") {
        const m = data as { src?: unknown };
        if (typeof m.src === "string" && m.src) onImageClick?.(m.src);
        return;
      }
      if (msg.type === "email-frame:open") {
        const m = data as { url?: unknown };
        // App installee : tiroir de l'app (site cadrable / fichier) ; sinon
        // ouverture systeme comme avant (Tauri, navigateur).
        if (typeof m.url === "string" && m.url) openLinkInApp(m.url);
        return;
      }
      if (msg.type !== "email-frame:height") return;
      if (typeof msg.height !== "number") return;
      setHeight(Math.max(0, Math.ceil(msg.height)));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId, onMailto, onImageClick]);

  return (
    <div
      className={bare ? "relative overflow-hidden" : "relative overflow-hidden rounded-md dark:p-2"}
      style={{ minHeight: ready ? undefined : 140, background }}
    >
      {/* key={srcDoc} : un srcDoc qui change (traduction, images, theme) REMONTE
          l'iframe au lieu de modifier son attribut. Changer srcdoc sur une iframe
          deja chargee la fait NAVIGUER et empile une entree dans l'historique
          conjoint de la page : le history.back() de fermeture d'un fil
          (hashBack) depilait alors cette entree, et l'app installee iOS ouvrait
          "about:srcdoc" dans son navigateur integre. */}
      <iframe
        key={srcDoc}
        ref={ref}
        title="Email content"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        scrolling="no"
        srcDoc={srcDoc}
        style={{
          width: "100%",
          height: ready ? `${height}px` : "1px",
          border: "none",
          display: "block",
          background,
          colorScheme: "light",
          position: ready ? "static" : "absolute",
          top: 0,
          left: 0,
          opacity: ready ? 1 : 0,
          pointerEvents: ready ? "auto" : "none",
          overflow: "hidden",
        }}
        data-ref="email-frame"
      />
      {!ready && (
        <div
          aria-hidden="true"
          data-ref="email-frame-skeleton"
          className="flex flex-col gap-2 py-1"
        >
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      )}
    </div>
  );
}

function buildSrcDoc(
  html: string,
  id: string,
  interceptExternal: boolean,
  background: string,
  padding?: string,
  bare = false
): string {
  const idJson = JSON.stringify(id);
  const bareJson = JSON.stringify(!!bare);
  const interceptJson = JSON.stringify(!!interceptExternal);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: light; --muted: #f5f5f5; --border: #e5e5e5; --muted-foreground: #737373; }
  html, body { margin: 0; padding: 0; background: ${background}; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #111;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  img[data-hk-zoom] { cursor: zoom-in; }
  a { color: #2563eb; }
  [data-collapsed-quote] { display: none; }
  /* flow-root = nouveau block formatting context : contient les marges basses
     du dernier element (p/signature/table) qui sinon s'echappent par
     margin-collapse et ne sont PAS comptees par scrollHeight -> bas du mail
     coupe au ras des boutons de reponse. Ne rogne rien (contrairement a
     overflow:hidden) donc compatible avec le shrink-to-fit. */
  #__fit { transform-origin: top left; display: flow-root; }
  /* Marge interieure portee par #__fit (pas par body) : elle entre dans la
     hauteur mesuree (offsetHeight) et dans la largeur du shrink-to-fit. */
  ${padding ? `#__fit { padding: ${padding.replace(/[;{}<>]/g, "")}; box-sizing: border-box; }` : ""}
</style>
</head>
<body><div id="__fit">${html}</div>
<script>
(function(){
  var ID = ${idJson};
  var INTERCEPT_EXTERNAL = ${interceptJson};
  var BARE = ${bareJson};
  var lastH = -1;
  var fit = document.getElementById('__fit');
  // Mode "bare" : on descend les enveloppes PLEINE LARGEUR du gabarit (table >
  // tbody > tr > td...) et on efface leur fond s'il est d'un gris neutre clair
  // (#f4f4f5, #eeeeee...). On s'arrete a l'element plus etroit (la carte du
  // mail) ou a un fond colore (bandeau de marque) : ceux-la restent intacts.
  function isNeutralLight(c){
    // Sans antislash : ce script vit dans un gabarit de chaine TS.
    var str = c || '', a = str.indexOf('('), b = str.indexOf(')');
    if (a < 0 || b < a) return false;
    var p = str.slice(a + 1, b).split(',').map(function(x){ return parseFloat(x); });
    if (p.length > 3 && p[3] === 0) return false;
    var mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]);
    return mn >= 200 && mx - mn <= 16;
  }
  // Relance a chaque nouvelle largeur : a l'ouverture du fil sur telephone, le
  // cadre peut naitre sans largeur (0) et les evenements de chargement passer
  // avant qu'il en ait une.
  var clearedW = -1;
  function clearBackdrop(){
    if (!BARE || !fit) return;
    var W = fit.clientWidth;
    if (!W || W === clearedW) return;
    clearedW = W;
    var fs = getComputedStyle(fit);
    var fitPadX = (parseFloat(fs.paddingLeft) || 0) + (parseFloat(fs.paddingRight) || 0);
    var level = [fit];
    for (var depth = 0; depth < 10 && level.length; depth++) {
      var next = [];
      for (var i = 0; i < level.length; i++) {
        var kids = level[i].children;
        for (var j = 0; j < kids.length; j++) {
          var k = kids[j];
          if (/^(IMG|STYLE|SCRIPT|BR)$/.test(k.tagName)) continue;
          // Enveloppe = remplit son parent, marges interieures comprises
          // (largeurs avant mise a l'echelle : un gabarit de 600 px depasse
          // le telephone, comparer a W ne suffit pas).
          // #__fit porte la marge du cadre : on compare a sa largeur utile.
          var ref = level[i] === fit ? W - fitPadX : (level[i].offsetWidth || W);
          if (k.offsetWidth < ref - 4) continue;
          var ks = getComputedStyle(k);
          // Bordure ou coins arrondis : c'est la carte du mail, on s'arrete.
          if (parseFloat(ks.borderTopWidth) > 0 || parseFloat(ks.borderTopLeftRadius) > 0) continue;
          var bg = ks.backgroundColor;
          if (isNeutralLight(bg)) {
            k.style.setProperty('background-color', 'transparent', 'important');
            k.style.setProperty('background-image', 'none', 'important');
            k.removeAttribute('bgcolor');
          } else if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
            continue;
          }
          next.push(k);
        }
      }
      level = next;
    }
  }
  var scheduled = false;
  // Shrink-to-fit : les newsletters utilisent des largeurs fixes (tables 600px)
  // plus larges que le viewport mobile. On mesure la largeur naturelle du
  // contenu et on applique un scale pour le faire tenir, comme Gmail mobile.
  function applyFit(){
    if (!fit) return 1;
    fit.style.transform = 'none';
    var available = document.documentElement.clientWidth || window.innerWidth || 0;
    var contentWidth = Math.max(fit.scrollWidth, fit.offsetWidth);
    // Un contenu qui deborde : scrollWidth compte la marge de gauche mais PAS
    // celle de droite (bloc non defilant) -> on l'ajoute, sinon le gabarit
    // reduit colle au bord droit.
    if (fit.scrollWidth > fit.offsetWidth + 1) {
      contentWidth += parseFloat(getComputedStyle(fit).paddingRight) || 0;
    }
    var scale = 1;
    if (available > 0 && contentWidth > available + 1) {
      scale = available / contentWidth;
      fit.style.transform = 'scale(' + scale + ')';
    }
    return scale;
  }
  function measure(){
    clearBackdrop();
    var scale = applyFit();
    var natural = fit ? Math.max(fit.scrollHeight, fit.offsetHeight) : 0;
    var h = Math.ceil(natural * scale);
    if (h === lastH) return;
    lastH = h;
    try { parent.postMessage({ type: 'email-frame:height', id: ID, height: h }, '*'); } catch (e) {}
  }
  function sendHeight(){
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || window.setTimeout)(function(){
      scheduled = false;
      try { measure(); } catch (e) {}
    });
  }
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var link = t.closest('a[href^="mailto:"]');
    if (link) {
      e.preventDefault();
      var raw = link.getAttribute('href').slice(7);
      var email = decodeURIComponent(raw.split('?')[0]).trim();
      if (email) {
        try { parent.postMessage({ type: 'email-frame:mailto', id: ID, email: email }, '*'); } catch (e2) {}
      }
      return;
    }
    // App de bureau / PWA : les liens externes doivent partir vers le navigateur
    // systeme. On capture le clic et on delegue au parent (base target=_blank ne
    // fait rien dans la webview Tauri et ouvre un volet interne en PWA).
    if (INTERCEPT_EXTERNAL) {
      var ext = t.closest('a[href^="http:"], a[href^="https:"]');
      if (ext) {
        var href = ext.getAttribute('href');
        if (href) {
          e.preventDefault();
          try { parent.postMessage({ type: 'email-frame:open', id: ID, url: href }, '*'); } catch (e3) {}
          return;
        }
      }
    }
    // Image du corps (hors lien) assez grande : visionneuse plein ecran.
    if (t.tagName === 'IMG' && t.hasAttribute('data-hk-zoom') && !t.closest('a[href]')) {
      e.preventDefault();
      try { parent.postMessage({ type: 'email-frame:image', id: ID, src: t.currentSrc || t.src }, '*'); } catch (e4) {}
      return;
    }
    var btn = t.closest('[data-quote-toggle]');
    if (!btn) return;
    e.preventDefault();
    var q = btn.nextElementSibling;
    if (!q || !q.hasAttribute('data-collapsed-quote')) return;
    var hidden = q.style.display === 'none' || q.style.display === '';
    q.style.display = hidden ? 'block' : 'none';
    sendHeight();
  }, true);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    clearBackdrop();
    sendHeight();
  }
  document.addEventListener('DOMContentLoaded', function(){ clearBackdrop(); sendHeight(); });
  window.addEventListener('load', clearBackdrop);
  window.addEventListener('load', sendHeight);
  window.addEventListener('resize', sendHeight);
  if (typeof ResizeObserver !== 'undefined' && fit) {
    try { new ResizeObserver(sendHeight).observe(fit); } catch(e) {}
  }
  // Les petites images (pixels, icones de signature) ne s'agrandissent pas.
  function markZoom(img){
    if (img.naturalWidth >= 64 && img.naturalHeight >= 64 && !img.closest('a[href]')) {
      img.setAttribute('data-hk-zoom', '');
    }
  }
  var imgs = document.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    (function(img){
      if (img.complete) { markZoom(img); return; }
      img.addEventListener('load', function(){ markZoom(img); sendHeight(); });
      img.addEventListener('error', sendHeight);
    })(imgs[i]);
  }
})();
<\/script>
</body>
</html>`;
}
