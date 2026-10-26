"use client";

export default function ErrorPage({ retry }: { retry: () => void }) {
  return <main><p className="brand">VOLTRONIX</p><h1>Service unavailable</h1><p>Please try again shortly.</p><button type="button" onClick={retry}>Try again</button></main>;
}
