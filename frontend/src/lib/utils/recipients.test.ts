import { describe, it, expect } from "vitest";
import {
  uniqueRecipients,
  recipientLabel,
  labelForRecipientEmail,
} from "./recipients";

describe("uniqueRecipients", () => {
  it("compte To + Cc + Cci sans doublon", () => {
    const list = uniqueRecipients([
      [
        { name: "Gabriela", address: "clara.rossi@conseil-example.ch" },
        { address: "lena@rh-example.ch" },
      ],
      [{ address: "pchowney@bluewin.ch" }],
      [{ address: "Clara.Rossi@conseil-example.ch" }],
    ]);
    expect(list).toHaveLength(3);
    expect(recipientLabel(list[0])).toBe("Gabriela");
  });

  it("retrouve le nom a partir de l'adresse d'ouverture", () => {
    const list = uniqueRecipients([
      [{ name: "Lena", address: "lena@rh-example.ch" }],
    ]);
    expect(labelForRecipientEmail(list, "LENA@rh-example.ch")).toBe("Lena");
    expect(labelForRecipientEmail(list, "")).toBe("");
  });
});
