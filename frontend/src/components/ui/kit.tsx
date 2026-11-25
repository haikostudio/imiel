"use client";

/**
 * Bibliotheque de pieces visuelles de la charte (maquettes 2026-10).
 *
 * UNE seule source pour toute l'application : barre d'ecran, champ de
 * recherche, pastilles de filtre, carte de section, ligne de liste, ligne
 * d'information, pastille de date, pastilles d'etat, barre d'action du bas et
 * pastille d'identite. Aucun ecran ne redessine sa propre variante : il
 * consomme ces pieces. Toutes les couleurs viennent des jetons (globals.css),
 * le mode sombre suit donc sans rien ajouter.
 */

import * as React from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils/avatar";

// ------------------------------------------------------------------ Identite

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : email.trim().toLowerCase();
}

const ENTITY_SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-9 text-sm",
  lg: "size-11 text-base",
  xl: "size-12 text-lg",
} as const;

export type EntitySize = keyof typeof ENTITY_SIZES;

export interface EntityAvatarProps {
  /** Nom affiche (initiales de repli). */
  name?: string;
  /** Adresse (le domaine donne le logo). */
  email?: string;
  /** Domaine direct (prime sur l'adresse). */
  domain?: string;
  /** Personne = rond ; dossier (suivi, affaire) = carre arrondi. */
  shape?: "person" | "folder";
  size?: EntitySize;
  className?: string;
  "data-ref"?: string;
}

/**
 * Pastille d'identite : LOGO du domaine (via le proxy /api/favicon, qui rend
 * un 404 vide en cas d'absence -> repli propre) sur fond blanc borde, sinon
 * initiales sur la surface grise. Une personne est toujours ronde, un dossier
 * toujours un carre aux coins arrondis.
 */
export function EntityAvatar({
  name = "",
  email = "",
  domain,
  shape = "person",
  size = "lg",
  className,
  ...rest
}: EntityAvatarProps) {
  const d = domain ? domainOf(domain) : email ? domainOf(email) : "";
  const shapeClass = shape === "folder" ? "rounded-[30%]" : "rounded-full";
  return (
    <Avatar
      data-ref={rest["data-ref"]}
      className={cn(ENTITY_SIZES[size], shapeClass, "shrink-0", className)}
    >
      {d && (
        <AvatarImage
          src={`/api/favicon?domain=${encodeURIComponent(d)}`}
          alt=""
          className={cn(
            "object-contain p-[20%]",
            shape === "folder"
              ? "bg-muted dark:bg-white"
              : "border border-border bg-white",
            shapeClass
          )}
        />
      )}
      <AvatarFallback
        className={cn(
          "bg-muted font-medium text-foreground",
          shapeClass
        )}
      >
        {getInitials(name || email || "?")}
      </AvatarFallback>
    </Avatar>
  );
}

// ------------------------------------------------------------------ Boutons

