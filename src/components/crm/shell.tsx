import type { AuthUser } from "@voltronix/crm-contracts";
import { CrmChrome } from "./chrome";
export function CrmShell({ user, children }: { user: AuthUser; children: React.ReactNode }) {
  return <CrmChrome user={user}>{children}</CrmChrome>;
}

