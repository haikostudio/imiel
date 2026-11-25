/**
 * Donnees des widgets de l'application iPhone (agenda, importants, suivis),
 * servies aux routes signees /device/widgets* (cle d'appareil). Lecture seule,
 * toujours bornees a l'utilisateur de la cle. Aucun "marquer lu" ici.
 */
import {
  listAccountsForUser,
  listCalendarGroupsForUser,
  listInboxFolderIds,
  pbAdminFetch,
} from "./pocketbase";

const space = (iso: string) => new Date(iso).toISOString().replace("T", " ");

export interface WidgetEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  color: string;
  invitation: "" | "needs_action" | "accepted" | "declined" | "tentative";
  organizer: string;
}

export async function widgetAgenda(userId: string, fromIso: string, toIso: string): Promise<WidgetEvent[]> {
  const [groups, res] = await Promise.all([
    listCalendarGroupsForUser(userId).catch(() => []),
    pbAdminFetch("/api/collections/calendar_events/records", {
      params: {
        filter: `user="${userId}" && status != "cancelled" && start < "${space(toIso)}" && end > "${space(fromIso)}"`,
        sort: "start",
        perPage: "200",
        fields: "id,group,title,start,end,all_day,location,invitation_status,organizer_name,organizer_email",
      },
    }) as Promise<{ items: Array<Record<string, unknown>> }>,
  ]);
  const colors = new Map(
    (groups as Array<{ id: string; color?: string; is_visible?: boolean }>).map((g) => [g.id, g.color || "#3b82f6"])
  );
  return res.items.map((e) => ({
    id: String(e.id),
    title: String(e.title || ""),
    start: new Date(String(e.start)).toISOString(),
    end: new Date(String(e.end)).toISOString(),
    allDay: !!e.all_day,
    location: String(e.location || ""),
    color: colors.get(String(e.group)) || "#3b82f6",
    invitation: (String(e.invitation_status || "") as WidgetEvent["invitation"]) || "",
    organizer: String(e.organizer_name || e.organizer_email || ""),
  }));
}

export interface WidgetMail {
  id: string;
  threadId: string;
  sender: string;
  senderAddress: string;
  subject: string;
  date: string;
  url: string;
}

/** Derniers mails IMPORTANTS non lus (boites de reception), + leur nombre. */
export async function widgetImportant(userId: string, limit = 10): Promise<{ count: number; items: WidgetMail[] }> {
  const accounts = (await listAccountsForUser(userId)).filter((a) => a.is_active !== false);
  const folderIds = (await Promise.all(accounts.map((a) => listInboxFolderIds(a.id)))).flat();
  if (folderIds.length === 0) return { count: 0, items: [] };
  const pages = await Promise.all(
    folderIds.map(
      (f) =>
        pbAdminFetch("/api/collections/messages/records", {
          params: {
            filter: `folder="${f}" && is_draft=false && is_read=false && importance="important"`,
            sort: "-date",
            perPage: String(limit),
            fields: "id,thread_id,message_id,subject,from_address,date",
          },
        }) as Promise<{ items: Array<Record<string, unknown>>; totalItems: number }>
    )
  );
  // Deux comptes relies recoivent le meme mail : une seule ligne.
  const seen = new Set<string>();
  const all: WidgetMail[] = [];
  for (const p of pages) {
    for (const m of p.items) {
      const key = String(m.message_id || m.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const from = (m.from_address || {}) as { name?: string; address?: string };
      const threadId = String(m.thread_id || "");
      all.push({
        id: String(m.id),
        threadId,
        sender: from.name || from.address || "",
        senderAddress: from.address || "",
        subject: String(m.subject || ""),
        date: new Date(String(m.date)).toISOString(),
        url: threadId
          ? `/#/mail/all?t=${encodeURIComponent(threadId)}&m=${encodeURIComponent(String(m.id))}`
          : "/#/mail/all",
      });
    }
  }
  all.sort((a, b) => (a.date < b.date ? 1 : -1));
  // Total approche (une copie par compte relie peut compter deux fois au-dela
  // de la page) ; jamais moins que ce qui est affiche.
  const total = pages.reduce((n, p) => n + (p.totalItems || 0), 0);
  const duplicates = pages.reduce((n, p) => n + p.items.length, 0) - all.length;
  return { count: Math.max(total - duplicates, all.length), items: all.slice(0, limit) };
}

export interface WidgetTracking {
  id: string;
  title: string;
  merchant: string;
  status: string;
  lastNews: string;
  date: string;
  moved: boolean;
  url: string;
}

/** Suivis ouverts, ceux qui ont bouge (non lus) d'abord. */
export async function widgetTracking(userId: string, limit = 8): Promise<{ moved: number; items: WidgetTracking[] }> {
  const res = (await pbAdminFetch("/api/collections/tracking_items/records", {
    params: {
      filter: `user="${userId}" && archived=false && status != "done" && status != "cancelled"`,
      sort: "is_read,-last_message_date",
      perPage: String(limit),
      fields: "id,title,merchant,status_label,last_message_date,is_read,updated",
    },
  })) as { items: Array<Record<string, unknown>> };
  const movedRes = (await pbAdminFetch("/api/collections/tracking_items/records", {
    params: {
      filter: `user="${userId}" && archived=false && is_read=false && status != "done" && status != "cancelled"`,
      perPage: "1",
      fields: "id",
    },
  }).catch(() => ({ totalItems: 0 }))) as { totalItems?: number };
  const items = res.items.map((t) => ({
    id: String(t.id),
    title: String(t.title || ""),
    merchant: String(t.merchant || ""),
    status: String(t.status_label || ""),
    lastNews: String(t.status_label || ""),
    date: t.last_message_date ? new Date(String(t.last_message_date)).toISOString() : new Date(String(t.updated)).toISOString(),
    moved: !t.is_read,
    url: `/#/suivi?f=${encodeURIComponent(String(t.id))}`,
  }));
  // Derniere nouvelle de la timeline pour les fiches qui ont bouge (4 au plus).
  await Promise.all(
    items
      .filter((i) => i.moved)
      .slice(0, 4)
      .map(async (i) => {
        try {
          const ev = (await pbAdminFetch("/api/collections/tracking_events/records", {
            params: { filter: `item="${i.id}"`, sort: "-date", perPage: "1", fields: "label,detail" },
          })) as { items: Array<{ label?: string; detail?: string }> };
          const e = ev.items[0];
          if (e?.label) i.lastNews = e.label;
        } catch {
          /* derniere nouvelle indisponible : statut seul */
        }
      })
  );
  return { moved: movedRes.totalItems || 0, items };
}