/** Bouton rond sur surface grise (menu "...", retour, actions d'en-tete). */
export function IconCircleButton({
  className,
  children,
  plain = false,
  ...props
}: React.ComponentProps<"button"> & { plain?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg:not([class*='size-'])]:size-5",
        plain ? "hover:bg-accent active:bg-accent" : "bg-muted hover:bg-accent/70 active:opacity-80",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Recherche

interface SearchFieldBase {
  placeholder?: string;
  className?: string;
  "data-ref"?: string;
}

type SearchFieldProps =
  | (SearchFieldBase & {
      /** Champ en lecture seule : un tap ouvre la recherche globale. */
      onActivate: () => void;
      value?: undefined;
      onValueChange?: undefined;
    })
  | (SearchFieldBase & {
      onActivate?: undefined;
      value: string;
      onValueChange: (value: string) => void;
      autoFocus?: boolean;
    });

/** Champ de recherche en pilule grise avec loupe. */
export function SearchField(props: SearchFieldProps) {
  const base =
    "flex h-11 w-full min-w-0 items-center gap-2.5 rounded-full bg-muted px-4 text-left text-[0.9375rem] text-muted-foreground";
  if (props.onActivate) {
    return (
      <button
        type="button"
        onClick={props.onActivate}
        className={cn(base, "transition-colors hover:bg-accent/80", props.className)}
        data-ref={props["data-ref"]}
        aria-label={props.placeholder}
      >
        <Search className="size-[1.15rem] shrink-0" />
        <span className="min-w-0 flex-1 truncate">{props.placeholder}</span>
      </button>
    );
  }
  return (
    <label className={cn(base, "cursor-text", props.className)} data-ref={props["data-ref"]}>
      <Search className="size-[1.15rem] shrink-0" />
      <input
        type="search"
        value={props.value}
        onChange={(e) => props.onValueChange?.(e.target.value)}
        placeholder={props.placeholder}
        autoFocus={"autoFocus" in props ? props.autoFocus : undefined}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {props.value && (
        <button
          type="button"
          onClick={() => props.onValueChange?.("")}
          className="-mr-1 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Effacer"
        >
          <X className="size-4" />
        </button>
      )}
    </label>
  );
}

// ------------------------------------------------------------------ Pastilles

/** Rangee horizontale de pastilles (defile sans barre). */
export function ChipRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("chip-row flex items-center gap-2 overflow-x-auto", className)}
      {...props}
    />
  );
}

/**
 * Pastille de filtre / d'onglet : active = noir plein, inactive = contour.
 * `count` pose un compteur en pastille, `chevron` signale un menu.
 */
export const Chip = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { active?: boolean; count?: number | null; chevron?: boolean }
>(function Chip({ active = false, count, chevron = false, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[0.85rem] font-medium whitespace-nowrap transition-colors disabled:opacity-50",
        active
          ? "bg-primary text-primary-foreground"
          : "border border-border bg-background text-foreground hover:bg-accent",
        className
      )}
      {...props}
    >
      {children}
      {count != null && count > 0 && (
        <span
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
            active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-foreground"
          )}
        >
          {count > 999 ? "999+" : count}
        </span>
      )}
      {chevron && <ChevronDown className="size-3.5 opacity-70" />}
    </button>
  );
});

/** Bouton carre-arrondi a contour en bout de rangee (reglages). `marked` pose
 * un point quand un reglage non visible est actif. */
export const ChipIconButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { marked?: boolean }
>(function ChipIconButton({ marked = false, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-accent [&_svg:not([class*='size-'])]:size-4",
        marked && "border-foreground",
        className
      )}
      {...props}
    >
      {children}
      {marked && (
        <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-unread" />
      )}
    </button>
  );
});

/** Pastille d'etiquette / de categorie (petite, grise). */
export function TagPill({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-[8.5rem] shrink-0 items-center truncate rounded-md bg-muted px-1.5 text-[11px] leading-none text-muted-foreground",
        className
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Pastille d'etat : contour, noire pleine ou grise. */
export function StatusPill({
  variant = "outline",
  className,
  ...props
}: React.ComponentProps<"span"> & { variant?: "outline" | "solid" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[0.84rem] whitespace-nowrap",
        variant === "solid" && "bg-primary text-primary-foreground",
        variant === "outline" && "border border-border bg-background text-foreground",
        variant === "muted" && "bg-muted text-foreground",
        className
      )}
      {...props}
    />
  );
}

/** Point noir de non-lu. */
export function UnreadDot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full bg-unread", className)}
      {...props}
    />
  );
}

/** Pastille de date centree entre deux filets (separateur de jour). */
export function DatePill({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-center gap-3 py-2", className)}
      data-ref="date-pill"
      {...props}
    >
      <span className="h-px w-12 bg-border" aria-hidden />
      <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        {children}
      </span>
      <span className="h-px w-12 bg-border" aria-hidden />
    </div>
  );
}

