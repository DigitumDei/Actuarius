import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface PendingAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}

export interface ProcessedAttachment {
  index: number;
  originalName: string;
  name: string;
  type: "text" | "image";
  savedPath: string;
  inlineContent?: string;
  size: number;
}

export interface AttachmentConfig {
  maxCount: number;
  maxFileSize: number;
  maxTotalSize: number;
  maxInlineText: number;
}

const TEXT_LIKE_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-ndjson",
]);

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".csv", ".log",
  ".cfg", ".conf", ".ini", ".toml", ".env",
  ".sh", ".bash", ".zsh", ".fish",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".java",
  ".c", ".cpp", ".cxx", ".h", ".hpp", ".hxx",
  ".css", ".scss", ".less", ".html", ".htm",
  ".sql", ".rb", ".php", ".swift", ".kt", ".kts", ".gradle",
  ".ps1", ".bat", ".cmd",
  ".diff", ".patch",
  ".lock", ".toml",
  ".yaml",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
]);

const DOWNLOAD_TIMEOUT_MS = 30_000;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
}

function detectType(contentType: string | null, filename: string): "text" | "image" | null {
  if (contentType) {
    const mime = contentType.split(";")[0]!.trim().toLowerCase();
    if (mime.startsWith("text/")) return "text";
    if (IMAGE_MIMES.has(mime)) return "image";
    if (TEXT_LIKE_MIMES.has(mime)) return "text";
    if (mime.startsWith("image/")) return null;
  }

  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";

  return null;
}

export function validateAttachments(
  attachments: PendingAttachment[],
  config: AttachmentConfig
): string | null {
  if (attachments.length === 0) return null;

  if (attachments.length > config.maxCount) {
    return `Maximum ${config.maxCount} attachments allowed, but ${attachments.length} were provided.`;
  }

  let totalSize = 0;
  for (const att of attachments) {
    if (att.size > config.maxFileSize) {
      return `Attachment ${att.name} is ${formatFileSize(att.size)}, above the ${formatFileSize(config.maxFileSize)} per-file limit.`;
    }
    totalSize += att.size;
  }

  if (totalSize > config.maxTotalSize) {
    return `Attachments total ${formatFileSize(totalSize)}, above the ${formatFileSize(config.maxTotalSize)} total limit.`;
  }

  for (const att of attachments) {
    const type = detectType(att.contentType, att.name);
    if (!type) {
      return `Attachment ${att.name} is not supported. Supported types: text files and PNG/JPEG/WebP/GIF images.`;
    }
  }

  return null;
}

export function buildAttachmentSummary(attachments: PendingAttachment[]): string {
  if (attachments.length === 0) return "";
  return attachments
    .map((a) => `- ${a.name} (${formatFileSize(a.size)}${a.contentType ? `, ${a.contentType}` : ""})`)
    .join("\n");
}

async function resolveGitDir(worktreePath: string): Promise<string | null> {
  const dotGitPath = join(worktreePath, ".git");
  try {
    const dotGitStat = await stat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return dotGitPath;
    }
    if (!dotGitStat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const dotGit = await readFile(dotGitPath, "utf-8");
  const match = /^gitdir:\s*(.+)\s*$/im.exec(dotGit);
  if (!match) {
    return null;
  }

  const gitDir = match[1]!.trim();
  return isAbsolute(gitDir) ? gitDir : resolve(dirname(dotGitPath), gitDir);
}

async function resolveCommonGitDir(worktreePath: string): Promise<string | null> {
  const gitDir = await resolveGitDir(worktreePath);
  if (!gitDir) {
    return null;
  }

  try {
    const commonDir = (await readFile(join(gitDir, "commondir"), "utf-8")).trim();
    return isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir);
  } catch {
    return gitDir;
  }
}

