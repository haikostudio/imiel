"use client";

import { useIaDisponible } from "@/lib/ai-settings";
import { Bot } from "lucide-react";
import { useMailStore } from "@/lib/stores/mail-store";
import { useT } from "@/lib/i18n";

/**
 * Apparence Miel, ordinateur : l'assistant IA quitte la barre du haut (retiree)
 * et devient un rond OPAQUE flottant en bas a droite de l'ecran (choix
 * utilisateur). Meme action que l'ancien bouton de la barre ; masque quand le
 * panneau de l'assistant est ouvert (il a sa propre croix et son champ en bas,
 * que le rond recouvrirait). Style : miel.css (`miel-ai-fab`).
 */
export function MielAiFab() {
  const t = useT();
  const iaDispo = useIaDisponible();
  const toggleAiChat = useMailStore((s) => s.toggleAiChat);
  const aiChatOpen = useMailStore((s) => s.aiChatOpen);
  if (aiChatOpen) return null;
  if (!iaDispo) return null;
  return (
    <button
      type="button"
      onClick={toggleAiChat}
      data-ref="miel-ai-fab"
      aria-label={t("aiChat.open")}
      title={t("aiChat.open")}
      className="fixed z-40 hidden items-center justify-center rounded-full transition-transform active:scale-95 md:flex"
    >
      <Bot className="size-6" strokeWidth={1.8} />
    </button>
  );
}
