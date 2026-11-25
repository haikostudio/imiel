/// <reference path="../pb_data/types.d.ts" />

// WhatsApp dans HaikoMail : passerelle Baileys en LECTURE SEULE (reprise du
// fonctionnement eprouve du projet Brain, cf. clients/whatsapp/gateway.mjs).
// - whatsapp_accounts : un compte WhatsApp appaire (code d'appairage a 8
//   caracteres, pas de QR ; l'auth Baileys est persistee sur disque cote worker
//   -> pas de re-appairage a chaque demarrage).
// - whatsapp_chats    : une conversation (tete-a-tete ou groupe), rapprochee du
//   carnet d'adresses par le NUMERO DE TELEPHONE (contact), corrigeable a la main.
// - whatsapp_messages : un message ingere (texte ou libelle de media).
// Ajoute aussi contacts.phone : c'est la cle du rapprochement contact <-> numero.
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const contacts = app.findCollectionByNameOrId("contacts");

    // --- contacts.phone : numero de telephone du contact (rapprochement WhatsApp).
    // Stocke tel que saisi ; le rapprochement compare les CHIFFRES (indicatif
    // pays optionnel, on compare les 9 derniers chiffres).
    if (!contacts.fields.getByName("phone")) {
      contacts.fields.add(new Field({ name: "phone", type: "text", max: 60 }));
      app.save(contacts);
    }

    // --- whatsapp_accounts ---
    const accounts = new Collection({
      name: "whatsapp_accounts",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "label", type: "text", max: 100 },
        // Numero avec indicatif pays, sans + ni espaces cote worker.
        { name: "phone_number", type: "text", max: 40, required: true },
        {
          name: "status",
          type: "select",
          maxSelect: 1,
          required: true,
          values: ["new", "pairing", "connected", "logged_out", "error"],
        },
        // Code d'appairage a 8 caracteres emis par WhatsApp (rafraichi ~2,5 min).
        { name: "pairing_code", type: "text", max: 40 },
        // Mis a true par l'UI pour demander un code FRAIS (consomme par le worker).
        { name: "pairing_requested", type: "bool" },
        { name: "last_error", type: "text", max: 1000 },
        { name: "last_connected_at", type: "date" },
        { name: "is_active", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_waacc_user_phone ON whatsapp_accounts (user, phone_number)",
        "CREATE INDEX idx_waacc_active ON whatsapp_accounts (is_active)",
      ],
    });
    app.save(accounts);

    // --- whatsapp_chats ---
    const chats = new Collection({
      name: "whatsapp_chats",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "jid", type: "text", max: 120, required: true },
        // Chiffres du numero (tete-a-tete uniquement ; vide pour un groupe).
        { name: "phone", type: "text", max: 40 },
        { name: "name", type: "text", max: 200 },
        { name: "is_group", type: "bool" },
        // Rapprochement carnet d'adresses. auto = trouve par le numero,
        // manual = corrige a la main (jamais ecrase par l'automatique).
        { name: "contact", type: "relation", collectionId: contacts.id, cascadeDelete: false, maxSelect: 1, required: false },
        { name: "link_mode", type: "select", maxSelect: 1, values: ["auto", "manual"] },
        { name: "last_message_at", type: "date" },
        { name: "last_message_preview", type: "text", max: 500 },
        { name: "message_count", type: "number" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_wachat_account_jid ON whatsapp_chats (account, jid)",
        "CREATE INDEX idx_wachat_user_last ON whatsapp_chats (user, last_message_at)",
        "CREATE INDEX idx_wachat_user_phone ON whatsapp_chats (user, phone)",
        "CREATE INDEX idx_wachat_user_contact ON whatsapp_chats (user, contact)",
      ],
    });
    app.save(chats);

    // --- whatsapp_messages ---
    const messages = new Collection({
      name: "whatsapp_messages",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: null,
      updateRule: null,
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "chat", type: "relation", collectionId: chats.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "wa_id", type: "text", max: 120, required: true },
        { name: "from_me", type: "bool" },
        { name: "sender", type: "text", max: 200 },
        { name: "text", type: "text", max: 20000 },
        // image | video | audio | note-vocale | document | sticker ... (libelle seul)
        { name: "media_type", type: "text", max: 40 },
        { name: "date", type: "date", required: true },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_wamsg_chat_waid ON whatsapp_messages (chat, wa_id)",
        "CREATE INDEX idx_wamsg_chat_date ON whatsapp_messages (chat, date)",
        "CREATE INDEX idx_wamsg_user_date ON whatsapp_messages (user, date)",
      ],
    });
    app.save(messages);
  },

  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("whatsapp_messages"));
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("whatsapp_chats"));
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("whatsapp_accounts"));
    } catch (_) {}
    try {
      const contacts = app.findCollectionByNameOrId("contacts");
      contacts.fields.removeByName("phone");
      app.save(contacts);
    } catch (_) {}
  }
);