// ------------------------------------------------------------------ Cartes

/** Carte blanche aux grands coins, filet tres clair. */
export function Surface({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("overflow-hidden rounded-3xl border border-border bg-card", className)}
      {...props}
    />
  );
}

/** Carte de section : picto + titre (+ compteur) + "Tout voir >". */
export function SectionCard({
  icon: Icon,
  title,
  count,
  onSeeAll,
  seeAllLabel,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  icon?: LucideIcon;
  title: React.ReactNode;
  count?: number | null;
  onSeeAll?: () => void;
  seeAllLabel?: string;
}) {
  return (
    <Surface data-ref="section-card" className={cn("flex flex-col", className)} {...props}>
      <header data-ref="section-card-head" className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        {Icon && <Icon className="size-5 shrink-0" strokeWidth={1.7} />}
        <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
        {count != null && count > 0 && (
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-2 text-xs font-medium tabular-nums">
            {count}
          </span>
        )}
        {onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full py-1 pl-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {seeAllLabel}
            <ChevronRight className="size-4" />
          </button>
        )}
      </header>
      <div className="flex flex-col">{children}</div>
    </Surface>
  );
}

/** Titre de carte simple (ex. "Informations", "Participants"). */
export function SurfaceTitle({
  className,
  count,
  action,
  children,
}: {
  className?: string;
  count?: number | null;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 px-4 pt-3 pb-1.5", className)}>
      <h3 className="text-base font-semibold">{children}</h3>
      {count != null && (
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-2 text-xs font-medium tabular-nums">
          {count}
        </span>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/** Etat vide illustre (picto dans un rond gris + titre + sous-texte). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-5 text-center", className)}>
      <span className="mb-1 inline-flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5" strokeWidth={1.6} />
      </span>
      <p className="text-base text-foreground/80">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Lignes

export interface ListRowProps extends Omit<React.ComponentProps<"div">, "title"> {
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** Haut droite (date, heure). */
  meta?: React.ReactNode;
  /** Deuxieme ligne (sujet, etat). */
  subtitle?: React.ReactNode;
  /** Troisieme ligne grise (apercu, resume). */
  description?: React.ReactNode;
  /** Bas droite (pastille d'etiquette). */
  trailing?: React.ReactNode;
  unread?: boolean;
  chevron?: boolean;
  selected?: boolean;
  /** Titre en gras (non lu) ; sinon graisse moyenne. */
  strong?: boolean;
  descriptionLines?: 1 | 2;
  /** Filet bas (insere entre deux lignes). */
  divider?: boolean;
}

/**
 * Ligne de liste de la charte : pastille d'identite a gauche, titre + date,
 * sous-titre + point non lu, apercu gris + pastille d'etiquette. Utilisee par
 * la vue d'ensemble, le suivi, les newsletters, les contacts...
 */
export function ListRow({
  leading,
  title,
  meta,
  subtitle,
  description,
  trailing,
  unread = false,
  chevron = false,
  selected = false,
  strong,
  descriptionLines = 1,
  divider = true,
  className,
  onClick,
  ...props
}: ListRowProps) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                (e.currentTarget as HTMLElement).click();
              }
            }
          : undefined
      }
      className={cn(
        "group/listrow relative flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none",
        interactive && "cursor-pointer transition-colors hover:bg-accent/60 focus-visible:bg-accent/60",
        selected && "bg-accent",
        divider &&
          "row-divider [--row-divider-inset:1rem] last:after:hidden",
        className
      )}
      {...props}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <div
            className={cn(
              "min-w-0 flex-1 truncate text-[0.9375rem]",
              (strong ?? unread) ? "font-semibold" : "font-medium"
            )}
          >
            {title}
          </div>
          {meta != null && (
            <div className="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</div>
          )}
        </div>
        {(subtitle != null || unread) && (
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-sm text-foreground/85">{subtitle}</div>
            {unread && <UnreadDot data-ref="list-row-unread-dot" />}
          </div>
        )}
        {(description != null || trailing != null) && (
          <div className="flex min-w-0 items-end gap-2">
            <div
              className={cn(
                "min-w-0 flex-1 text-sm text-muted-foreground",
                descriptionLines === 2 ? "line-clamp-2" : "truncate"
              )}
            >
              {description}
            </div>
            {trailing}
          </div>
        )}
      </div>
      {chevron && <ChevronRight className="mt-3 size-4 shrink-0 self-center text-muted-foreground" />}
    </div>
  );
}

