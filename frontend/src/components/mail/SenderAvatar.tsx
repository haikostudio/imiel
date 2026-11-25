"use client";

import {
  PenLine,
  Clock,
  ShieldAlert,
  Trash2,
  Inbox,
  Archive,
  Folder,
  Check,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils/avatar";

// Favicon de l'expediteur via notre proxy serveur (reduit le sous-domaine
// d'envoi au domaine de marque, rejette le globe generique, renvoie un 404 a
// corps VIDE en cas de miss -> Radix retombe proprement sur l'initiale coloree).
// Voir app/api/favicon/route.ts.
function faviconUrl(domain: string): string {
  return `/api/favicon?domain=${encodeURIComponent(domain)}`;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

interface TypeBadge {
  Icon: LucideIcon;
  className: string;
  label: string;
}

// Petit rond en haut a droite = TYPE du mail (une seule icone, par priorite).
// En vue multi-dossiers (folderType fourni) on montre le dossier ; sinon on
// retombe sur l'etat lu / non lu.
function typeBadge(state: SenderAvatarState): TypeBadge | null {
  const ft = state.folderType;
  if (ft === "spam" || state.isSpam)
    return { Icon: ShieldAlert, className: "bg-red-500 text-white", label: "Spam" };
  if (state.isScheduled)
    return { Icon: Clock, className: "bg-primary text-primary-foreground", label: "Programme" };
  if (ft === "drafts" || state.isDraft)
    return { Icon: PenLine, className: "bg-primary text-primary-foreground", label: "Brouillon" };
  if (ft === "trash")
    return { Icon: Trash2, className: "bg-muted text-muted-foreground", label: "Corbeille" };
  if (ft === "archive")
    return { Icon: Archive, className: "bg-muted text-muted-foreground", label: "Archive" };
  if (ft === "inbox")
    return { Icon: Inbox, className: "bg-muted text-muted-foreground", label: "Boite de reception" };
  if (ft === "custom")
    return { Icon: Folder, className: "bg-muted text-muted-foreground", label: "Dossier" };
  // Lu / non lu : plus de pastille sur l'avatar, la ligne porte le point noir
  // de non-lu (charte des maquettes).
  return null;
}

export interface SenderAvatarState {
  /** Type de dossier (inbox|sent|drafts|trash|spam|archive|custom) en vue multi-dossiers. */
  folderType?: string;
  isSpam?: boolean;
  isScheduled?: boolean;
  isDraft?: boolean;
  isUnread?: boolean;
}

interface SenderAvatarProps extends SenderAvatarState {
  name: string;
  email: string;
  size?: "default" | "sm" | "lg";
  className?: string;
  /** Ligne cochee : le favicon laisse place a une coche (selection). */
  checked?: boolean;
  /** Si fourni, un clic sur l'avatar declenche ce callback (ex: cocher la ligne). */
  onClick?: () => void;
}

/**
 * Avatar d'un expediteur dans la liste des mails :
 * - image principale = FAVICON du domaine de l'expediteur (repli initiales
 *   colorees si aucune icone) ;
 * - petit rond en haut a droite = icone du TYPE de mail (dossier en vue
 *   multi-dossiers, sinon lu / non lu / brouillon / spam).
 *
 * Le badge est un FRERE de l'Avatar (dont la racine est `overflow-hidden`) pour
 * ne pas etre rogne : il deborde volontairement le coin haut-droit.
 */
// Diametre par taille : "default" = ligne confortable/spacieuse, "sm" = ligne
// compacte (une seule ligne de texte), "lg" = en-tete.
const AVATAR_SIZE = { default: "size-10", sm: "size-6", lg: "size-12" } as const;

// Un rond d'avatar : favicon du domaine, repli initiales.
function AvatarFace({
  name,
  email,
  size,
  className,
  textClassName,
  initials,
}: {
  name: string;
  email: string;
  size: "default" | "sm" | "lg";
  className: string;
  textClassName: string;
  initials?: string;
}) {
  const domain = domainOf(email);
  return (
    <Avatar
      data-ref="message-row-avatar"
      size={size}
      className={cn(className, "rounded-full")}
      data-seed={email || name}
    >
      {domain && (
        <AvatarImage
          src={faviconUrl(domain)}
          alt=""
          className="rounded-full border border-border bg-white object-contain p-[20%]"
        />
      )}
      <AvatarFallback className={cn("rounded-full bg-muted font-medium text-foreground", textClassName)}>
        {initials ?? getInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

function CheckOverlay({ size }: { size: "default" | "sm" | "lg" }) {
  // Coche de selection : overlay simple (pas via AvatarFallback dont le
  // statut de chargement Radix reste "loaded" -> carre vide sans remount).
  return (
    <span
      aria-hidden="true"
      className="bg-primary text-primary-foreground absolute inset-0 z-20 flex items-center justify-center rounded-full"
    >
      <Check className={size === "sm" ? "size-3" : "size-4"} strokeWidth={3} />
    </span>
  );
}

function TypeBadgeDot({ badge, size }: { badge: TypeBadge; size: "default" | "sm" | "lg" }) {
  return (
    <span
      aria-label={badge.label}
      title={badge.label}
      className={cn(
        "absolute z-10 inline-flex items-center justify-center rounded-full ring-2 ring-background",
        size === "sm" ? "-top-0.5 -right-0.5 size-2.5 [&>svg]:size-1.5" : "-top-1 -right-1 size-3.5 [&>svg]:size-2.5",
        badge.className
      )}
    >
      <badge.Icon strokeWidth={2.5} />
    </span>
  );
}

export function SenderAvatar({
  name,
  email,
  size = "default",
  className,
  checked = false,
  onClick,
  ...state
}: SenderAvatarProps) {
  const badge = typeBadge(state);

  return (
    <div
      className={cn("relative shrink-0 self-center", onClick && "cursor-pointer", className)}
      data-ref="sender-avatar"
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
    >
      <AvatarFace
        name={name}
        email={email}
        size={size}
        className={AVATAR_SIZE[size]}
        textClassName={size === "sm" ? "text-[10px]" : "text-sm"}
      />
      {checked && <CheckOverlay size={size} />}
      {!checked && badge && <TypeBadgeDot badge={badge} size={size} />}
    </div>
  );
}

// Diametre des deux ronds d'un avatar double : la BOITE exterieure reste celle
// de l'avatar simple (AVATAR_SIZE) pour que le texte des lignes reste aligne.
const PAIR_FACE_SIZE = { default: "size-7", sm: "size-4", lg: "size-8" } as const;

interface SenderAvatarPairProps extends SenderAvatarState {
  people: { name: string; address: string }[];
  size?: "default" | "sm" | "lg";
  className?: string;
  checked?: boolean;
  onClick?: () => void;
}

/**
 * Avatar d'une ligne regroupee : les deux interlocuteurs principaux en deux
 * ronds qui se chevauchent (le second en bas a droite), dans le MEME
 * encombrement que l'avatar simple. Une seule personne -> avatar simple.
 */
export function SenderAvatarPair({
  people,
  size = "default",
  className,
  checked = false,
  onClick,
  ...state
}: SenderAvatarPairProps) {
  const [first, second] = people;
  if (!second) {
    return (
      <SenderAvatar
        name={first?.name || ""}
        email={first?.address || ""}
        size={size}
        className={className}
        checked={checked}
        onClick={onClick}
        {...state}
      />
    );
  }
  const badge = typeBadge(state);
  const face = PAIR_FACE_SIZE[size];
  // En compact les ronds font 16 px : une seule initiale reste lisible.
  const initialsOf = (name: string) => (size === "sm" ? getInitials(name).slice(0, 1) : getInitials(name));
  const textClassName = size === "sm" ? "text-[8px]" : "text-[11px]";

  return (
    <div
      className={cn("relative shrink-0 self-center", AVATAR_SIZE[size], onClick && "cursor-pointer", className)}
      data-ref="sender-avatar"
      data-pair="true"
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
    >
      <AvatarFace
        name={first.name}
        email={first.address}
        // Taille "default" pour l'Avatar de base : ses variantes data-[size]
        // primeraient sur le diametre reduit des ronds.
        size="default"
        className={cn(face, "absolute top-0 left-0")}
        textClassName={textClassName}
        initials={initialsOf(first.name)}
      />
      <AvatarFace
        name={second.name}
        email={second.address}
        // Taille "default" pour l'Avatar de base : ses variantes data-[size]
        // primeraient sur le diametre reduit des ronds.
        size="default"
        className={cn(face, "absolute right-0 bottom-0 z-[1] ring-2 ring-background")}
        textClassName={textClassName}
        initials={initialsOf(second.name)}
      />
      {checked && <CheckOverlay size={size} />}
      {!checked && badge && <TypeBadgeDot badge={badge} size={size} />}
    </div>
  );
}
