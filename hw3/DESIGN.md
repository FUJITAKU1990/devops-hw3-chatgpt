# HW3 Design

## Release path

PR
↓
Existing HW2 CI checks
↓
Human review → Merge to main
↓
Build release images for student-controlled components
↓
Syft SBOM → Grype vulnerability scan
├─ Critical vulnerability with a fix available → BLOCK
↓
Store images in GHCR + record their digests
↓
Push the exact images to the production VM
↓
External health check + smoke test
├─ FAIL → Release failed
↓
Release successful

PR review and merge to `main` are the human approval point; no additional manual release approval is required. After the merge, the release process is automated. Existing HW2 checks and the vulnerability gate can block deployment.

## Design choice

I will use push deployment from GitHub Actions to the production VM, keeping CI and release execution in one pipeline and making the path for production changes explicit.

I considered a pull-based deployment model such as Komodo. Pull would require an additional VM-side agent or deployment controller and its operational state to be managed. For this application, continuous reconciliation is not required, so that additional component provides limited benefit. The trade-off is that the push workflow will not continuously detect or correct configuration drift after deployment.

## Operation and evidence

Release images will be built once from the `main` commit and stored in GHCR. Production will deploy the same images by digest rather than rebuilding them, linking the running artifacts to their source commit.

GitHub Actions will record the source commit, image digests, pipeline/deployment result, and smoke-test result. The running digests on the VM can be compared with this record. I will not add a separate release-management system; this limits centralized management and auditing if the deployment grows to many environments or releases.

Recovery will be manual. After investigating a failure, I can redeploy a previous known-good set of digests through the release workflow and verify recovery with the external smoke test.

## Implementation plan

The existing GitHub Actions CI, Docker/Compose setup, automated checks, and secret handling already work. HW3 will add release artifact management, the Syft/Grype gate, push deployment, external smoke testing, and manual recovery. The exact production smoke-test operations remain to be finalized.
