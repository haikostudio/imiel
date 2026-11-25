/// <reference path="../pb_data/types.d.ts" />

// context_summary : SYNTHESE D'IDENTITE d'une fiche de suivi (le "registre"
// central voulu par l'utilisateur). 1-2 phrases qui disent DE QUOI il s'agit et
// portent les IDENTIFIANTS CONCRETS distinctifs (marchand, produit, numero de
// commande/suivi, montant, transporteur, adresse). Mis a jour a chaque
// re-synthese. Sert au RATTACHEMENT : a chaque nouveau mail, on compare son
// contenu a ce contexte pour trouver la bonne affaire (au lieu du seul nom du
// marchand, qui melange deux commandes du meme magasin).
migrate(
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    items.fields.add(new Field({ name: "context_summary", type: "text", max: 2000 }));
    app.save(items);
  },
  (app) => {
    const items = app.findCollectionByNameOrId("tracking_items");
    items.fields.removeByName("context_summary");
    app.save(items);
  }
);
