"use client";

// Execution CLIENT des actions proposees par l'assistant IA, apres clic sur
// Accepter. Tout passe par les chemins deja utilises par l'app, avec l'auth
// PocketBase de l'utilisateur :
//  - brouillon : /api/mail/auto-save (pb.send) puis ouverture dans le compose ;
//  - agenda : worker /calendar/event (propage vers Google si l'agenda l'est) ;
//  - contact : collection contacts ;
//  - suivi : worker /tracking/analyze (cree la fiche) + /tracking/attach.
//  - le reste de l'application (comptes, signatures, etiquettes, dossiers,
//    regles, bloques, newsletters, alertes, contacts, suivis, mails,
//    reglages) : lib/ai-actions-app.ts, memes chemins que les ecrans.
// Chaque action faite est inscrite dans `ai_actions` (historique + annulation
// des creations du jour).
import pb, {
  accounts,
  calendarGroups,
  contacts,
  getCurrentUserId,
  messages,
  trackingItems,
  type Account,
  type CalendarGroup,
  type TrackingItem,
} from "@/lib/pocketbase";
import { useMailStore } from "@/lib/stores/mail-store";
import { clearMailListPageCache } from "@/lib/mail-list-api";
import type {
  AiAction,
  AiActionPayload,
  AiCreatedRef,
  AiEventFields,
  ContactPayload,
  DraftPayload,
  EventCreatePayload,
  EventDeletePayload,
  EventUpdatePayload,
  TrackingPayload,
} from "@/lib/ai-actions-types";
import { APP_UNDOABLE_KINDS, executeAppAction, summarizeAppAction, undoAppRef } from "@/lib/ai-actions-app";
import { scrubSecrets } from "@/lib/ai-actions-fields";

export interface AiActionHistoryRecord {
  id: string;
  kind: AiAction["kind"];
  summary: string;
  payload: AiActionPayload;
  created_refs: AiCreatedRef[] | null;
  status: "done" | "error" | "undone";
  error: string;
  edited: boolean;
  undone_at: string;
  created: string;
}

export interface ExecResult {
  created: AiCreatedRef[];
  label: string;
}

