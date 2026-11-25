/**
 * Extrait les initiales d'un nom (2 caractères max).
 * - "Jean Dupont" -> "JD"
 * - "alice@example.com" -> "AL"
 * - "" -> "?"
 */
export function getInitials(name: string | undefined | null): string {
  if (!name || !name.trim()) return "?";

  // Si c'est un email, prendre les 2 premières lettres avant le @
  if (name.includes("@")) {
    const local = name.split("@")[0];
    return local.slice(0, 2).toUpperCase();
  }

  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Génère une couleur HSL déterministe à partir d'un email.
 * Même email = même couleur, toujours.
 */
export function getAvatarColor(email: string | undefined | null): string {
  if (!email) return "hsl(0, 0%, 65%)";
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // Conversion en 32-bit integer
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}
