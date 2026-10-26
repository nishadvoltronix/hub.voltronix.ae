> Historical native-schema staging gates only. These are NOT instructions for the existing Hub/PHP database or the database-disabled Hub deployment. No native migrations or test writes may target historical CRM data. Use the current [Hub runbook](manual-deployment-guide.md); [legacy compatibility](legacy-production-compatibility.md) remains blocked.

# Isolated staging acceptance gates

All real-target checks below are **BLOCKED / NOT RUN** until the owner supplies an independently approved empty Oracle MySQL 8.4.11 target, identities and synthetic test scope. Offline tests do not satisfy them. Use the [manual guide](manual-deployment-guide.md) and [MySQL operator guide](mysql-production-operator-guide.md). Never use the preserved demo or production database as the staging fixture.

Use the single-root package and lockfile: dependency installation, `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` all run at the project root. The root README specifies local commands. Passing `npm run dev` or `npm start` proves only the intentionally database-free local startup; API readiness must remain unavailable there. Real staging requires the separately approved configured API entrypoint and distinct Next service environment in the manual guide, not the local foundation launcher.

| Gate | Required evidence |
| --- | --- |
| Target/migrations | Actual UUID/version/schema, separate exact runtime/operator privileges; fresh migration 3 then 0; exact-v1 upgrade 2 then 0; drift, wrong identity and partial DDL refuse without repair. |
| Authentication | Authorized synthetic login/logout/expiry/throttling; Secure/HttpOnly/SameSite cookies; CSRF and origin failures; no tokens in receipts. |
| Permissions | Anonymous 401, unauthorized 403, department scope, reassignment and grant revocation effective immediately; no accidental account elevation. |
| Products/deals | Create/read/search, idempotent replay, notes/stages and stale-version conflicts; bounded inputs, unauthorized writes denied. Arbitrary product deletion is not a promised endpoint. |
| Quotations | New/edit percentage-only discounts, boundaries/rounding, both approved issuers; historical values/inputs/policies unchanged; missing historical inputs refuse rather than reprice. |
| PDFs/uploads | Both approved quotation templates, licensed assets, protected download/preview, limits/malformed/active-content rejection, digest and BLOB persistence, cross-user denial; unsupported originals stay rejected. |
| Jobs/reports | All supported departments, assignments, status/logs, exports, employee reports and permission boundaries; authorized synthetic records only. |
| Transactions | Real concurrent writes, uniqueness/FKs, savepoint/full rollback, deadlocks, idempotency, uncertain commits without blind retries, process restart and connection loss. |
| HTTPS/host | Actual Nginx/systemd validation, same-origin Next-to-Express routing, direct API/DB not public, TLS renewal, service UID isolation, resource/packet/upload load. |
| Recovery | Approved encrypted backup; independent new-target restore with source unavailable; compare schema/ledger/rows/BLOBs/history/account state, reconnect matched app; measured RPO/RTO and rollback compatibility. |
| Operations | Health ready fails closed for unavailable/wrong DB; liveness separate; delivered alerts, log redaction/retention, backup age/certificate expiry and restart-loop monitoring. |

Record release/asset manifest, target identity, exact commands, expected/actual results, failures and reviewer sign-off privately. Approve synthetic authentication/data mutations explicitly before testing. Initial production account/grant provisioning is a separate unresolved owner procedure: migrations create no default administrator. Historical attachment import, Zoho synchronization and GitHub publication are not enabled by passing this matrix.
