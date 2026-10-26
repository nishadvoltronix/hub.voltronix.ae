"use client";
import { useEffect, useId, useState } from "react";
import type { Page } from "@/server/settings/service";

export async function readApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal });
  return decode<T>(response);
}
async function decode<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
      ? data.error : "The request could not be completed.";
    throw new Error(message);
  }
  return data as T;
}
export async function writeApi<T>(path: string, method: string, body: unknown): Promise<T> {
  const challenge = await readApi<{ csrfToken: string }>("/api/auth/csrf");
  return decode<T>(await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": challenge.csrfToken },
    body: JSON.stringify(body),
  }));
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
export function usePaged<T>(path: string, query: string, page: number) {
  const [revision, setRevision] = useState(0);
  const url = path + "?" + new URLSearchParams({ query, page: String(page), pageSize: "25" });
  const key = url + "#" + revision;
  const [result, setResult] = useState<{ key: string; data?: Page<T>; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void readApi<Page<T>>(url, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ key, data }); },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ key, error: message(error) }); },
    );
    return () => controller.abort();
  }, [key, url]);
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    loading: result?.key !== key,
    reload: () => setRevision((value) => value + 1),
  };
}
export function Pagination({ data, page, onPage }: { data?: { total: number; pageSize: number }; page: number; onPage: (page: number) => void }) {
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : page;
  return <div className="pagination">
    <button type="button" disabled={page <= 1 || !data} onClick={() => onPage(page - 1)}>Previous page</button>
    <span>Page {page} of {pages}{data ? ` · ${data.total} records` : ""}</span>
    <button type="button" disabled={!data || page >= pages} onClick={() => onPage(page + 1)}>Next page</button>
  </div>;
}
export function SearchBox({ label = "Search", onSearch }: { label?: string; onSearch: (value: string) => void }) {
  return <form className="search-form" onSubmit={(event) => {
    event.preventDefault(); onSearch(String(new FormData(event.currentTarget).get("query") ?? ""));
  }}><label>{label}<input name="query" type="search" maxLength={120} /></label><button type="submit">Search</button></form>;
}
export function RecordPicker<T extends { id: string }>({ path, label, value, selectedLabel, onChange, describe, required = true }: {
  path: string; label: string; value: string; selectedLabel?: string; onChange: (value: string) => void; describe: (row: T) => string; required?: boolean;
}) {
  const selectId = useId();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [chosen, setChosen] = useState<{ id: string; label: string }>();
  const list = usePaged<T>(path, query, page);
  return <div className="record-picker">
    <label>Find {label.toLowerCase()}<input type="search" maxLength={120} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
    <label htmlFor={selectId}>{label}</label><select id={selectId} required={required} value={value} onChange={(event) => {
      const id = event.target.value;
      const row = list.data?.items.find((item) => item.id === id);
      if (row) setChosen({ id, label: describe(row) });
      onChange(id);
    }}>
      <option value="">Select {label.toLowerCase()}</option>
      {value && !list.data?.items.some((item) => item.id === value) && <option value={value}>{chosen?.id === value ? chosen.label : selectedLabel ?? "Current selection"}</option>}
      {list.data?.items.map((item) => <option key={item.id} value={item.id}>{describe(item)}</option>)}
    </select>
    {list.loading && <p role="status">Loading choices…</p>}
    {list.error && <p role="alert" className="error">{list.error}</p>}
    <Pagination data={list.data} page={page} onPage={setPage} />
  </div>;
}

