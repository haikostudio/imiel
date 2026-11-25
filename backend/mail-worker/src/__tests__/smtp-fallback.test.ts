import { describe, it, expect } from "vitest";
import { isSmtpConnectionError } from "../smtp";

describe("isSmtpConnectionError", () => {
  it("reconnait un delai de connexion depasse (port bloque)", () => {
    const err = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" });
    expect(isSmtpConnectionError(err)).toBe(true);
  });

  it("reconnait une connexion refusee", () => {
    expect(isSmtpConnectionError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(true);
  });

  it("ne change pas de port sur un refus d'identifiants", () => {
    const err = Object.assign(new Error("Invalid login: 535 Authentication failed"), { code: "EAUTH", command: "AUTH PLAIN" });
    expect(isSmtpConnectionError(err)).toBe(false);
  });

  it("ignore une erreur de socket apres la connexion", () => {
    expect(isSmtpConnectionError(Object.assign(new Error("socket closed"), { code: "ESOCKET", command: "DATA" }))).toBe(false);
  });
});
