import { HarnessFiles } from "../mysql-auth/files.js";
import { targetFor } from "./guard.js";

/** Reuse the audited private containment/ACL/no-link/exclusive-write rules,
 * but keep CRM fixture and approval namespaces disjoint from auth fixtures. */
export class CrmDemoFiles extends HarnessFiles {
  override approvalPath(id: string): string { targetFor(id); return `.local-data/approvals/crm-demo-${id}.json`; }
  override fixtureRoot(id: string): string { targetFor(id); return `.local-data/test/crm-demo-${id}`; }
  // operatorPath deliberately retains the explicit existing reviewed reference.
  // It is never discovered from a Next profile or created by this subclass.
}
