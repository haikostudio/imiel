// Choix du premier lancement, garde dans le dossier de reglages de l'app :
// « choix.json » = { "mode": "cloud" | "local" | "serveur", "serveur": "https://..." }.
// L'ancien « serveur.txt » (une ligne) reste lu : il vaut choix « serveur ».
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Choix {
    pub mode: String,
    #[serde(default)]
    pub serveur: Option<String>,
}

fn dossier(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// Adresse acceptee pour un serveur iMiel : https, ou http sur la machine.
pub fn adresse_valide(texte: &str) -> Option<tauri::Url> {
    let t = texte.trim();
    let ok = t.starts_with("https://") || t.starts_with("http://127.0.0.1") || t.starts_with("http://localhost");
    if !ok {
        return None;
    }
    let url = t.parse::<tauri::Url>().ok()?;
    url.host_str()?;
    Some(url)
}

pub fn lire(app: &tauri::AppHandle) -> Option<Choix> {
    let d = dossier(app)?;
    if let Ok(txt) = std::fs::read_to_string(d.join("choix.json")) {
        if let Ok(c) = serde_json::from_str::<Choix>(&txt) {
            return Some(c);
        }
    }
    let ancien = std::fs::read_to_string(d.join("serveur.txt")).ok()?;
    adresse_valide(&ancien).map(|u| Choix { mode: "serveur".into(), serveur: Some(u.to_string()) })
}

pub fn ecrire(app: &tauri::AppHandle, choix: &Choix) -> Result<(), String> {
    let d = dossier(app).ok_or("dossier de reglages introuvable")?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let txt = serde_json::to_string_pretty(choix).map_err(|e| e.to_string())?;
    std::fs::write(d.join("choix.json"), txt).map_err(|e| e.to_string())?;
    // Compatibilite : serveur.txt suit le choix « serveur » (et disparait sinon)
    // pour qu'une version precedente de l'app relise la meme adresse.
    match (&choix.mode[..], &choix.serveur) {
        ("serveur", Some(s)) => std::fs::write(d.join("serveur.txt"), s).map_err(|e| e.to_string())?,
        _ => {
            let _ = std::fs::remove_file(d.join("serveur.txt"));
        }
    }
    Ok(())
}

pub fn oublier(app: &tauri::AppHandle) {
    if let Some(d) = dossier(app) {
        let _ = std::fs::remove_file(d.join("choix.json"));
        let _ = std::fs::remove_file(d.join("serveur.txt"));
    }
}

#[cfg(test)]
mod tests {
    use super::adresse_valide;

    #[test]
    fn adresses() {
        assert!(adresse_valide("https://mail.example.com").is_some());
        assert!(adresse_valide("  https://mail.example.com/  ").is_some());
        assert!(adresse_valide("http://127.0.0.1:8080").is_some());
        assert!(adresse_valide("http://mail.example.com").is_none());
        assert!(adresse_valide("ftp://x").is_none());
        assert!(adresse_valide("https://").is_none());
    }
}
