import { readQuotationPage } from "@/server/commercial/read-page";
import { CrmShell } from "@/components/crm/shell";
import { QuotationDetails } from "@/components/crm/quotations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function QuotationPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { user, quote } = await readQuotationPage((await params).taskId);
  return <CrmShell user={user}><QuotationDetails quote={quote} /></CrmShell>;
}
