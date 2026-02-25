output "instance_ip" {
  description = "External IP of the Actuarius VM (ephemeral — changes on stop/start)"
  value       = google_compute_instance.actuarius.network_interface[0].access_config[0].nat_ip
}

output "ssh_command" {
  description = "Command to SSH into the VM via IAP (no open port 22 needed)"
  value       = "gcloud compute ssh actuarius-bot --zone ${var.gcp_zone} --project ${var.gcp_project_id} --tunnel-through-iap"
}

output "logs_command" {
  description = "Command to tail bot logs via IAP"
  value       = "gcloud compute ssh actuarius-bot --zone ${var.gcp_zone} --project ${var.gcp_project_id} --tunnel-through-iap --command=\"docker logs actuarius --tail 100 -f\""
}
