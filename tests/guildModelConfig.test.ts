import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../src/db/database.js";

function createInMemoryDb(): AppDatabase {
  const db = new AppDatabase(":memory:");
  db.runMigrations();
  return db;
}

describe("AppDatabase guild model config", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
  });

  it("returns undefined when no config is set", () => {
    expect(db.getGuildModelConfig("guild-1")).toBeUndefined();
  });

  it("sets and retrieves model config", () => {
    db.setGuildModelConfig("guild-1", "claude", "claude-opus-4-5", "user-1");
    const config = db.getGuildModelConfig("guild-1");
    expect(config).toBeDefined();
    expect(config!.guild_id).toBe("guild-1");
    expect(config!.provider).toBe("claude");
    expect(config!.model).toBe("claude-opus-4-5");
    expect(config!.updated_by_user_id).toBe("user-1");
  });

  it("overwrites existing config on second set", () => {
    db.setGuildModelConfig("guild-1", "claude", "claude-opus-4-5", "user-1");
    db.setGuildModelConfig("guild-1", "gemini", "gemini-2.0-flash", "user-2");
    const config = db.getGuildModelConfig("guild-1");
    expect(config!.provider).toBe("gemini");
    expect(config!.model).toBe("gemini-2.0-flash");
    expect(config!.updated_by_user_id).toBe("user-2");
  });

  it("sets codex provider config", () => {
    db.setGuildModelConfig("guild-1", "codex", "o4-mini", "user-3");
    const config = db.getGuildModelConfig("guild-1");
    expect(config!.provider).toBe("codex");
    expect(config!.model).toBe("o4-mini");
  });

  it("returns undefined for unknown guild", () => {
    expect(db.getGuildModelConfig("unknown-guild")).toBeUndefined();
  });

  it("cascades delete when guild is removed", () => {
    db.setGuildModelConfig("guild-1", "claude", "claude-opus-4-5", "user-1");
    db.removeGuild("guild-1");
    expect(db.getGuildModelConfig("guild-1")).toBeUndefined();
  });
});
