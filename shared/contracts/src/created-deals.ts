/** Admin::view_all_self_created_deals selects every non-null CRM creator, not
 * records created by the current actor. No remote identifiers are synthesized. */
export interface CreatedDealRecord {
  id: string;
  createdAt: string;
  qualificationNumber: string | null;
  jobNumber: string | null;
  accountName: string | null;
  status: string;
  assignedName: string | null;
  serviceCharge: string | null;
}
export interface CreatedDealsPage { items: CreatedDealRecord[]; total: number; page: number; pageSize: number }
