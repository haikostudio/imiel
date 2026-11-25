/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // =========================================================================
    // 1. LABELS
    // =========================================================================
    const labels = new Collection({
      name: "labels",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: "_pb_users_auth_", cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", required: true, min: 1, max: 100 },
        { name: "color", type: "text", max: 20 },
      ],
      indexes: [
        "CREATE INDEX idx_labels_user ON labels (user)",
        "CREATE UNIQUE INDEX idx_labels_user_name ON labels (user, name)",
      ],
    });
    app.save(labels);

    // =========================================================================
    // 2. ACCOUNTS
    // =========================================================================
    const accounts = new Collection({
      name: "accounts",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: "_pb_users_auth_", cascadeDelete: true, maxSelect: 1, required: true },
        { name: "label", type: "text", required: true, min: 1, max: 200 },
        { name: "email", type: "email", required: true },
        { name: "display_name", type: "text", max: 200 },
        { name: "protocol", type: "select", required: true, values: ["imap", "pop3"] },
        { name: "imap_host", type: "text", required: true, max: 255 },
        { name: "imap_port", type: "number", required: true, min: 1, max: 65535 },
        { name: "imap_security", type: "select", required: true, values: ["none", "ssl", "starttls"] },
        { name: "imap_username", type: "text", required: true, max: 255 },
        { name: "imap_password", type: "text", required: true, max: 500 },
        { name: "smtp_host", type: "text", required: true, max: 255 },
        { name: "smtp_port", type: "number", required: true, min: 1, max: 65535 },
        { name: "smtp_security", type: "select", required: true, values: ["none", "ssl", "starttls"] },
        { name: "smtp_username", type: "text", required: true, max: 255 },
        { name: "smtp_password", type: "text", required: true, max: 500 },
        { name: "check_interval", type: "number", min: 1, max: 1440 },
        { name: "signature", type: "editor" },
        { name: "sync_status", type: "select", values: ["idle", "syncing", "error", "initial"] },
        { name: "sync_error", type: "text", max: 1000 },
        { name: "last_synced_at", type: "date" },
        { name: "is_active", type: "bool" },
      ],
      indexes: [
        "CREATE INDEX idx_accounts_user ON accounts (user)",
        "CREATE INDEX idx_accounts_sync ON accounts (sync_status, last_synced_at)",
      ],
    });
    app.save(accounts);

    // =========================================================================
    // 3. FOLDERS
    // =========================================================================
    const folders = new Collection({
      name: "folders",
      type: "base",
      listRule: "@request.auth.id = account.user",
      viewRule: "@request.auth.id = account.user",
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "name", type: "text", required: true, max: 255 },
        { name: "path", type: "text", required: true, max: 500 },
        { name: "type", type: "select", values: ["inbox", "sent", "drafts", "trash", "spam", "archive", "custom"] },
        { name: "unread_count", type: "number", min: 0 },
        { name: "total_count", type: "number", min: 0 },
        { name: "sort_order", type: "number", min: 0 },
      ],
      indexes: [
        "CREATE INDEX idx_folders_account ON folders (account)",
        "CREATE UNIQUE INDEX idx_folders_path ON folders (account, path)",
      ],
    });
    app.save(folders);

    // =========================================================================
    // 4. MESSAGES
    // =========================================================================
    const messages = new Collection({
      name: "messages",
      type: "base",
      listRule: "@request.auth.id = account.user",
      viewRule: "@request.auth.id = account.user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = account.user",
      deleteRule: "@request.auth.id = account.user",
      fields: [
        { name: "account", type: "relation", collectionId: accounts.id, cascadeDelete: true, maxSelect: 1, required: true },
        { name: "folder", type: "relation", collectionId: folders.id, maxSelect: 1 },
        { name: "message_id", type: "text", max: 1000 },
        { name: "in_reply_to", type: "text", max: 1000 },
        { name: "references", type: "json" },
        { name: "thread_id", type: "text", max: 255 },
        { name: "from_address", type: "json" },
        { name: "to_addresses", type: "json" },
        { name: "cc_addresses", type: "json" },
        { name: "bcc_addresses", type: "json" },
        { name: "subject", type: "text", max: 1000 },
        { name: "text_body", type: "editor" },
        { name: "html_body", type: "editor" },
        { name: "snippet", type: "text", max: 500 },
        { name: "date", type: "date" },
        { name: "is_read", type: "bool" },
        { name: "is_starred", type: "bool" },
        { name: "is_answered", type: "bool" },
        { name: "is_draft", type: "bool" },
        { name: "is_sent", type: "bool" },
        { name: "has_attachments", type: "bool" },
        { name: "priority", type: "select", values: ["low", "normal", "high"] },
        { name: "labels", type: "relation", collectionId: labels.id, maxSelect: 50 },
        { name: "uid", type: "number" },
        { name: "attachments", type: "file", maxSelect: 50, maxSize: 26214400 },
        { name: "draft_reply_to", type: "text", max: 255 },
        { name: "auto_saved_at", type: "date" },
      ],
      indexes: [
        "CREATE INDEX idx_msg_account ON messages (account)",
        "CREATE INDEX idx_msg_folder ON messages (folder)",
        "CREATE INDEX idx_msg_thread ON messages (thread_id)",
        "CREATE INDEX idx_msg_date ON messages (date)",
        "CREATE INDEX idx_msg_mid ON messages (message_id)",
        "CREATE INDEX idx_msg_uid ON messages (account, folder, uid)",
        "CREATE INDEX idx_msg_read ON messages (is_read)",
        "CREATE INDEX idx_msg_draft ON messages (is_draft)",
      ],
    });
    app.save(messages);

    // =========================================================================
    // 5. PUSH_TOKENS
    // =========================================================================
    const pushTokens = new Collection({
      name: "push_tokens",
      type: "base",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id != ''",
      updateRule: "@request.auth.id = user",
      deleteRule: "@request.auth.id = user",
      fields: [
        { name: "user", type: "relation", collectionId: "_pb_users_auth_", cascadeDelete: true, maxSelect: 1, required: true },
        { name: "endpoint", type: "url", required: true },
        { name: "p256dh", type: "text", required: true, max: 500 },
        { name: "auth_key", type: "text", required: true, max: 500 },
        { name: "device_name", type: "text", max: 200 },
        { name: "is_active", type: "bool" },
      ],
      indexes: [
        "CREATE INDEX idx_push_user ON push_tokens (user)",
        "CREATE UNIQUE INDEX idx_push_endpoint ON push_tokens (endpoint)",
      ],
    });
    app.save(pushTokens);

    // =========================================================================
    // 6. EXTEND USERS with custom fields
    // =========================================================================
    const users = app.findCollectionByNameOrId("users");

    const newFields = [
      { name: "theme", type: "select", values: ["light", "dark", "system"] },
      { name: "language", type: "select", values: ["fr", "en", "de", "it"] },
      { name: "notifications_enabled", type: "bool" },
      { name: "notification_sound", type: "bool" },
      { name: "preview_lines", type: "number", min: 0, max: 10 },
      { name: "density", type: "select", values: ["compact", "comfortable", "spacious"] },
      { name: "reading_pane", type: "select", values: ["right", "bottom", "off"] },
      { name: "default_reply_all", type: "bool" },
      { name: "conversation_view", type: "bool" },
      { name: "auto_mark_read_seconds", type: "number", min: 0, max: 60 },
      { name: "default_account", type: "relation", collectionId: accounts.id, maxSelect: 1 },
      { name: "auto_save_interval", type: "number", min: 5, max: 300 },
    ];

    for (const field of newFields) {
      users.fields.add(new Field(field));
    }

    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.updateRule = "id = @request.auth.id";

    app.save(users);
  },

  // -- Rollback --
  (app) => {
    const names = ["push_tokens", "messages", "folders", "accounts", "labels"];
    for (const name of names) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {}
    }
    try {
      const users = app.findCollectionByNameOrId("users");
      const fieldsToRemove = [
        "theme", "language", "notifications_enabled", "notification_sound",
        "preview_lines", "density", "reading_pane", "default_reply_all",
        "conversation_view", "auto_mark_read_seconds", "default_account",
        "auto_save_interval",
      ];
      for (const f of fieldsToRemove) {
        users.fields.removeByName(f);
      }
      app.save(users);
    } catch (_) {}
  }
);
