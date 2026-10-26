"use client";
import Link from "next/link";
import { useId, useState } from "react";
import { PIPELINE_STAGES, type LeadPage, type PipelineAgent, type PipelineResult } from "@/server/leads/contracts";
import { Pagination } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
export function Pipeline({ forcedOwn, initialOwn = false, showAgentFilter = false }: { forcedOwn: boolean; initialOwn?: boolean; showAgentFilter?: boolean }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [stage, setStage] = useState("all");
  const [own, setOwn] = useState(forcedOwn || initialOwn);
  const [agentId, setAgentId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [agentPage, setAgentPage] = useState(1);
  const agentSelectId = useId();
  const searchId = useId();
  const scope = own ? "own" : "default";
  const params = new URLSearchParams({ query, page: String(page), pageSize: "25", stage, scope });
  if (agentId) params.set("agentId", agentId);
  const result = useRead<PipelineResult>("/api/pipeline?" + params);
  const agents = useRead<LeadPage<PipelineAgent>>("/api/pipeline/agents?" + new URLSearchParams({ query: agentSearch, page: String(agentPage), pageSize: "25", scope }));
  const stages = [...PIPELINE_STAGES, { key: "other", label: "Other stages" }];
  const stageLabels: Record<string, string> = { qualification: "Qualification", siteVisit: "Site Visit", proposal: "Proposal", won: "Closed Won", lost: "Lost", other: "Other stages" };
  const agentSelector = <select className="form-control" id={agentSelectId} value={agentId} onChange={(event) => {
    const value = event.target.value; setAgentId(value); setAgentName(agents.data?.items.find((item) => item.externalId === value)?.name ?? "Selected agent"); setPage(1);
  }}>
    <option value="">{showAgentFilter ? "All Agents" : "All allowed agents"}</option>{!own && <option value="unassigned">{showAgentFilter ? "Not Assigned" : "Unassigned"}</option>}
    {agentId && agentId !== "unassigned" && !agents.data?.items.some((item) => item.externalId === agentId) && <option value={agentId}>{agentName}</option>}
    {agents.data?.items.map((agent) => <option key={agent.externalId} value={agent.externalId}>{agent.name}</option>)}
  </select>;
  const agentSearchInput = <label>Find an agent<input className="form-control" type="search" value={agentSearch} maxLength={120} onChange={(event) => { setAgentSearch(event.target.value); setAgentPage(1); }} /></label>;
  const agentPageControls = <>
    {agents.error && <p role="alert" className="error">{agents.error}</p>}
    <Pagination data={agents.data} page={agentPage} onPage={setAgentPage} />
  </>;
  return <div className="crm-stack crm-pipeline">
    <div className={"pipeline-toolbar" + (showAgentFilter ? " pipeline-agent-view" : "")}><span className="field-hint">{result.data?.scope === "own" || own ? "Your assigned leads" : "All leads you can view"}</span>
      {showAgentFilter && <div className="pipeline-agent-picker"><label className="visually-hidden" htmlFor={agentSelectId}>Assigned agent</label>{agentSelector}</div>}
      <form className="pipeline-search-form" onSubmit={(event) => { event.preventDefault(); setQuery(String(new FormData(event.currentTarget).get("query") ?? "")); setPage(1); }}>
        <label className="visually-hidden" htmlFor={searchId}>Search leads</label><div className="input-group"><button className="input-group-text bg-white" type="submit" aria-label="Search leads"><i className="ph ph-magnifying-glass" aria-hidden="true" /></button><input className="form-control" id={searchId} name="query" type="search" maxLength={120} placeholder="Search leads..." /></div>
      </form>
    {showAgentFilter && <details className="pipeline-agent-search-options"><summary>Find an agent</summary><div className="pipeline-filters panel">{agentSearchInput}{agentPageControls}</div></details>}
    <details className="pipeline-filter-options"><summary>Filters</summary><div className="pipeline-filters panel">
      <label className="check-option"><input type="checkbox" checked={own} disabled={forcedOwn} onChange={(event) => { setOwn(event.target.checked); setAgentId(""); setPage(1); setAgentPage(1); }} />Only my assigned leads</label>
      {!showAgentFilter && <details><summary>Filter by agent</summary>
        {agentSearchInput}
        <label htmlFor={agentSelectId}>Assigned agent</label>
        {agentSelector}
        {agentPageControls}
      </details>}
    <div className="stage-filters" role="group" aria-label="Pipeline stages">
      <button type="button" className={stage === "all" ? "" : "secondary"} aria-pressed={stage === "all"} onClick={() => { setStage("all"); setPage(1); }}>All stages</button>
      {stages.map((item) => <button type="button" key={item.key} aria-pressed={stage === item.key} className={stage === item.key ? "" : "secondary"} onClick={() => { setStage(item.key); setPage(1); }}>
        {item.label}{result.data ? " (" + result.data.counts[item.key as keyof PipelineResult["counts"]] + ")" : ""}
      </button>)}
    </div></div></details></div>
    {result.loading && <p role="status">Loading leads…</p>}
    {result.error && <p role="alert" className="error">{result.error}</p>}
    {result.data && <>
      <div className="pipeline-board" role="region" aria-label="Lead pipeline board" tabIndex={0}>{stages.filter((item) => (stage === "all" && (item.key !== "other" || result.data!.counts.other > 0)) || stage === item.key).map((column) => <section className="pipeline-column" key={column.key} aria-label={column.label}>
        <div className={`pipeline-header ${column.key === "won" ? "bg-yellow-500" : column.key === "lost" ? "bg-pink-500" : "bg-secondary"} d-flex justify-content-between align-items-center`}>
          <div><h2 className="text-white mb-0">{stageLabels[column.key]}</h2><small className="text-gray-100">{column.key === "qualification" ? "Early discussion" : column.key === "siteVisit" ? "Inspection" : column.key === "proposal" ? "Awaiting approval" : "Confirmed"}</small></div>
          <span className="pipeline-count">{result.data!.counts[column.key as keyof PipelineResult["counts"]]}</span>
        </div>
        <div className="pipeline-body">{result.data!.items.filter((lead) => lead.stage === column.key).map((lead) => <article className={`lead-card ${lead.stage === "won" ? "lead-won" : lead.stage === "lost" ? "lead-lost" : ""}`} key={lead.id}>
          <p className="lead-title mb-0"><RecordedValue value={lead.accountName} /></p>
          <h3 className="lead-title text-muted mb-0">{lead.dealName}</h3>
          <p className="lead-sub"><i className="ph ph-hash me-1" aria-hidden="true" /><RecordedValue value={lead.displayNumber} /></p>
          <p className="lead-sub mt-2"><i className="ph ph-user-circle me-1" aria-hidden="true" /><RecordedValue value={lead.assignedName} /></p>
          <p className="lead-value text-success"><i className="ti ti-currency-dirham me-1" aria-hidden="true" /><RecordedValue value={lead.serviceCharge} /> AED</p>
          <div className="lead-meta"><span className={`badge ${lead.stage === "won" ? "bg-warning" : lead.stage === "lost" ? "bg-dangers" : lead.stage === "siteVisit" ? "bg-danger" : lead.stage === "proposal" ? "bg-success" : "bg-primary"}`}>{lead.status || "Not recorded"}</span><Link className="btn btn-sm btn-outline-secondary" href={"/leads/" + lead.id} aria-label={`View ${lead.dealName}`}>View Details</Link></div>
        </article>)}
        {!result.data!.items.some((lead) => lead.stage === column.key) && <p className="muted">No matching leads on this page.</p>}</div>
      </section>)}</div>
      <Pagination data={result.data} page={page} onPage={setPage} />
    </>}
  </div>;
}

