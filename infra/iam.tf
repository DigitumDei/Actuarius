resource "google_service_account" "actuarius_bot" {
  account_id   = "actuarius-bot"
  display_name = "Actuarius Bot"
}

# Lets the COS Cloud Logging agent ship container logs to Cloud Logging.
resource "google_project_iam_member" "bot_log_writer" {
  project = var.gcp_project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.actuarius_bot.email}"
}
