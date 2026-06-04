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

  it("sets planner config without clobbering default provider", () => {
    db.setGuildModelConfig("guild-1", "gemini", "gemini-2.0-flash", "user-1");
    db.setGuildRoleModelConfig("guild-1", "planner", "opencode", "deepseek/deepseek-v4-pro", "user-2");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.provider).toBe("gemini");
    expect(config!.model).toBe("gemini-2.0-flash");
    expect(config!.planner_provider).toBe("opencode");
    expect(config!.planner_model).toBe("deepseek/deepseek-v4-pro");
    expect(config!.updated_by_user_id).toBe("user-2");
  });

  it("can set implementer config before default config exists", () => {
    db.setGuildRoleModelConfig("guild-1", "implementer", "claude", "claude-haiku-4-5", "user-1");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.provider).toBe("claude");
    expect(config!.model).toBeNull();
    expect(config!.implementer_provider).toBe("claude");
    expect(config!.implementer_model).toBe("claude-haiku-4-5");
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

describe("AppDatabase guild review config", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
  });

  it("returns undefined when no review config is set", () => {
    expect(db.getGuildReviewConfig("guild-1")).toBeUndefined();
  });

  it("sets and retrieves review rounds", () => {
    db.setGuildReviewConfig("guild-1", 4, "user-1");
    const config = db.getGuildReviewConfig("guild-1");
    expect(config).toBeDefined();
    expect(config!.guild_id).toBe("guild-1");
    expect(config!.rounds).toBe(4);
    expect(config!.updated_by_user_id).toBe("user-1");
  });

  it("overwrites existing review config on second set", () => {
    db.setGuildReviewConfig("guild-1", 2, "user-1");
    db.setGuildReviewConfig("guild-1", 5, "user-2");
    const config = db.getGuildReviewConfig("guild-1");
    expect(config!.rounds).toBe(5);
    expect(config!.updated_by_user_id).toBe("user-2");
  });

  it("cascades review config delete when guild is removed", () => {
    db.setGuildReviewConfig("guild-1", 3, "user-1");
    db.removeGuild("guild-1");
    expect(db.getGuildReviewConfig("guild-1")).toBeUndefined();
  });
});

describe("AppDatabase reviewer slots", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
  });

  it("returns empty array when no slots set", () => {
    expect(db.getReviewerSlots("guild-1")).toEqual([]);
  });

  it("upserts single reviewer slot", () => {
    const slot = db.setReviewerSlot("guild-1", 1, "claude", "claude-sonnet-4-5", "user-1");
    expect(slot.slot_index).toBe(1);
    expect(slot.provider).toBe("claude");
    expect(slot.model).toBe("claude-sonnet-4-5");
    expect(slot.updated_by_user_id).toBe("user-1");

    const slots = db.getReviewerSlots("guild-1");
    expect(slots).toHaveLength(1);
    expect(slots[0].provider).toBe("claude");
  });

  it("updates existing slot on second upsert", () => {
    db.setReviewerSlot("guild-1", 1, "claude", "claude-sonnet-4-5", "user-1");
    const updated = db.setReviewerSlot("guild-1", 1, "gemini", "gemini-2.0-flash", "user-2");
    expect(updated.provider).toBe("gemini");
    expect(updated.model).toBe("gemini-2.0-flash");
    expect(updated.updated_by_user_id).toBe("user-2");

    const slots = db.getReviewerSlots("guild-1");
    expect(slots).toHaveLength(1);
    expect(slots[0].provider).toBe("gemini");
  });

  it("stores multiple slots at different indices", () => {
    db.setReviewerSlot("guild-1", 1, "claude", "claude-sonnet-4-5", "user-1");
    db.setReviewerSlot("guild-1", 2, "gemini", "gemini-2.0-flash", "user-1");
    db.setReviewerSlot("guild-1", 3, "opencode", "deepseek/deepseek-v4-pro", "user-1");

    const slots = db.getReviewerSlots("guild-1");
    expect(slots).toHaveLength(3);
    expect(slots[0].slot_index).toBe(1);
    expect(slots[1].slot_index).toBe(2);
    expect(slots[2].slot_index).toBe(3);
  });

  it("clears a single reviewer slot", () => {
    db.setReviewerSlot("guild-1", 1, "claude", "claude-sonnet-4-5", "user-1");
    db.setReviewerSlot("guild-1", 2, "gemini", "gemini-2.0-flash", "user-1");

    db.clearReviewerSlot("guild-1", 1);

    const slots = db.getReviewerSlots("guild-1");
    expect(slots).toHaveLength(1);
    expect(slots[0].slot_index).toBe(2);
    expect(slots[0].provider).toBe("gemini");
  });

  it("clearing nonexistent slot does not throw", () => {
    db.setReviewerSlot("guild-1", 1, "claude", "claude-sonnet-4-5", "user-1");
    expect(() => db.clearReviewerSlot("guild-1", 99)).not.toThrow();
    expect(db.getReviewerSlots("guild-1")).toHaveLength(1);
  });

  it("cascades delete when guild is removed", () => {
    db.setReviewerSlot("guild-1", 1, "claude", "claude-sonnet-4-5", "user-1");
    db.removeGuild("guild-1");
    expect(db.getReviewerSlots("guild-1")).toEqual([]);
  });
});

