# rtgs-settlement-engine

RTGS simulation on Kubernetes with Kafka, deployed by ArgoCD. Developed in GitHub Codespaces.

## Stage 1: environment (this commit)
1. Open the repo in a Codespace (4-core / 16 GB recommended). The devcontainer installs Docker,
   Node 22, kubectl, helm, k3d and the argocd CLI.
2. `make up` creates a 3-node k3d cluster and installs ArgoCD (about 3-5 minutes).
3. `make argocd-password`, then `make argocd-ui` and open port 8080 from the Ports tab (user `admin`).

The cluster is disposable. A stopped codespace keeps its files but not its running containers, so run
`make up` again after restarting; it is safe to re-run. Stop the codespace when you finish to save free hours.

## Roadmap
1. Environment (done)  2. RTGS services as manifests  3. ArgoCD root app  4. Kafka (Strimzi)  5. Consumers and drills
