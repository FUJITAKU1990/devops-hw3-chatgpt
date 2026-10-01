# HW3 Design

## Release path

1. A pull request runs the existing HW2 CI checks. A human reviews the PR and merges it to `main` only after the required checks pass.
2. The release workflow builds the four student-controlled runtime images (`auth-service`, `ticket-service`, `api-gateway`, and `frontend`). The migrator intentionally reuses the exact `auth-service` image.
3. Syft generates an SBOM for each image. Grype scans each SBOM and blocks the release when a known Critical vulnerability has a fix available.
4. Only after the vulnerability gate passes, the workflow publishes the images to GHCR and records their immutable registry digests together with the source commit and workflow run.
5. Deployment sends the Compose configuration and release record to the production VM. The VM pulls those exact digests and starts the stack with `--no-build`; it does not rebuild student-controlled artifacts.
6. The workflow compares the running container image IDs with the recorded digests and checks HTTPS reachability. Course external probes are the authoritative verification of the required core user journeys.

PR review and merge to `main` are the human approval point; no additional manual release approval is planned. Existing CI and the vulnerability gate can block deployment.

## Design choice

I use push deployment from GitHub Actions to the production VM, keeping release execution and its evidence in the repository workflow. I considered a pull-based model such as Komodo, but that would add a VM-side controller and operational state. Continuous reconciliation is not required for this single-VM application, so the additional component provides limited benefit. The trade-off is that the push workflow does not continuously detect or correct configuration drift after deployment.

## Operation and evidence

A release record identifies the source commit, workflow run, and exact GHCR digests. The deployment workflow also records the deployment action, verifies the running digests, and checks `https://17643-team11.s3d.cmu.edu/` and `/api/events`. After activation, I will add the permanent run/release links and the course external-probe evidence here.

To release, merge an approved PR to `main`. To identify production, compare the running image IDs with the release record using `scripts/verify-production-state`. To recover, manually dispatch the release workflow with the source commit of a previous known-good release; the workflow retrieves that release record, redeploys the recorded digests, and repeats verification. The same recovery path is used if a deployment fails partway through and leaves production in a partial or unhealthy state. Recovery does not rebuild images or require manual changes to containers on the VM.

The main limitation is dependence on the workflow-to-VM connection and the VM container runtime; there is no continuous reconciliation if production drifts outside the release workflow.

## Implementation status

Implemented on the HW3 working branch: release image build, Syft SBOM generation, Grype blocking gate, GHCR publication and digest recording, digest-pinned production Compose configuration, HTTPS/Caddy configuration, automated push deployment, running-digest verification, deployment evidence, and manual recovery by known-good release record.

The production VM and Compose configuration have been validated, production environment configuration is in place, and SSH key authentication for deployment has been configured. Remaining before production activation: replace every GitHub Actions `runs-on` value with the course-published self-hosted-runner labels, run the initial deployment, verify the course external probes, exercise the recovery path, and add permanent evidence links.
