# rtgs-settlement-engine

RTGS simulation on Kubernetes with Kafka, deployed by ArgoCD. Developed in GitHub Codespaces.

## Stage 1: environment (this commit)
1. Open the repo in a Codespace (4-core / 16 GB recommended). The devcontainer installs Docker,
   Node 22, kubectl, helm, k3d and the argocd CLI.
2. `make up` creates a 3-node k3d cluster and installs ArgoCD (about 3-5 minutes).
3. `make argocd-password`, then `make argocd-ui` and open port 8080 from the Ports tab (user `admin`).

The cluster is disposable. A stopped codespace keeps its files but not its running containers, so run
`make up` again after restarting; it is safe to re-run. Stop the codespace when you finish to save free hours.

## Stage 2: RTGS on Kubernetes, deployed by ArgoCD
```
git push --> GitHub Actions: lint, test, build, Trivy scan --> push images to ghcr.io (tag = commit SHA)
                                                          --> bump tags in gitops/overlays/dev (commit)
ArgoCD (in the k3d cluster) watches gitops/ in Git and syncs it. Nothing connects into the codespace.
```
- `rtgs/`      the application (services, tests, docker compose for plain-Docker runs)
- `gitops/`    Kubernetes manifests (Kustomize): `base`, `overlays/dev` (ArgoCD), `overlays/local` (no ArgoCD)
- `.github/workflows/ci.yml`   the pipeline

First run, in the codespace:
1. `make rtgs-env`        random secrets in `rtgs/.env` (never committed)
2. `make up`              cluster + ArgoCD + secrets + the root app
3. Push to `main`; when CI is green the images exist and ArgoCD rolls them out.
   If the ghcr.io packages are private, either make them public (Package settings) or export
   `GHCR_PULL_TOKEN` (a PAT with read:packages) before `make up`.
4. Console: port 8081 in the Ports tab. ArgoCD: `make argocd-ui`, port 8080.

Try it before CI exists (no ArgoCD, no registry): `make k8s-build && make k8s-local`, then `make k8s-status`.
Do not run the local overlay and the ArgoCD app at the same time; they manage the same namespace.

## Roadmap
1. Environment (done)  2. RTGS on Kubernetes + CI/CD (this stage)  3. Kafka consumers (reporting, notifications)  4. Drills (pod kill, lag, poison message, bad sync)
