// Copie COMPLETE sur l'iPhone (mode « Sur cet iPhone ») : la base d'iMiel
// tourne DANS l'app (Pbmobile, mobile/base/pbmobile) et sert, a la meme
// adresse locale, l'API et l'interface statique embarquee. Le courrier se lit
// donc meme ordinateur eteint et sans reseau.
//
// Compile seulement dans la version « copie locale » (condition
// IMIEL_COPIE_LOCALE posee par mobile/scripts/poser-copie-locale.mjs) : la
// version « serveur iMiel » actuelle ne change pas.
#if IMIEL_COPIE_LOCALE
import Foundation
import Security
import Pbmobile

enum LocalStack {
    static let adresse = "127.0.0.1:8099"
    static var origine: String { "http://\(adresse)" }
    /// Session de l'utilisateur local (pocketbase_auth) a poser dans la page.
    private(set) static var sessionJSON: String?

    /// Demarre la base et ouvre la session locale. A appeler HORS du fil
    /// principal (la premiere fois, les migrations prennent quelques secondes).
    static func demarrer() throws {
        let res = Bundle.main.resourceURL!.appendingPathComponent("local")
        let fm = FileManager.default
        let donnees = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("imiel/base")
        try fm.createDirectory(at: donnees, withIntermediateDirectories: true)
        var err: NSError?
        let ok = PbmobileStart(donnees.path,
                               res.appendingPathComponent("base/pb_migrations").path,
                               res.appendingPathComponent("base/pb_hooks").path,
                               res.appendingPathComponent("interface").path,
                               adresse, &err)
        if !ok { throw err ?? erreur("la base locale n'a pas demarre") }
        try attendreSante()
        let ids = IdentifiantsLocaux.chargerOuCreer()
        if !PbmobileEnsureSuperuser(ids.adminEmail, ids.adminMotDePasse, &err) { throw err ?? erreur("administrateur local") }
        sessionJSON = try ouvrirSession(ids)
    }

    private static func attendreSante() throws {
        for _ in 0..<300 {
            if let (_, r) = try? requete("GET", "/api/health"), r == 200 { return }
            let e = PbmobileLastError()
            if !e.isEmpty { throw erreur(e) }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw erreur("la base locale ne repond pas")
    }

    /// Administrateur -> utilisateur local (cree une fois) -> jeton de session.
    private static func ouvrirSession(_ ids: IdentifiantsLocaux) throws -> String {
        let admin = try json(requete("POST", "/api/collections/_superusers/auth-with-password",
                                     ["identity": ids.adminEmail, "password": ids.adminMotDePasse]))
        guard let jetonAdmin = admin["token"] as? String else { throw erreur("session administrateur") }
        let filtre = "email=\"\(ids.email)\"".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let liste = try json(requete("GET", "/api/collections/users/records?perPage=1&filter=\(filtre)", nil, jeton: jetonAdmin))
        if (liste["items"] as? [Any])?.isEmpty ?? true {
            _ = try requete("POST", "/api/collections/users/records",
                            ["email": ids.email, "password": ids.motDePasse, "passwordConfirm": ids.motDePasse, "verified": true, "name": "Moi"],
                            jeton: jetonAdmin)
        }
        let sess = try json(requete("POST", "/api/collections/users/auth-with-password",
                                    ["identity": ids.email, "password": ids.motDePasse]))
        guard let token = sess["token"] as? String, let record = sess["record"] else { throw erreur("session locale") }
        let auth: [String: Any] = ["token": token, "record": record, "model": record]
        let data = try JSONSerialization.data(withJSONObject: auth)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    /// Script pose AVANT les scripts de la page : session + marqueur local.
    static func scriptSession() -> String {
        let session = sessionJSON ?? "null"
        let data = (try? JSONSerialization.data(withJSONObject: [session])) ?? Data("[\"\"]".utf8)
        let tableau = String(data: data, encoding: .utf8) ?? "[\"\"]"
        let litteral = String(tableau.dropFirst().dropLast())
        let apns = UserDefaults.standard.string(forKey: "imiel.apns") ?? ""
        return """
        window.__IMIEL_LOCAL__ = true; window.__IMIEL_IPHONE_LOCAL__ = true; window.__IMIEL_APNS__ = "\(apns)";
        try { if (location.origin === "\(origine)" && \(session != "null" ? "true" : "false")) { localStorage.setItem("pocketbase_auth", \(litteral)); } } catch (e) {}
        """
    }

    // --- petites aides HTTP synchrones (fil d'arriere-plan uniquement) ---
    private static func requete(_ methode: String, _ chemin: String, _ corps: [String: Any]? = nil, jeton: String? = nil) throws -> (Data, Int) {
        var req = URLRequest(url: URL(string: origine + chemin)!, timeoutInterval: 10)
        req.httpMethod = methode
        if let jeton { req.setValue(jeton, forHTTPHeaderField: "Authorization") }
        if let corps {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: corps)
        }
        let sem = DispatchSemaphore(value: 0)
        var sortie: (Data, Int)?
        var echec: Error?
        URLSession.shared.dataTask(with: req) { d, r, e in
            if let e { echec = e } else { sortie = (d ?? Data(), (r as? HTTPURLResponse)?.statusCode ?? 0) }
            sem.signal()
        }.resume()
        sem.wait()
        if let echec { throw echec }
        return sortie!
    }

    private static func json(_ r: (Data, Int)) throws -> [String: Any] {
        guard (200..<300).contains(r.1), let o = try JSONSerialization.jsonObject(with: r.0) as? [String: Any] else {
            throw erreur("reponse \(r.1) de la base locale")
        }
        return o
    }

    private static func erreur(_ m: String) -> NSError {
        NSError(domain: "iMiel.LocalStack", code: 1, userInfo: [NSLocalizedDescriptionKey: m])
    }
}

/// Secrets de la base locale, GENERES sur l'iPhone et gardes dans le trousseau
/// (jamais dans les fichiers de l'app ni dans une sauvegarde lisible).
struct IdentifiantsLocaux: Codable {
    let adminEmail: String
    let adminMotDePasse: String
    let email: String
    let motDePasse: String

    static let service = "studio.haiko.imiel.base-locale"

    static func chargerOuCreer() -> IdentifiantsLocaux {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "base"]
        var lu = q
        lu[kSecReturnData as String] = true
        lu[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        if SecItemCopyMatching(lu as CFDictionary, &out) == errSecSuccess, let d = out as? Data,
           let ids = try? JSONDecoder().decode(IdentifiantsLocaux.self, from: d) {
            return ids
        }
        let ids = IdentifiantsLocaux(adminEmail: "admin@imiel.local", adminMotDePasse: aleatoire(), email: "moi@imiel.local", motDePasse: aleatoire())
        var ajout = q
        ajout[kSecValueData as String] = try? JSONEncoder().encode(ids)
        ajout[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemDelete(q as CFDictionary)
        SecItemAdd(ajout as CFDictionary, nil)
        return ids
    }

    private static func aleatoire() -> String {
        var b = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return b.map { String(format: "%02x", $0) }.joined()
    }
}
#endif
