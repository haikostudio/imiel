// Mises a jour de l'app d'ordinateur : PROPOSEES, jamais installees seules.
// Le greffon de mise a jour Tauri lit le manifeste signe servi par la vitrine
// (https://getimiel.com/mises-a-jour/latest.json, produit par
// desktop/scripts/manifeste-mises-a-jour.mjs ; secours : le serveur iMiel
// Cloud, /v1/mises-a-jour/...), telecharge le paquet indique et verifie
// sa signature minisign avec la cle publique de tauri.conf.json avant toute
// installation. `signature_valide` rejoue cette verification (meme
// bibliotheque, minisign-verify) : les essais prouvent qu'un paquet falsifie
// ou signe par une autre cle est refuse.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Cle publique et signature au format du greffon (texte minisign en base64).
pub fn signature_valide(cle_publique_b64: &str, donnees: &[u8], signature_b64: &str) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    let lire = |t: &str| b64.decode(t.trim()).ok().and_then(|o| String::from_utf8(o).ok());
    let (Some(cle), Some(sig)) = (lire(cle_publique_b64), lire(signature_b64)) else {
        return false;
    };
    let (Ok(cle), Ok(sig)) = (PublicKey::decode(&cle), Signature::decode(&sig)) else {
        return false;
    };
    cle.verify(donnees, &sig, false).is_ok()
}

#[derive(Serialize)]
pub struct MiseAJour {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

/// Une version plus recente existe-t-elle ? (rien n'est telecharge)
#[tauri::command]
pub async fn verifier_mise_a_jour(app: AppHandle) -> Result<Option<MiseAJour>, String> {
    let maj = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(maj.map(|u| MiseAJour { version: u.version.clone(), notes: u.body.clone(), date: u.date.map(|d| d.to_string()) }))
}

/// Installe la mise a jour, SUR GESTE de l'utilisateur, puis relance l'app.
/// La base applique ses nouvelles migrations au redemarrage de la pile.
#[tauri::command]
pub async fn installer_mise_a_jour(app: AppHandle) -> Result<(), String> {
    let Some(maj) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    // Signature verifiee par le greffon : un paquet falsifie s'arrete ici.
    maj.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    crate::pile::arreter(&app.state::<crate::pile::EtatPile>());
    app.restart();
}

#[cfg(test)]
mod essais {
    use super::signature_valide;

    const CLE_ESSAI: &str = include_str!("../essais/maj/essai.pub");
    const PAQUET: &[u8] = include_bytes!("../essais/maj/paquet-essai.bin");
    const SIGNATURE: &str = include_str!("../essais/maj/paquet-essai.bin.sig");

    fn cle_de_production() -> String {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        conf["plugins"]["updater"]["pubkey"].as_str().unwrap().to_string()
    }

    #[test]
    fn paquet_signe_accepte() {
        assert!(signature_valide(CLE_ESSAI, PAQUET, SIGNATURE));
    }

    #[test]
    fn paquet_falsifie_refuse() {
        let mut falsifie = PAQUET.to_vec();
        falsifie[0] ^= 1;
        assert!(!signature_valide(CLE_ESSAI, &falsifie, SIGNATURE));
    }

    #[test]
    fn signe_par_une_autre_cle_refuse() {
        // Paquet authentique pour la cle d'essai, mais l'app de production
        // n'accepte que SA cle : refus.
        assert!(!signature_valide(&cle_de_production(), PAQUET, SIGNATURE));
    }

    #[test]
    fn signature_illisible_refusee() {
        assert!(!signature_valide(CLE_ESSAI, PAQUET, "pas une signature"));
        assert!(!signature_valide("", PAQUET, SIGNATURE));
    }
}
