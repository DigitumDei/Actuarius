resource "google_compute_instance" "actuarius" {
  name         = "actuarius-bot"
  machine_type = "e2-micro"
  zone         = var.gcp_zone

  boot_disk {
    initialize_params {
      # Container-Optimized OS: Docker pre-installed, minimal, auto-updates
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = 10          # GB — stays within 10 GB remaining free tier quota
      type  = "pd-standard"
    }
  }

  network_interface {
    network    = google_compute_network.vpc.self_link
    subnetwork = google_compute_subnetwork.subnet.self_link
    access_config {}    # Ephemeral public IP (free while VM is running)
  }

  # Secrets passed via instance metadata — read by startup script
  metadata = {
    env-discord-token       = var.discord_token
    env-discord-client-id   = var.discord_client_id
    env-discord-guild-id    = var.discord_guild_id
    env-gh-token            = var.gh_token
    env-claude-creds-b64    = var.claude_credentials_b64
  }

  metadata_startup_script = templatefile("${path.module}/startup.sh", {
    docker_image    = var.docker_image
    ask_concurrency = var.ask_concurrency
  })

  service_account {
    email  = google_service_account.actuarius_bot.email
    scopes = ["cloud-platform"]
  }

  tags = ["actuarius-bot"]

  # Allow Terraform to stop the VM to apply changes (e.g. metadata updates)
  allow_stopping_for_update = true
}
