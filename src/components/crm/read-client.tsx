"use client";
import { useCallback, useEffect, useState } from "react";
import { message, readApi } from "@/components/settings/client";
export function useRead<T>(url: string | null) {
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const key = (url ?? "") + "#" + revision;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>();
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    void readApi<T>(url, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ key, data }); },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ key, error: message(error) }); },
    );
    return () => controller.abort();
  }, [url, key]);
  return { data: url !== null && result?.key === key ? result.data : undefined,
    error: url !== null && result?.key === key ? result.error : undefined,
    loading: url !== null && result?.key !== key, reload };
}
export function RecordedValue({ value }: { value: string | null | undefined }) {
  return <>{value === null || value === undefined || value === "" ? <span className="muted">Not recorded</span> : value}</>;
}

