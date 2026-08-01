resource "google_compute_disk" "boot" {
  # Snapshot-restored pd-balanced boot/stateful replacement created during the
  # 2026-08-01 I/O migration. The original pd-standard disk and the offline
  # snapshot are retained separately for rollback.
  name = "actuarius-boot-balanced-20260801"
  type = "pd-balanced"
  zone = var.gcp_zone
  size = 10

  description = "Balanced boot clone from offline snapshot; original actuarius-bot boot retained for rollback"

  snapshot = "actuarius-boot-pre-balanced-20260801-0828z"

  lifecycle {
    # The stateful COS partition holds Docker state and the swap file. Never
    # allow a routine Terraform operation to destroy this disk.
    prevent_destroy = true
  }
}

resource "google_compute_disk" "data" {
  # Snapshot-restored pd-balanced replacement created during the 2026-07-31
  # I/O migration. Keep device_name below stable so the guest mount path does
  # not depend on the provider-side disk resource name.
  name = "actuarius-data-balanced-20260731"
  type = "pd-balanced"
  zone = var.gcp_zone
  size = 10 # GB — separate persistent disk so /data survives VM deletion

  # Creation provenance for the imported replacement. Keeping this explicit
  # prevents Terraform from interpreting the snapshot-backed disk as drift.
  snapshot = "actuarius-data-pre-balanced-20260731-1530z"

  lifecycle {
    # Guard against destroy/recreate (which previously caused full data loss).
    # A size increase is an in-place update and is unaffected; this only blocks
    # Terraform from tearing the disk down. See docs/lessons-learned.md.
    prevent_destroy = true
  }
}

resource "google_compute_instance" "actuarius" {
  name         = "actuarius-bot"
  machine_type = "e2-micro"
  zone         = var.gcp_zone

  boot_disk {
    source      = google_compute_disk.boot.self_link
    auto_delete = false
  }

  attached_disk {
    source      = google_compute_disk.data.self_link
    device_name = "actuarius-data"
  }

  network_interface {
    network    = google_compute_network.vpc.self_link
    subnetwork = google_compute_subnetwork.subnet.self_link
    access_config {} # Ephemeral public IP (free while VM is running)
  }

  # All config and scripts stored in metadata — the startup script is a static
  # bootstrapper that pulls the real script from metadata, so metadata changes
  # never force VM recreation.
  # Metadata carries NON-SECRET config only. Secret values (Discord token,
  # GitHub App key, Claude OAuth token, API keys, federation token) live in
  # Secret Manager (see secrets.tf) and are fetched by redeploy.sh at deploy
  # time — never through Terraform, so they cannot leak via tfvars, state, or
  # plan files.
  metadata = {
    # COS built-in Cloud Logging agent: streams all container stdout/stderr to
    # Cloud Logging so logs are readable without SSH (needs logging.logWriter).
    google-logging-enabled = "true"

    env-discord-client-id                = var.discord_client_id
    env-discord-guild-id                 = var.discord_guild_id
    env-github-app-id                    = var.github_app_id
    env-github-app-installation-id       = var.github_app_installation_id
    env-docker-image                     = var.docker_image
    env-ask-concurrency                  = var.ask_concurrency
    env-request-stuck-timeout-ms         = var.request_stuck_timeout_ms
    env-request-stuck-scan-interval-ms   = var.request_stuck_scan_interval_ms
    env-container-memory                 = var.container_memory
    env-container-memory-swap            = var.container_memory_swap
    env-container-cpus                   = var.container_cpus
    env-container-pids-limit             = var.container_pids_limit
    env-enable-codex-execution           = var.enable_codex_execution
    env-enable-gemini-execution          = var.enable_gemini_execution
    env-enable-opencode-execution        = var.enable_opencode_execution
    env-enable-mempalace                 = var.enable_mempalace
    env-enable-mempalace-remote          = var.enable_mempalace_remote
    env-mempalace-embedding-profile      = var.mempalace_embedding_profile
    env-mempalace-remote-url             = var.mempalace_remote_url
    env-mempalace-remote-bind            = var.mempalace_remote_bind
    env-mempalace-remote-name            = var.mempalace_remote_name
    env-mempalace-remote-timeout-ms      = var.mempalace_remote_timeout_ms
    env-mempalace-remote-mine-on-sync    = var.mempalace_remote_mine_on_sync
    env-mempalace-remote-mine-timeout-ms = var.mempalace_remote_mine_timeout_ms
    env-mempalace-remote-mine-batch-size = var.mempalace_remote_mine_batch_size
    env-redeploy-script                  = file("${path.module}/../scripts/redeploy.sh")
    env-startup-script                   = file("${path.module}/startup.sh")
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