describe("AppDatabase review role model config", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
  });

  it("sets analyzer override without clobbering default provider", () => {
    db.setGuildModelConfig("guild-1", "gemini", "gemini-2.0-flash", "user-1");
    db.setGuildReviewRoleModelConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-2");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.provider).toBe("gemini");
    expect(config!.model).toBe("gemini-2.0-flash");
    expect(config!.analyzer_provider).toBe("claude");
    expect(config!.analyzer_model).toBe("claude-sonnet-4-5");
    expect(config!.planner_provider).toBeNull();
    expect(config!.implementer_provider).toBeNull();
    expect(config!.updated_by_user_id).toBe("user-2");
  });

  it("sets judge override before default config exists", () => {
    db.setGuildReviewRoleModelConfig("guild-1", "judge", "opencode", "deepseek/deepseek-v4-pro", "user-1");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.provider).toBe("claude");
    expect(config!.model).toBeNull();
    expect(config!.judge_provider).toBe("opencode");
    expect(config!.judge_model).toBe("deepseek/deepseek-v4-pro");
    expect(config!.analyzer_provider).toBeNull();
    expect(config!.summarizer_provider).toBeNull();
  });

  it("sets summarizer override without clobbering planner and implementer", () => {
    db.setGuildRoleModelConfig("guild-1", "planner", "opencode", "deepseek/deepseek-v4-pro", "user-1");
    db.setGuildRoleModelConfig("guild-1", "implementer", "claude", "claude-haiku-4-5", "user-2");
    db.setGuildReviewRoleModelConfig("guild-1", "summarizer", "gemini", "gemini-2.0-flash", "user-3");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.planner_provider).toBe("opencode");
    expect(config!.planner_model).toBe("deepseek/deepseek-v4-pro");
    expect(config!.implementer_provider).toBe("claude");
    expect(config!.implementer_model).toBe("claude-haiku-4-5");
    expect(config!.summarizer_provider).toBe("gemini");
    expect(config!.summarizer_model).toBe("gemini-2.0-flash");
    expect(config!.updated_by_user_id).toBe("user-3");
  });

  it("updates existing review role override", () => {
    db.setGuildReviewRoleModelConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-1");
    db.setGuildReviewRoleModelConfig("guild-1", "analyzer", "gemini", "gemini-2.0-flash", "user-2");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.analyzer_provider).toBe("gemini");
    expect(config!.analyzer_model).toBe("gemini-2.0-flash");
    expect(config!.updated_by_user_id).toBe("user-2");
  });

  it("can clear a review role override by setting provider to null", () => {
    db.setGuildModelConfig("guild-1", "gemini", "gemini-2.0-flash", "user-1");
    db.setGuildReviewRoleModelConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-1");
    db.setGuildReviewRoleModelConfig("guild-1", "analyzer", null, null, "user-2");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.analyzer_provider).toBeNull();
    expect(config!.analyzer_model).toBeNull();
  });

  it("can set provider without model to partially override", () => {
    db.setGuildModelConfig("guild-1", "gemini", "gemini-2.0-flash", "user-1");
    db.setGuildReviewRoleModelConfig("guild-1", "judge", "claude", null, "user-2");

    const config = db.getGuildModelConfig("guild-1");
    expect(config!.judge_provider).toBe("claude");
    expect(config!.judge_model).toBeNull();
  });

  it("cascades review role config delete when guild is removed", () => {
    db.setGuildReviewRoleModelConfig("guild-1", "judge", "opencode", "deepseek/deepseek-v4-pro", "user-1");
    db.removeGuild("guild-1");
    expect(db.getGuildModelConfig("guild-1")).toBeUndefined();
  });
});

