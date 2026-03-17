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

  # All config and scripts stored in metadata — the startup script is a static
  # bootstrapper that pulls the real script from metadata, so metadata changes
  # never force VM recreation.
  metadata = {
    env-discord-token       = var.discord_token
    env-discord-client-id   = var.discord_client_id
    env-discord-guild-id    = var.discord_guild_id
    env-gh-token                   = var.gh_token
    env-github-app-id              = var.github_app_id
    env-github-app-installation-id = var.github_app_installation_id
    env-github-app-private-key-b64 = var.github_app_private_key_b64
    env-claude-oauth-token  = var.claude_oauth_token
    env-docker-image        = var.docker_image
    env-ask-concurrency         = var.ask_concurrency
    env-enable-codex-execution  = var.enable_codex_execution
    env-enable-gemini-execution = var.enable_gemini_execution
    env-google-genai-use-gca    = var.google_genai_use_gca
    env-redeploy-script         = file("${path.module}/../scripts/redeploy.sh")
    env-startup-script          = file("${path.module}/startup.sh")
  }

  # Static bootstrapper — pulls the real startup script from metadata and runs it.
  # Because this string never changes, Terraform won't force-replace the VM.
  metadata_startup_script = "#!/bin/bash\nMETA=\"http://metadata.google.internal/computeMetadata/v1/instance/attributes\"\ncurl -sf -H \"Metadata-Flavor: Google\" \"$${META}/env-startup-script\" > /var/startup-inner.sh\nbash /var/startup-inner.sh\n"

  service_account {
    email  = google_service_account.actuarius_bot.email
    scopes = ["cloud-platform"]
  }

  tags = ["actuarius-bot"]

  # Allow Terraform to stop the VM to apply changes (e.g. metadata updates)
  allow_stopping_for_update = true
}
