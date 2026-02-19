import { createHash } from "node:crypto";

function sanitizeToken(raw: string): string {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  return trimmed || "x";
}

export function buildRepoChannelName(owner: string, repo: string, existingNames: Set<string>): string {
  const base = sanitizeToken(`repo-${owner}-${repo}`).slice(0, 95);
  if (!existingNames.has(base)) {
    return base;
  }

  const hash = createHash("sha1").update(`${owner}/${repo}`).digest("hex").slice(0, 6);
  const maxBaseLength = 100 - hash.length - 1;
  return `${base.slice(0, maxBaseLength)}-${hash}`;
}

export function buildThreadName(prompt: string): string {
  const token = sanitizeToken(prompt).slice(0, 64);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `ask-${token}-${timestamp}`;
  return name.slice(0, 100);
}

