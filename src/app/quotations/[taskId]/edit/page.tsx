import { readQuotationPage } from "@/server/commercial/read-page";
import { CrmShell } from "@/components/crm/shell";
import { QuotationForm } from "@/components/crm/quotation-form";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function QuotationEditPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { user, quote } = await readQuotationPage((await params).taskId, true);
  return <CrmShell user={user}><QuotationForm quote={quote} /></CrmShell>;
}
