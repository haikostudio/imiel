"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface InfinitePagerProps {
  /** Sens du defilement : mois/annee = vertical, semaine = horizontal. */
  orientation: "vertical" | "horizontal";
  /** Periode active courante (pilotee par le parent : aujourd'hui, deep-link...). */
  value: Date;
  /** Emis quand le scroll fait changer la periode centree (maj du titre + fenetre d'events). */
  onChange: (d: Date) => void;
  /** Decale une date de N periodes (addMonths / addWeeks / addYears). */
  step: (d: Date, n: number) => Date;
  /** Deux dates sont-elles dans la meme periode (isSameMonth / semaine / annee). */
  samePeriod: (a: Date, b: Date) => boolean;
  /** Cle stable d'un panneau. */
  keyOf: (d: Date) => string;
  /** Rendu d'un panneau (la vue mois/semaine/annee pour cette periode). */
  renderPanel: (d: Date) => React.ReactNode;
  /** Nombre de panneaux de chaque cote du centre (fenetre = 2*radius+1). */
  radius?: number;
}

/**
 * Pager a defilement "infini" : empile des panneaux plein ecran (un par
 * periode) dans un conteneur scroll-snap. Le scroll fait passer d'une periode a
 * l'autre (mois suivant, semaine precedente...). Quand on approche d'un bord, la
 * fenetre est reconstruite autour de la periode courante (et on re-scrolle au
 * centre AVANT paint, donc sans saut visible) -> defilement sans fin.
 */
export function InfinitePager({
  orientation,
  value,
  onChange,
  step,
  samePeriod,
  keyOf,
  renderPanel,
  radius = 8,
}: InfinitePagerProps) {
  const horizontal = orientation === "horizontal";
  const containerRef = useRef<HTMLDivElement>(null);
  const centerIdx = radius;

  const build = useCallback(
    (center: Date) => Array.from({ length: radius * 2 + 1 }, (_, i) => step(center, i - radius)),
    [radius, step]
  );

  const [periods, setPeriods] = useState<Date[]>(() => build(value));
  const activeRef = useRef(centerIdx); // index du panneau centre
  const suppressRef = useRef(false); // ignore les events scroll pendant un scroll programmatique
  const recenterRef = useRef(false); // demande de re-centrage apres reconstruction
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null); // debounce reconstruction

  const panelSize = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return horizontal ? el.clientWidth : el.clientHeight;
  }, [horizontal]);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = containerRef.current;
      if (!el) return;
      const size = panelSize();
      if (size <= 0) return;
      suppressRef.current = true;
      if (horizontal) el.scrollLeft = i * size;
      else el.scrollTop = i * size;
      // Libere la suppression apres que l'event scroll programmatique ait passe.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          suppressRef.current = false;
        })
      );
    },
    [horizontal, panelSize]
  );

  // Centrage initial. Si la hauteur du conteneur n'est pas encore resolue
  // (clientHeight = 0 au tout premier layout), on re-tente quelques frames.
  useLayoutEffect(() => {
    activeRef.current = centerIdx;
    let tries = 0;
    const center = () => {
      scrollToIndex(centerIdx);
      if (panelSize() <= 0 && tries++ < 10) requestAnimationFrame(center);
    };
    center();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changement de periode externe (bouton Aujourd'hui, fleches desktop,
  // deep-link) : si ce n'est pas deja la periode active, on reconstruit autour.
  useEffect(() => {
    const active = periods[activeRef.current];
    if (active && samePeriod(active, value)) return;
    activeRef.current = centerIdx;
    recenterRef.current = true;
    setPeriods(build(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Apres une reconstruction (externe ou bord atteint) : re-scroll au centre
  // AVANT le paint pour eviter tout saut visuel.
  useLayoutEffect(() => {
    if (recenterRef.current) {
      recenterRef.current = false;
      scrollToIndex(activeRef.current);
    }
  }, [periods, scrollToIndex]);

  // Re-aligne le panneau actif si le conteneur est redimensionne (rotation...).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      scrollToIndex(activeRef.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToIndex]);

  const handleScroll = useCallback(() => {
    if (suppressRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const size = panelSize();
    if (size <= 0) return;
    const pos = horizontal ? el.scrollLeft : el.scrollTop;
    const idx = Math.round(pos / size);
    // Maj live du titre / fenetre d'events quand la periode centree change.
    if (idx >= 0 && idx < periods.length && idx !== activeRef.current) {
      activeRef.current = idx;
      onChange(periods[idx]);
    }
    // Reconstruction de la fenetre DIFFEREE au repos du scroll (jamais en plein
    // fling, sinon le re-centrage saccaderait) : si on s'est arrete pres d'un
    // bord, on recentre autour de la periode courante -> defilement sans fin.
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => {
      const i = activeRef.current;
      const d = periods[i];
      if (d && (i <= 1 || i >= periods.length - 2)) {
        activeRef.current = centerIdx;
        recenterRef.current = true;
        setPeriods(build(d));
      }
    }, 140);
  }, [horizontal, panelSize, periods, onChange, build, centerIdx]);

  // Nettoyage du timer de reconstruction.
  useEffect(() => () => {
    if (idleRef.current) clearTimeout(idleRef.current);
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={cn(
        "calendar-pager h-full w-full",
        horizontal
          ? "flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
          : "snap-y snap-mandatory overflow-x-hidden overflow-y-auto"
      )}
    >
      {periods.map((d) => (
        <div key={keyOf(d)} className="h-full w-full shrink-0 snap-start">
          {renderPanel(d)}
        </div>
      ))}
    </div>
  );
}
