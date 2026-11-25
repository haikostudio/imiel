"use client";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils/avatar";

// Favicon du domaine de l'expediteur/contact via notre proxy serveur (reduit le
// sous-domaine d'envoi au domaine de marque, rejette le globe generique, 404 a
// corps VIDE en cas de miss -> Radix retombe sur l'initiale coloree). Voir
// app/api/favicon/route.ts.
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

interface ContactAvatarProps extends React.ComponentProps<typeof Avatar> {
  name?: string;
  email?: string;
  /** Taille + forme appliquees a la racine (defaut : rond size-8). */
  className?: string;
  /** Taille du texte de repli (initiales). */
  textClassName?: string;
  /** Forme : rond (contacts) ou carre arrondi facon chip logo (listes mail). */
  rounded?: "full" | "md";
  /** Couleur de repli forcee (sinon derivee de l'email). */
  fallbackColor?: string;
}

/**
 * Avatar d'un contact / expediteur : FAVICON du domaine en image principale,
 * repli sur les initiales colorees. Contrairement a `SenderAvatar`, PAS de badge
 * de type de mail : reserve aux en-tetes, carnets de contacts et suggestions.
 */
export function ContactAvatar({
  name,
  email = "",
  className,
  textClassName,
  rounded = "full",
  fallbackColor,
  ...rest
}: ContactAvatarProps) {
  const domain = domainOf(email);
  const seed = email || name || "";
  const label = name || email || "";
  // Charte : une personne est toujours ronde ; "md" reste accepte pour les
  // appelants existants mais suit la meme forme (identite = rond).
  const shape = rounded === "md" ? "rounded-full" : "rounded-full";

  return (
    <Avatar className={cn(shape, className)} {...rest}>
      {domain && (
        <AvatarImage
          src={`/api/favicon?domain=${encodeURIComponent(domain)}`}
          alt=""
          className={cn("border border-border bg-white object-contain p-[18%]", shape)}
        />
      )}
      <AvatarFallback
        style={fallbackColor ? { backgroundColor: fallbackColor, color: "white" } : undefined}
        className={cn("bg-muted font-medium text-foreground", shape, textClassName)}
        data-seed={seed}
      >
        {getInitials(label)}
      </AvatarFallback>
    </Avatar>
  );
}
