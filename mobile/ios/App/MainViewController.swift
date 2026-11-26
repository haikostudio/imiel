import UIKit
import WebKit
import Capacitor
import UserNotifications
import WidgetKit

/// Vue Capacitor : enregistre le greffon maison et ouvre les liens profonds
/// (notification, widget) dans le routeur a hash du site.
class MainViewController: CAPBridgeViewController {
    private var observer: NSObjectProtocol?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HaikoBridgePlugin())
        #if IMIEL_COPIE_LOCALE
        // Session de l'utilisateur local posee AVANT les scripts de la page
        // (comme l'app d'ordinateur) : jamais d'ecran de connexion.
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: LocalStack.scriptSession(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        webView?.isOpaque = false
        webView?.backgroundColor = .black
        // Application mobile sans zoom (pincement desactive).
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
        observer = NotificationCenter.default.addObserver(forName: PendingLink.notification, object: nil, queue: .main) { [weak self] _ in
            self?.openPendingLink()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        openPendingLink()
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// "/#/mail/all?t=..." -> on change seulement le hash (pas de rechargement).
    private func openPendingLink() {
        guard let webView, let target = PendingLink.shared.take() else { return }
        let hash: String
        if let i = target.firstIndex(of: "#") {
            hash = String(target[target.index(after: i)...])
        } else {
            hash = target.hasPrefix("/") ? target : "/" + target
        }
        let js = "window.location.hash = \(Self.jsString(hash));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }
}

/// Greffon "HaikoBridge" appele par la page (frontend/src/lib/native-app.ts).
@objc(HaikoBridgePlugin)
public class HaikoBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HaikoBridgePlugin"
    public let jsName = "HaikoBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveDeviceKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDeviceKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasDeviceKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enableNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notificationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadWidgets", returnType: CAPPluginReturnPromise),
    ]

    @objc func saveDeviceKey(_ call: CAPPluginCall) {
        guard let deviceId = call.getString("deviceId"), let secret = call.getString("secret"),
              let baseUrl = call.getString("baseUrl") else {
            call.reject("deviceId, secret et baseUrl requis")
            return
        }
        do {
            try HaikoKeychain.save(DeviceKey(deviceId: deviceId, secret: secret, baseUrl: baseUrl))
            WidgetCenter.shared.reloadAllTimelines()
            // Autorisation deja donnee : le jeton APNs part avec la nouvelle cle.
            UNUserNotificationCenter.current().getNotificationSettings { s in
                if s.authorizationStatus == .authorized || s.authorizationStatus == .provisional {
                    DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
                }
            }
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func clearDeviceKey(_ call: CAPPluginCall) {
        Task {
            await HaikoAPI.revokeAndClear()
            WidgetCenter.shared.reloadAllTimelines()
            call.resolve()
        }
    }

    @objc func hasDeviceKey(_ call: CAPPluginCall) {
        if let key = HaikoKeychain.load() {
            call.resolve(["present": true, "deviceId": key.deviceId])
        } else {
            call.resolve(["present": false])
        }
    }

    /// Fenetre d'Apple APRES le geste "Activer" de l'application, puis jeton APNs.
    @objc func enableNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
            call.resolve(["granted": granted])
        }
    }

    @objc func notificationStatus(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let status: String
            switch s.authorizationStatus {
            case .authorized: status = "granted"
            case .provisional, .ephemeral: status = "provisional"
            case .denied: status = "denied"
            default: status = "notDetermined"
            }
            call.resolve(["status": status])
        }
    }

    @objc func reloadWidgets(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
