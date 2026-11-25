import http from "http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchRemoteImage,
  ImageRejected,
  isBlockedIp,
  normalizeRemoteUrl,
  reencodeImage,
  signImageUrl,
  sniffImageType,
  verifySignedParams,
} from "./image-proxy";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-key";

function params(path: string) {
  const q = new URL(path, "https://x").searchParams;
  return { u: q.get("u"), e: q.get("e"), s: q.get("s") };
}

describe("signature des URL", () => {
  it("rend l'URL d'origine pour une signature valide", () => {
    const url = "https://cdn.example.com/a.png?x=1";
    const { u, e, s } = params(signImageUrl(url));
    expect(verifySignedParams(u, e, s)).toBe(url);
  });

  it("refuse une signature alteree, une URL changee ou expiree", () => {
    const url = "https://cdn.example.com/a.png";
    const { u, e, s } = params(signImageUrl(url));
    expect(verifySignedParams(u, e, `${s!.slice(0, -1)}A`)).toBeNull();
    const other = Buffer.from("http://127.0.0.1:8090/").toString("base64url");
    expect(verifySignedParams(other, e, s)).toBeNull();
    expect(verifySignedParams(u, e, s, Number(e) + 1)).toBeNull();
    expect(verifySignedParams(undefined, e, s)).toBeNull();
  });

  it("n'accepte que http(s)", () => {
    expect(normalizeRemoteUrl("//cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(normalizeRemoteUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRemoteUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeRemoteUrl("/illustration.png")).toBeNull();
    expect(normalizeRemoteUrl("https://user:pw@example.com/a.png")).toBeNull();
  });
});

describe("adresses internes", () => {
  it("refuse les IP privees, loopback, link-local et metadonnees", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.18.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "2606:4700::6810:84e5"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("secret"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("ne contacte jamais un service interne (IP ou nom)", async () => {
    await expect(fetchRemoteImage(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(ImageRejected);
    await expect(fetchRemoteImage(`http://localhost:${port}/`)).rejects.toThrow();
  });
});

describe("controle et redessin", () => {
  it("refuse le SVG, le HTML et le texte", () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from("<html><body>hello</body></html>"))).toBeNull();
  });

  it("refuse un faux PNG", async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<script>alert(1)</script>")]);
    await expect(reencodeImage(fake)).rejects.toThrow();
  });

  it("redessine un PNG piege : la charge ajoutee apres l'image disparait", async () => {
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#3366cc" } }).png().toBuffer();
    const payload = Buffer.from("PAYLOAD-<script>alert(1)</script>-EICAR");
    const out = await reencodeImage(Buffer.concat([png, payload]));
    expect(out.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(out.includes(Buffer.from("PAYLOAD"))).toBe(false);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([20, 10]);
  });

  it("garde l'animation d'un GIF anime", async () => {
    const frames = await sharp({ create: { width: 8, height: 16, channels: 4, background: "#ff0000" } })
      .gif()
      .toBuffer();
    const gif = await sharp(frames, { animated: true }).gif().toBuffer();
    expect(sniffImageType(gif)).toBe("gif");
    const out = await reencodeImage(gif);
    expect((await sharp(out).metadata()).format).toBe("webp");
  });
});
