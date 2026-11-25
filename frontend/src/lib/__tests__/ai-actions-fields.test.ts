import { describe, expect, it } from "vitest";
import { scrubSecrets } from "@/lib/ai-actions-fields";
import { providerByEmail, providerByMx, providerByName } from "@/lib/mail-providers";
import type { AccountCreatePayload, RecordPayload } from "@/lib/ai-actions-types";

describe("scrubSecrets", () => {
  it("masque le mot de passe d'un ajout de compte", () => {
    const p = { email: "a@b.c", password: "secret" } as AccountCreatePayload;
    expect(JSON.stringify(scrubSecrets("account_create", p))).not.toContain("secret");
  });
  it("masque les mots de passe d'une modification de compte", () => {
    const p: RecordPayload = { items: [{ id: "a", title: "a", after: { imap_password: "s1", label: "x" } }] };
    const out = scrubSecrets("account_update", p) as RecordPayload;
    expect(out.items[0].after.label).toBe("x");
    expect(JSON.stringify(out)).not.toContain("s1");
  });
});

describe("fournisseurs", () => {
  it("par nom, adresse ou MX", () => {
    expect(providerByName("Infomaniak")?.imap.host).toBe("mail.infomaniak.com");
    expect(providerByEmail("x@hotmail.fr")?.key).toBe("outlook");
    expect(providerByMx(["mta-gw.infomaniak.ch."])?.key).toBe("infomaniak");
    expect(providerByMx(["aspmx.l.google.com"])?.oauth).toBe("google");
    expect(providerByName("")).toBeUndefined();
  });
});
