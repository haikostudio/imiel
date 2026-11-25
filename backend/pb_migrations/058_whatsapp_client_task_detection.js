/// <reference path="../pb_data/types.d.ts" />

// Detection AUTOMATIQUE des demandes de travail sur les discussions WhatsApp.
//
// - whatsapp_accounts.is_client : ce numero est un numero CLIENT. C'est le
//   seul interrupteur de la detection automatique : sans lui, aucun message
//   WhatsApp n'est lu par le LLM (discipline de cout inchangee).
// - whatsapp_accounts.client_project : nom du projet HaikoDev propose par
//   defaut pour les cartes issues de ce compte (facultatif ; un lien
//   expediteur -> projet plus precis prime, sinon l'utilisateur saisit le nom
//   avant d'envoyer).
// - whatsapp_chats.task_checked_at : date du dernier message DEJA analyse pour
//   cette discussion. Empeche de repayer un appel LLM sur les memes messages
//   apres un redemarrage du worker.
migrate(
  (app) => {
    const accounts = app.findCollectionByNameOrId("whatsapp_accounts");
    if (!accounts.fields.getByName("is_client")) {
      accounts.fields.add(new Field({ name: "is_client", type: "bool" }));
    }
    if (!accounts.fields.getByName("client_project")) {
      accounts.fields.add(new Field({ name: "client_project", type: "text", max: 200 }));
    }
    app.save(accounts);

    const chats = app.findCollectionByNameOrId("whatsapp_chats");
    if (!chats.fields.getByName("task_checked_at")) {
      chats.fields.add(new Field({ name: "task_checked_at", type: "date" }));
    }
    app.save(chats);
  },

  (app) => {
    const accounts = app.findCollectionByNameOrId("whatsapp_accounts");
    accounts.fields.removeByName("is_client");
    accounts.fields.removeByName("client_project");
    app.save(accounts);

    const chats = app.findCollectionByNameOrId("whatsapp_chats");
    chats.fields.removeByName("task_checked_at");
    app.save(chats);
  }
);
