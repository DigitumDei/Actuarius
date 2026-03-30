variable "gcp_project_id" {
  type        = string
  description = "GCP project ID"
}

variable "gcp_region" {
  type        = string
  description = "GCP region (must be us-west1, us-central1, or us-east1 for free tier)"
  default     = "us-east1"
}

variable "gcp_zone" {
  type        = string
  description = "GCP zone within the region"
  default     = "us-east1-b"
}

variable "docker_image" {
  type        = string
  description = "Docker image to run (from ghcr.io)"
  default     = "ghcr.io/digitumdei/actuarius:latest"
}

variable "ask_concurrency" {
  type        = number
  description = "Max concurrent /ask requests per guild. Keep at 1 on e2-micro to avoid OOM."
  default     = 1
}

variable "discord_token" {
  type      = string
  sensitive = true
}

variable "discord_client_id" {
  type      = string
  sensitive = true
}

variable "discord_guild_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional: guild-scoped command registration for dev. Leave empty for global commands."
}

variable "gh_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional fallback: GitHub personal access token. Prefer GitHub App auth instead."
}
variable "github_app_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "GitHub App ID for bot authentication."
}
variable "github_app_installation_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "GitHub App installation ID."
}
variable "github_app_private_key_b64" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Base64-encoded GitHub App private key (.pem)."
}

variable "claude_oauth_token" {
  type        = string
  sensitive   = true
  description = "Long-lived Claude OAuth token — generate with: claude setup-token"
}

variable "enable_codex_execution" {
  type        = bool
  default     = false
  description = "Enable Codex CLI execution for /ask requests"
}

variable "enable_gemini_execution" {
  type        = bool
  default     = false
  description = "Enable Gemini CLI execution for /ask requests"
}

variable "gemini_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Gemini API key required when Gemini execution is enabled"
}
