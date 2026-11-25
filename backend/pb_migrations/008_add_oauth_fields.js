/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");

    // Add OAuth2 fields
    accounts.fields.add(
      new Field({
        name: "auth_type",
        type: "select",
        values: ["password", "oauth2"],
      })
    );

    accounts.fields.add(
      new Field({
        name: "oauth_provider",
        type: "text",
        max: 50,
      })
    );

    accounts.fields.add(
      new Field({
        name: "oauth_refresh_token",
        type: "text",
        max: 2000,
      })
    );

    accounts.fields.add(
      new Field({
        name: "oauth_access_token",
        type: "text",
        max: 2000,
      })
    );

    accounts.fields.add(
      new Field({
        name: "oauth_token_expiry",
        type: "date",
      })
    );

    // Make imap_password and smtp_password optional (empty for OAuth2 accounts)
    const imapPw = accounts.fields.getByName("imap_password");
    if (imapPw) {
      imapPw.required = false;
    }
    const smtpPw = accounts.fields.getByName("smtp_password");
    if (smtpPw) {
      smtpPw.required = false;
    }

    // Also make host/port/username optional for OAuth2 (auto-filled)
    const fields = [
      "imap_host",
      "imap_port",
      "imap_security",
      "imap_username",
      "smtp_host",
      "smtp_port",
      "smtp_security",
      "smtp_username",
    ];
    for (const fname of fields) {
      const f = accounts.fields.getByName(fname);
      if (f) {
        f.required = false;
      }
    }

    app.save(accounts);
  },
  (app) => {
    const accounts = app.findCollectionByNameOrId("accounts");

    accounts.fields.removeByName("auth_type");
    accounts.fields.removeByName("oauth_provider");
    accounts.fields.removeByName("oauth_refresh_token");
    accounts.fields.removeByName("oauth_access_token");
    accounts.fields.removeByName("oauth_token_expiry");

    app.save(accounts);
  }
);
