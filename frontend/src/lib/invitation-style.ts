import type { CSSProperties } from "react";

/** Invitation encore sans reponse ferme (a repondre ou "peut-etre"). */
export function isPendingInvitation(ev: { invitation_status?: string }): boolean {
  return ev.invitation_status === "needs_action" || ev.invitation_status === "tentative";
}

/**
 * Barre d'evenement "a repondre" (maquette #4568) : bordure en pointilles de la
 * couleur de l'agenda + hachures pales, texte lisible en clair comme en sombre.
 */
export function pendingInvitationStyle(color: string): CSSProperties {
  return {
    backgroundColor: "var(--background)",
    backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 22%, transparent) 0 4px, transparent 4px 8px)`,
    border: `1.5px dashed ${color}`,
    color: "var(--foreground)",
  };
}
