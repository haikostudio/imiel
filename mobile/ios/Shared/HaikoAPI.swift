// Code partage application <-> widgets : cle d'appareil (trousseau partage,
// PAS d'App Group), requetes signees vers le worker, modeles des widgets.
//
// Signature (cf backend/mail-worker/src/device-keys.ts) :
//   canonical = "<METHODE> <chemin sans /worker ni query>\n" + corps brut
//   X-Device-Sig = hex(HMAC-SHA256(secret, "<ts>.<deviceId>.<sha256 hex(canonical)>"))
//   X-Device-Ts  = millisecondes, strictement croissantes par cle.
import Foundation
import Security
import CryptoKit

public struct DeviceKey: Codable, Equatable {
    public let deviceId: String
    public let secret: String
    public let baseUrl: String
}

public enum HaikoKeychain {
    static let service = "studio.haiko.imiel.devicekey"
    static let account = "device"

    /// "$(AppIdentifierPrefix)studio.haiko.imiel.shared", lu dans l'Info.plist.
    static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "HaikoKeychainGroup") as? String
    }

    private static func baseQuery() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let g = accessGroup, !g.isEmpty, !g.hasPrefix("$(") { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    public static func save(_ key: DeviceKey) throws {
        let data = try JSONEncoder().encode(key)
        SecItemDelete(baseQuery() as CFDictionary)
        var add = baseQuery()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            throw NSError(domain: "HaikoKeychain", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "trousseau: \(status)"])
        }
    }

    public static func load() -> DeviceKey? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceKey.self, from: data)
    }

    public static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

public enum HaikoAPIError: Error {
    case noKey
    case http(Int, String)
}

public enum HaikoAPI {
    private static var lastTs: Int64 = 0
    private static let tsLock = NSLock()

    /// Horodatage en ms strictement croissant dans ce processus (anti-rejeu serveur).
    static func nextTs() -> Int64 {
        tsLock.lock(); defer { tsLock.unlock() }
        var ts = Int64(Date().timeIntervalSince1970 * 1000)
        if ts <= lastTs { ts = lastTs + 1 }
        lastTs = ts
        return ts
    }