async function worker<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: pb.authStore.token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/worker${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Texte brut -> HTML de l'editeur (un <p> par paragraphe, <br> dans un paragraphe). */
export function textToHtml(text: string): string {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Heure locale "YYYY-MM-DDTHH:mm" / jour "YYYY-MM-DD" -> ISO attendu par le worker. */
function eventToIso(f: AiEventFields): { start: string; end: string } {
  if (f.all_day) {
    // Meme convention que EventForm : minuit UTC, fin EXCLUSIVE (lendemain).
    const [sy, sm, sd] = f.start.slice(0, 10).split("-").map(Number);
    const endDay = (f.end || f.start).slice(0, 10);
    const [ey, em, ed] = endDay.split("-").map(Number);
    return {
      start: new Date(Date.UTC(sy, sm - 1, sd)).toISOString(),
      end: new Date(Date.UTC(ey, em - 1, ed + 1)).toISOString(),
    };
  }
  const start = new Date(f.start);
  let end = f.end ? new Date(f.end) : new Date(start.getTime() + 3600_000);
  if (Number.isNaN(start.getTime())) throw new Error(`date invalide : ${f.start}`);
  if (Number.isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + 3600_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function defaultGroupId(userId: string): Promise<string> {
  const groups = await calendarGroups().getFullList<CalendarGroup>({ filter: `user = "${userId}"`, sort: "created" });
  // Agenda par defaut choisi dans les reglages (Chris, l'agenda principal
  // Google, d'office), sinon "Perso" (seede par la page Agenda), sinon le
  // premier agenda local, sinon le premier tout court.
  const g =
    groups.find((x) => x.is_default) ||
    groups.find((x) => x.name === "Perso") ||
    groups.find((x) => !x.google_calendar_id && x.name !== "Suivi") ||
    groups[0];
  if (g) return g.id;
  const created = await calendarGroups().create<CalendarGroup>({ user: userId, name: "Perso", color: "#3b82f6", is_visible: true });
  return created.id;
}

async function pickAccount(from: string): Promise<Account> {
  const list = await accounts().getFullList<Account>({ sort: "created" });
  const active = list.filter((a) => a.is_active !== false);
  const pool = active.length ? active : list;
  if (pool.length === 0) throw new Error("aucun compte email configure");
  const wanted = from.trim().toLowerCase();
  const byFrom = wanted ? pool.find((a) => a.email.toLowerCase() === wanted) : undefined;
  const defaultId = (pb.authStore.record as { default_account?: string } | null)?.default_account;
  const storeId = useMailStore.getState().activeAccountId;
  return (
    byFrom ||
    pool.find((a) => a.id === defaultId) ||
    pool.find((a) => a.id === storeId) ||
    pool[0]
  );
}

function refreshMail() {
  clearMailListPageCache();
  const st = useMailStore.getState();
  st.invalidateMessages();
  st.invalidateFolders();
}

// --- execution -------------------------------------------------------------

export async function executeAiAction(action: AiAction): Promise<ExecResult> {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("session expiree");

  switch (action.kind) {
    case "draft": {
      const p = action.payload as DraftPayload;
      if (p.to.length === 0) throw new Error("aucun destinataire");
      const account = await pickAccount(p.from);
      const res = await pb.send<{ draft_id: string }>("/api/mail/auto-save", {
        method: "POST",
        body: {
          account_id: account.id,
          to: p.to.map((address) => ({ address })),
          cc: p.cc.map((address) => ({ address })),
          bcc: [],
          subject: p.subject,
          html_body: textToHtml(p.body),
          text_body: p.body,
          in_reply_to: "",
          references: [],
          thread_id: "",
        },
      });
      refreshMail();
      // Ouvre le brouillon pour relecture : il n'est JAMAIS envoye tout seul.
      useMailStore.getState().openCompose("edit", res.draft_id);
      return { created: [{ type: "draft", id: res.draft_id }], label: `Brouillon cree (${account.email})` };
    }

    case "event_create": {
      const p = action.payload as EventCreatePayload;
      const group = await defaultGroupId(userId);
      const created: AiCreatedRef[] = [];
      const errors: string[] = [];
      for (const ev of p.events) {
        try {
          const { start, end } = eventToIso(ev);
          const data = await worker<{ event?: { id: string } }>("/calendar/event", "POST", {
            userId, group, title: ev.title, description: ev.description, location: ev.location, start, end, all_day: ev.all_day,
          });
          if (data?.event?.id) created.push({ type: "event", id: data.event.id });
        } catch (err) {
          errors.push(`${ev.title} : ${(err as Error).message}`);
        }
      }
      if (created.length === 0) throw new Error(errors.join(" ; ") || "aucun evenement cree");
      if (errors.length) throw Object.assign(new Error(`${created.length} cree(s), echec : ${errors.join(" ; ")}`), { created });
      return { created, label: `${created.length} evenement(s) cree(s)` };
    }

    case "event_update": {
      const p = action.payload as EventUpdatePayload;
      let n = 0;
      const errors: string[] = [];
      for (const c of p.changes) {
        try {
          const { start, end } = eventToIso(c.after);
          await worker(`/calendar/event/${c.id}`, "PATCH", {
            title: c.after.title, description: c.after.description, location: c.after.location, start, end, all_day: c.after.all_day,
          });
          n++;
        } catch (err) {
          errors.push(`${c.after.title} : ${(err as Error).message}`);
        }
      }
      if (errors.length) throw new Error(`${n} modifie(s), echec : ${errors.join(" ; ")}`);
      return { created: [], label: `${n} evenement(s) modifie(s)` };
    }

    case "event_delete": {
      const p = action.payload as EventDeletePayload;
      let n = 0;
      const errors: string[] = [];
      for (const ev of p.events) {
        try {
          await worker(`/calendar/event/${ev.id}`, "DELETE");
          n++;
        } catch (err) {
          errors.push(`${ev.title} : ${(err as Error).message}`);
        }
      }
      if (errors.length) throw new Error(`${n} supprime(s), echec : ${errors.join(" ; ")}`);
      return { created: [], label: `${n} evenement(s) supprime(s)` };
    }

    case "contact_create": {
      const p = action.payload as ContactPayload;
      if (!p.email) throw new Error("adresse email requise");
      const existing = await contacts()
        .getFirstListItem(`user = "${userId}" && email = "${p.email.replace(/"/g, "")}"`)
        .catch(() => null);
      if (existing) throw new Error(`un contact existe deja pour ${p.email}`);
      const rec = await contacts().create({ user: userId, name: p.name, email: p.email, phone: p.phone, company: p.company, message_count: 0 });
      return { created: [{ type: "contact", id: rec.id }], label: `Contact cree : ${p.name || p.email}` };
    }

    case "tracking_create": {
      const p = action.payload as TrackingPayload;
      if (p.emails.length === 0) throw new Error("aucun email a rattacher");
      const anchor = p.emails[0];
      const anchorMsg = await messages().getOne(anchor.id, { fields: "id,thread_id" });
      await worker("/tracking/analyze", "POST", { messageId: anchor.id });
      const thread = anchorMsg.thread_id;
      const item = await trackingItems().getFirstListItem<TrackingItem>(
        `user = "${userId}" && archived = false && (thread_id = "${thread}" || thread_ids ~ "${thread}")`,
        { sort: "-updated" }
      );
      const others = p.emails.filter((e) => e.thread_id !== thread).map((e) => e.id);
      if (others.length > 0) {
        await worker("/tracking/attach", "POST", { itemId: item.id, messageIds: others });
      }
      if (p.title.trim()) {
        await trackingItems().update(item.id, { title: p.title.trim() }).catch(() => {});
      }
      return {
        created: [{ type: "tracking", id: item.id, messageId: anchor.id }],
        label: `Suivi cree : ${p.title || item.title} (${p.emails.length} email(s))`,
      };
    }
  }
  const app = await executeAppAction(action);
  if (app) return app;
  throw new Error("action inconnue");
}

// --- historique ------------------------------------------------------------

export function summarizeAction(action: AiAction): string {
  const p = action.payload;
  switch (action.kind) {
    case "draft": {
      const d = p as DraftPayload;
      return `Brouillon a ${d.to.join(", ")} : ${d.subject}`;
    }
    case "event_create":
      return `Creation : ${(p as EventCreatePayload).events.map((e) => e.title).join(", ")}`;
    case "event_update":
      return `Modification : ${(p as EventUpdatePayload).changes.map((c) => c.after.title).join(", ")}`;
    case "event_delete":
      return `Suppression : ${(p as EventDeletePayload).events.map((e) => e.title).join(", ")}`;
    case "contact_create": {
      const c = p as ContactPayload;
      return `Contact : ${c.name ? `${c.name} <${c.email}>` : c.email}`;
    }
    case "tracking_create":
      return `Suivi : ${(p as TrackingPayload).title}`;
  }
  return summarizeAppAction(action) ?? action.kind;
}

export async function recordAiAction(
  action: AiAction,
  outcome: { created: AiCreatedRef[]; error?: string }
): Promise<string | undefined> {
  const userId = getCurrentUserId();
  if (!userId) return undefined;
  try {
    const rec = await pb.collection("ai_actions").create({
      user: userId,
      kind: action.kind,
      summary: summarizeAction(action).slice(0, 500),
      // Jamais de mot de passe dans l'historique.
      payload: scrubSecrets(action.kind, action.payload),
      created_refs: outcome.created,
      status: outcome.error && outcome.created.length === 0 ? "error" : "done",
      error: (outcome.error || "").slice(0, 2000),
      edited: !!action.edited,
    });
    return rec.id;
  } catch {
    // Historique best effort : l'action elle-meme a deja eu lieu.
    return undefined;
  }
}

export async function listAiActionHistory(): Promise<AiActionHistoryRecord[]> {
  const res = await pb.collection("ai_actions").getList<AiActionHistoryRecord>(1, 100, { sort: "-created" });
  return res.items;
}

/** Une creation n'est annulable que le jour meme (fuseau de l'appareil). */
export function isUndoable(rec: AiActionHistoryRecord): boolean {
  if (rec.status === "undone") return false;
  if (!rec.created_refs || rec.created_refs.length === 0) return false;
  if (!["draft", "event_create", "contact_create", "tracking_create", ...APP_UNDOABLE_KINDS].includes(rec.kind)) return false;
  const created = new Date(rec.created.replace(" ", "T"));
  return created.toDateString() === new Date().toDateString();
}

async function undoRef(ref: AiCreatedRef): Promise<void> {
  switch (ref.type) {
    case "draft":
      await pb.send(`/api/mail/draft/${ref.id}`, { method: "DELETE" });
      refreshMail();
      return;
    case "event":
      await worker(`/calendar/event/${ref.id}`, "DELETE");
      return;
    case "contact":
      await contacts().delete(ref.id);
      return;
    case "tracking":
      // Ne plus suivre (nettoie agenda + propositions), puis efface la fiche.
      if (ref.messageId) await worker("/tracking/untrack", "POST", { messageId: ref.messageId }).catch(() => {});
      await trackingItems().delete(ref.id).catch(async () => {
        await trackingItems().update(ref.id, { archived: true });
      });
      return;
  }
  if (!(await undoAppRef(ref))) throw new Error(`annulation inconnue : ${ref.type}`);
}

export async function undoAiAction(rec: AiActionHistoryRecord): Promise<void> {
  if (!isUndoable(rec)) throw new Error("cette action ne peut plus etre annulee");
  const errors: string[] = [];
  for (const ref of rec.created_refs || []) {
    try {
      await undoRef(ref);
    } catch (err) {
      // Deja supprime a la main : l'annulation est acquise.
      const status = (err as { status?: number }).status;
      if (status !== 404) errors.push((err as Error).message);
    }
  }
  if (errors.length) throw new Error(errors.join(" ; "));
  await pb.collection("ai_actions").update(rec.id, { status: "undone", undone_at: new Date().toISOString() });
}
