import type { JobRecord } from "@voltronix/crm-contracts";
import { RecordedValue } from "./read-client";

/** Original job detail fields, rendered as saved: stage dates are not quotation issue dates. */
export function JobSourceDetails({ job }: { job: Pick<JobRecord, "accountName" | "complaintDescription" | "enquiryDate" | "quotationDate" | "customerEmail" | "customerContact"> }) {
  return <>
    <div className="card-body border-bottom"><strong className="text-danger">Description:</strong><p className="preserve-lines"><RecordedValue value={job.complaintDescription} /></p><strong className="text-danger">Account Name:</strong><p className="mb-0"><RecordedValue value={job.accountName} /></p></div>
    <div className="card-body py-3 border-bottom"><div className="row">
      {[["Inquiry Date", job.enquiryDate], ["Quotation Date", job.quotationDate], ["Customer Email", job.customerEmail], ["Contact Number", job.customerContact]].map(([label, value]) =>
        <div className="col-sm-6 my-1" key={label}><strong>{label}: </strong><RecordedValue value={value} /></div>)}
    </div></div>
  </>;
}
