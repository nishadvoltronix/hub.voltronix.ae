import "server-only";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "../frontend-auth";
import { readQuotation, readQuotationCapabilities } from "../frontend-records";
import { canOpenQuotationEditor } from "./edit-access";
export async function readQuotationPage(taskId: string, edit = false) {
  const user = await currentUser(); if (!user) redirect("/login");
  const quote = await readQuotation(taskId);
  if (edit && !canOpenQuotationEditor(user, quote, await readQuotationCapabilities(taskId))) notFound();
  return { user, quote };
}
