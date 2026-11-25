// iMiel Desktop - fine fenetre native (Tauri v2) qui charge l'app web
// hebergee. Aucune logique applicative ici : tout vit dans le frontend Next.js
// servi par le serveur iMiel choisi (voir adresse_du_serveur). On construit la fenetre en Rust (plutot que
// via tauri.conf.json) pour pouvoir injecter un script d'initialisation qui
// marque la page comme "tournant dans l'app de bureau" (window.__IMIEL_DESKTOP__),
// ce qui permet au frontend de masquer la banniere de telechargement.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// Adresse du serveur iMiel. A la fabrication : variable IMIEL_APP_URL (sinon
// l'instance de l'editeur). Sur la machine : un fichier « serveur.txt » dans le
// dossier de reglages de l'app (une ligne, https://...) prime, sans refabriquer.
const APP_URL_PAR_DEFAUT: &str = match option_env!("IMIEL_APP_URL") {
    Some(url) => url,
    None => "https://imiel.example.com/",
};

fn adresse_du_serveur(app: &tauri::App) -> tauri::Url {
    let choisie = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dossier| std::fs::read_to_string(dossier.join("serveur.txt")).ok())
        .map(|texte| texte.trim().to_string())
        .filter(|texte| texte.starts_with("https://") || texte.starts_with("http://127.0.0.1") || texte.starts_with("http://localhost"))
        .and_then(|texte| texte.parse::<tauri::Url>().ok());
    choisie.unwrap_or_else(|| APP_URL_PAR_DEFAUT.parse().expect("URL de l'app invalide"))
}

fn main() {
    tauri::Builder::default()
        // Notifications OS natives : le Web Push ne fonctionne pas dans la
        // WKWebView, le frontend declenche donc des notifications via ce plugin
        // (alimentees par le WebSocket temps reel des nouveaux mails).
        .plugin(tauri_plugin_notification::init())
        // Ouverture des liens externes dans le navigateur systeme (Chrome/Safari/
        // ...). Sans ca, un clic sur un lien d'email ne fait rien dans la webview.
        .plugin(tauri_plugin_opener::init())
        // Taille et position de la fenetre memorisees d'un lancement a l'autre
        // (enregistrees a la fermeture, reappliquees a la creation de "main").
        // Premier lancement : 1280x860 ci-dessous.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let adresse = adresse_du_serveur(app);
            // Les notifications natives et l'ouverture des liens ne sont permises
            // qu'a la page de CE serveur (en plus des adresses de capabilities/).
            let origine = format!("{}/*", adresse.origin().ascii_serialization());
            app.add_capability(
                CapabilityBuilder::new("serveur-choisi")
                    .remote(origine)
                    .window("main")
                    .permission("core:default")
                    .permission("notification:default")
                    .permission("opener:default"),
            )?;
            let url = WebviewUrl::External(adresse);
            WebviewWindowBuilder::new(app, "main", url)
                .title("iMiel")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 600.0)
                .resizable(true)
                .initialization_script("window.__IMIEL_DESKTOP__ = true;")
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement d'iMiel");
}
