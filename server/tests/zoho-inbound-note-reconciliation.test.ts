import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import { applyZohoInboundChanges } from "../src/integrations/zoho/inbound-apply.js";
import { normalizeZohoInboundRecord } from "../src/integrations/zoho/inbound-snapshot.js";
import { parseZohoInboundChangeSet } from "../src/integrations/zoho/inbound-sync-contracts.js";
import type { ZohoInboundLease } from "../src/integrations/zoho/inbound-store.js";

const oldTime="2026-09-24T06:41:13.000Z",startedAt="2026-10-21T06:00:00.000Z";
const note=normalizeZohoInboundRecord("Notes",{id:"3001",Note_Title:"Historical conversion note",Note_Content:"Original history",
  Parent_Id:{id:"2001",module:{api_name:"Deals"}},Created_Time:oldTime,Modified_Time:oldTime});
const lease:ZohoInboundLease={organizationId:"9001",principalId:"1",runId:"01234567-89ab-4def-8123-456789abcdef",generation:3,
  startedAt,watermark:"2026-10-21T05:55:00.000Z",since:"2026-10-21T05:50:00.000Z",leaseMs:300_000};
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function changes(value=note) {
  return parseZohoInboundChangeSet({schemaVersion:1,profile:"voltronix-inbound-v1",organizationId:lease.organizationId,
    startedAt,since:lease.since,nextWatermark:startedAt,complete:true,snapshotConsistent:false,requestsPerformed:11,excludedOtherModuleNotes:0,
    coverage:{notesDeletions:false,quoteFinancials:"source-only",deletionRetentionDays:60},products:[],deals:[],notes:[value],quotes:[],appUsers:[],tombstones:[]});
}
function fixture(imported=true,sourceNotes=[note]) {
  const locals=new Map<string,Record<string,unknown>>(),savedRows=new Map<string,Record<string,unknown>>();
  const parents=new Map(sourceNotes.map((value,index)=>[value.dealId,String(index+1)]));
  for(const [index,value] of sourceNotes.entries())if(imported) {
    const localId=String(index+11),projection={note_title:value.title,note_content:value.content};
    locals.set(value.externalId,{externalId:value.externalId,localId,parentExternalId:value.dealId,...projection});
    savedRows.set(value.externalId,{organization_id:lease.organizationId,module_api_name:"Notes",external_id:value.externalId,
      local_id:localId,task_id:parents.get(value.dealId),origin:"imported",state:"active",reason:null,source_created_at:value.createdAt,source_modified_at:value.modifiedAt,
      source_hash:digest(value),source_json:JSON.stringify(value),applied_hash:digest(projection),applied_json:JSON.stringify(projection),
      last_run_id:"previous-run",last_synced_at:"2026-10-20T06:00:00.000Z"});
  }
  const mutations:{sql:string;values:unknown[]}[]=[],journals:Record<string,unknown>[]=[];
  const bulkReads:{sql:string;values:unknown[]}[]=[];
  const savedFields=["local_id","task_id","state","reason","source_created_at","source_modified_at","source_hash","source_json","applied_hash","applied_json","last_run_id","last_synced_at"];
  const db={inTransaction:true,prepare(sql:string){return{
    all:async(...values:unknown[])=>{
      if(sql.includes("FROM crm_zoho_sync_records WHERE organization_id=?"))return [...savedRows.values()];
      if(sql.includes("FROM crm_lead_operations"))return journals;
      if(sql.includes("FROM crm_commercial_operations")||sql.includes("FROM crm_zoho_user_bindings"))return [];
      if(sql.includes("FROM job_notes WHERE zoho_note_id IN")) {
        bulkReads.push({sql,values});return values.flatMap(value=>locals.has(String(value))?[locals.get(String(value))]:[]);
      }
      if(sql.includes("FROM tasks WHERE zoho_crm_id IN")) {
        bulkReads.push({sql,values});return values.flatMap(value=>parents.has(String(value))?[{externalId:String(value),id:parents.get(String(value))}]:[]);
      }
      assert.fail("Unexpected note reconciliation collection read");
    },
    get:async(...values:unknown[])=>{
      if(sql.startsWith("SELECT 1 FROM crm_zoho_sync_records"))return savedRows.has(String(values.at(-1)))?{exists:1}:undefined;
      assert.fail("Unexpected note reconciliation lookup");
    },
    run:async(...values:unknown[])=>{
      mutations.push({sql,values});
      if(sql.startsWith("INSERT INTO job_notes(")) {
        const names=/^INSERT INTO job_notes\(([^)]+)\)/.exec(sql)![1]!.split(",");
        const row=Object.fromEntries(names.map((name,index)=>[name,values[index]]));locals.set(String(row.zoho_note_id),{...row,externalId:row.zoho_note_id,localId:"11",parentExternalId:row.deal_id});
      }else if(sql.startsWith("INSERT INTO crm_zoho_sync_records"))savedRows.set(String(values[2]),{organization_id:values[0],module_api_name:values[1],external_id:values[2],origin:values[3],
        ...Object.fromEntries(savedFields.map((field,index)=>[field,values[index+4]]))});
      else if(sql.startsWith("UPDATE crm_zoho_sync_records"))savedRows.set(String(values.at(-1)),{...savedRows.get(String(values.at(-1))),...Object.fromEntries(savedFields.map((field,index)=>[field,values[index]]))});
      else if(!sql.startsWith("UPDATE tasks SET version=version+1")&&!sql.startsWith("INSERT INTO crm_zoho_sync_runs")&&!sql.startsWith("INSERT INTO crm_zoho_sync_events"))assert.fail("Unexpected note reconciliation mutation");
      return{changes:1,lastInsertRowid:11};
    },
  };}} as unknown as MysqlDatabase;
  return{db,mutations,journals,bulkReads,parents,local:()=>locals.get(note.externalId),saved:()=>savedRows.get(note.externalId)};
}

