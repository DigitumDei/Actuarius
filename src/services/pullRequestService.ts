import { getGitHubCommandEnvironment } from "./githubAuthService.js";
import { spawnCollect } from "../utils/spawnCollect.js";

export class PullRequestServiceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PullRequestServiceError";
  }
}

function extractUrl(stdout: string): string {
  return stdout.trim().split(/\s+/u).find((part) => part.startsWith("https://github.com/")) ?? stdout.trim();
}

function isAlreadyExistsError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("pull request") && (lowered.includes("already exists") || lowered.includes("already exists for"));
}

export async function createDraftPullRequest(input: {
  worktreePath: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  try {
    const result = await spawnCollect(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body
      ],
      {
        cwd: input.worktreePath,
        env: getGitHubCommandEnvironment(),
        timeoutMs: 60_000,
        maxBuffer: 1024 * 1024
      }
    );
    return extractUrl(result.stdout);
  } catch (error) {
    const spawnError = error as { message?: string; stderr?: string; stdout?: string; code?: string };
    const message = [spawnError.message, spawnError.stderr].filter(Boolean).join("\n").trim();

    if (isAlreadyExistsError(message)) {
      try {
        const existing = await spawnCollect("gh", ["pr", "view", input.head, "--json", "url", "-q", ".url"], {
          cwd: input.worktreePath,
          env: getGitHubCommandEnvironment(),
          timeoutMs: 60_000,
          maxBuffer: 1024 * 1024
        });
        return extractUrl(existing.stdout);
      } catch (viewError) {
        const viewSpawnError = viewError as { message?: string; stderr?: string };
        const viewMessage = [viewSpawnError.message, viewSpawnError.stderr].filter(Boolean).join("\n").trim();
        throw new PullRequestServiceError(viewMessage || "A pull request already exists, but its URL could not be resolved.");
      }
    }

    if (spawnError.code === "ENOENT" || message.includes("ENOENT")) {
      throw new PullRequestServiceError("GitHub CLI is not installed or not available in PATH.");
    }

    throw new PullRequestServiceError(message || "Could not create draft pull request.");
  }
}
