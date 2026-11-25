import WidgetKit
import SwiftUI

// Widgets Importants et Suivis (listes courtes, SANS bouton d'action : un
// toucher ouvre l'application au bon ecran) + ecran de verrouillage (prochain
// rendez-vous, compteurs ; JAMAIS de sujet de mail sur l'ecran verrouille).

struct HaikoEntry: TimelineEntry {
    let date: Date
    let payload: WidgetPayload
    let connected: Bool
}

struct HaikoProvider: TimelineProvider {
    func placeholder(in context: Context) -> HaikoEntry { HaikoEntry(date: Date(), payload: .empty, connected: true) }

    func getSnapshot(in context: Context, completion: @escaping (HaikoEntry) -> Void) {
        Task {
            let (p, c) = await WidgetLoader.load(weekOffset: 0)
            completion(HaikoEntry(date: Date(), payload: p, connected: c))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HaikoEntry>) -> Void) {
        Task {
            let (p, c) = await WidgetLoader.load(weekOffset: 0)
            completion(Timeline(entries: [HaikoEntry(date: Date(), payload: p, connected: c)], policy: .after(WidgetLoader.nextRefresh)))
        }
    }
}

// MARK: - Importants

struct ImportantWidgetView: View {
    let entry: HaikoEntry
    private let avatarColors: [Color] = [Color(hex: "#111111"), Color(hex: "#0f766e"), Color(hex: "#6d28d9"), Color(hex: "#b45309")]

    var body: some View {
        if !entry.connected {
            NotConnectedView(title: "Importants", symbol: "envelope")
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label("Importants", systemImage: "envelope").font(.system(size: 14, weight: .semibold))
                    Spacer()
                    Text("\(entry.payload.important.count) non lu\(entry.payload.important.count > 1 ? "s" : "")")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                }
                if entry.payload.important.items.isEmpty {
                    Spacer()
                    Text("Rien d'important en attente").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                }
                ForEach(Array(entry.payload.important.items.prefix(3).enumerated()), id: \.element.id) { i, mail in
                    Link(destination: HaikoLink.url(mail.url)) {
                        HStack(spacing: 8) {
                            Text(WidgetFormat.initials(mail.sender))
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
                                .frame(width: 28, height: 28)
                                .background(Circle().fill(avatarColors[i % avatarColors.count]))
                            VStack(alignment: .leading, spacing: 0) {
                                Text(mail.sender).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                                Text(mail.subject).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            Text(WidgetFormat.shortTime(mail.dateValue)).font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .widgetURL(HaikoLink.url("/#/mail/inbox"))
        }
    }
}

struct ImportantWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HaikoImportant", provider: HaikoProvider()) { entry in
            ImportantWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
        }
        .configurationDisplayName("Mails importants")
        .description("Les derniers mails importants non lus.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Suivis

struct TrackingWidgetView: View {
    let entry: HaikoEntry

    var body: some View {
        if !entry.connected {
            NotConnectedView(title: "Suivis", symbol: "shippingbox")
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label("Suivis", systemImage: "shippingbox").font(.system(size: 14, weight: .semibold))
                    Spacer()
                    let moved = entry.payload.tracking.moved
                    Text(moved > 0 ? "\(moved) \(moved > 1 ? "ont bougé" : "a bougé")" : "à jour")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                }
                if entry.payload.tracking.items.isEmpty {
                    Spacer()
                    Text("Aucun suivi ouvert").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                }
                ForEach(entry.payload.tracking.items.prefix(3)) { t in
                    Link(destination: HaikoLink.url(t.url)) {
                        HStack(spacing: 8) {
                            Circle().fill(t.moved ? Color(hex: "#f59e0b") : Color.secondary.opacity(0.35)).frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(t.title).font(.system(size: 12, weight: t.moved ? .semibold : .regular)).lineLimit(1)
                                Text(t.lastNews.isEmpty ? t.merchant : t.lastNews)
                                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            if !t.status.isEmpty {
                                Text(t.status).font(.system(size: 9, weight: .semibold)).lineLimit(1)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                                    .frame(maxWidth: 90, alignment: .trailing)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .widgetURL(HaikoLink.url("/#/suivi"))
        }
    }
}

struct TrackingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HaikoTracking", provider: HaikoProvider()) { entry in
            TrackingWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
        }
        .configurationDisplayName("Suivis")
        .description("Les suivis qui ont bougé, avec leur statut.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Ecran de verrouillage

struct NextEventLockView: View {
    @Environment(\.widgetFamily) var family
    let entry: HaikoEntry

    private var next: WidgetEvent? {
        entry.payload.agenda
            .filter { !$0.allDay && $0.endDate > Date() && $0.invitation != "declined" }
            .sorted { $0.startDate < $1.startDate }
            .first
    }

    var body: some View {
        if let ev = next {
            switch family {
            case .accessoryInline:
                Text("\(WidgetFormat.time.string(from: ev.startDate)) \(ev.title)")
            default:
                VStack(alignment: .leading, spacing: 1) {
                    Text(WidgetFormat.time.string(from: ev.startDate)).font(.system(size: 13, weight: .bold))
                    Text(ev.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    if !ev.location.isEmpty {
                        Text(ev.location).font(.system(size: 11)).lineLimit(1).foregroundStyle(.secondary)
                    }
                    if ev.startDate > Date() {
                        Text(ev.startDate, style: .relative).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            Text(family == .accessoryInline ? "Aucun rendez-vous" : "Aucun rendez-vous à venir")
                .font(.system(size: 12))
        }
    }
}

struct NextEventLockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HaikoNextEvent", provider: HaikoProvider()) { entry in
            NextEventLockView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
                .widgetURL(HaikoLink.url("/#/calendar"))
        }
        .configurationDisplayName("Prochain rendez-vous")
        .description("L'heure, le titre et le lieu de votre prochain rendez-vous.")
        .supportedFamilies([.accessoryInline, .accessoryRectangular])
    }
}

struct CounterLockView: View {
    let value: Int
    let symbol: String
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
                Text("\(value)").font(.system(size: 17, weight: .bold)).minimumScaleFactor(0.6)
            }
        }
    }
}

struct ImportantCountWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HaikoImportantCount", provider: HaikoProvider()) { entry in
            CounterLockView(value: entry.payload.important.count, symbol: "envelope.badge")
                .containerBackground(for: .widget) { Color.clear }
                .widgetURL(HaikoLink.url("/#/mail/inbox"))
        }
        .configurationDisplayName("Importants non lus")
        .description("Le nombre de mails importants non lus, sans leur contenu.")
        .supportedFamilies([.accessoryCircular])
    }
}

struct TrackingCountWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HaikoTrackingCount", provider: HaikoProvider()) { entry in
            CounterLockView(value: entry.payload.tracking.moved, symbol: "shippingbox")
                .containerBackground(for: .widget) { Color.clear }
                .widgetURL(HaikoLink.url("/#/suivi"))
        }
        .configurationDisplayName("Suivis qui ont bougé")
        .description("Le nombre de suivis qui ont bougé.")
        .supportedFamilies([.accessoryCircular])
    }
}

@main
struct HaikoWidgetsBundle: WidgetBundle {
    var body: some Widget {
        AgendaWidget()
        ImportantWidget()
        TrackingWidget()
        NextEventLockWidget()
        ImportantCountWidget()
        TrackingCountWidget()
    }
}