test("OFFLINE repeated historical Notes keep complete run receipts without duplicate note/provenance/event writes",async()=>{
  const f=fixture(),original=structuredClone(f.saved());
  for(let pass=0;pass<3;pass++) {
    const result=await applyZohoInboundChanges(f.db,{...lease,generation:lease.generation+pass},changes(),startedAt);
    assert.deepEqual(result,{counts:{read:1,applied:0,skipped:1,conflicts:0,deleted:0},partial:false});
  }
  assert.equal(f.mutations.length,3);assert.ok(f.mutations.every(value=>value.sql.startsWith("INSERT INTO crm_zoho_sync_runs")));
  for(const mutation of f.mutations){assert.equal(mutation.values[10],digest(changes()));assert.equal(JSON.parse(String(mutation.values[11])).read,1);}
  assert.deepEqual(f.saved(),original);assert.equal(f.local()?.note_content,note.content);
});

test("OFFLINE a newly discovered old converted Note imports with original dates and repeats without extra audit rows",async()=>{
  const f=fixture(false),result=await applyZohoInboundChanges(f.db,lease,changes(),startedAt);
  assert.equal(result.counts.applied,1);assert.equal(result.partial,false);
  assert.equal(f.local()?.created_at,oldTime);assert.equal(f.local()?.updated_at,oldTime);assert.equal(f.local()?.parentExternalId,note.dealId);
  const noteEvents=f.mutations.filter(value=>value.sql.startsWith("INSERT INTO crm_zoho_sync_events"));assert.equal(noteEvents.length,1);
  const previous=f.mutations.length;
  const again=await applyZohoInboundChanges(f.db,lease,changes(),startedAt);assert.equal(again.counts.skipped,1);
  assert.deepEqual(f.mutations.slice(previous).map(value=>value.sql.startsWith("INSERT INTO crm_zoho_sync_runs")),[true]);
});

test("OFFLINE newer source times remain audited even when the Note projection is unchanged",async()=>{
  const f=fixture(),modifiedAt="2026-10-21T05:59:00.000Z";
  const result=await applyZohoInboundChanges(f.db,lease,changes({...note,modifiedAt}),startedAt);
  assert.equal(result.partial,false);assert.equal(result.counts.skipped,1);
  assert.equal(f.saved()?.source_modified_at,modifiedAt);assert.equal(f.saved()?.last_synced_at,startedAt);
  assert.equal(f.mutations.filter(value=>value.sql.startsWith("UPDATE crm_zoho_sync_records")).length,1);
  assert.equal(f.mutations.filter(value=>value.sql.startsWith("INSERT INTO crm_zoho_sync_events")).length,1);
  assert.equal(f.local()?.note_content,note.content);
});

test("OFFLINE exact-source Notes still validate local changes, parent identity and pending operations before deduplication",async()=>{
  for(const [scenario,reason] of [["local","LOCAL_PROJECTION_CHANGED"],["source","SAME_TIMESTAMP_CHANGED"],
    ["parent","PARENT_UNAVAILABLE"],["pending","PENDING_OUTBOUND_OPERATION"]] as const) {
    const f=fixture();
    if(scenario==="local")f.local()!.note_content="User local edit";
    if(scenario==="parent")f.parents.set("2002","2");
    if(scenario==="pending")f.journals.push({kind:"note.create",state:"reconcile",task_id:"1",remote_references:JSON.stringify({noteId:note.externalId}),remote_effect_possible:1,updated_at:startedAt});
    const incoming=scenario==="source"?{...note,content:"Changed without timestamp"}:scenario==="parent"?{...note,dealId:"2002"}:note;
    const result=await applyZohoInboundChanges(f.db,lease,changes(incoming),startedAt);
    assert.equal(result.partial,true);assert.equal(result.counts.conflicts,1);assert.equal(f.saved()?.reason,reason);
    assert.equal(f.saved()?.task_id,"1","A conflicting remote parent must not move provenance away from the retained local note");
    assert.equal(f.mutations.filter(value=>value.sql.startsWith("INSERT INTO crm_zoho_sync_events")).length,1);
    assert.equal(f.local()?.note_content,scenario==="local"?"User local edit":note.content);
  }
});

test("OFFLINE hundreds of unchanged Notes use bounded parameterized reads with no per-note SQL or audit amplification",async()=>{
  const notes=Array.from({length:401},(_,index)=>({...note,externalId:String(3001+index),dealId:String(5001+index)}));
  const f=fixture(true,notes),batch=changes();batch.notes=notes;
  const result=await applyZohoInboundChanges(f.db,lease,parseZohoInboundChangeSet(batch),startedAt);
  assert.equal(result.counts.read,401);assert.equal(result.counts.skipped,401);assert.equal(result.partial,false);
  assert.equal(f.bulkReads.length,6,"Three Notes batches and three parent batches replace hundreds of sequential lookups");
  assert.deepEqual(f.bulkReads.map(value=>value.values.length),[200,200,1,200,200,1]);
  for(const read of f.bulkReads) {
    assert.equal((read.sql.match(/\?/g)??[]).length,read.values.length);
    assert.ok(read.values.every(value=>typeof value==="string"&&!read.sql.includes(value)));
  }
  assert.equal(f.mutations.length,1);assert.ok(f.mutations[0]!.sql.startsWith("INSERT INTO crm_zoho_sync_runs"));
});
