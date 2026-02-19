import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ParsedRepoReference {
  owner: string;
  repo: string;
  fullName: string;
}

export interface RepoLookupResult {
  owner: string;
  repo: string;
  fullName: string;
  visibility: string;
  isPublic: boolean;
}

export class GitHubRepoLookupError extends Error {
  public readonly code: "NOT_FOUND" | "GH_UNAVAILABLE" | "COMMAND_FAILED" | "INVALID_OUTPUT";

  public constructor(code: "NOT_FOUND" | "GH_UNAVAILABLE" | "COMMAND_FAILED" | "INVALID_OUTPUT", message: string) {
    super(message);
    this.name = "GitHubRepoLookupError";
    this.code = code;
  }
}

function cleanRepoToken(value: string): string {
  let token = value.trim();
  if (token.endsWith(".git")) {
    token = token.slice(0, -4);
  }

  while (token.endsWith("/")) {
    token = token.slice(0, -1);
  }

  return token;
}

export function parseRepoReference(rawInput: string): ParsedRepoReference | null {
  const input = cleanRepoToken(rawInput);
  if (!input) {
    return null;
  }

  if (input.startsWith("https://") || input.startsWith("http://")) {
    try {
      const url = new URL(input);
      if (url.hostname !== "github.com") {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) {
        return null;
      }

      const ownerToken = parts[0];
      const repoToken = parts[1];
      if (!ownerToken || !repoToken) {
        return null;
      }

      const owner = ownerToken;
      const repo = cleanRepoToken(repoToken);
      if (!owner || !repo) {
        return null;
      }

      return {
        owner,
        repo,
        fullName: `${owner}/${repo}`
      };
    } catch {
      return null;
    }
  }

  const match = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    return null;
  }

  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    return null;
  }
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`
  };
}

interface GhRepoResponse {
  name: string;
  nameWithOwner: string;
  isPrivate: boolean;
  owner: {
    login: string;
  };
}

export async function lookupRepo(reference: ParsedRepoReference): Promise<RepoLookupResult> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "repo",
        "view",
        reference.fullName,
        "--json",
        "name,nameWithOwner,isPrivate,owner"
      ],
      {
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    let parsed: GhRepoResponse;
    try {
      parsed = JSON.parse(stdout) as GhRepoResponse;
    } catch {
      throw new GitHubRepoLookupError("INVALID_OUTPUT", "Could not parse JSON output from GitHub CLI.");
    }

    if (!parsed?.nameWithOwner || !parsed.owner?.login || !parsed.name || typeof parsed.isPrivate !== "boolean") {
      throw new GitHubRepoLookupError("INVALID_OUTPUT", "GitHub CLI output did not contain required repo fields.");
    }

    const fullName = parsed.nameWithOwner;
    const visibility = parsed.isPrivate ? "PRIVATE" : "PUBLIC";
    return {
      owner: parsed.owner.login,
      repo: parsed.name,
      fullName,
      visibility,
      isPublic: !parsed.isPrivate
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub CLI call failed.";
    if (error instanceof GitHubRepoLookupError) {
      throw error;
    }

    if (message.includes("ENOENT")) {
      throw new GitHubRepoLookupError("GH_UNAVAILABLE", "GitHub CLI is not installed or not available in PATH.");
    }

    if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("could not resolve")) {
      throw new GitHubRepoLookupError("NOT_FOUND", "Repository not found.");
    }

    throw new GitHubRepoLookupError("COMMAND_FAILED", message);
  }
}
