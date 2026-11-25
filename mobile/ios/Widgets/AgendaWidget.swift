import WidgetKit
import SwiftUI
import AppIntents

// Widget Agenda (maquette #db2c) : rangee de 7 jours a toucher, < > pour
// changer de semaine, invitation a repondre avec Accepter / Refuser, puis les
// evenements du jour choisi ; nombre d'evenements reglable (2, 3, 5, 8 en grand).

struct AgendaEntry: TimelineEntry {
    let date: Date
    let payload: WidgetPayload
    let connected: Bool
    let selectedDay: Date
    let weekOffset: Int
    let maxEvents: Int
}

struct AgendaProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> AgendaEntry {
        AgendaEntry(date: Date(), payload: .empty, connected: true, selectedDay: Date(), weekOffset: 0, maxEvents: 3)
    }

    func snapshot(for configuration: AgendaConfigIntent, in context: Context) async -> AgendaEntry {
        await entry(configuration, context)
    }

    func timeline(for configuration: AgendaConfigIntent, in context: Context) async -> Timeline<AgendaEntry> {
        Timeline(entries: [await entry(configuration, context)], policy: .after(WidgetLoader.nextRefresh))
    }

    private func entry(_ configuration: AgendaConfigIntent, _ context: Context) async -> AgendaEntry {
        let week = AgendaState.weekOffset
        let (payload, connected) = await WidgetLoader.load(weekOffset: week)
        var n = configuration.count.rawValue
        if context.family != .systemLarge { n = min(n, 3) } // 8 reserve au grand format
        return AgendaEntry(date: Date(), payload: payload, connected: connected,
                           selectedDay: AgendaState.selectedDay, weekOffset: week, maxEvents: n)
    }
}

