import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { LeadDetail } from "./leads/contracts";
import type { JobRecord } from "./jobs/contracts";
import type { DepartmentJob } from "./departments/contracts";
import type { QuotationCapabilities, QuotationDetail } from "./commercial/persistence-contracts";
import { frontendBackend } from "./config/frontend-backend";
import { webConfig } from "./frontend-auth";
import { ExpressReadError, readExpress } from "./express-bridge";

async function source<T>(path: string, legacy: (token: string | undefined) => Promise<T>): Promise<T> {
  try {
    if (frontendBackend(process.env).mode === "express") return await readExpress<T>(path, (await cookies()).toString(), process.env);
    return await legacy((await cookies()).get(webConfig().sessionCookie)?.value);
  } catch (error) {
    const status = error instanceof ExpressReadError ? error.status
      : typeof error === "object" && error !== null && "status" in error ? error.status : 503;
    if (status === 401) redirect("/login");
    if (status === 403 || status === 404) notFound();
    throw new ExpressReadError(503);
  }
}

export function readLead(id: string): Promise<LeadDetail> {
  return source(`/api/leads/${encodeURIComponent(id)}`, async token => {
    const [{ getDatabase }, { createLeadsService }] = await Promise.all([import("./db"), import("./leads/service")]);
    return createLeadsService(getDatabase()).getLead(token, id);
  });
}
export function readJob(id: string): Promise<JobRecord> {
  return source(`/api/jobs/${encodeURIComponent(id)}`, async token => {
    const [{ getDatabase }, { createJobsService }] = await Promise.all([import("./db"), import("./jobs/service")]);
    return createJobsService(getDatabase()).getJob(token, id);
  });
}
export function readDepartmentJob(department: string, id: string): Promise<DepartmentJob> {
  return source(`/api/departments/${encodeURIComponent(department)}/jobs/${encodeURIComponent(id)}`, async token => {
    const [{ getDatabase }, { createDepartmentsService }] = await Promise.all([import("./db"), import("./departments/service")]);
    return createDepartmentsService(getDatabase()).getJob(token, department, id);
  });
}
export function readQuotation(taskId: string): Promise<QuotationDetail> {
  return source(`/api/quotations/${encodeURIComponent(taskId)}`, async token => {
    const [{ getDatabase }, { createCommercialService }] = await Promise.all([import("./db"), import("./commercial/service")]);
    return createCommercialService(getDatabase()).getQuotation(token, taskId);
  });
}
export function readQuotationCapabilities(taskId: string): Promise<QuotationCapabilities> {
  return source(`/api/quotations/${encodeURIComponent(taskId)}/capabilities`, async token => {
    const [{ getDatabase }, { createCommercialService }] = await Promise.all([import("./db"), import("./commercial/service")]);
    return createCommercialService(getDatabase()).quotationCapabilities(token, taskId);
  });
}
