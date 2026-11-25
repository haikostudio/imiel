import UIKit
import UserNotifications
import WidgetKit
import Capacitor

/// Coquille iMiel : charge https://imiel.example.com (Capacitor), gere les
/// notifications APNs en NATIF (pas de @capacitor/push-notifications : le jeton
/// arrive ici et part signe au serveur), les actions Accepter / Refuser d'une
/// invitation SANS ouvrir l'application, et les liens profonds des widgets.
@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?

    static let invitationCategory = "INVITATION"

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let accept = UNNotificationAction(identifier: "ACCEPT", title: "Accepter", options: [])
        let decline = UNNotificationAction(identifier: "DECLINE", title: "Refuser", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.invitationCategory, actions: [accept, decline], intentIdentifiers: [], options: [])
        ])

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        window.rootViewController = MainViewController()
        window.makeKeyAndVisible()
        self.window = window

        // Deja autorise (lancement suivant) : on renouvelle le jeton APNs.
        center.getNotificationSettings { s in
            if s.authorizationStatus == .authorized || s.authorizationStatus == .provisional {
                DispatchQueue.main.async { application.registerForRemoteNotifications() }
            }
        }
        if let url = (launchOptions?[.remoteNotification] as? [AnyHashable: Any])?["url"] as? String {
            PendingLink.shared.open(url)
        }
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: - APNs

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        Task { try? await HaikoAPI.registerPushToken(token, sandbox: sandbox) }
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    /// Notification recue (content-available) : les widgets relisent leurs donnees.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        WidgetCenter.shared.reloadAllTimelines()
        completionHandler(.newData)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        WidgetCenter.shared.reloadAllTimelines()
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let eventId = info["eventId"] as? String
        switch response.actionIdentifier {
        case "ACCEPT", "DECLINE":
            // Action sans ouverture de l'application : appel signe en arriere-plan.
            guard let eventId else { completionHandler(); return }
            let answer = response.actionIdentifier == "ACCEPT" ? "accepted" : "declined"
            Task {
                try? await HaikoAPI.respond(eventId: eventId, response: answer)
                WidgetCenter.shared.reloadAllTimelines()
                completionHandler()
            }
        default:
            if let url = info["url"] as? String { PendingLink.shared.open(url) }
            completionHandler()
        }
    }

    // MARK: - Liens profonds (widgets : imiel://open?u=/#/...)

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if url.scheme == "imiel" {
            let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "u" })?.value ?? "/"
            PendingLink.shared.open(target)
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

/// File d'un lien a ouvrir dans la page (avant que la vue web soit prete, il attend).
final class PendingLink {
    static let shared = PendingLink()
    static let notification = Notification.Name("iMielOpenLink")
    private(set) var pending: String?

    func open(_ target: String) {
        pending = target
        NotificationCenter.default.post(name: Self.notification, object: nil)
    }

    func take() -> String? {
        defer { pending = nil }
        return pending
    }
}