async function ensureActuariusExcluded(worktreePath: string): Promise<void> {
  const commonGitDir = await resolveCommonGitDir(worktreePath);
  if (!commonGitDir) {
    try {
      await stat(join(worktreePath, ".git"));
    } catch {
      return;
    }
    throw new AttachmentError("Unable to resolve Git directory for attachment exclusion.");
  }

  const infoDir = join(commonGitDir, "info");
  const excludePath = join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });

  let contents = "";
  try {
    contents = await readFile(excludePath, "utf-8");
  } catch {
    // Missing exclude files are normal for newly-created repositories/worktrees.
  }

  const hasEntry = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".actuarius/" || line === ".actuarius");
  if (hasEntry) {
    return;
  }

  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}.actuarius/\n`);
}

async function downloadAttachment(att: PendingAttachment): Promise<Buffer> {
  try {
    const response = await fetch(att.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      throw new AttachmentError(`Failed to download attachment ${att.name}: HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof AttachmentError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new AttachmentError(`Failed to download attachment ${att.name}: ${message}`);
  }
}

export async function processAttachments(
  attachments: PendingAttachment[],
  requestId: number,
  worktreePath: string,
  config: AttachmentConfig
): Promise<{ processed: ProcessedAttachment[]; promptSection: string }> {
  if (attachments.length === 0) return { processed: [], promptSection: "" };

  const validationError = validateAttachments(attachments, config);
  if (validationError) {
    throw new AttachmentError(validationError);
  }

  await ensureActuariusExcluded(worktreePath);

  const saveDir = join(worktreePath, ".actuarius", "attachments", `request-${requestId}`);
  await mkdir(saveDir, { recursive: true });

  const processed: ProcessedAttachment[] = [];
  const promptLines: string[] = ["## Attachments", ""];
  let actualTotalSize = 0;

  try {
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      const safeName = `${i + 1}-${sanitizeFilename(att.name)}`;
      const savePath = join(saveDir, safeName);
      const relativePath = join(".actuarius", "attachments", `request-${requestId}`, safeName);
      const type = detectType(att.contentType, att.name);
      if (!type) {
        throw new AttachmentError(`Attachment ${att.name} is not supported. Supported types: text files and PNG/JPEG/WebP/GIF images.`);
      }

      const buffer = await downloadAttachment(att);
      const actualSize = buffer.length;
      if (actualSize > config.maxFileSize) {
        throw new AttachmentError(`Attachment ${att.name} downloaded as ${formatFileSize(actualSize)}, above the ${formatFileSize(config.maxFileSize)} per-file limit.`);
      }
      actualTotalSize += actualSize;
      if (actualTotalSize > config.maxTotalSize) {
        throw new AttachmentError(`Attachments downloaded total ${formatFileSize(actualTotalSize)}, above the ${formatFileSize(config.maxTotalSize)} total limit.`);
      }

      await writeFile(savePath, buffer);

      if (type === "text") {
        let textContent = buffer.toString("utf-8");
        let clipped = false;
        if (textContent.length > config.maxInlineText) {
          textContent = textContent.slice(0, config.maxInlineText);
          clipped = true;
        }

        const ext = extname(att.name).toLowerCase().replace(/^\./, "") || "text";

        promptLines.push(`File: ${att.name} (text, ${formatFileSize(actualSize)})`);
        promptLines.push("```" + ext);
        promptLines.push(textContent);
        promptLines.push("```");
        if (clipped) {
          promptLines.push(`*[Text clipped to ${formatFileSize(config.maxInlineText)}; full file saved at ${relativePath}]*`);
        }
        promptLines.push("");

        processed.push({
          index: i + 1,
          originalName: att.name,
          name: safeName,
          type: "text",
          savedPath: relativePath,
          inlineContent: textContent,
          size: actualSize,
        });
      } else {
        promptLines.push(`File: ${att.name} (image, ${formatFileSize(actualSize)})`);
        promptLines.push(`Attached image: ${relativePath}`);
        promptLines.push("");

        processed.push({
          index: i + 1,
          originalName: att.name,
          name: safeName,
          type: "image",
          savedPath: relativePath,
          size: actualSize,
        });
      }
    }
  } catch (err) {
    await rm(saveDir, { recursive: true, force: true });
    throw err;
  }

  return { processed, promptSection: promptLines.join("\n").trim() };
}
