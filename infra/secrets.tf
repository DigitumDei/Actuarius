resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

# Secret CONTAINERS only — never values. Values are added out-of-band with
# `gcloud secrets versions add <name> --data-file=-` so they never appear in
# terraform.tfvars, Terraform state, or saved plan files (see the 2026-07-07
# incident in docs/lessons-learned.md). scripts/redeploy.sh reads them at
# deploy time using the VM service account's access token.
locals {
  actuarius_secrets = [
    "actuarius-discord-token",
    "actuarius-gh-token",
    "actuarius-github-app-private-key",
    "actuarius-github-app-private-key-b64",
    "actuarius-claude-oauth-token",
    "actuarius-gemini-api-key",
    "actuarius-mempalace-remote-token",
  ]
}

resource "google_secret_manager_secret" "actuarius" {
  for_each  = toset(local.actuarius_secrets)
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "bot_accessor" {
  for_each  = google_secret_manager_secret.actuarius
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.actuarius_bot.email}"
}