    static func hex(_ data: some Sequence<UInt8>) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func signedRequest(method: String, path: String, query: [URLQueryItem] = [], body: Data? = nil, key: DeviceKey) -> URLRequest {
        var comps = URLComponents(string: key.baseUrl + "/worker" + path)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = 12
        let raw = body ?? Data()
        var canonical = Data("\(method.uppercased()) \(path)\n".utf8)
        canonical.append(raw)
        let bodyHash = hex(SHA256.hash(data: canonical))
        let ts = nextTs()
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data("\(ts).\(key.deviceId).\(bodyHash)".utf8),
            using: SymmetricKey(data: Data(key.secret.utf8))
        )
        req.setValue(key.deviceId, forHTTPHeaderField: "X-Device-Id")
        req.setValue(String(ts), forHTTPHeaderField: "X-Device-Ts")
        req.setValue(hex(mac), forHTTPHeaderField: "X-Device-Sig")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    @discardableResult
    static func send(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw HaikoAPIError.http(code, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    // MARK: - Widgets

    public static func fetchWidgets(from: Date, to: Date) async throws -> WidgetPayload {
        guard let key = HaikoKeychain.load() else { throw HaikoAPIError.noKey }
        let iso = ISO8601DateFormatter()
        let req = signedRequest(
            method: "GET", path: "/device/widgets",
            query: [URLQueryItem(name: "from", value: iso.string(from: from)), URLQueryItem(name: "to", value: iso.string(from: to))],
            key: key
        )
        let data = try await send(req)
        let payload = try JSONDecoder().decode(WidgetPayload.self, from: data)
        WidgetCache.save(payload)
        return payload
    }

    // MARK: - Invitations

    public static func respond(eventId: String, response: String) async throws {
        guard let key = HaikoKeychain.load() else { throw HaikoAPIError.noKey }
        let body = try JSONSerialization.data(withJSONObject: ["response": response])
        let path = "/device/invitations/\(eventId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? eventId)/respond"
        try await send(signedRequest(method: "POST", path: path, body: body, key: key))
        WidgetCache.markInvitation(eventId: eventId, status: response)
    }

    // MARK: - Notifications

    public static func registerPushToken(_ token: String, sandbox: Bool) async throws {
        guard let key = HaikoKeychain.load() else { throw HaikoAPIError.noKey }
        let body = try JSONSerialization.data(withJSONObject: [
            "token": token,
            "environment": sandbox ? "sandbox" : "production",
            "deviceName": "iPhone",
        ])
        try await send(signedRequest(method: "POST", path: "/device/push-token", body: body, key: key))
    }

    /// Deconnexion : revocation cote serveur, PUIS effacement du trousseau.
    public static func revokeAndClear() async {
        if let key = HaikoKeychain.load() {
            _ = try? await send(signedRequest(method: "DELETE", path: "/device/keys/current", key: key))
        }
        HaikoKeychain.clear()
        WidgetCache.clear()
    }
}

// MARK: - Modeles (miroir de backend/mail-worker/src/widgets-data.ts)

public struct WidgetEvent: Codable, Identifiable, Hashable {
    public let id: String
    public let title: String
    public let start: String
    public let end: String
    public let allDay: Bool
    public let location: String
    public let color: String
    public var invitation: String
    public let organizer: String

    public var startDate: Date { HaikoDates.parse(start) ?? .distantPast }
    public var endDate: Date { HaikoDates.parse(end) ?? .distantPast }
    public var isPendingInvitation: Bool { invitation == "needs_action" }
}

public struct WidgetMail: Codable, Identifiable, Hashable {
    public let id: String
    public let threadId: String
    public let sender: String
    public let senderAddress: String
    public let subject: String
    public let date: String
    public let url: String
    public var dateValue: Date { HaikoDates.parse(date) ?? .distantPast }
}

public struct WidgetImportant: Codable, Hashable {
    public let count: Int
    public let items: [WidgetMail]
}

public struct WidgetTrack: Codable, Identifiable, Hashable {
    public let id: String
    public let title: String
    public let merchant: String
    public let status: String
    public let lastNews: String
    public let date: String
    public let moved: Bool
    public let url: String
}

public struct WidgetTracking: Codable, Hashable {
    public let moved: Int
    public let items: [WidgetTrack]
}

public struct WidgetPayload: Codable, Hashable {
    public let generatedAt: String
    public var agenda: [WidgetEvent]
    public let important: WidgetImportant
    public let tracking: WidgetTracking

    public static let empty = WidgetPayload(
        generatedAt: "", agenda: [], important: WidgetImportant(count: 0, items: []),
        tracking: WidgetTracking(moved: 0, items: [])
    )
}

public enum HaikoDates {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain = ISO8601DateFormatter()

    public static func parse(_ s: String) -> Date? {
        withFraction.date(from: s) ?? plain.date(from: s)
    }
}

/// Dernieres donnees recues, gardees dans les UserDefaults PROPRES au processus
/// (l'application et l'extension ont chacune les leurs : pas d'App Group).
public enum WidgetCache {
    static let key = "imiel.widgets.payload"

    public static func save(_ p: WidgetPayload) {
        if let data = try? JSONEncoder().encode(p) { UserDefaults.standard.set(data, forKey: key) }
    }

    public static func load() -> WidgetPayload? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(WidgetPayload.self, from: data)
    }

    public static func markInvitation(eventId: String, status: String) {
        guard var p = load() else { return }
        if let i = p.agenda.firstIndex(where: { $0.id == eventId }) {
            if status == "declined" { p.agenda.remove(at: i) } else { p.agenda[i].invitation = status }
            save(p)
        }
    }

    public static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}

/// Lien profond vers un ecran de l'application (hash-router du site).
public enum HaikoLink {
    public static func url(_ hashPath: String) -> URL {
        var c = URLComponents()
        c.scheme = "imiel"
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "u", value: hashPath)]
        return c.url ?? URL(string: "imiel://open")!
    }
}
