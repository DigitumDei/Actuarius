import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ensurePalaceIdentity } from "../src/services/memPalaceClient.js";

const logger = pino({ level: "silent" });

describe("ensurePalaceIdentity", () => {
  it("seeds identity.txt when absent and never overwrites it", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "actuarius-palace-identity-"));

    await ensurePalaceIdentity(logger, homeDir);

    const identityPath = join(homeDir, ".mempalace", "identity.txt");
    const seeded = readFileSync(identityPath, "utf8");
    expect(seeded).toContain("Actuarius agents");
    expect(seeded).toContain("NEVER push directly");

    // Operator edits on the persistent disk must survive restarts.
    writeFileSync(identityPath, "custom identity\n", "utf8");
    await ensurePalaceIdentity(logger, homeDir);
    expect(readFileSync(identityPath, "utf8")).toBe("custom identity\n");
  });
});