/**
 * Ligne d'information : picto (nu ou dans un rond gris), libelle gris, valeur,
 * et a droite un chevron (geste) ou une copie d'un clic. `stacked` : la valeur
 * passe SOUS son libelle, sur toute la largeur (ecrans etroits).
 */
export function InfoRow({
  icon: Icon,
  label,
  value,
  onClick,
  chevron,
  copyValue,
  onCopy,
  iconStyle = "plain",
  mono = false,
  className,
  children,
  divider = true,
  stacked = false,
}: {
  icon?: LucideIcon;
  label: React.ReactNode;
  value?: React.ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  /** Valeur copiee au clic (bouton copier a droite). */
  copyValue?: string;
  onCopy?: (value: string) => void;
  iconStyle?: "plain" | "circle";
  mono?: boolean;
  className?: string;
  children?: React.ReactNode;
  divider?: boolean;
  stacked?: boolean;
}) {
  const labelValue = stacked ? (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[0.84rem] leading-snug text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-sm break-words [overflow-wrap:anywhere]", mono && "font-mono")}>
        {value}
        {children}
      </span>
    </span>
  ) : null;
  const content = (
    <>
      {Icon &&
        (iconStyle === "circle" ? (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-[1.15rem]" strokeWidth={1.7} />
          </span>
        ) : (
          <Icon className="mt-0.5 size-5 shrink-0" strokeWidth={1.6} />
        ))}
      {labelValue ?? (
        <>
          <span
            className={cn(
              "shrink-0 text-[0.84rem] leading-snug text-muted-foreground",
              iconStyle === "circle" ? "w-[30%] pt-2.5" : "w-[38%]"
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 text-sm break-words [overflow-wrap:anywhere]",
              iconStyle === "circle" && "pt-2",
              mono && "font-mono"
            )}
          >
            {value}
            {children}
          </span>
        </>
      )}
      {copyValue && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onCopy?.(copyValue);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onCopy?.(copyValue);
            }
          }}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground",
            iconStyle === "circle" && "mt-1"
          )}
          aria-label="Copier"
        >
          <Copy className="size-4" />
        </span>
      )}
      {(chevron ?? !!onClick) && !copyValue && (
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground", stacked && "self-center")} />
      )}
    </>
  );
  const cls = cn(
    "relative flex w-full gap-3.5 py-3 text-left",
    iconStyle === "circle" || stacked ? "items-start" : "items-center",
    divider && "border-b border-border last:border-b-0",
    onClick && "cursor-pointer transition-colors hover:bg-accent/40",
    className
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {content}
      </button>
    );
  }
  return <div className={cls}>{content}</div>;
}

// ------------------------------------------------------------------ Ecrans

/**
 * En-tete d'un ecran de detail : retour (chevron) ou fermeture (croix) a
 * gauche, titre centre OU bloc identite (pastille + titre + sous-titre), et
 * une action a droite.
 */
