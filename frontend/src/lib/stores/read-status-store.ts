"use client";

import { create } from "zustand";
import { readReceipts, messages as messagesCollection } from "@/lib/pocketbase";

/**
 * Source unique du statut de LECTURE des mails ENVOYES cote liste/vue
 * d'ensemble (coches facon messagerie).
 *
 * Le drawer "Suivi de lecture" (ThreadView) charge les receipts fil par fil ;
 * ici on veut au contraire un apercu GLOBAL et bon marche pour teinter les
 * lignes de liste sans requete par ligne. On charge donc en UN appel les
 * receipts recents de l'utilisateur et on materialise deux ensembles indexes
 * par id du message ENVOYE (= id de l'enregistrement porteur du pixel) :
 *  - `sentIds`   : un pixel a ete pose (mail suivi) -> coches grises "distribue"
 *  - `openedIds` : au moins une ouverture destinataire -> coches bleues "lu"
 *
 * Les receipts n'existent que pour les mails envoyes DEPUIS l'activation du
 * suivi : le volume reste faible, une fenetre bornee suffit largement.
 *
 * Les ensembles sont indexes par id de record ET par message_id RFC : un mail
 * envoye a soi-meme existe en 2 copies (record Envoyes porteur du pixel + copie
 * recue) qui partagent le meme message_id ; la liste/vue d'ensemble peut
 * afficher l'une ou l'autre -> on matche par les deux cles.
 */

// Plafond : on ne remonte que les receipts recents (les mails anciens n'ont de
// toute facon pas de pixel). Large mais borne pour ne jamais scanner sans fin.
const MAX_RECEIPTS = 2000;

type ReadStatus = "sent" | "opened";

// Au-dela, un rechargement sur navigation vers la liste/vue d'ensemble est
// declenche pour refleter les ouvertures survenues entre-temps.
const STALE_MS = 60_000;

type ReadStatusState = {
  // Indexation par id de record ENVOYE (porteur du pixel).
  sentIds: Set<string>;
  openedIds: Set<string>;
  // Indexation par message_id RFC (matche aussi la copie recue d'un self-send).
  sentRfc: Set<string>;
  openedRfc: Set<string>;
  loaded: boolean;
  loading: boolean;
  lastLoaded: number;
  /** Charge si pas deja fait ou si le cache est perime (>60s). */
  ensureLoaded: () => void;
  /** Recharge depuis PocketBase. */
  refresh: () => Promise<void>;
  /** Statut d'un mail envoye (par id de record et/ou message_id RFC). */
  statusFor: (messageId?: string | null, messageRfc?: string | null) => ReadStatus | null;
};

export const useReadStatus = create<ReadStatusState>((set, get) => ({
  sentIds: new Set<string>(),
  openedIds: new Set<string>(),
  sentRfc: new Set<string>(),
  openedRfc: new Set<string>(),
  loaded: false,
  loading: false,
  lastLoaded: 0,

  ensureLoaded: () => {
    const s = get();
    if (s.loading) return;
    if (s.loaded && Date.now() - s.lastLoaded < STALE_MS) return;
    void s.refresh();
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const items = await readReceipts().getList(1, MAX_RECEIPTS, {
        sort: "-date",
        fields: "message,kind",
        requestKey: "read-status-overview",
      });
      const sentIds = new Set<string>();
      const openedIds = new Set<string>();
      for (const r of items.items) {
        if (!r.message) continue;
        sentIds.add(r.message);
        if (r.kind === "opened") openedIds.add(r.message);
      }

      // Resoudre les message_id RFC des records suivis (une requete bornee) pour
      // matcher aussi les copies dedupliquees (self-send). Best effort.
      const sentRfc = new Set<string>();
      const openedRfc = new Set<string>();
      const ids = [...sentIds];
      if (ids.length > 0) {
        try {
          const orFilter = ids.map((id) => `id = "${id}"`).join(" || ");
          const msgs = await messagesCollection().getFullList({
            filter: `(${orFilter})`,
            fields: "id,message_id",
            requestKey: "read-status-rfc",
          });
          for (const m of msgs) {
            if (!m.message_id) continue;
            sentRfc.add(m.message_id);
            if (openedIds.has(m.id)) openedRfc.add(m.message_id);
          }
        } catch {
          /* pas de RFC : on garde le match par id de record */
        }
      }

      set({
        sentIds,
        openedIds,
        sentRfc,
        openedRfc,
        loaded: true,
        loading: false,
        lastLoaded: Date.now(),
      });
    } catch {
      // collection absente / non authentifie : etat vide, on retentera plus tard
      set({ loading: false });
    }
  },

  statusFor: (messageId, messageRfc) => {
    const s = get();
    if (messageId) {
      if (s.openedIds.has(messageId)) return "opened";
      if (s.sentIds.has(messageId)) return "sent";
    }
    if (messageRfc) {
      if (s.openedRfc.has(messageRfc)) return "opened";
      if (s.sentRfc.has(messageRfc)) return "sent";
    }
    return null;
  },
}));