struct AgendaWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: AgendaEntry

    private var cal: Calendar { AgendaState.calendar }
    private var weekDays: [Date] {
        let start = AgendaState.weekStart(offset: entry.weekOffset)
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: start) }
    }

    private func events(on day: Date) -> [WidgetEvent] {
        guard let next = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: day)) else { return [] }
        let dayStart = cal.startOfDay(for: day)
        return entry.payload.agenda
            .filter { $0.startDate < next && $0.endDate > dayStart }
            .sorted { $0.startDate < $1.startDate }
    }

    /// Prochaine invitation a repondre (a venir).
    private var pendingInvitation: WidgetEvent? {
        entry.payload.agenda
            .filter { $0.isPendingInvitation && $0.endDate > Date() }
            .sorted { $0.startDate < $1.startDate }
            .first
    }

    var body: some View {
        if !entry.connected {
            NotConnectedView(title: "Agenda", symbol: "calendar")
        } else {
            VStack(alignment: .leading, spacing: family == .systemLarge ? 10 : 6) {
                header
                dayRow
                let invitation = pendingInvitation
                if let invitation, family == .systemLarge || events(on: entry.selectedDay).isEmpty {
                    InvitationCard(event: invitation)
                }
                dayList(skipping: family == .systemLarge ? invitation?.id : nil)
                Spacer(minLength: 0)
            }
        }
    }

    private var header: some View {
        HStack {
            Label("Agenda", systemImage: "calendar")
                .font(.system(size: 14, weight: .semibold))
                .labelStyle(.titleAndIcon)
            Spacer()
            Text(WidgetFormat.month.string(from: entry.selectedDay))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }

    private var dayRow: some View {
        HStack(spacing: 0) {
            Button(intent: ShiftWeekIntent(delta: -1)) {
                Image(systemName: "chevron.left").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .frame(width: 16, height: 30)
            }.buttonStyle(.plain)
            ForEach(Array(weekDays.enumerated()), id: \.offset) { index, day in
                let selected = cal.isDate(day, inSameDayAs: entry.selectedDay)
                let hasEvents = !events(on: day).isEmpty
                Button(intent: SelectDayIntent(day: day)) {
                    VStack(spacing: 2) {
                        Text(WidgetFormat.weekdayLetters[index])
                            .font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                        Text("\(cal.component(.day, from: day))")
                            .font(.system(size: 13, weight: selected ? .bold : .semibold))
                            .foregroundStyle(selected ? Color(uiColor: .systemBackground) : Color.primary)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(selected ? Color.primary : Color.clear))
                        Circle().fill(hasEvents ? Color.primary : Color.clear).frame(width: 3, height: 3)
                    }
                    .frame(maxWidth: .infinity)
                }.buttonStyle(.plain)
            }
            Button(intent: ShiftWeekIntent(delta: 1)) {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .frame(width: 16, height: 30)
            }.buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func dayList(skipping skipId: String?) -> some View {
        let list = events(on: entry.selectedDay).filter { $0.id != skipId }
        let shown = Array(list.prefix(entry.maxEvents))
        VStack(alignment: .leading, spacing: 4) {
            if family == .systemLarge {
                Text(dayTitle(entry.selectedDay).uppercased())
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
            if shown.isEmpty {
                Text("Aucun événement").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(shown) { ev in
                Link(destination: HaikoLink.url("/#/calendar")) { EventRow(event: ev, showCountdown: ev.id == nextUpcomingId) }
            }
            if list.count > shown.count {
                let more = list.count - shown.count
                Text("+ \(more) autre\(more > 1 ? "s" : "") événement\(more > 1 ? "s" : "")")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }

    private var nextUpcomingId: String? {
        entry.payload.agenda.filter { $0.startDate > Date() && !$0.allDay }.sorted { $0.startDate < $1.startDate }.first?.id
    }

    private func dayTitle(_ d: Date) -> String {
        let base = WidgetFormat.dayTitle.string(from: d)
        return cal.isDateInToday(d) ? "Aujourd'hui · \(base)" : base
    }
}

struct EventRow: View {
    let event: WidgetEvent
    let showCountdown: Bool

    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color(hex: event.color))
                .frame(width: 3, height: 16)
                .overlay {
                    if event.invitation == "needs_action" || event.invitation == "tentative" {
                        RoundedRectangle(cornerRadius: 1.5).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                            .foregroundStyle(Color(hex: event.color))
                    }
                }
            Text(event.allDay ? "Jour" : WidgetFormat.time.string(from: event.startDate))
                .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                .frame(width: 38, alignment: .leading)
            Text(event.title).font(.system(size: 12)).lineLimit(1)
            Spacer(minLength: 4)
            if event.invitation == "accepted" {
                Text("accepté").font(.system(size: 10)).foregroundStyle(.secondary)
            } else if event.invitation == "needs_action" {
                Text("à répondre").font(.system(size: 10)).foregroundStyle(.secondary)
            } else if showCountdown {
                Text(event.startDate, style: .relative)
                    .font(.system(size: 10)).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                    .frame(maxWidth: 70, alignment: .trailing)
            }
        }
    }
}

struct InvitationCard: View {
    let event: WidgetEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("INVITATION · \(WidgetFormat.invitation.string(from: event.startDate))")
                .font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 6) {
                Text(event.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 2)
                Button(intent: RespondInvitationIntent(eventId: event.id, response: "accepted")) {
                    Text("Accepter").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color(uiColor: .systemBackground))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(Color.primary))
                }.buttonStyle(.plain)
                Button(intent: RespondInvitationIntent(eventId: event.id, response: "declined")) {
                    Text("Refuser").font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .overlay(Capsule().stroke(Color.secondary.opacity(0.4)))
                }.buttonStyle(.plain)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.12)))
    }
}

struct NotConnectedView: View {
    let title: String
    let symbol: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol).font(.system(size: 14, weight: .semibold))
            Spacer()
            Text("Ouvrez iMiel et connectez-vous pour afficher vos données.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(HaikoLink.url("/"))
    }
}

struct AgendaWidget: Widget {
    let kind = "HaikoAgenda"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: AgendaConfigIntent.self, provider: AgendaProvider()) { entry in
            AgendaWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
        }
        .configurationDisplayName("Agenda")
        .description("Vos rendez-vous, jour par jour, et les invitations à accepter.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
