resource "google_compute_network" "vpc" {
  name                    = "actuarius-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "actuarius-subnet"
  ip_cidr_range = "10.0.0.0/24"
  region        = var.gcp_region
  network       = google_compute_network.vpc.self_link
}

resource "google_compute_firewall" "allow_iap_ssh" {
  name    = "actuarius-allow-iap-ssh"
  network = google_compute_network.vpc.self_link

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # Google's IAP tunnel source range — required for gcloud compute ssh --tunnel-through-iap
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["actuarius-bot"]
}