describe("AppDatabase review role config on guild_review_config", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
  });

  it("sets analyzer override without clobbering existing rounds", () => {
    db.setGuildReviewConfig("guild-1", 3, "user-1");
    const result = db.setGuildReviewRoleConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-2");

    expect(result.analyzer_provider).toBe("claude");
    expect(result.analyzer_model).toBe("claude-sonnet-4-5");
    expect(result.rounds).toBe(3);
    expect(result.updated_by_user_id).toBe("user-2");

    const config = db.getGuildReviewConfig("guild-1");
    expect(config!.analyzer_provider).toBe("claude");
    expect(config!.analyzer_model).toBe("claude-sonnet-4-5");
    expect(config!.rounds).toBe(3);
  });

  it("sets judge override before any review config exists", () => {
    const result = db.setGuildReviewRoleConfig("guild-1", "judge", "opencode", "deepseek/deepseek-v4-pro", "user-1");

    expect(result.judge_provider).toBe("opencode");
    expect(result.judge_model).toBe("deepseek/deepseek-v4-pro");
    expect(result.rounds).toBe(2);

    const config = db.getGuildReviewConfig("guild-1");
    expect(config!.judge_provider).toBe("opencode");
    expect(config!.judge_model).toBe("deepseek/deepseek-v4-pro");
    expect(config!.rounds).toBe(2);
  });

  it("sets summarizer override without clobbering other roles", () => {
    db.setGuildReviewRoleConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-1");
    db.setGuildReviewRoleConfig("guild-1", "judge", "gemini", "gemini-2.0-flash", "user-2");
    db.setGuildReviewRoleConfig("guild-1", "summarizer", "opencode", "deepseek/deepseek-v4-pro", "user-3");

    const config = db.getGuildReviewConfig("guild-1");
    expect(config!.analyzer_provider).toBe("claude");
    expect(config!.analyzer_model).toBe("claude-sonnet-4-5");
    expect(config!.judge_provider).toBe("gemini");
    expect(config!.judge_model).toBe("gemini-2.0-flash");
    expect(config!.summarizer_provider).toBe("opencode");
    expect(config!.summarizer_model).toBe("deepseek/deepseek-v4-pro");
  });

  it("can clear a review role override while preserving rounds", () => {
    db.setGuildReviewRoleConfig("guild-1", "judge", "claude", "claude-sonnet-4-5", "user-1");
    db.clearGuildReviewRoleConfig("guild-1", "judge", "user-2");

    const config = db.getGuildReviewConfig("guild-1");
    expect(config).toBeDefined();
    expect(config!.judge_provider).toBeNull();
    expect(config!.judge_model).toBeNull();
    expect(config!.rounds).toBe(2);
  });

  it("clearing last override preserves a prior custom round limit", () => {
    db.setGuildReviewConfig("guild-1", 3, "user-1");
    db.setGuildReviewRoleConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-2");
    db.clearGuildReviewRoleConfig("guild-1", "analyzer", "user-3");

    const config = db.getGuildReviewConfig("guild-1");
    expect(config).toBeDefined();
    expect(config!.analyzer_provider).toBeNull();
    expect(config!.analyzer_model).toBeNull();
    expect(config!.rounds).toBe(3);
  });

  it("updates existing override on second call", () => {
    db.setGuildReviewRoleConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-1");
    db.setGuildReviewRoleConfig("guild-1", "analyzer", "gemini", "gemini-2.0-flash", "user-2");

    const config = db.getGuildReviewConfig("guild-1");
    expect(config!.analyzer_provider).toBe("gemini");
    expect(config!.analyzer_model).toBe("gemini-2.0-flash");
    expect(config!.updated_by_user_id).toBe("user-2");
  });

  it("cascades delete when guild is removed", () => {
    db.setGuildReviewRoleConfig("guild-1", "analyzer", "claude", "claude-sonnet-4-5", "user-1");
    db.removeGuild("guild-1");
    expect(db.getGuildReviewConfig("guild-1")).toBeUndefined();
  });
});
