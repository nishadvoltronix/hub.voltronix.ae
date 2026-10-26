import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { currentUser, webConfig } from "../web-auth";
import { getDatabase } from "../db";
import { createCommercialService, CommercialPersistenceError } from "./service";
export async function readQuotationPage(taskId: string, edit = false) {
  const user = await currentUser(); if (!user) redirect("/login");
  const token = (await cookies()).get(webConfig().sessionCookie)?.value;
  let quote;
  try {
    quote = createCommercialService(getDatabase()).getQuotation(token, taskId);
  } catch (error) {
    if (error instanceof CommercialPersistenceError && error.status === 401) redirect("/login");
    if (error instanceof CommercialPersistenceError && [403, 404].includes(error.status)) notFound();
    throw new CommercialPersistenceError(503);
  }
  if (edit && (!user.permissions.some((key) => key === "leads.manage" || key === "leads.manage.agents") || !user.externalUserId || user.externalUserId !== quote.task.assignedExternalId)) notFound();
  return { user, quote };
}
