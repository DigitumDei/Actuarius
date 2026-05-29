import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildAttachmentSummary,
  formatFileSize,
  processAttachments,
  sanitizeFilename,
  validateAttachments,
  type PendingAttachment
} from "../src/services/attachmentService.js";

const testConfig = {
  maxCount: 5,
  maxFileSize: 10 * 1024 * 1024,
  maxTotalSize: 25 * 1024 * 1024,
  maxInlineText: 256 * 1024,
};

function makeTextAttachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "att-1",
    name: "debug.log",
    url: "https://cdn.discord.com/attachments/1/debug.log",
    size: 4096,
    contentType: "text/plain",
    ...overrides,
  };
}

function makeImageAttachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "att-2",
    name: "screenshot.png",
    url: "https://cdn.discord.com/attachments/1/screenshot.png",
    size: 512 * 1024,
    contentType: "image/png",
    ...overrides,
  };
}

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(500)).toBe("500 B");
  });

  it("formats KiB", () => {
    expect(formatFileSize(2048)).toBe("2.0 KiB");
  });

  it("formats MiB", () => {
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
});

describe("sanitizeFilename", () => {
  it("replaces unsafe characters", () => {
    expect(sanitizeFilename("hello world.txt")).toBe("hello_world.txt");
  });

  it("collapses consecutive underscores", () => {
    expect(sanitizeFilename("file!!!.log")).toBe("file_.log");
  });

  it("preserves safe characters", () => {
    expect(sanitizeFilename("my-file_v2.test.js")).toBe("my-file_v2.test.js");
  });
});

describe("validateAttachments", () => {
  it("returns null for no attachments", () => {
    expect(validateAttachments([], testConfig)).toBeNull();
  });

  it("accepts valid text and image attachments", () => {
    const atts = [makeTextAttachment(), makeImageAttachment()];
    expect(validateAttachments(atts, testConfig)).toBeNull();
  });

  it("rejects excessive count", () => {
    const atts = Array.from({ length: 6 }, (_, i) =>
      makeTextAttachment({ id: `att-${i}`, name: `file-${i}.log`, size: 100 })
    );
    const result = validateAttachments(atts, { ...testConfig, maxCount: 5 });
    expect(result).toBe("Maximum 5 attachments allowed, but 6 were provided.");
  });

  it("rejects per-file size violation", () => {
    const att = makeTextAttachment({ size: 20 * 1024 * 1024 });
    const result = validateAttachments([att], { ...testConfig, maxFileSize: 10 * 1024 * 1024 });
    expect(result).toContain("above the 10.0 MiB per-file limit");
  });

  it("rejects total size violation", () => {
    const atts = [
      makeTextAttachment({ id: "att-1", name: "file1.log", size: 13 * 1024 * 1024 }),
      makeTextAttachment({ id: "att-2", name: "file2.log", size: 13 * 1024 * 1024 }),
    ];
    const result = validateAttachments(atts, { ...testConfig, maxFileSize: 20 * 1024 * 1024, maxTotalSize: 25 * 1024 * 1024 });
    expect(result).toContain("above the 25.0 MiB total limit");
  });

  it("rejects unsupported type by mime", () => {
    const att = makeTextAttachment({ contentType: "application/zip", name: "archive.zip" });
    const result = validateAttachments([att], testConfig);
    expect(result).toContain("is not supported");
  });

  it("rejects unsupported type by extension when mime is null", () => {
    const att = makeTextAttachment({ contentType: null, name: "archive.zip" });
    const result = validateAttachments([att], testConfig);
    expect(result).toContain("is not supported");
  });

  it("accepts text attachments with text-like mime", () => {
    const att = makeTextAttachment({ contentType: "application/json", name: "data.json" });
    expect(validateAttachments([att], testConfig)).toBeNull();
  });

  it("accepts jpeg images", () => {
    const att = makeImageAttachment({ contentType: "image/jpeg", name: "photo.jpg" });
    expect(validateAttachments([att], testConfig)).toBeNull();
  });

  it("accepts webp images", () => {
    const att = makeImageAttachment({ contentType: "image/webp", name: "image.webp" });
    expect(validateAttachments([att], testConfig)).toBeNull();
  });

  it("accepts gif images", () => {
    const att = makeImageAttachment({ contentType: "image/gif", name: "animation.gif" });
    expect(validateAttachments([att], testConfig)).toBeNull();
  });

  it("rejects unsupported image mime values even when the extension is image-like", () => {
    const att = makeImageAttachment({ contentType: "image/svg+xml", name: "diagram.png" });
    const result = validateAttachments([att], testConfig);
    expect(result).toContain("is not supported");
  });
});

describe("buildAttachmentSummary", () => {
  it("summarizes attachments with sizes and content types", () => {
    expect(buildAttachmentSummary([makeTextAttachment(), makeImageAttachment()])).toBe([
      "- debug.log (4.0 KiB, text/plain)",
      "- screenshot.png (512.0 KiB, image/png)",
    ].join("\n"));
  });

  it("returns empty string for no attachments", () => {
    expect(buildAttachmentSummary([])).toBe("");
  });
});

