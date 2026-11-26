// iMiel pour ordinateur (Tauri v2). Trois usages, choisis au premier lancement
// (ecran desktop/dist/index.html) :
//   - « iMiel Cloud » (abonnement) : l'app embarque iMiel ENTIER (base,
//     interface) sur 127.0.0.1 ; sa base est alimentee par le serveur de
//     transfert, qui releve les boites (rien a regler, rien de garde la-bas).
//   - « Gratuit, sur cet ordinateur » (version libre) : meme pile, mais le
//     releveur local releve lui-meme les boites reglees a la main. Fenetre
//     fermee, la releve continue (icone de la barre des menus).
//   - « J'ai deja mon propre serveur iMiel » : fine fenetre sur ce serveur
//     (comportement historique).
// Quand l'abonnement s'arrete, l'app propose de passer en version gratuite
// sur la meme base (commande passer_gratuit).
// Version de l'editeur : si l'adresse est IMPOSEE a la fabrication
// (IMIEL_APP_URL), l'app ouvre directement ce serveur, sans premier ecran,
// comme avant.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod maj;
mod pile;
mod reglages;

use std::time::Duration;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const APP_URL_IMPOSEE: Option<&str> = option_env!("IMIEL_APP_URL");
const CLOUD_URL_FABRICATION: Option<&str> = option_env!("IMIEL_CLOUD_URL");
const CLOUD_URL_DEFAUT: &str = "https://sync.getimiel.com";

/// Adresse du serveur de transfert iMiel Cloud.
fn adresse_cloud() -> String {
    std::env::var("IMIEL_CLOUD_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .or_else(|| CLOUD_URL_FABRICATION.map(String::from))
        .unwrap_or_else(|| CLOUD_URL_DEFAUT.into())
}
const ARG_EN_FOND: &str = "--en-fond";

enum Mode {
    Accueil,
    Local { cloud: bool },
    Serveur(tauri::Url),
}

fn mode_au_demarrage(app: &AppHandle) -> Mode {
    if let Some(choix) = reglages::lire(app) {
        if (choix.mode == "local" || choix.mode == "cloud") && pile_disponible(app) {
            return Mode::Local { cloud: choix.mode == "cloud" };
        }
        if choix.mode == "serveur" {
            if let Some(u) = choix.serveur.as_deref().and_then(reglages::adresse_valide) {
                return Mode::Serveur(u);
            }
        }
    }
    if let Some(u) = APP_URL_IMPOSEE.and_then(reglages::adresse_valide) {
        return Mode::Serveur(u);
    }
    Mode::Accueil
}

fn pile_disponible(app: &AppHandle) -> bool {
    app.path().resource_dir().ok().and_then(|d| pile::dossier_pile(&d)).is_some()
}

fn autoriser_origine(app: &AppHandle, url: &tauri::Url) -> Result<(), String> {
    // Notifications natives, ouverture des liens et mises a jour : permises a
    // la page de CE serveur seulement (en plus de capabilities/).
    let origine = format!("{}/*", url.origin().ascii_serialization());
    app.add_capability(
        CapabilityBuilder::new(format!("origine-{}", url.port_or_known_default().unwrap_or(0)))
            .remote(origine)
            .window("main")
            .permission("core:default")
            .permission("notification:default")
            .permission("opener:default"),
    )
    .map_err(|e| e.to_string())
}

fn fenetre_principale(app: &AppHandle, url: tauri::Url, script: String, visible: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
    autoriser_origine(app, &url)?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("iMiel")
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 600.0)
        .resizable(true)
        .visible(visible)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ouvrir_accueil(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("accueil") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "accueil", WebviewUrl::App("index.html".into()))
        .title("Bienvenue dans iMiel")
        .inner_size(560.0, 720.0)
        .min_inner_size(420.0, 600.0)
        .resizable(true)
        .initialization_script("window.__IMIEL_DESKTOP__ = true;")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Demarre la pile locale (bloquant, jusqu'a 3 minutes au premier lancement :
/// la base applique toutes ses migrations) puis ouvre la fenetre dessus.
fn ouvrir_local(app: &AppHandle, suite: Option<&str>, visible: bool, cloud: bool) -> Result<(), String> {
    let ressources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let dossier = pile::dossier_pile(&ressources).ok_or("cette version n'embarque pas iMiel en local")?;
    let donnees = app.path().app_data_dir().map_err(|e| e.to_string())?.join("local");
    let etat = app.state::<pile::EtatPile>();
    let prete = pile::demarrer(&etat, &dossier, &donnees, Duration::from_secs(180), if cloud { "cloud" } else { "local" })?;
    let mut url: tauri::Url = prete.adresse.parse().map_err(|e| format!("adresse locale : {e}"))?;
    if let Some(fragment) = suite {
        url.set_fragment(Some(fragment));
    }
    let adresse = adresse_cloud();
    fenetre_principale(app, url, pile::script_session(&prete, if cloud { Some(&adresse) } else { None }), visible)?;
    installer_icone(app);
    Ok(())
}

fn ouvrir_serveur(app: &AppHandle, url: tauri::Url) -> Result<(), String> {
    fenetre_principale(app, url, "window.__IMIEL_DESKTOP__ = true;".into(), true)
}

// --- Icone de la barre des menus / zone de notification (mode local) --------
fn installer_icone(app: &AppHandle) {
    if app.tray_by_id("imiel").is_some() {
        return;
    }
    let construire = || -> tauri::Result<()> {
        let ouvrir = MenuItem::with_id(app, "ouvrir", "Ouvrir iMiel", true, None::<&str>)?;
        let session = CheckMenuItem::with_id(
            app,
            "session",
            "Lancer a l'ouverture de session",
            true,
            app.autolaunch().is_enabled().unwrap_or(false),
            None::<&str>,
        )?;
        let changer = MenuItem::with_id(app, "changer", "Changer de mode…", true, None::<&str>)?;
        let quitter = MenuItem::with_id(app, "quitter", "Quitter iMiel", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&ouvrir, &session, &changer, &sep, &quitter])?;
        let mut b = TrayIconBuilder::with_id("imiel")
            .tooltip("iMiel : la releve du courrier continue")
            .menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "ouvrir" => montrer_principale(app),
                "session" => {
                    let al = app.autolaunch();
                    let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                }
                "changer" => {
                    reglages::oublier(app);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.destroy();
                    }
                    pile::arreter(&app.state::<pile::EtatPile>());
                    let _ = ouvrir_accueil(app);
                }
                "quitter" => app.exit(0),
                _ => {}
            });
        if let Some(icone) = app.default_window_icon() {
            b = b.icon(icone.clone());
        }
        b.build(app)?;
        Ok(())
    };
    if let Err(e) = construire() {
        eprintln!("icone de la barre des menus : {e}");
    }
}

