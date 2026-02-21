export interface GuildRow {
  id: string;
  name: string;
  created_at: string;
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

export type RequestStatus = "queued" | "running" | "succeeded" | "failed";

export interface RequestRow {
  id: number;
  guild_id: string;
  repo_id: number;
  channel_id: string;
  thread_id: string;
  user_id: string;
  prompt: string;
  status: RequestStatus;
  created_at: string;
}
