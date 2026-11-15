SHELL := /bin/bash
.PHONY: tools up down status argocd-ui argocd-password

tools:            ## install k3d and argocd (devcontainer does this on create)
	bash scripts/install-tools.sh

up:               ## create the cluster and install ArgoCD
	bash scripts/bootstrap.sh

down:             ## delete the cluster (data inside it is lost)
	k3d cluster delete rtgs

status:
	kubectl get nodes
	kubectl get pods -A

argocd-ui:        ## https://localhost:8080 via the Ports tab; Ctrl+C to stop
	kubectl -n argocd port-forward svc/argocd-server 8080:443 --address 0.0.0.0

argocd-password:
	@kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo

# ---- RTGS (docker compose, runs in the codespace) ----
.PHONY: rtgs-env rtgs-test rtgs-up rtgs-down rtgs-logs rtgs-ps

rtgs-env:         ## generate rtgs/.env with random secrets (once)
	bash rtgs/scripts/gen-env.sh

rtgs-test:        ## unit + e2e tests against a throwaway Postgres
	bash rtgs/scripts/test.sh

rtgs-up:          ## build and start the stack; console on port 8081
	cd rtgs && docker compose --env-file .env up -d --build --wait

rtgs-ps:
	cd rtgs && docker compose ps

rtgs-logs:
	cd rtgs && docker compose logs --tail=100 kafka event-relay event-consumer rtgs-core

rtgs-down:        ## stop the stack (add -v by hand to also wipe data)
	cd rtgs && docker compose down

# ---- Kubernetes (k3d) ----
.PHONY: secrets k8s-build k8s-local k8s-local-down k8s-status k8s-logs

secrets:          ## (re)create cluster secrets from rtgs/.env
	bash scripts/create-secrets.sh

k8s-build:        ## build the images locally and import them into k3d
	bash scripts/build-local.sh

k8s-local:        ## deploy the local overlay WITHOUT ArgoCD (do not combine with the ArgoCD app)
	bash scripts/create-secrets.sh
	kubectl apply -k gitops/overlays/local
	kubectl -n rtgs rollout status statefulset/db statefulset/kafka --timeout=300s
	kubectl -n rtgs rollout status deploy --timeout=300s

k8s-local-down:
	kubectl delete -k gitops/overlays/local --ignore-not-found

k8s-status:
	kubectl -n rtgs get pods,svc,ingress,pvc

k8s-logs:
	kubectl -n rtgs logs -l 'app in (kafka,event-relay,event-consumer,rtgs-core)' --tail=50 --prefix
