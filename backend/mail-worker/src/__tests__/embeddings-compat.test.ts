import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { embedDocument, embedQuery, cosine } from "../embeddings";

// Garde-fou : les vecteurs stockes dans mail_embeddings ont ete calcules par
// fastembed 1.14.4 (pooling CLS, troncature 512). Toute montee de fastembed ou
// tout changement de getModel() doit produire les MEMES vecteurs, sinon la
// recherche semantique ne retrouve plus les mails deja indexes. Reference
// figee : fixtures-embeddings-1.14.4.json (calculee avec 1.14.4).
const ref = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures-embeddings-1.14.4.json"), "utf8")
) as { text: string; document: number[]; query: number[] };

describe("compatibilite des vecteurs avec l'index existant", () => {
  it("embedDocument reproduit le vecteur de fastembed 1.14.4", async () => {
    const v = await embedDocument(ref.text);
    expect(v).toHaveLength(384);
    expect(cosine(v, ref.document)).toBeGreaterThan(0.9999);
  }, 60_000);

  it("embedQuery reproduit le vecteur de requete de fastembed 1.14.4", async () => {
    const v = await embedQuery(ref.text);
    expect(cosine(v, ref.query)).toBeGreaterThan(0.9999);
  }, 60_000);
});
