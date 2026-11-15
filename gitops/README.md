gitops/base            manifests for every service (images are placeholders such as `rtgs-core`)
gitops/overlays/dev    what ArgoCD deploys: ghcr.io images, tagged by CI with the commit SHA
gitops/overlays/local  local images (tag `dev`) for testing without ArgoCD or a registry
gitops/apps            ArgoCD Applications; gitops/root-app.yaml is the app-of-apps that watches this folder
Secrets are NOT in Git: scripts/create-secrets.sh creates them in the cluster from rtgs/.env.
