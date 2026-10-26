import { z } from "zod";
import type { VerifiedZohoRequestPort } from "./transports.js";

export class ZohoAppUserError extends Error {
  constructor() { super("The active custom Zoho application user could not be verified."); }
}
const id = z.string().regex(/^[1-9][0-9]{0,29}$/);
const record = z.object({ id, Name: z.string().min(1).max(200).refine(value => !value.includes("\0")),
  Email: z.email().max(254).transform(value => value.toLowerCase()), user_status: z.literal("active"),
  Modified_Time: z.iso.datetime({ offset: true }) });
const responseSchema = z.object({ data: z.tuple([record]) }).strict();
export interface VerifiedZohoAppUser { externalId: string; name: string; email: string; status: "active"; modifiedTime: string }

/** Only an exact VZ_app_users record from the independently org-verified port.
 * Standard CRM Users, owner IDs, name matching and truthy status flags are not
 * application-user verification. No remote writes or collection searches. */
export async function readVerifiedZohoAppUser(port: VerifiedZohoRequestPort, externalId: string): Promise<VerifiedZohoAppUser> {
  try {
    id.parse(externalId);
    const response = await port.request({ apiVersion: "v8", method: "GET",
      path: `/VZ_app_users/${externalId}?fields=Name,Modified_Time,Email,user_status` });
    if (response.status !== 200) throw new Error();
    const row = responseSchema.parse(response.body).data[0];
    if (row.id !== externalId) throw new Error();
    return Object.freeze({ externalId: row.id, name: row.Name, email: row.Email, status: row.user_status, modifiedTime: row.Modified_Time });
  } catch { throw new ZohoAppUserError(); }
}
