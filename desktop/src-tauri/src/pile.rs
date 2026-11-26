// Pile LOCALE (mode « Sur cet ordinateur ») : lance desktop/pile/lanceur.mjs
// avec le Node embarque, qui demarre et surveille la base, le releveur de
// courrier et l'interface sur 127.0.0.1 (voir l'en-tete du lanceur).
//
// Contrat : le lanceur ecrit « PRET {json} » ou « ECHEC {json} » sur sa sortie
// standard. On garde son ENTREE standard ouverte : la fermer (quitter l'app,
// ou plantage de l'app) l'arrete proprement avec ses trois processus.
use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct PilePrEte {
    pub adresse: String,
    pub jeton: String,
    pub utilisateur: serde_json::Value,
}

#[derive(Default)]
pub struct EtatPile {
    pub enfant: Mutex<Option<Child>>,
    pub prete: Mutex<Option<PilePrEte>>,
}

/// Dossier des ressources de la pile dans le paquet (absent dans la version
/// « fenetre » de l'editeur, qui n'embarque pas la pile).
pub fn dossier_pile(resource_dir: &Path) -> Option<PathBuf> {
    let d = resource_dir.join("pile");
    if d.join("lanceur.mjs").is_file() && executable_node(&d).is_file() {
        Some(d)
    } else {
        None
    }
}

pub fn executable_node(pile: &Path) -> PathBuf {
    if cfg!(windows) {
        pile.join("node").join("node.exe")
    } else {
        pile.join("node").join("bin").join("node")
    }
}

/// Demarre la pile et attend la ligne PRET (au plus `delai`).
/// `mode` : « local » (version gratuite, le releveur releve) ou « cloud »
/// (iMiel Cloud : la base locale est alimentee par le serveur de transfert).
pub fn demarrer(etat: &EtatPile, pile: &Path, donnees: &Path, delai: Duration, mode: &str) -> Result<PilePrEte, String> {
    if let Some(p) = etat.prete.lock().unwrap().clone() {
        return Ok(p);
    }
    std::fs::create_dir_all(donnees).map_err(|e| format!("dossier de donnees : {e}"))?;
    let mut cmd = Command::new(executable_node(pile));
    cmd.arg(pile.join("lanceur.mjs"))
        .arg("--pile")
        .arg(pile)
        .arg("--donnees")
        .arg(donnees)
        .arg("--mode")
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut enfant = cmd.spawn().map_err(|e| format!("lancement de la pile : {e}"))?;
    let sortie = enfant.stdout.take().ok_or("sortie du lanceur indisponible")?;
    *etat.enfant.lock().unwrap() = Some(enfant);

    let (tx, rx) = std::sync::mpsc::channel::<Result<PilePrEte, String>>();
    std::thread::spawn(move || {
        let lecteur = BufReader::new(sortie);
        for ligne in lecteur.lines().map_while(Result::ok) {
            if let Some(json) = ligne.strip_prefix("PRET ") {
                let _ = tx.send(serde_json::from_str::<PilePrEte>(json).map_err(|e| e.to_string()));
            } else if let Some(json) = ligne.strip_prefix("ECHEC ") {
                let msg = serde_json::from_str::<serde_json::Value>(json)
                    .ok()
                    .and_then(|v| v.get("erreur").and_then(|e| e.as_str()).map(String::from))
                    .unwrap_or_else(|| json.to_string());
                let _ = tx.send(Err(msg));
            }
        }
    });
    match rx.recv_timeout(delai) {
        Ok(Ok(p)) => {
            *etat.prete.lock().unwrap() = Some(p.clone());
            Ok(p)
        }
        Ok(Err(e)) => {
            arreter(etat);
            Err(e)
        }
        Err(_) => {
            arreter(etat);
            Err("la pile locale n'a pas demarre a temps".into())
        }
    }
}

/// Arret propre : fermer l'entree standard suffit (le lanceur arrete ses
/// processus) ; on attend un peu, puis on force.
pub fn arreter(etat: &EtatPile) {
    if let Some(mut enfant) = etat.enfant.lock().unwrap().take() {
        drop(enfant.stdin.take());
        for _ in 0..60 {
            if let Ok(Some(_)) = enfant.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = enfant.kill();
        let _ = enfant.wait();
    }
    *etat.prete.lock().unwrap() = None;
}

/// Script injecte dans la page AVANT ses scripts : pose la session de
/// l'utilisateur local dans le stockage lu par le client PocketBase (cle
/// « pocketbase_auth »), et marque l'app comme locale (canal temps reel par
/// /ws, voir frontend/src/lib/ws-channel.ts). Le jeton est renouvele a chaque
/// lancement : l'utilisateur n'a jamais a se connecter.
pub fn script_session(p: &PilePrEte, cloud: Option<&str>) -> String {
    let auth = serde_json::json!({ "token": p.jeton, "record": p.utilisateur, "model": p.utilisateur });
    let auth_txt = serde_json::to_string(&auth.to_string()).unwrap_or_else(|_| "\"\"".into());
    let origine = serde_json::to_string(p.adresse.trim_end_matches('/')).unwrap_or_else(|_| "\"\"".into());
    // iMiel Cloud : l'interface se relie au serveur de transfert (adresse
    // fixee a la fabrication, ou IMIEL_CLOUD_URL a l'execution pour un essai).
    let cloud_js = match cloud {
        Some(url) => format!(
            "window.__IMIEL_CLOUD__ = true; window.__IMIEL_CLOUD_URL__ = {};",
            serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into())
        ),
        None => String::new(),
    };
    format!(
        "window.__IMIEL_DESKTOP__ = true; window.__IMIEL_LOCAL__ = true; {cloud_js}\
         try {{ if (window.location.origin === {origine}) {{ localStorage.setItem('pocketbase_auth', {auth_txt}); }} }} catch (e) {{}}"
    )
}
