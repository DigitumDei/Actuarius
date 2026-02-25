resource "google_compute_disk" "data" {
  name = "actuarius-data"
  type = "pd-standard"
  zone = var.gcp_zone
  size = 10 # GB — separate persistent disk so /data survives VM deletion
}

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

  attached_disk {
    source      = google_compute_disk.data.self_link
    device_name = "actuarius-data"
  }

  network_interface {
    network    = google_compute_network.vpc.self_link
    subnetwork = google_compute_subnetwork.subnet.self_link
    access_config {}    # Ephemeral public IP (free while VM is running)
  }

  # All config passed via metadata — read by startup script at runtime.
  # This keeps metadata_startup_script static so changes here don't force VM recreation.
  metadata = {
    env-discord-token       = var.discord_token
    env-discord-client-id   = var.discord_client_id
    env-discord-guild-id    = var.discord_guild_id
    env-gh-token            = var.gh_token
    env-claude-oauth-token  = var.claude_oauth_token
    env-docker-image        = var.docker_image
    env-ask-concurrency     = var.ask_concurrency
  }

  metadata_startup_script = replace(file("${path.module}/startup.sh"), "\r\n", "\n")

  service_account {
    email  = google_service_account.actuarius_bot.email
    scopes = ["cloud-platform"]
  }

  tags = ["actuarius-bot"]

  # Allow Terraform to stop the VM to apply changes (e.g. metadata updates)
  allow_stopping_for_update = true
}
