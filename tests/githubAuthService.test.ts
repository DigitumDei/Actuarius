import { describe, expect, it } from "vitest";
import {
  deriveGitHubAppIdentity,
  getGitCredentialConfigArgs,
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

  it("builds git credential helper args for gh auth", () => {
    expect(getGitCredentialConfigArgs()).toEqual([
      "-c",
      "credential.helper=!gh auth git-credential",
      "-c",
      "credential.useHttpPath=true"
    ]);
  });
});
