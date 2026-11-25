"use client";

import { CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { t as tStatic } from "@/lib/i18n";
import { useReadStatus } from "@/lib/stores/read-status-store";

/**
 * Coches de suivi de lecture pour une ligne de liste / vue d'ensemble.
 * S'affiche pour TOUT mail ENVOYE par l'utilisateur (`isSent`), meme sans
 * historique de suivi (mail anterieur au pixel) :
 * - grises  = envoye (etat par defaut de tout mail sortant)
 * - bleues  = lu (au moins une ouverture destinataire enregistree)
 *
 * Le pixel ne sert QU'A detecter le "lu" : son absence laisse les coches
 * grises, elle ne les cache pas.
 *
 * `selectedColored` : la ligne est selectionnee avec la couleur du compte
 * (fond colore) -> on force le blanc pour rester lisible.
 */
export function ReadStatusChecks({
  messageId,
  messageRfc,
  isSent,
  selectedColored,
  className,
}: {
  messageId?: string | null;
  /** message_id RFC (matche la copie recue d'un self-send). */
  messageRfc?: string | null;
  /** Le mail est-il un envoi de l'utilisateur ? (condition d'affichage) */
  isSent?: boolean;
  selectedColored?: boolean;
  className?: string;
}) {
  const opened = useReadStatus(
    (s) =>
      (!!messageId && s.openedIds.has(messageId)) ||
      (!!messageRfc && s.openedRfc.has(messageRfc))
  );
  if (!isSent) return null;
  return (
    <CheckCheck
      data-ref="mail-row-read-status"
      className={cn(
        "size-3.5 shrink-0",
        selectedColored
          ? "text-white/80"
          : opened
            ? "text-foreground"
            : "text-muted-foreground/60",
        className
      )}
      aria-label={opened ? tStatic("readReceipts.opened") : tStatic("readReceipts.sent")}
    >
      <title>{opened ? tStatic("readReceipts.opened") : tStatic("readReceipts.sent")}</title>
    </CheckCheck>
  );
}
