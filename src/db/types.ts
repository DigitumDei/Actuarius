export interface GuildRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type AiProvider = "claude" | "codex" | "gemini";

export interface GuildModelConfigRow {
  guild_id: string;
  provider: AiProvider;
  model: string | null;
  updated_by_user_id: string;
  updated_at: string;
}

export interface GuildReviewConfigRow {
  guild_id: string;
  rounds: number;
  updated_by_user_id: string;
  updated_at: string;
}

export interface RepoRow {
  id: number;
  guild_id: string;
  owner: string;
  repo: string;
  full_name: string;
  visibility: string;
  channel_id: string;
  linked_by_user_id: string;
  created_at: string;
}

export type RequestStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "install_approved"
  | "install_running"
  | "install_succeeded"
  | "install_failed";

export type InstallScope = "repo" | "request";
export type InstallRequestStatus = "approved" | "running" | "succeeded" | "failed";

export type ReviewRunStatus = "running" | "completed" | "failed";
export type ReviewVerdict = "ready_for_pr" | "revise";

export interface RequestRow {
  id: number;
  guild_id: string;
  repo_id: number;
  channel_id: string;
  thread_id: string;
  user_id: string;
  prompt: string;
  status: RequestStatus;
  worktree_path: string | null;
  branch_name: string | null;
  created_at: string;
}

export interface ReviewRunRow {
  id: number;
  request_id: number;
  thread_id: string;
  branch_name: string;
  status: ReviewRunStatus;
  config_json: string;
  diff_base: string;
  diff_head: string;
  final_verdict: ReviewVerdict | null;
  summary_markdown: string | null;
  raw_result_json: string | null;
  artifact_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstallRequestRow {
  id: number;
  guild_id: string;
  repo_id: number;
  request_id: number | null;
  thread_id: string | null;
  package_id: string;
  package_version: string;
  scope: InstallScope;
  status: InstallRequestStatus;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  install_root: string;
  bin_path: string | null;
  env_json: string | null;
  logs: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
