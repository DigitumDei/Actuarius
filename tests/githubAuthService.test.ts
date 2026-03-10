import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitHubAppJwt,
  deriveGitHubAppIdentity,
  normalizeGitHubSecretValue,
  resolveGitHubAppPrivateKey
} from "../src/services/githubAuthService.js";

describe("githubAuthService helpers", () => {
  it("normalizes escaped newlines in secrets", () => {
    expect(normalizeGitHubSecretValue("line-1\\nline-2\r\n")).toBe("line-1\nline-2");
  });

  it("decodes base64 private keys", () => {
    const encoded = Buffer.from("-----BEGIN KEY-----\nabc\n-----END KEY-----\n", "utf8").toString("base64");
    expect(resolveGitHubAppPrivateKey(undefined, encoded)).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

  it("prefers raw private key when provided directly", () => {
    expect(resolveGitHubAppPrivateKey("-----BEGIN KEY-----\\nabc\\n-----END KEY-----", undefined)).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----"
    );
  });

  it("derives the GitHub App bot commit identity", () => {
    expect(deriveGitHubAppIdentity("123456", "actuarius-bot")).toEqual({
      userName: "actuarius-bot[bot]",
      userEmail: "123456+actuarius-bot[bot]@users.noreply.github.com"
    });
  });

  it("creates a signed GitHub App JWT with expected claims", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const nowMs = Date.UTC(2026, 2, 10, 12, 0, 0);
    const token = createGitHubAppJwt(
      "123456",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      nowMs
    );

    const [headerPart, payloadPart, signaturePart] = token.split(".");
    expect(signaturePart).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerPart!, "base64url").toString("utf8")) as { alg: string; typ: string };
    const payload = JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    };

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({
      iss: "123456",
      iat: Math.floor(nowMs / 1000) - 60,
      exp: Math.floor(nowMs / 1000) - 60 + 9 * 60
    });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();

    expect(
      verifier.verify(
        createPublicKey(publicKey.export({ type: "spki", format: "pem" })),
        Buffer.from(signaturePart!, "base64url")
      )
    ).toBe(true);
  });
});
