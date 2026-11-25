"use client";

import { useEffect, useState } from "react";
import pb from "@/lib/pocketbase";

/**
 * Images distantes des mails : affichees d'office, mais toujours via le
 * proxy du worker (backend/mail-worker/src/image-proxy.ts), qui verifie le
 * type reel et REDESSINE chaque image avant de la servir. Le navigateur ne
 * contacte jamais l'expediteur (IP, appareil et ouverture caches).
 *
 * Le worker signe les URL (POST /worker/image-proxy/sign, jeton de
 * l'utilisateur) ; l'URL signee est stable une journee et gardee ici en
 * memoire : rouvrir un mail ne redemande rien.
 */

const signed = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
const SIGN_BATCH = 200;

function absolute(path: string): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

/** Adresse proxy d'une image distante deja signee ; null sinon. */
export function proxiedImageSrc(url: string): string | null {
  return signed.get(url) ?? null;
}

async function signBatch(urls: string[]): Promise<void> {
  const res = await fetch("/worker/image-proxy/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: pb.authStore.token },
    body: JSON.stringify({ urls }),
  });
  if (!res.ok) throw new Error(`image-proxy sign ${res.status}`);
  const data = (await res.json()) as { signed?: Record<string, string> };
  for (const [url, path] of Object.entries(data.signed ?? {})) {
    signed.set(url, absolute(path));
  }
}

/** Fait signer les URL encore inconnues (requetes partagees entre composants). */
export async function signImageUrls(urls: string[]): Promise<void> {
  const waits: Promise<void>[] = [];
  const missing: string[] = [];
  for (const u of urls) {
    if (signed.has(u)) continue;
    const p = pending.get(u);
    if (p) waits.push(p);
    else missing.push(u);
  }
  for (let i = 0; i < missing.length; i += SIGN_BATCH) {
    const chunk = missing.slice(i, i + SIGN_BATCH);
    const p = signBatch(chunk).finally(() => {
      for (const u of chunk) pending.delete(u);
    });
    for (const u of chunk) pending.set(u, p);
    waits.push(p);
  }
  await Promise.all(waits);
}

/**
 * Signe les URL donnees et dit quand le corps peut etre rendu. `true` des
 * qu'il n'y a rien a signer ; en cas d'echec, `true` aussi : les images non
 * signees restent alors des cadres neutres (jamais de requete directe).
 */
export function useProxiedImages(urls: string[]): boolean {
  const key = urls.join("\n");
  const allKnown = urls.every((u) => signed.has(u));
  const [doneKey, setDoneKey] = useState<string | null>(allKnown ? key : null);

  useEffect(() => {
    if (urls.every((u) => signed.has(u))) {
      setDoneKey(key);
      return;
    }
    let alive = true;
    signImageUrls(urls)
      .catch(() => { /* cadres neutres */ })
      .finally(() => { if (alive) setDoneKey(key); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return allKnown || doneKey === key;
}
