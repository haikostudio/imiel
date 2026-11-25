/// <reference path="../pb_data/types.d.ts" />

// Retrait DEFINITIF de WhatsApp et de la detection de taches clients.
//
// Supprime les collections (et donc tous leurs enregistrements, ainsi que les
// fichiers de media stockes par PocketBase pour whatsapp_messages) :
//   - task_suggestions  (migrations 050/051)
//   - whatsapp_messages, whatsapp_chats, whatsapp_accounts (052-055, 058)
//
// GARDE : project_links (rattachement contact -> projet Beluga Build),
// users.haikodev_api_key (057) et contacts.phone (052, champ de contact neutre).
//
// Irreversible : le retour arriere ne recree rien (donnees perdues).
// L'etat d'appairage Baileys vivait HORS base, dans le volume Docker
// `wa_state` : a retirer a la main au deploiement (cf. docs/API.md).

migrate(
  (app) => {
    // Ordre : enfants avant parents (relations whatsapp_messages -> chats -> accounts).
    const names = [
      "task_suggestions",
      "whatsapp_messages",
      "whatsapp_chats",
      "whatsapp_accounts",
    ];
    for (const name of names) {
      let col = null;
      try {
        col = app.findCollectionByNameOrId(name);
      } catch (_) {
        col = null; // deja absente (base neuve ou migration rejouee)
      }
      if (col) app.delete(col);
    }
  },
  (_app) => {
    // Pas de retour arriere : les donnees effacees ne se recreent pas.
  }
);