fn montrer_principale(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// --- Commandes de l'ecran de premier lancement ------------------------------
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EtatAccueil {
    local_disponible: bool,
    version: String,
    lancement_session: bool,
}

#[tauri::command]
fn etat_accueil(app: AppHandle) -> EtatAccueil {
    EtatAccueil {
        local_disponible: pile_disponible(&app),
        version: app.package_info().version.to_string(),
        lancement_session: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
async fn choisir_local(app: AppHandle, lancement_session: bool, cloud: bool) -> Result<(), String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let al = a.autolaunch();
        let _ = if lancement_session { al.enable() } else { al.disable() };
        ouvrir_local(&a, None, true, cloud)?;
        let mode = if cloud { "cloud" } else { "local" };
        reglages::ecrire(&a, &reglages::Choix { mode: mode.into(), serveur: None })?;
        if let Some(w) = a.get_webview_window("accueil") {
            let _ = w.destroy();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abonnement iMiel Cloud arrete : l'ordinateur continue avec la version
/// gratuite, sur la MEME base (les boites ont repris leurs identifiants, voir
/// frontend/src/lib/cloud/abonnement.ts). La pile redemarre en mode local.
#[tauri::command]
async fn passer_gratuit(app: AppHandle) -> Result<(), String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        reglages::ecrire(&a, &reglages::Choix { mode: "local".into(), serveur: None })?;
        pile::arreter(&a.state::<pile::EtatPile>());
        ouvrir_local(&a, None, true, false)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Commande asynchrone : creer une fenetre depuis une commande synchrone bloque
// sous Windows.
#[tauri::command]
async fn choisir_serveur(app: AppHandle, adresse: String) -> Result<(), String> {
    let url = reglages::adresse_valide(&adresse)
        .ok_or("Adresse invalide : elle doit commencer par https:// (par exemple https://mail.votre-domaine.fr).")?;
    reglages::ecrire(&app, &reglages::Choix { mode: "serveur".into(), serveur: Some(url.to_string()) })?;
    ouvrir_serveur(&app, url)?;
    if let Some(w) = app.get_webview_window("accueil") {
        let _ = w.destroy();
    }
    Ok(())
}

fn main() {
    let en_fond = std::env::args().any(|a| a == ARG_EN_FOND);
    let app = tauri::Builder::default()
        // Notifications OS natives : le Web Push ne fonctionne pas dans la
        // WKWebView, le frontend declenche donc des notifications via ce plugin.
        .plugin(tauri_plugin_notification::init())
        // Liens externes ouverts dans le navigateur du systeme.
        .plugin(tauri_plugin_opener::init())
        // Taille et position de la fenetre memorisees d'un lancement a l'autre.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Lancement a l'ouverture de session (option, mode local) : l'app part
        // alors « en fond » (fenetre cachee, releve active).
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![ARG_EN_FOND])))
        // Mises a jour PROPOSEES (bandeau de l'interface), signature verifiee,
        // jamais installees sans geste de l'utilisateur (voir maj.rs).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pile::EtatPile::default())
        .invoke_handler(tauri::generate_handler![
            etat_accueil,
            choisir_local,
            choisir_serveur,
            passer_gratuit,
            maj::verifier_mise_a_jour,
            maj::installer_mise_a_jour
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            match mode_au_demarrage(&handle) {
                Mode::Serveur(url) => ouvrir_serveur(&handle, url)?,
                Mode::Accueil => ouvrir_accueil(&handle)?,
                Mode::Local { cloud } => {
                    // Demarrage de la pile hors du fil principal (la fenetre
                    // s'ouvre des qu'elle est prete).
                    std::thread::spawn(move || {
                        if let Err(e) = ouvrir_local(&handle, None, !en_fond, cloud) {
                            eprintln!("pile locale : {e}");
                            let _ = ouvrir_accueil(&handle);
                        }
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Mode local : fermer la fenetre la CACHE (la releve continue).
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let locale = app.state::<pile::EtatPile>().prete.lock().unwrap().is_some();
                if window.label() == "main" && locale {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("erreur au lancement d'iMiel");

    app.run(|app, event| match event {
        RunEvent::Exit => pile::arreter(&app.state::<pile::EtatPile>()),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => montrer_principale(app),
        _ => {}
    });
}
