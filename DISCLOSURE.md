# AI Use Disclosure

## HW1-A

I used ChatGPT as a review and investigation assistant, while I developed the initial defect hypotheses and testing approach myself.

For defect investigation, I first identified possible issues based on my own observations and reasoning. These included whether frontend and backend restrictions were inconsistent, whether application state could be overwritten during an active session, and whether related rules were implemented consistently across different layers of the application. I then used ChatGPT to inspect the relevant implementation, trace behavior across components, and evaluate whether the code supported or contradicted my hypotheses. Based on that analysis, I personally reproduced each behavior in the running application and verified the evidence before preparing the defect reports.

For automated testing, I developed the test scenarios based on the idea of a pre-operation health check, similar to the morning health-check batch jobs used in production systems. I selected behaviors that I considered necessary to confirm that this application was functioning correctly, including a normal customer path and important limits or error conditions. I used ChatGPT to review these test ideas, identify missing cases, and help refine the test implementation. I personally ran the tests, interpreted the results, and confirmed that `./scripts/check` completed successfully.

I made the final decisions about which behaviors qualified as defects, which tests to retain, and what evidence and explanations to include. I also reviewed the final output and removed credentials and other sensitive information before submission.

## HW1-B

For HW1-B, I implemented fixes for the three approved defects based on the behavior and evidence I had already confirmed in HW1-A.

For the checkout-pricing defect, I fixed the server to use the authoritative ticket price instead of trusting the client-supplied total. For the General Admission limit defect, I added server-side `maxPerOrder` validation and boundary tests for quantities above and exactly at the limit. For the reservation-expiry defect, I used a configurable timeout so the expiration behavior could be tested without waiting for the full production hold period.

I used ChatGPT mainly to review the relevant code paths, challenge my proposed fixes, and check the regression-test coverage. I made the final implementation and testing decisions myself.

I developed the fixes in three independent branches and submitted separate pull requests for each approved issue. After merging them, I resolved the merge conflicts, rebuilt the services, and personally ran `./scripts/check` on the final `main` branch. All 12 automated tests passed.

## HW2-A

For HW2-A, I used ChatGPT as a review and analysis assistant, while I made the high-level design decisions and all final judgments myself.

For the CI design, I first determined the overall structure based on principles covered in class. I decided to run inexpensive checks first, defer heavier processing to later stages, and separate type-checking to improve performance. After drafting the initial workflow, I asked ChatGPT to review the job dependencies and the details of the .yml configuration. I incorporated its feedback to refine job ordering and conditional execution, and I finalized the CI design myself.

For the hw2-safe and hw2-unsafe test suites, I chose to base the testing approach on the work from HW1. I decided to focus on areas that are critical to the service's correctness. ChatGPT proposed several concrete test cases, including boundary tests for minimum quantities and regression tests for client-side price tampering. I evaluated these suggestions and selected the ones I considered appropriate. All decisions about which tests to include or remove were made by me.

During development, ChatGPT helped identify that the hw2-unsafe branch had been created from an outdated commit. Merging it as-is would have caused inconsistencies with the current CI and test configuration. To avoid this, I recreated the branch from the latest main and reapplied the necessary changes. This ensured that the work remained aligned with the updated project structure.

## HW2-B

For HW2-B, I used Claude as a review and implementation assistant, while I made all final design decisions myself.

I identified hardcoded weak defaults in docker-compose.yml and database/src/fixtures.ts through investigation with Claude, judged which needed containment versus which were benign, and implemented the fixes myself (required env vars, blanked .env.example, CI-generated random values).

Categories 3-5 (secrets-scan, guardrails-check, ci-integrity-check) were drafted by Claude, then reviewed, tested, and committed by me. I decided to pin the gitleaks version rather than auto-track it. Discussing self-weakening risks with Claude led me to add a mutual cross-check between ci-integrity-check and check-secret-guardrails.

One concrete issue: requiring POSTGRES_PASSWORD in docker-compose.yml missed that it was also used to build DATABASE_URL in three separate places (migrator, auth-service, ticket-service); reviewing with Claude surfaced all three.

A full re-review with Claude, independent of my prior judgments, found two real gaps: the Release Operator/Support Agent bcrypt hashes matched plaintext still visible in git history (not actually rotated), and JWT_SECRET, DATABASE_URL, and TARTANPAY_API_KEY still had hardcoded fallbacks in application code, bypassing the docker-compose.yml containment entirely. I rotated the credentials, removed the fallbacks, and extended check-secret-guardrails to catch this pattern going forward. The same review found and fixed a ref: flow-mapping gap and an indentation-dependent job count in ci-integrity-check's own detectors.

Finally, I had Claude consolidate the CI's per-variable secret generation into one script (also wired into the Dev Container), and overlap the Docker build with host-side install/build/type-check to speed up CI. I tested each change, including regression-testing guardrails by reintroducing each weakness, before merging.

After Checkpoint B, since the assignment states the additional mistakes are staff-injected and undefined in advance, I had Claude find verifiable improvements in the real code rather than guess at a fixed list.

For the speed bonus, Claude added non-root Docker users, least-privilege permissions: blocks, and a static .env/.gitignore check (bonus-hardening-check); reviewing this surfaced a real regression I fixed myself, where checkout accepted a zero or negative ticket quantity. A shared base image removed duplicate package builds for a small real speedup, while a healthcheck-timing change showed no benefit and was reverted. Measured ci runtime ranged 2m32s-3m01s — usually within 3 minutes but not reliably, so I decided against a larger rebuild.

For the mistake-classification bonus, reviewing ticket-service's real code found that an unvalidated parseInt(:id) (including NaN) and non-numeric ticket-type keys in checkout were passed straight into TypeORM queries, risking an unhandled 500 instead of 400. I added Number.isInteger guards and regression tests for both.

## HW3

For the HW3 design baseline, I used ChatGPT to review the assignment criteria, inspect the existing HW2 Compose and CI configuration, and refine the release path and evidence plan.
