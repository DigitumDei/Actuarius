resource "google_compute_network" "vpc" {
  name                    = "actuarius-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "actuarius-subnet"
  ip_cidr_range = "10.0.0.0/24"
  region        = var.gcp_region
  network       = google_compute_network.vpc.self_link
  # IPv6 was enabled during infra experimentation. GCP does not support disabling
  # IPv6 on a subnet after it has been enabled, so this matches GCP reality.
  # The VM itself uses IPv4 only (no ipv6_access_config on the network interface).
  stack_type       = "IPV4_IPV6"
  ipv6_access_type = "EXTERNAL"
}

resource "google_compute_firewall" "allow_iap_ssh" {
  name    = "actuarius-allow-iap-ssh"
  network = google_compute_network.vpc.self_link

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # 35.235.240.0/20 is Google's reserved IAP tunnel range.
  # Port 22 is NOT exposed to the public internet — traffic is proxied
  # through Google's Identity-Aware Proxy and requires valid GCP credentials
  # (gcloud compute ssh --tunnel-through-iap). No SSH keys or open ports needed.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["actuarius-bot"]
}
