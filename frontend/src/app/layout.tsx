import type { Metadata, Viewport } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
// Apparence Miel (defaut) : jetons et surfaces sous [data-design="miel"].
import "./miel.css";
import { STATUS_BAR_SCRIPT } from "./status-bar-script";

export const metadata: Metadata = {
  title: "iMiel",
  description: "Client email self-hosted - iMiel",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    // "black-translucent" (2026-10-19, choix utilisateur, carte 51edb838) : en
    // PWA standalone la web view passe SOUS l'heure. Fond de l'app, menu de
    // gauche, volets et VOILES des fenetres montent jusqu'en haut de l'ecran,
    // d'une seule teinte : l'heure se pose sur la couleur reelle de l'ecran,
    // fenetre ouverte comprise. La couleur du TEXTE de la barre suit
    // `color-scheme` (pose par les scripts de boot selon le theme de l'app).
    // iOS 26/27 pose un degrade flou sous l'encart, qu'aucun CSS n'eteint :
    // invisible sur une surface unie, il ne doit passer sur aucun texte ->
    // --app-top = encart + --edge-clear (24px, cf globals.css).
    // "default" (a28e1bc) a ete ABANDONNE : la bande de l'heure est dessinee hors
    // de la web view et reste BLANCHE sous les voiles ; l'echantillonnage par un
    // element fixe (65fbf03) ne l'a pas recoloree sur iPhone. Ne pas y revenir.
    // /!\ iOS lit ce style a l'AJOUT a l'ecran d'accueil -> supprimer puis
    // reinstaller l'icone apres la mise en ligne, sinon rien ne change.
    statusBarStyle: "black-translucent",
    title: "iMiel",
  },
  // Logo iMiel tire de l'image originale (scripts/icones-imiel.mjs), jamais
  // redessine. ?v=2 : force le rechargement des anciennes icones en cache.
  icons: {
    icon: [
      { url: "/favicon.ico?v=2", sizes: "16x16 32x32 48x48" },
      { url: "/favicon-32.png?v=2", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png?v=2", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/icon-180.png?v=2",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // Valeur unique (clair) au SSR. La couleur de la status bar iOS doit suivre
  // le THEME CHOISI dans l'app (.dark class), pas le `prefers-color-scheme` de
  // l'OS : sinon, en theme clair sur un telephone en dark mode systeme, la
  // status bar reste noire (bande noire en haut, cf. theme-color script ci-dessous).
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        {/* Premier script : reprend une seule fois les reglages gardes sous
            l'ancien nom (cles "haikomail:*" -> "imiel:*", anciennes laissees en
            place) AVANT toute lecture, pour ne rien perdre au renommage. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(!localStorage.getItem("imiel:migrated")){var ks=[];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf("haikomail:")===0)ks.push(k);}for(var j=0;j<ks.length;j++){var nk="imiel:"+ks[j].slice(10);if(localStorage.getItem(nk)===null)localStorage.setItem(nk,localStorage.getItem(ks[j]));}localStorage.setItem("imiel:migrated","1");}}catch(e){}try{var dz=localStorage.getItem("imiel:design");document.documentElement.setAttribute("data-design",dz==="minimal"?"minimal":"miel");var db=localStorage.getItem("imiel:designBg");document.documentElement.setAttribute("data-design-bg",(db==="alveoles"||db==="matin"||db==="uni")?db:"vagues");}catch(e){}try{var us=localStorage.getItem("imiel:uiScale");if(us==="small"||us==="medium"||us==="large")document.documentElement.setAttribute("data-ui-scale",us);}catch(e){}try{var t=localStorage.getItem("theme");var dark=false;if(t==="dark")dark=true;else if(t==="light")dark=false;else if(!t||t==="system"){dark=window.matchMedia("(prefers-color-scheme:dark)").matches;}if(dark)document.documentElement.classList.add("dark");else document.documentElement.classList.remove("dark");var ms=document.querySelectorAll('meta[name="theme-color"]');if(ms.length===0){var mm=document.createElement("meta");mm.setAttribute("name","theme-color");document.head.appendChild(mm);ms=[mm];}var col=dark?"#0a0a0a":"#ffffff";for(var i=0;i<ms.length;i++){ms[i].removeAttribute("media");ms[i].setAttribute("content",col);}var csm=document.querySelector('meta[name="color-scheme"]');if(!csm){csm=document.createElement("meta");csm.setAttribute("name","color-scheme");document.head.appendChild(csm);}csm.setAttribute("content",dark?"dark":"light");document.documentElement.style.colorScheme=dark?"dark":"light";}catch(e){}})()`,
          }}
        />
        {/* theme-color + color-scheme suivent le THEME de l'app (couleur du
            texte de la barre d'etat en black-translucent) : cf status-bar-script.ts. */}
        <script dangerouslySetInnerHTML={{ __html: STATUS_BAR_SCRIPT }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function isInputFocused(){try{var el=document.activeElement;if(!el)return false;var t=el.tagName;return t==='INPUT'||t==='TEXTAREA'||el.isContentEditable===true;}catch(e){return false;}}var KBDEBUG=false;var dbg=null;var probe=null;function ensureProbe(){try{if(!probe){probe=document.createElement('div');probe.style.cssText='position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';(document.body||document.documentElement).appendChild(probe);}return probe;}catch(e){return null;}}function ensureDbg(){try{if(!KBDEBUG)return null;if(!dbg){dbg=document.createElement('div');dbg.id='kbdebug';dbg.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(255,0,0,.85);color:#fff;font:11px/1.3 monospace;padding:4px 6px;pointer-events:none;white-space:pre-wrap';(document.body||document.documentElement).appendChild(dbg);}return dbg;}catch(e){return null;}}function s(){try{var iw=window.innerHeight;var vvh=(window.visualViewport&&window.visualViewport.height)||iw;var vot=(window.visualViewport&&window.visualViewport.offsetTop)||0;var foc=isInputFocused();var diff=Math.max(0,iw-vvh-vot);var kbOpen=foc&&diff>100;var standalone=window.navigator.standalone===true||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
/* --app-height : hauteur plein ecran FIABLE pour le body + les conteneurs qui
   veulent une hauteur stable (page contacts...). En PWA standalone on prend
   window.screen.height (constante de l'ecran) car innerHeight/100dvh/clientHeight
   sous-estiment l'ecran de l'inset haut au chargement a froid -> bande blanche en
   bas (cf body dans globals.css). En onglet navigateur on NE pose PAS --app-height
   (removeProperty) -> le CSS retombe sur 100dvh (dynamique, gere la barre d'URL).
   Stable au clavier (screen.height ne retrecit pas ; --keyboard-inset gere a part).
   screen.height SEULEMENT si la web view passe sous la barre d'etat (encart haut
   > 0 : black-translucent, cas normal). Une ancienne icone installee en
   "default" (encart haut 0) commence SOUS la barre d'etat : screen.height
   deborderait de sa hauteur -> on prend innerHeight. */
var pr=standalone?ensureProbe():null;var satop=pr?(parseFloat(getComputedStyle(pr).paddingTop)||0):0;var ah=standalone?(satop>0?((window.screen&&window.screen.height)||iw):iw):0;if(ah){document.documentElement.style.setProperty('--app-height', ah+'px');}else{document.documentElement.style.removeProperty('--app-height');}document.documentElement.style.setProperty('--keyboard-inset',(kbOpen?diff:0)+'px');document.documentElement.classList.toggle('kb-open',kbOpen);var d=ensureDbg();if(d){var sw=window.navigator.standalone===true||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);var p=ensureProbe();var cs=p?getComputedStyle(p):null;var sat=cs?Math.round(parseFloat(cs.paddingTop)||0):-1;var sab=cs?Math.round(parseFloat(cs.paddingBottom)||0):-1;var sh=(window.screen&&window.screen.height)||0;var dpr=window.devicePixelRatio||1;var bodyH=Math.round((document.body&&document.body.clientHeight)||0);var gap=bodyH-Math.round(vvh);d.textContent='iw='+iw+' vvh='+Math.round(vvh)+' vot='+Math.round(vot)+' scrY='+Math.round(window.scrollY)+'\\nbodyH='+bodyH+' GAP(body-vvh)='+gap+' kbInset='+(kbOpen?Math.round(diff):0)+'\\nsafeTop='+sat+' safeBot='+sab+' screenH='+sh+' dpr='+dpr+'\\nfoc='+foc+' standalone='+sw+' diff='+Math.round(diff)+' kbOpen='+kbOpen;}}catch(e){}}s();if(window.visualViewport){window.visualViewport.addEventListener('resize',s);window.visualViewport.addEventListener('scroll',s);}window.addEventListener('resize',s);window.addEventListener('focusin',s);window.addEventListener('focusout',function(){setTimeout(s,50);setTimeout(s,300);});window.addEventListener('orientationchange',function(){setTimeout(s,100);setTimeout(s,400);});document.addEventListener('DOMContentLoaded',s);window.addEventListener('load',s);setInterval(s,500);})()`,
          }}
        />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <TooltipProvider>
          {children}
        </TooltipProvider>
        <Toaster position="bottom-right" />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}

function ServiceWorkerRegistration() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
        // On desactive le SW uniquement sur localhost (dev local). Sur tout
        // autre host (VPS, prod), on enregistre le SW pour que les
        // notifications push fonctionnent meme si le serveur tourne en
        // mode "next dev".
        var __hn = location.hostname;
        var __swDisabled = (__hn === 'localhost' || __hn === '127.0.0.1' || __hn === '0.0.0.0');
        if (__swDisabled) {
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function(registrations) {
              registrations.forEach(function(r) { r.unregister(); });
            });
            caches.keys().then(function(names) {
              names.forEach(function(name) { caches.delete(name); });
            });
          }
        } else {
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function() {
              navigator.serviceWorker.register('/sw.js').then(function(reg) {
                // Auto-update SW when new version is available
                reg.addEventListener('updatefound', function() {
                  var newWorker = reg.installing;
                  if (newWorker) {
                    newWorker.addEventListener('statechange', function() {
                      if (newWorker.state === 'activated') {
                        // New SW activated - reload to use fresh assets
                        window.location.reload();
                      }
                    });
                  }
                });
              }).catch(function() {});
              // Listen for messages from SW (cache cleared + deep-link nav)
              navigator.serviceWorker.addEventListener('message', function(event) {
                if (event.data && event.data.type === 'CACHE_CLEARED') {
                  window.location.reload();
                } else if (event.data && event.data.type === 'NAVIGATE' && event.data.url) {
                  // Deep-link depuis un clic sur notification : on applique le
                  // hash en in-app (fiable sur iOS PWA, contrairement a
                  // client.navigate()). Le hashchange est ecoute par le routeur.
                  var u = String(event.data.url);
                  var hi = u.indexOf('#');
                  var h = hi >= 0 ? u.slice(hi) : ('#' + u);
                  if (location.hash !== h) { location.hash = h; }
                }
              });
            });
          }
        }
          // Badge PWA : remise a zero du compteur de nouveaux mails a
          // l'ouverture de l'app et a chaque retour au premier plan.
          function __clearAppBadge() {
            if ('clearAppBadge' in navigator) {
              navigator.clearAppBadge().catch(function() {});
            }
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
              navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_BADGE' });
            }
          }
          __clearAppBadge();
          document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') __clearAppBadge();
          });
          // Global error recovery: catch chunk load failures
          window.addEventListener('error', function(e) {
            if (e.message && (e.message.indexOf('Loading chunk') !== -1 || e.message.indexOf('ChunkLoadError') !== -1 || e.message.indexOf('Failed to fetch dynamically imported module') !== -1)) {
              var key = 'imiel:chunkErrorRecovery';
              var last = sessionStorage.getItem(key);
              var now = Date.now();
              if (!last || now - Number(last) > 60000) {
                sessionStorage.setItem(key, String(now));
                caches.keys().then(function(names) {
                  return Promise.all(names.map(function(name) { return caches.delete(name); }));
                }).then(function() {
                  window.location.reload();
                });
              }
            }
          });
        `,
      }}
    />
  );
}
