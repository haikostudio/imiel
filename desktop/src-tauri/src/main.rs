// iMiel Desktop - fine fenetre native (Tauri v2) qui charge l'app web
// hebergee. Aucune logique applicative ici : tout vit dans le frontend Next.js
// servi par imiel.example.com. On construit la fenetre en Rust (plutot que
// via tauri.conf.json) pour pouvoir injecter un script d'initialisation qui
// marque la page comme "tournant dans l'app de bureau" (window.__IMIEL_DESKTOP__),
// ce qui permet au frontend de masquer la banniere de telechargement.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

const APP_URL: &str = "https://imiel.example.com/";

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
            let url = WebviewUrl::External(
                APP_URL.parse().expect("URL de l'app invalide"),
            );
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
