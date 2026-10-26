// Fixed SQL fragments for aliases t (task) and l (immutable local provenance).
// These are never built from a request, guessed filename, or historical creator.
export const localOwnershipJoin = "LEFT JOIN crm_local_tasks l ON l.task_id=t.id";
export const validLocalOwnership = `t.zoho_crm_id IS NULL AND t.assigned_to IS NULL AND t.owner_id IS NULL AND t.quote_id IS NULL
  AND t.deal_crm_created_by=l.owner_user_id AND EXISTS(SELECT 1 FROM crm_local_operations o
    WHERE o.operation_id=l.creation_operation_id AND o.task_id=t.id AND o.actor_user_id=l.owner_user_id
      AND o.kind='deal.create' AND o.remote_effect_possible=0 AND o.remote_references='{}' AND o.state='completed')`;
export const visibleOwnership = `(l.task_id IS NULL OR (${validLocalOwnership}))`;
export const localSalesScope = `((${visibleOwnership}) AND ((l.task_id IS NULL AND t.assigned_to=?) OR l.owner_user_id=?))`;
