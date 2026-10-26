export const PRODUCT_SORTS = ["name", "updatedAt"] as const;
export const QUOTATION_SORTS = ["createdAt", "quoteNumber", "dealNumber", "accountName", "dealStatus", "jobStatus", "assignedName", "subtotal"] as const;
type Direction = "asc" | "desc";
export function productListOrder(sort: typeof PRODUCT_SORTS[number], direction: Direction) {
  const column = { name: "product_name", updatedAt: "updated_at" }[sort];
  if (!PRODUCT_SORTS.includes(sort) || !column || !["asc", "desc"].includes(direction)) throw new Error("Invalid list ordering.");
  return `${column} ${direction === "desc" ? "DESC" : "ASC"},product_id ASC`;
}
export function quotationListOrder(sort: typeof QUOTATION_SORTS[number], direction: Direction, dialect: "sqlite" | "mysql", local = false) {
  const fields = { createdAt: "q.created_at", quoteNumber: "q.quote_number", dealNumber: "t.deal_number", accountName: "t.account_name",
    dealStatus: "t.status", jobStatus: "COALESCE(NULLIF(t.Job_Status,''),'Active')",
    assignedName: local ? "CASE WHEN l.task_id IS NOT NULL THEN local_owner.username ELSE u.username END" : "u.username",
    subtotal: dialect === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(q.totals_json,'$.subtotal'))" : "json_extract(q.totals_json,'$.subtotal')" };
  const column = fields[sort], order = direction === "desc" ? "DESC" : "ASC";
  if (!QUOTATION_SORTS.includes(sort) || !column || !["asc", "desc"].includes(direction) || !["sqlite", "mysql"].includes(dialect)) throw new Error("Invalid list ordering.");
  // Canonical saved subtotals are nonnegative fixed-two-place decimal strings.
  // Compare integer width then the string, never an IEEE float or bounded decimal cast.
  const width = dialect === "mysql" ? `LENGTH(SUBSTRING_INDEX(${column},'.',1))` : `CASE WHEN instr(${column},'.')=0 THEN length(${column}) ELSE instr(${column},'.')-1 END`;
  return `${sort === "subtotal" ? `${width} ${order},` : ""}${column} ${order},q.id DESC${local ? ",q.origin ASC" : ""}`;
}
