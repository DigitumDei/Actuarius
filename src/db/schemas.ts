import { z } from "zod";

const dbInteger = z.number().or(z.bigint());

const requestStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "install_approved",
  "install_running",
  "install_succeeded",
  "install_failed",
]);

const reviewRunStatusSchema = z.enum(["running", "completed", "failed"]);

const reviewVerdictSchema = z.enum(["ready_for_pr", "revise"]);

const installRequestStatusSchema = z.enum(["approved", "running", "succeeded", "failed", "invalidated"]);

const installScopeSchema = z.enum(["repo", "request"]);

const aiProviderSchema = z.enum(["claude", "codex", "gemini", "opencode"]);

export const repoRowRawSchema = z.object({
  id: dbInteger,
  guild_id: z.string(),
  owner: z.string(),
  repo: z.string(),
  full_name: z.string(),
  visibility: z.string(),
  channel_id: z.string(),
  linked_by_user_id: z.string(),
  created_at: z.string(),
});

export const requestRowRawSchema = z.object({
  id: dbInteger,
  guild_id: z.string(),
  repo_id: dbInteger,
  channel_id: z.string(),
  thread_id: z.string(),
  user_id: z.string(),
  prompt: z.string(),
  status: requestStatusSchema,
  worktree_path: z.string().nullable(),
  branch_name: z.string().nullable(),
  revision_of_request_id: dbInteger.nullable(),
  status_reason: z.string().nullable(),
  created_at: z.string(),
  status_changed_at: z.string(),
  updated_at: z.string(),
});

export const reviewRunRowRawSchema = z.object({
  id: dbInteger,
  request_id: dbInteger,
  thread_id: z.string(),
  branch_name: z.string(),
  status: reviewRunStatusSchema,
  config_json: z.string(),
  diff_base: z.string(),
  diff_head: z.string(),
  final_verdict: reviewVerdictSchema.nullable(),
  summary_markdown: z.string().nullable(),
  raw_result_json: z.string().nullable(),
  artifact_path: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const installRequestRowRawSchema = z.object({
  id: dbInteger,
  guild_id: z.string(),
  repo_id: dbInteger,
  request_id: dbInteger.nullable(),
  thread_id: z.string().nullable(),
  package_id: z.string(),
  package_version: z.string(),
  scope: installScopeSchema,
  status: installRequestStatusSchema,
  requested_by_user_id: z.string(),
  approved_by_user_id: z.string().nullable(),
  install_root: z.string(),
  bin_path: z.string().nullable(),
  env_json: z.string().nullable(),
  logs: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

export const guildModelConfigRowSchema = z.object({
  guild_id: z.string(),
  provider: aiProviderSchema,
  model: z.string().nullable(),
  planner_provider: aiProviderSchema.nullable(),
  planner_model: z.string().nullable(),
  implementer_provider: aiProviderSchema.nullable(),
  implementer_model: z.string().nullable(),
  analyzer_provider: aiProviderSchema.nullable(),
  analyzer_model: z.string().nullable(),
  judge_provider: aiProviderSchema.nullable(),
  judge_model: z.string().nullable(),
  summarizer_provider: aiProviderSchema.nullable(),
  summarizer_model: z.string().nullable(),
  updated_by_user_id: z.string(),
  updated_at: z.string(),
});

export const guildReviewConfigRowRawSchema = z.object({
  guild_id: z.string(),
  rounds: dbInteger,
  analyzer_provider: aiProviderSchema.nullable(),
  analyzer_model: z.string().nullable(),
  judge_provider: aiProviderSchema.nullable(),
  judge_model: z.string().nullable(),
  summarizer_provider: aiProviderSchema.nullable(),
  summarizer_model: z.string().nullable(),
  updated_by_user_id: z.string(),
  updated_at: z.string(),
});

export const reviewerSlotRowRawSchema = z.object({
  guild_id: z.string(),
  slot_index: dbInteger,
  provider: aiProviderSchema,
  model: z.string().nullable(),
  updated_by_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const tableInfoRowSchema = z.object({
  name: z.string(),
});

export const worktreePathRowSchema = z.object({
  worktree_path: z.string(),
});

export const modelHistoryRowSchema = z.object({
  model: z.string(),
});