describe("processAttachments", () => {
  beforeAll(() => {
    globalThis.fetch = vi.fn();
  });

  it("returns empty for no attachments", async () => {
    const result = await processAttachments([], 1, "/tmp/worktree", testConfig);
    expect(result.processed).toEqual([]);
    expect(result.promptSection).toBe("");
  });

  it("downloads text attachment, saves file, and returns inline content", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("line1\nline2\nline3").buffer,
    } as Response);

    const result = await processAttachments(
      [makeTextAttachment()],
      42,
      "/tmp/worktree",
      testConfig
    );

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.type).toBe("text");
    expect(result.processed[0]!.inlineContent).toBe("line1\nline2\nline3");
    expect(result.promptSection).toContain("File: debug.log");
    expect(result.promptSection).toContain("```log");
    expect(result.promptSection).toContain("line1\nline2\nline3");
  });

  it("adds .actuarius to the git exclude file before saving attachments", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-attachment-worktree-"));
    const gitDir = join(worktreePath, ".git");
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), "*.tmp\n");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
    } as Response);

    await processAttachments([makeTextAttachment()], 42, worktreePath, testConfig);
    await processAttachments([makeTextAttachment()], 43, worktreePath, testConfig);

    const exclude = await readFile(join(gitDir, "info", "exclude"), "utf-8");
    expect(exclude).toContain("*.tmp\n.actuarius/\n");
    expect(exclude.match(/^\.actuarius\/$/gm)).toHaveLength(1);
  });

  it("adds .actuarius to the real git dir for linked git worktrees", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-linked-worktree-"));
    const realGitDir = await mkdtemp(join(tmpdir(), "actuarius-real-gitdir-"));
    await mkdir(join(realGitDir, "info"), { recursive: true });
    await writeFile(join(worktreePath, ".git"), `gitdir: ${realGitDir}\n`);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
    } as Response);

    await processAttachments([makeTextAttachment()], 44, worktreePath, testConfig);

    const exclude = await readFile(join(realGitDir, "info", "exclude"), "utf-8");
    expect(exclude).toBe(".actuarius/\n");
  });

  it("downloads image attachment, saves file, and returns path reference", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    } as Response);

    const result = await processAttachments(
      [makeImageAttachment()],
      42,
      "/tmp/worktree",
      testConfig
    );

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.type).toBe("image");
    expect(result.promptSection).toContain("File: screenshot.png");
    expect(result.promptSection).toContain("Attached image: .actuarius/attachments/request-42/1-screenshot.png");
  });

  it("processes multiple mixed text and image attachments", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("debug output").buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      } as Response);

    const result = await processAttachments(
      [makeTextAttachment(), makeImageAttachment()],
      45,
      "/tmp/worktree",
      testConfig
    );

    expect(result.processed.map((attachment) => attachment.type)).toEqual(["text", "image"]);
    expect(result.promptSection).toContain("debug output");
    expect(result.promptSection).toContain("Attached image: .actuarius/attachments/request-45/2-screenshot.png");
  });

  it("clips inline text to max", async () => {
    const smallConfig = { ...testConfig, maxInlineText: 10 };
    const text = "a".repeat(100);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    } as Response);

    const result = await processAttachments(
      [makeTextAttachment()],
      1,
      "/tmp/worktree",
      smallConfig
    );

    expect(result.processed[0]!.inlineContent?.length).toBe(10);
    expect(result.promptSection).toContain("clipped to");
  });

  it("throws on download failure", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);

    await expect(
      processAttachments([makeTextAttachment()], 1, "/tmp/worktree", testConfig)
    ).rejects.toThrow("Failed to download attachment debug.log: HTTP 403");
  });

  it("throws on unsupported type during processing", async () => {
    const att = makeTextAttachment({ contentType: "application/octet-stream", name: "archive.bin" });
    await expect(
      processAttachments([att], 1, "/tmp/worktree", testConfig)
    ).rejects.toThrow("is not supported");
  });

  it("throws when downloaded content exceeds the per-file size limit", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array(11).buffer,
    } as Response);

    await expect(
      processAttachments(
        [makeTextAttachment({ size: 5 })],
        1,
        "/tmp/worktree",
        { ...testConfig, maxFileSize: 10 }
      )
    ).rejects.toThrow("downloaded as 11 B, above the 10 B per-file limit");
  });

  it("throws when downloaded content exceeds the total size limit", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(8).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(8).buffer,
      } as Response);

    await expect(
      processAttachments(
        [
          makeTextAttachment({ id: "att-1", name: "one.log", size: 5 }),
          makeTextAttachment({ id: "att-2", name: "two.log", size: 5 }),
        ],
        1,
        "/tmp/worktree",
        { ...testConfig, maxTotalSize: 15 }
      )
    ).rejects.toThrow("downloaded total 16 B, above the 15 B total limit");
  });
});
