import { z } from "zod";
import { exactSearchPath, externalIdSchema, multiLine, parseCommercial, singleLine } from "./validation";

const optionalText = (max: number) => singleLine(max).default("");
const dealSchema = z.object({
  firstName: singleLine(100).min(1), lastName: singleLine(100).min(1),
  companyName: singleLine(200).min(1), email: z.email().max(254),
  mobile: singleLine(40).min(1), phone: singleLine(40).min(1),
  department: z.enum(["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]),
  poBox: optionalText(100), trn: optionalText(100), address: multiLine(2_000).default(""),
  description: multiLine(10_000).default(""),
}).strict();

export type DealInput = z.infer<typeof dealSchema>;
export function parseDealInput(input: unknown): DealInput { return parseCommercial(dealSchema, input); }
export function buildAccountSearchPath(companyName: string) {
  return exactSearchPath("Accounts", "Account_Name", companyName);
}
export function buildAccountPayload(input: unknown, accountOwnerId: string) {
  const deal = parseDealInput(input);
  return { data: [{ Account_Name: deal.companyName, Phone: deal.phone, Email: deal.email,
    Owner: { id: parseCommercial(externalIdSchema, accountOwnerId) } }] };
}
export function buildContactPayload(input: unknown, accountId: string) {
  const deal = parseDealInput(input);
  return { data: [{ First_Name: deal.firstName, Last_Name: deal.lastName, Email: deal.email,
    Mobile: deal.mobile, Phone: deal.phone, Mailing_Street: deal.address,
    Account_Name: { id: parseCommercial(externalIdSchema, accountId) } }] };
}
export function buildDealPayload(input: unknown, links: {
  accountId: string; contactId: string; assignedExternalId: string;
}) {
  const deal = parseDealInput(input);
  return { data: [{
    Deal_Name: `${deal.firstName} ${deal.lastName}`, Stage: "Qualification", VZ_App_Status: "Pending",
    Description: deal.description, Email: deal.email, Mobile: deal.mobile, Phone: deal.phone,
    Account_Name: { id: parseCommercial(externalIdSchema, links.accountId) },
    Contact_Name: { id: parseCommercial(externalIdSchema, links.contactId) },
    VZ_app_user: { id: parseCommercial(externalIdSchema, links.assignedExternalId) },
    ...(deal.address ? { Address: deal.address } : {}),
    ...(deal.poBox ? { P_Box: deal.poBox } : {}), ...(deal.trn ? { TRN: deal.trn } : {}),
    Department: deal.department,
  }] };
}
