"use client";
export function CommercialPageLength({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="crm-commercial-length">Show <select className="form-select form-select-sm" aria-label={label} value={value} onChange={event => onChange(Number(event.target.value))}>
    {[10, 25, 50, 100].map(size => <option value={size} key={size}>{size}</option>)}
  </select> entries</label>;
}
export function CommercialSortHeading<T extends string>({ label, sortKey, sort, direction, onSort }: {
  label: string; sortKey: T; sort: T; direction: "asc" | "desc"; onSort: (sort: T) => void;
}) {
  return <th aria-sort={sort === sortKey ? direction === "asc" ? "ascending" : "descending" : "none"}>
    <button type="button" className="btn crm-commercial-sort" aria-label={`Sort by ${label}`} data-direction={sort === sortKey ? direction : "none"} onClick={() => onSort(sortKey)}>{label}</button>
  </th>;
}
