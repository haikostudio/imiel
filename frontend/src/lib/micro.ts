/**
 * LA SEULE PORTE PAR OU UN MICRO S'OUVRE (reprise de Beluga Build).
 *
 * On ouvre par `ouvrirMicro`, on referme par la PRISE rendue ; la porte tient
 * le registre de ce qui est ouvert. Sur iPhone, arreter les pistes ne suffit
 * pas toujours : tant qu'un AudioContext nourri par le micro reste ouvert, le
 * systeme garde sa session d'enregistrement (repere orange). La prise ferme
 * donc le contexte AVEC le flux : debrancher, fermer le contexte, puis les
 * pistes.
 */

export interface PriseMicro {
  flux: MediaStream;
  /** Confier le contexte audio qui ecoute ce flux : ferme avec lui. */
  brancher(contexte: AudioContext, source: AudioNode): void;
  /** Tout refermer. Rejouable sans risque. */
  fermer(): void;
}

const prises = new Set<PriseMicro>();

/** Nombre de micros ouverts a cet instant. Zero au repos, toujours. */
export function microsOuverts(): number {
  return prises.size;
}

export function fermerTousLesMicros(): void {
  for (const prise of [...prises]) prise.fermer();
}

export async function ouvrirMicro(): Promise<PriseMicro> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("micro indisponible");
  }
  const flux = await navigator.mediaDevices.getUserMedia({ audio: true });

  let ouverte = true;
  let contexte: AudioContext | null = null;
  let source: AudioNode | null = null;

  const fermerLeSon = () => {
    try {
      source?.disconnect();
    } catch {
      // deja debranchee
    }
    source = null;
    const ctx = contexte;
    contexte = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
  };

  const prise: PriseMicro = {
    flux,
    brancher(ctx, src) {
      contexte = ctx;
      source = src;
      if (!ouverte) fermerLeSon();
    },
    fermer() {
      if (!ouverte) return;
      ouverte = false;
      prises.delete(prise);
      fermerLeSon();
      for (const piste of flux.getTracks()) {
        try {
          piste.stop();
        } catch {
          // deja arretee
        }
      }
    },
  };

  prises.add(prise);
  return prise;
}

// QUITTER LA PAGE (ou la passer en arriere-plan) REFERME LE MICRO : la dictee
// n'a pas d'ecoute voulue en arriere-plan.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", fermerTousLesMicros);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") fermerTousLesMicros();
  });
  // Point d'essai pour les controles navigateur (compte des micros ouverts).
  (window as unknown as { haikoEssai?: Record<string, unknown> }).haikoEssai ??= {};
  (window as unknown as { haikoEssai: Record<string, unknown> }).haikoEssai.micros = microsOuverts;
}
