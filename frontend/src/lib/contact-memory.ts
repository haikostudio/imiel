// Memoire des contacts ("qui est qui") : regles PURES partagees entre l'agent
// de reponse (/api/ai/reply-agent) et l'ecran du contact.
// Le bloc rendu par formatWhoIsWho est donne a l'IA comme information DEJA
// ETABLIE : il fait foi sur toute deduction tiree des mails lies au dossier.

import type { ContactMemory } from "./pocketbase";
import { normAddr, type AddressLike } from "./reply-agent";

export type MemoryLike = Pick<
  ContactMemory,
  "key" | "name" | "role" | "organization" | "relation" | "facts" | "related" | "user_notes" | "addresses"
>;

export interface WhoIsWho {
  me?: MemoryLike | null;
  person?: MemoryLike | null;
  others?: MemoryLike[] | null;
}

function hasContent(m: MemoryLike | null | undefined): m is MemoryLike {
  return !!m && !!(m.role || m.organization || m.relation || m.user_notes || (m.facts || []).length);
}

function describe(m: MemoryLike, max: number): string[] {
  const lines: string[] = [];
  if (m.user_notes?.trim()) lines.push(`  - Note de l'utilisateur (fait foi) : ${m.user_notes.trim()}`);
  if (m.role) lines.push(`  - Role : ${m.role}`);
  if (m.organization) lines.push(`  - Organisation : ${m.organization}`);
  if (m.relation) lines.push(`  - Lien avec MOI : ${m.relation}`);
  for (const f of (m.facts || []).slice(0, max)) lines.push(`  - ${f}`);
  return lines;
}

function who(m: MemoryLike, fallback: string): string {
  const addr = (m.addresses || [])[0] || (m.key !== "me" ? m.key : "");
  return `${m.name || fallback}${addr ? ` <${addr}>` : ""}`;
}

/**
 * Bloc "Qui est qui" pour les prompts. "" quand aucune fiche n'a de contenu.
 * Ordre : MOI, l'interlocuteur (fiche complete), les personnes liees de sa
 * fiche, puis les fiches des autres participants du fil.
 */
export function formatWhoIsWho(w: WhoIsWho, interlocutorLabel: string): string {
  const parts: string[] = [];
  if (hasContent(w.me)) parts.push(["MOI (l'utilisateur, au nom de qui tu ecris) :", ...describe(w.me, 6)].join("\n"));
  const person = w.person;
  if (hasContent(person)) {
    parts.push([`${who(person, interlocutorLabel)} (l'interlocuteur) :`, ...describe(person, 10)].join("\n"));
  }
  const seen = new Set<string>();
  const known = new Map<string, MemoryLike>();
  for (const o of w.others || []) {
    if (!hasContent(o)) continue;
    for (const a of [o.key, ...(o.addresses || [])]) known.set(normAddr(a), o);
  }
  const rel = (person?.related || []).filter((p) => p.name || p.address);
  if (rel.length) {
    const lines = rel.slice(0, 8).map((p) => {
      const key = normAddr(p.address);
      seen.add(key);
      const full = key ? known.get(key) : undefined;
      const extra = full ? describe(full, 4).join("\n") : "";
      return `- ${p.name || p.address}${p.address ? ` <${p.address}>` : ""} : ${p.role || "role inconnu"}${extra ? `\n${extra}` : ""}`;
    });
    parts.push(["Personnes du meme dossier :", ...lines].join("\n"));
  }
  const rest = (w.others || []).filter((o) => hasContent(o) && ![o.key, ...(o.addresses || [])].some((a) => seen.has(normAddr(a))));
  for (const o of rest.slice(0, 5)) parts.push([`${who(o, o.key)} :`, ...describe(o, 4)].join("\n"));
  return parts.join("\n\n");
}

/** Adresses des participants d'une conversation, hors les miennes, sans doublons. */
export function conversationParticipants(
  messages: { from_address?: AddressLike | null; to_addresses?: AddressLike[] | null; cc_addresses?: AddressLike[] | null }[],
  myAddrs: Iterable<string>,
  limit = 20
): string[] {
  const mine = new Set(Array.from(myAddrs, normAddr));
  const out = new Set<string>();
  for (const m of messages) {
    for (const a of [m.from_address, ...(m.to_addresses || []), ...(m.cc_addresses || [])]) {
      const c = normAddr(a?.address);
      if (c && c.includes("@") && !mine.has(c)) out.add(c);
      if (out.size >= limit) return Array.from(out);
    }
  }
  return Array.from(out);
}
