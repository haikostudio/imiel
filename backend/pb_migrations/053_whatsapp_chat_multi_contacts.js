/// <reference path="../pb_data/types.d.ts" />

// Une meme personne a souvent PLUSIEURS fiches dans le carnet (adresse perso et
// adresse pro, ou plusieurs interlocuteurs derriere un seul numero WhatsApp).
// `whatsapp_chats.contact` ne pouvait en designer qu'une : rattacher la seconde
// EFFACAIT la premiere. On passe le champ en relation MULTIPLE.
//
// Le stockage change de forme : une relation simple garde l'identifiant brut
// ("abc123"), une relation multiple garde un tableau JSON (["abc123"]). PB
// convertit deja les valeurs existantes en enregistrant la collection ; la
// requete de normalisation qui suit est un filet de securite idempotent (elle
// n'agit que sur les lignes restees au format simple).
migrate(
  (app) => {
    const chats = app.findCollectionByNameOrId("whatsapp_chats");
    const field = chats.fields.getByName("contact");
    field.maxSelect = 20;
    app.save(chats);

    app
      .db()
      .newQuery(
        "UPDATE whatsapp_chats SET contact = json_array(contact) " +
          "WHERE contact IS NOT NULL AND contact != '' AND contact NOT LIKE '[%'"
      )
      .execute();
  },

  (app) => {
    // Retour a un seul contact : on garde le PREMIER de la liste.
    app
      .db()
      .newQuery(
        "UPDATE whatsapp_chats SET contact = COALESCE(json_extract(contact, '$[0]'), '') " +
          "WHERE contact LIKE '[%'"
      )
      .execute();

    const chats = app.findCollectionByNameOrId("whatsapp_chats");
    const field = chats.fields.getByName("contact");
    field.maxSelect = 1;
    app.save(chats);
  }
);
