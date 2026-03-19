import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureGitHubCliAuthenticated, getGitHubCommandEnvironment } from "./githubAuthService.js";

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

export interface GitHubIssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string;
  labels: string[];
  authorLogin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
  assignees: string[];
}

export class GitHubRepoLookupError extends Error {
  public readonly code: "NOT_FOUND" | "GH_UNAVAILABLE" | "COMMAND_FAILED" | "INVALID_OUTPUT";

  public constructor(code: "NOT_FOUND" | "GH_UNAVAILABLE" | "COMMAND_FAILED" | "INVALID_OUTPUT", message: string) {
    super(message);
    this.name = "GitHubRepoLookupError";
    this.code = code;
  }
}

export class GitHubIssueLookupError extends Error {
  public readonly code: "NOT_FOUND" | "GH_UNAVAILABLE" | "COMMAND_FAILED" | "INVALID_OUTPUT";

  public constructor(code: "NOT_FOUND" | "GH_UNAVAILABLE" | "COMMAND_FAILED" | "INVALID_OUTPUT", message: string) {
    super(message);
    this.name = "GitHubIssueLookupError";
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

interface GhIssueListResponseItem {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
  author?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface GhIssueDetailResponse {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
  author?: unknown;
  assignees?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function normalizeIssueUser(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const login = (value as { login?: unknown }).login;
  return typeof login === "string" && login.trim() ? login : null;
}

function normalizeIssueLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name] : [];
  });
}

function normalizeIssueAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const login = normalizeIssueUser(entry);
    return login ? [login] : [];
  });
}

function normalizeIssueTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeIssueSummary(item: GhIssueListResponseItem): GitHubIssueSummary {
  if (
    typeof item.number !== "number"
    || !Number.isInteger(item.number)
    || typeof item.title !== "string"
    || typeof item.url !== "string"
    || typeof item.state !== "string"
  ) {
    throw new GitHubIssueLookupError("INVALID_OUTPUT", "GitHub CLI output did not contain required issue list fields.");
  }

  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    body: typeof item.body === "string" ? item.body : "",
    labels: normalizeIssueLabels(item.labels),
    authorLogin: normalizeIssueUser(item.author),
    createdAt: normalizeIssueTimestamp(item.createdAt),
    updatedAt: normalizeIssueTimestamp(item.updatedAt)
  };
}

export function parseIssueListJson(stdout: string): GitHubIssueSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GitHubIssueLookupError("INVALID_OUTPUT", "Could not parse JSON output from GitHub CLI.");
  }

  if (!Array.isArray(parsed)) {
    throw new GitHubIssueLookupError("INVALID_OUTPUT", "GitHub CLI output did not return an issue list.");
  }

  return parsed.map((item) => normalizeIssueSummary(item as GhIssueListResponseItem));
}

export function parseIssueDetailJson(stdout: string): GitHubIssueDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GitHubIssueLookupError("INVALID_OUTPUT", "Could not parse JSON output from GitHub CLI.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new GitHubIssueLookupError("INVALID_OUTPUT", "GitHub CLI output did not return issue detail.");
  }

  const issue = normalizeIssueSummary(parsed as GhIssueDetailResponse);
  return {
    ...issue,
    assignees: normalizeIssueAssignees((parsed as GhIssueDetailResponse).assignees)
  };
}

function mapGitHubIssueLookupError(error: unknown): never {
  const message = error instanceof Error ? error.message : "GitHub CLI call failed.";
  if (error instanceof GitHubIssueLookupError) {
    throw error;
  }

  if (message.includes("ENOENT")) {
    throw new GitHubIssueLookupError("GH_UNAVAILABLE", "GitHub CLI is not installed or not available in PATH.");
  }

  const lowered = message.toLowerCase();
  if (lowered.includes("not found") || lowered.includes("could not resolve")) {
    throw new GitHubIssueLookupError("NOT_FOUND", "Issue not found.");
  }

  throw new GitHubIssueLookupError("COMMAND_FAILED", message);
}

export async function lookupRepo(reference: ParsedRepoReference): Promise<RepoLookupResult> {
  try {
    await ensureGitHubCliAuthenticated();
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
        env: getGitHubCommandEnvironment(),
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

export async function listOpenIssues(repoFullName: string): Promise<GitHubIssueSummary[]> {
  return runGhIssueCommand(
    [
      "issue",
      "list",
      "--repo",
      repoFullName,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,state,body,labels,author,createdAt,updatedAt"
    ],
    parseIssueListJson
  );
}

export async function viewIssueDetail(repoFullName: string, issueNumber: number): Promise<GitHubIssueDetail> {
  return runGhIssueCommand(
    [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repoFullName,
      "--json",
      "number,title,url,state,body,labels,author,assignees,createdAt,updatedAt"
    ],
    parseIssueDetailJson
  );
}

async function runGhIssueCommand<T>(args: string[], parser: (stdout: string) => T): Promise<T> {
  try {
    await ensureGitHubCliAuthenticated();
    const { stdout } = await execFileAsync(
      "gh",
      args,
      {
        env: getGitHubCommandEnvironment(),
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024
      }
    );

    return parser(stdout);
  } catch (error) {
    mapGitHubIssueLookupError(error);
  }
}
