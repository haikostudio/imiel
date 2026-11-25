import Foundation
import WidgetKit
import AppIntents
import SwiftUI

// MARK: - Etat du widget agenda (UserDefaults PROPRES a l'extension)

enum AgendaState {
    static let dayKey = "imiel.agenda.selectedDay"   // debut du jour choisi (timestamp)
    static let weekKey = "imiel.agenda.weekOffset"   // semaines depuis la semaine courante

    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.locale = Locale(identifier: "fr_FR")
        c.firstWeekday = 2 // lundi
        c.timeZone = .current
        return c
    }

    static var weekOffset: Int {
        get { UserDefaults.standard.integer(forKey: weekKey) }
        set { UserDefaults.standard.set(newValue, forKey: weekKey) }
    }

    /// Jour choisi ; aujourd'hui par defaut, et retour a aujourd'hui le lendemain.
    static var selectedDay: Date {
        get {
            let today = calendar.startOfDay(for: Date())
            let ts = UserDefaults.standard.double(forKey: dayKey)
            guard ts > 0 else { return today }
            let saved = Date(timeIntervalSince1970: ts)
            // Un choix fait un AUTRE jour que celui-ci ne survit pas a minuit.
            let setOn = UserDefaults.standard.double(forKey: dayKey + ".setOn")
            if setOn > 0, !calendar.isDate(Date(timeIntervalSince1970: setOn), inSameDayAs: Date()) {
                return today
            }
            return saved
        }
        set {
            UserDefaults.standard.set(calendar.startOfDay(for: newValue).timeIntervalSince1970, forKey: dayKey)
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: dayKey + ".setOn")
        }
    }

    static func weekStart(offset: Int) -> Date {
        let cal = calendar
        let today = cal.startOfDay(for: Date())
        let start = cal.dateInterval(of: .weekOfYear, for: today)?.start ?? today
        return cal.date(byAdding: .day, value: 7 * offset, to: start) ?? start
    }
}

// MARK: - Intents interactifs (iOS 17)

struct SelectDayIntent: AppIntent {
    static var title: LocalizedStringResource = "Choisir un jour"
    static var isDiscoverable = false
    @Parameter(title: "Jour") var dayTimestamp: Double

    init() {}
    init(day: Date) { self.dayTimestamp = day.timeIntervalSince1970 }

    func perform() async throws -> some IntentResult {
        AgendaState.selectedDay = Date(timeIntervalSince1970: dayTimestamp)
        return .result()
    }
}

struct ShiftWeekIntent: AppIntent {
    static var title: LocalizedStringResource = "Changer de semaine"
    static var isDiscoverable = false
    @Parameter(title: "Decalage") var delta: Int

    init() {}
    init(delta: Int) { self.delta = delta }

    func perform() async throws -> some IntentResult {
        let next = AgendaState.weekOffset + delta
        AgendaState.weekOffset = next
        // Le jour choisi suit la semaine (meme jour de la semaine).
        AgendaState.selectedDay = AgendaState.calendar.date(byAdding: .day, value: 7 * delta, to: AgendaState.selectedDay) ?? AgendaState.selectedDay
        return .result()
    }
}

struct RespondInvitationIntent: AppIntent {
    static var title: LocalizedStringResource = "Repondre a une invitation"
    static var isDiscoverable = false
    @Parameter(title: "Événement") var eventId: String
    @Parameter(title: "Réponse") var response: String

    init() {}
    init(eventId: String, response: String) {
        self.eventId = eventId
        self.response = response
    }

    func perform() async throws -> some IntentResult {
        // Meme chemin que l'encart du mail et la notification (requete signee).
        try await HaikoAPI.respond(eventId: eventId, response: response)
        return .result()
    }
}

enum EventCountOption: Int, AppEnum {
    case two = 2, three = 3, five = 5, eight = 8

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Nombre d'événements"
    static var caseDisplayRepresentations: [EventCountOption: DisplayRepresentation] = [
        .two: "2", .three: "3", .five: "5", .eight: "8 (grande taille)",
    ]
}

struct AgendaConfigIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Agenda"
    static var description = IntentDescription("Touchez un jour pour voir ses événements, < > change de semaine.")

    @Parameter(title: "Nombre d'événements", default: .three)
    var count: EventCountOption
}

// MARK: - Chargement (reseau, sinon dernieres donnees connues)

enum WidgetLoader {
    static func load(weekOffset: Int) async -> (WidgetPayload, Bool) {
        let start = AgendaState.weekStart(offset: min(weekOffset, 0))
        let end = AgendaState.calendar.date(byAdding: .day, value: 7 * (max(weekOffset, 0) + 1) + 7, to: AgendaState.weekStart(offset: 0)) ?? Date()
        let hasKey = HaikoKeychain.load() != nil
        if hasKey, let p = try? await HaikoAPI.fetchWidgets(from: start, to: end) {
            return (p, true)
        }
        return (WidgetCache.load() ?? .empty, hasKey)
    }

    /// Les donnees glissent de quelques minutes (budget de rafraichissement
    /// d'Apple) : nouvelle lecture toutes les 15 min, et a chaque notification.
    static var nextRefresh: Date { Date().addingTimeInterval(15 * 60) }
}

// MARK: - Couleurs

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        if s.count == 3 {
            let r = (v >> 8) & 0xF, g = (v >> 4) & 0xF, b = v & 0xF
            self = Color(red: Double(r * 17) / 255, green: Double(g * 17) / 255, blue: Double(b * 17) / 255)
        } else {
            self = Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
        }
    }

    static let haikoImportant = Color(hex: "#e5484d")
    static let haikoSecondary = Color(hex: "#3b82f6")
}

enum WidgetFormat {
    static let time: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "HH:mm"; return f
    }()
    static let month: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "LLLL"; return f
    }()
    static let dayTitle: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "EEEE d"; return f
    }()
    static let invitation: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "EEE d MMM, HH:mm"; return f
    }()
    static let weekdayLetters = ["L", "M", "M", "J", "V", "S", "D"]

    static func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "@" }).prefix(2)
        let s = parts.compactMap { $0.first }.map { String($0) }.joined().uppercased()
        return s.isEmpty ? "?" : s
    }

    static func shortTime(_ d: Date) -> String {
        AgendaState.calendar.isDateInToday(d) ? time.string(from: d) : {
            let f = DateFormatter(); f.locale = Locale(identifier: "fr_FR"); f.dateFormat = "d MMM"; return f.string(from: d)
        }()
    }
}