export function ScreenHeader({
  leading = "back",
  onLeading,
  leadingLabel,
  title,
  subtitle,
  avatar,
  centered = false,
  trailing,
  onTitleClick,
  className,
  "data-ref": dataRef,
}: {
  leading?: "back" | "close" | "none";
  onLeading?: () => void;
  leadingLabel?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  avatar?: React.ReactNode;
  centered?: boolean;
  trailing?: React.ReactNode;
  onTitleClick?: () => void;
  className?: string;
  "data-ref"?: string;
}) {
  const LeadingIcon = leading === "close" ? X : ChevronLeft;
  const titleBlock = (
    <div className={cn("flex min-w-0 flex-col", centered && "items-center text-center")}>
      <span className="max-w-full truncate text-base leading-tight font-semibold">{title}</span>
      {subtitle && (
        <span className="max-w-full truncate text-sm leading-tight text-muted-foreground">
          {subtitle}
        </span>
      )}
    </div>
  );
  const leadingNode =
    leading !== "none" ? (
      <IconCircleButton
        plain
        onClick={onLeading}
        aria-label={leadingLabel}
        data-drawer-close={leading === "close" ? "" : undefined}
      >
        <LeadingIcon className="size-5" strokeWidth={1.8} />
      </IconCircleButton>
    ) : (
      <span className="w-1" />
    );
  if (centered) {
    // Grille 3 colonnes : le titre reste centre et ne chevauche jamais un
    // bouton de droite large (ex. "Reconstruire la chronologie").
    return (
      <header
        data-ref={dataRef}
        className={cn(
          "grid min-h-12 shrink-0 grid-cols-[1fr_minmax(0,max-content)_1fr] items-center gap-2 border-b border-border bg-background px-2 py-1.5",
          className
        )}
      >
        <div className="flex justify-start">{leadingNode}</div>
        <div className="min-w-0">{titleBlock}</div>
        <div className="flex items-center justify-end gap-1 pr-1">{trailing}</div>
      </header>
    );
  }
  return (
    <header
      data-ref={dataRef}
      className={cn(
        "relative flex min-h-12 shrink-0 items-center gap-2.5 border-b border-border bg-background px-2 py-1.5",
        className
      )}
    >
      {leadingNode}
      {onTitleClick ? (
        <button
          type="button"
          onClick={onTitleClick}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {avatar}
          {titleBlock}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {avatar}
          {titleBlock}
        </div>
      )}
      {trailing && <div className="flex shrink-0 items-center gap-1 pr-1">{trailing}</div>}
    </header>
  );
}

/** Barre d'action epinglee en bas (bouton principal noir + bouton "..."),
 * au-dessus de la barre d'accueil de l'iPhone. */
export function BottomActionBar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-action-bar"
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className
      )}
      {...props}
    />
  );
}

/** Bouton principal pleine largeur (noir), avec picto. */
export function PrimaryAction({
  icon: Icon,
  variant = "solid",
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { icon?: LucideIcon; variant?: "solid" | "outline" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-12 min-w-0 flex-1 items-center justify-center gap-2.5 rounded-2xl text-base font-medium transition-opacity active:opacity-85 disabled:opacity-50",
        variant === "solid"
          ? "bg-primary text-primary-foreground"
          : "border border-border bg-background text-foreground hover:bg-accent",
        className
      )}
      {...props}
    >
      {Icon && <Icon className="size-5" strokeWidth={1.8} />}
      {children}
    </button>
  );
}

/** Bouton carre a contour, compagnon du bouton principal ("..."). */
export function SquareAction({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-background text-foreground transition-colors hover:bg-accent [&_svg:not([class*='size-'])]:size-5",
        className
      )}
      {...props}
    />
  );
}

/** Tuile d'action (Repondre, Transferer...) : picto au-dessus du libelle. */
export function ActionTile({
  icon: Icon,
  label,
  className,
  ...props
}: React.ComponentProps<"button"> & { icon: LucideIcon; label: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-[4.75rem] flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-card px-1 py-2.5 text-center text-xs leading-tight transition-colors hover:bg-accent/60 active:bg-accent",
        className
      )}
      {...props}
    >
      <Icon className="size-5" strokeWidth={1.7} />
      <span>{label}</span>
    </button>
  );
}
