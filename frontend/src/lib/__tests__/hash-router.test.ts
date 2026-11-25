import { describe, it, expect, beforeEach, vi } from "vitest";
import { hashSetParams } from "@/lib/hash-router";

/**
 * L'ADRESSE porte l'ecran ouvert (boite, dossier, conversation, fiche de
 * suivi, contact). `hashSetParams` est le seul endroit qui l'ecrit :
 * il ne touche JAMAIS au chemin, seulement aux parametres demandes.
 */
describe("hashSetParams", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("ajoute un parametre sans toucher au chemin", () => {
    window.location.hash = "#/suivi";
    hashSetParams({ f: "fiche1" });
    expect(window.location.hash).toBe("#/suivi?f=fiche1");
  });

  it("garde les parametres deja presents", () => {
    window.location.hash = "#/mail/inbox?q=facture";
    hashSetParams({ t: "thread1", m: "msg1" });
    expect(window.location.hash).toContain("/mail/inbox?");
    expect(window.location.hash).toContain("q=facture");
    expect(window.location.hash).toContain("t=thread1");
    expect(window.location.hash).toContain("m=msg1");
  });

  it("retire un parametre avec une valeur nulle", () => {
    window.location.hash = "#/suivi?f=fiche1&x=1";
    hashSetParams({ f: null });
    expect(window.location.hash).toBe("#/suivi?x=1");
  });

  it("retire le point d'interrogation quand il ne reste aucun parametre", () => {
    window.location.hash = "#/suivi?f=fiche1";
    hashSetParams({ f: null });
    expect(window.location.hash).toBe("#/suivi");
  });

  it("remplace l'entree d'historique quand on le demande (pas de nouvelle entree)", () => {
    window.location.hash = "#/mail/inbox";
    const replaceState = vi.spyOn(history, "replaceState");
    hashSetParams({ a: "compte1" }, { replace: true });
    expect(replaceState).toHaveBeenCalled();
    expect(window.location.hash).toBe("#/mail/inbox?a=compte1");
    replaceState.mockRestore();
  });
});
