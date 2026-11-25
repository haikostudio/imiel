import SwiftUI
import Pbmobile

// App d'essai : demarre la base iMiel embarquee au lancement, puis l'hote du
// simulateur l'interroge sur 127.0.0.1:8099 (le simulateur partage le reseau).
@main
struct SpikeApp: App {
    @State private var status = "demarrage..."

    init() {
        let res = Bundle.main.resourceURL!
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let data = docs.appendingPathComponent("pb_data").path
        try? FileManager.default.createDirectory(atPath: data, withIntermediateDirectories: true)
        let t0 = Date()
        var err: NSError?
        let ok = PbmobileStart(data,
                               res.appendingPathComponent("pb_migrations").path,
                               res.appendingPathComponent("pb_hooks").path,
                               "127.0.0.1:8099", &err)
        NSLog("IMIEL_SPIKE start ok=%d err=%@ en %.0f ms", ok ? 1 : 0, err?.localizedDescription ?? "-", Date().timeIntervalSince(t0) * 1000)
    }

    var body: some Scene {
        WindowGroup { Text("iMiel — base embarquee : \(status)").padding() }
    }
}
