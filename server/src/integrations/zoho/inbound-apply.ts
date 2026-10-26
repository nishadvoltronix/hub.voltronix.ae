import { createHash } from "node:crypto";
import type { MysqlDatabase } from "../../crm/db/mysql/database.js";
import type { ZohoInboundChangeSet, ZohoInboundHistoricalQuote } from "./inbound-sync-contracts.js";
import { ZOHO_INBOUND_PROFILE } from "./inbound-sync-contracts.js";
import { zohoInboundDealSchema,assertZohoInboundMissingValues } from "./inbound-snapshot.js";
import { parseZohoV8QuotationReadback, ZOHO_V8_QUOTATION_PROFILE } from "./quotation-v8.js";
import { inboundDealProjection,inboundNoteProjection,inboundProductProjection,mergeZohoInboundProjection,type ZohoInboundProjection } from "./inbound-projections.js";
import { emptyZohoInboundCounts,ZohoInboundStoreError,type ZohoInboundLease,type ZohoInboundModule } from "./inbound-store.js";

interface Saved {
  organization_id:string;module_api_name:ZohoInboundModule;external_id:string;local_id:string|null;task_id:string|null;
  origin:"imported"|"native"|"directory";state:"active"|"deleted"|"conflict";reason:string|null;
  source_created_at:string|null;source_modified_at:string;source_hash:string;source_json:string;applied_hash:string|null;applied_json:string|null;
}
type Observation={externalId:string;createdAt:string;modifiedAt:string};
type Outcome="inserted"|"updated"|"unchanged"|"conflict"|"deleted"|"skipped";
interface Event {module:ZohoInboundModule;externalId:string;outcome:Outcome;reason:string|null;sourceHash:string;sourceJson:string;appliedJson:string|null}
const hash=(value:unknown)=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
const key=(module:string,id:string)=>`${module}:${id}`;
const tables={Products:{table:"products",id:"product_id",external:"product_id"},Deals:{table:"tasks",id:"id",external:"zoho_crm_id"},Notes:{table:"job_notes",id:"id",external:"zoho_note_id"}} as const;
type ProjectedModule=keyof typeof tables;
type Row=ZohoInboundProjection&{localId:string;taskId?:string;version?:number};
interface Journal {kind:string;state:string;task_id:string|null;remote_references:string;remote_effect_possible:number;updated_at:string;result_task_id?:string|null;result_note_id?:string|null;result_json?:string|null}

/** Must be called inside the existing application-wide transaction/lock. Every
 * source read completed before this function; no HTTP or authorization fallback. */
export async function applyZohoInboundChanges(db:MysqlDatabase,lease:ZohoInboundLease,changes:ZohoInboundChangeSet,at:string,signal?:AbortSignal) {
  if(!db.inTransaction)throw new ZohoInboundStoreError("DATABASE");
  const counts=emptyZohoInboundCounts(),events:Event[]=[],dirty=new Map<string,Saved>();
  const noteRows=new Map<string,Row&{externalId:string;parentExternalId:string}>();
  const noteParents=new Map<string,{externalId:string;id:string}>();
  const saved=new Map((await db.prepare("SELECT organization_id,module_api_name,external_id,local_id,CAST(task_id AS CHAR) task_id,origin,state,reason,source_created_at,source_modified_at,source_hash,source_json,applied_hash,applied_json FROM crm_zoho_sync_records WHERE organization_id=?")
    .all(lease.organizationId) as Saved[]).map(row=>[key(row.module_api_name,row.external_id),row]));
  const leads=await db.prepare("SELECT kind,state,CAST(task_id AS CHAR) task_id,remote_references,remote_effect_possible,updated_at,CAST(result_task_id AS CHAR) result_task_id,CAST(result_note_id AS CHAR) result_note_id FROM crm_lead_operations").all() as Journal[];
  const commercial=await db.prepare("SELECT kind,state,CAST(task_id AS CHAR) task_id,remote_references,remote_effect_possible,updated_at,result_json FROM crm_commercial_operations").all() as Journal[];
  const journals=[...leads,...commercial].map(row=>({...row,refs:JSON.parse(row.remote_references) as Record<string,string>}));
  const check=()=>{if(signal?.aborted)throw new ZohoInboundStoreError("ABORTED");};
  const bindings=await db.prepare("SELECT b.external_user_id,b.record_email,u.email,u.status FROM crm_zoho_user_bindings b JOIN users u ON u.id=b.local_user_id AND u.user_id=b.external_user_id WHERE b.organization_id=?")
    .all(lease.organizationId) as {external_user_id:string;record_email:string;email:string;status:string}[];
  const deletedUsers=new Map(changes.tombstones.filter(row=>row.module==="VZ_app_users").map(row=>[row.externalId,row.deletedAt]));
  function assigned(externalId:string|null) {
    if(!externalId)return null;
    const bound=bindings.find(row=>row.external_user_id===externalId&&row.status==="active"&&row.email.toLowerCase()===row.record_email.toLowerCase());
    if(!bound)return null;
    const directory=saved.get(key("VZ_app_users",externalId));
    if(directory&&directory.state!=="active")return null;
    const observed=directory?JSON.parse(directory.source_json) as {status?:string;email?:string}:undefined;
    if(observed && (observed.status!=="active"||observed.email?.toLowerCase()!==bound.email.toLowerCase()))return null;
    const deletedAt=deletedUsers.get(externalId);
    if(deletedAt&&(!directory||Date.parse(deletedAt)>=Date.parse(directory.source_modified_at)))return null;
    return externalId;
  }
  function blocked(module:ZohoInboundModule,externalId:string,taskId:string|null) {
    const ref=module==="Products"?"productId":module==="Deals"?"dealId":module==="Notes"?"noteId":"quoteId";
    return journals.some(row=>row.state!=="completed" && ((taskId!==null&&row.task_id===taskId)||row.refs[ref]===externalId
      || row.remote_effect_possible===1 && !row.task_id && ((module==="Deals"&&row.kind==="deal.create"&&!row.refs.dealId)
        ||(module==="Products"&&row.kind==="product.create"&&!row.refs.productId))));
  }
  function native(module:ProjectedModule,externalId:string,row:Row) {
    if(module==="Deals")return journals.some(item=>item.state==="completed"&&item.remote_effect_possible===1&&item.kind==="deal.create"&&item.result_task_id===row.localId&&item.refs.dealId===externalId);
    if(module==="Notes")return journals.some(item=>item.state==="completed"&&item.remote_effect_possible===1&&item.kind==="note.create"&&item.result_note_id===row.localId&&item.refs.noteId===externalId);
    return journals.some(item=>item.state==="completed"&&item.remote_effect_possible===1&&item.kind==="product.create"&&item.refs.productId===externalId);
  }
  function event(module:ZohoInboundModule,value:Observation|{externalId:string},outcome:Outcome,reason:string|null,sourceJson:string,appliedJson:string|null) {
    events.push({module,externalId:value.externalId,outcome,reason,sourceHash:hash(sourceJson),sourceJson,appliedJson});counts.read++;
    if(outcome==="conflict")counts.conflicts++;else if(outcome==="deleted")counts.deleted++;else if(outcome==="inserted"||outcome==="updated")counts.applied++;else counts.skipped++;
  }
  function remember(module:ZohoInboundModule,value:Observation,old:Saved|undefined,options:{origin:Saved["origin"];localId:string|null;taskId:string|null;
    state:Saved["state"];reason:string|null;applied:ZohoInboundProjection|null},outcome:Outcome) {
    const sourceJson=JSON.stringify(value),appliedJson=options.applied?JSON.stringify(options.applied):old?.applied_json??null;
    const row:Saved={organization_id:lease.organizationId,module_api_name:module,external_id:value.externalId,local_id:options.localId,task_id:options.taskId,
      origin:options.origin,state:options.state,reason:options.reason,source_created_at:old?.source_created_at??value.createdAt,source_modified_at:value.modifiedAt,
      source_hash:hash(sourceJson),source_json:sourceJson,applied_hash:appliedJson?hash(appliedJson):null,applied_json:appliedJson};
    // Notes are fully observed each pass because conversion can change their
    // parent without a new source timestamp. Only after normal identity,
    // parent, journal and local-merge checks may an exact active repeat avoid
    // duplicate provenance/event writes. The run still counts and hashes it;
    // last_synced_at remains the last material per-note reconciliation.
    if(module==="Notes"&&outcome==="unchanged"&&old?.state==="active"&&old.reason===null
      &&old.source_hash===row.source_hash&&old.applied_hash===row.applied_hash
      &&old.local_id===row.local_id&&old.task_id===row.task_id) {
      counts.read++;counts.skipped++;return;
    }
    saved.set(key(module,value.externalId),row);dirty.set(key(module,value.externalId),row);
    event(module,value,outcome,options.reason,sourceJson,appliedJson);
  }
  function older(module:ZohoInboundModule,value:Observation,old:Saved|undefined) {
    if(old&&Date.parse(value.modifiedAt)<Date.parse(old.source_modified_at)) {event(module,value,"skipped","OLDER_REMOTE_VERSION",JSON.stringify(value),old.applied_json);return true;}
    return false;
  }
  async function project(module:ProjectedModule,value:Observation,projection:ZohoInboundProjection|undefined,parentId?:string) {
    check();const old=saved.get(key(module,value.externalId));if(older(module,value,old))return;
    const target=tables[module],columns=projection?Object.keys(projection):[];
    const row=module==="Notes"?noteRows.get(value.externalId):await db.prepare(`SELECT CAST(${target.id} AS CHAR) localId,version${columns.length?","+columns.join(","):""} FROM ${target.table} WHERE ${target.external}=?`)
      .get(value.externalId) as Row|undefined;
    const parent=module==="Notes"?noteParents.get(parentId!):undefined;
    // A changed remote parent is a conflict, not a local move. Keep conflict
    // provenance attached to the actual local note's parent task.
    const noteTaskId=module==="Notes"&&row&&row.parentExternalId!==parentId
      ?noteParents.get(String(row.parentExternalId))?.id??old?.task_id??null:parent?.id??null;
    let taskId=module==="Deals"?row?.localId??null:noteTaskId,localId=row?.localId??null;
    const origin=old?.origin??(row&&native(module,value.externalId,row)?"native":"imported");
    let reason=!projection?"UNSUPPORTED_PROJECTION":module==="Notes"&&(!parent||row&&row.parentExternalId!==parentId)?"PARENT_UNAVAILABLE":
      old?.local_id&&old.local_id!==localId?"LOCAL_IDENTITY_CHANGED":row&&!old&&origin!=="native"?"PREEXISTING_RECORD":null;
    if(!reason&&old?.reason==="PREEXISTING_RECORD"&&!old.applied_json)reason="PREEXISTING_RECORD";
    if(!reason&&old?.source_created_at&&old.source_created_at!==value.createdAt)reason="SOURCE_IDENTITY_CHANGED";
    if(!reason&&old&&Date.parse(old.source_modified_at)===Date.parse(value.modifiedAt)
      && (old.source_hash!==hash(value)||old.reason==="SAME_TIMESTAMP_CHANGED"))reason="SAME_TIMESTAMP_CHANGED";
    if(!reason&&blocked(module,value.externalId,taskId))reason="PENDING_OUTBOUND_OPERATION";
    if(!reason&&taskId&&journals.some(item=>item.state==="completed"&&item.task_id===taskId&&Date.parse(item.updated_at)>Date.parse(lease.startedAt)))reason="CONCURRENT_LOCAL_WRITE";
    if(projection&&row&&module==="Deals") {
      // These fields are Hub-local or frozen by a saved quotation. Remote empty
      // counters never replace the deliberately local HUB-* references.
      for(const name of ["site_deal_number","job_deal_number","lost_deal_number"])if(typeof row[name]==="string"&&row[name].startsWith("HUB-")&&!projection[name])delete projection[name];
      const quote=await db.prepare("SELECT task_id FROM crm_zoho_quotations WHERE task_id=? UNION SELECT task_id FROM crm_quotations WHERE task_id=? UNION SELECT task_id FROM crm_percentage_quotations WHERE task_id=? LIMIT 1").get(taskId,taskId,taskId);
      if(quote)delete projection.service_charge;
    }
    let applied:ZohoInboundProjection|null=null,outcome:Outcome="conflict";
    if(!reason&&projection) {
      const baseline=old?.applied_json?JSON.parse(old.applied_json) as ZohoInboundProjection:null;
      const merged=mergeZohoInboundProjection(row??{},projection,baseline);
      if(merged.conflict)reason="LOCAL_PROJECTION_CHANGED";
      else if(!row) {
        const insert={...merged.projection,...(module==="Products"?{product_id:value.externalId}:module==="Deals"?{zoho_crm_id:value.externalId}:{zoho_note_id:value.externalId,deal_id:parentId!}),
          created_at:value.createdAt,updated_at:value.modifiedAt};
        const result=await db.prepare(`INSERT INTO ${target.table}(${Object.keys(insert).join(",")}) VALUES(${Object.keys(insert).map(()=>"?").join(",")})`).run(...Object.values(insert));
        localId=module==="Products"?value.externalId:String(result.lastInsertRowid);if(module==="Deals")taskId=localId;applied=merged.projection;outcome="inserted";
        if(module==="Notes")await db.prepare("UPDATE tasks SET version=version+1 WHERE id=?").run(taskId);
      } else {
        applied={...baseline,...merged.projection};outcome=merged.changed?"updated":"unchanged";
        if(merged.changed)await db.prepare(`UPDATE ${target.table} SET ${Object.keys(merged.projection).map(name=>`${name}=?`).join(",")},updated_at=?${module==="Notes"?"":",version=version+1"} WHERE ${target.id}=?`)
          .run(...Object.values(merged.projection),value.modifiedAt,localId);
        if(module==="Notes"&&merged.changed)await db.prepare("UPDATE tasks SET version=version+1 WHERE id=?").run(taskId);
      }
    }
    remember(module,value,old,{origin,localId,taskId,state:reason?"conflict":"active",reason,applied},reason?"conflict":outcome);
  }
  for(const value of changes.appUsers) {
    check();const old=saved.get(key("VZ_app_users",value.externalId));if(older("VZ_app_users",value,old))continue;
    const binding=bindings.find(row=>row.external_user_id===value.externalId);
    const tie=old&&Date.parse(old.source_modified_at)===Date.parse(value.modifiedAt)&&(old.source_hash!==hash(value)||old.reason==="SAME_TIMESTAMP_CHANGED");
    const reason=old?.source_created_at&&old.source_created_at!==value.createdAt?"SOURCE_IDENTITY_CHANGED":tie?"SAME_TIMESTAMP_CHANGED":
      binding&&value.status!=="active"?"REMOTE_USER_INACTIVE":binding&&value.email?.toLowerCase()!==binding.record_email.toLowerCase()?"REMOTE_USER_EMAIL_CHANGED":null;
    remember("VZ_app_users",value,old,{origin:"directory",localId:null,taskId:null,state:reason?"conflict":"active",reason,applied:null},
      reason?"conflict":old?.source_hash===hash(value)?"unchanged":old?"updated":"inserted");
  }
  for(const value of changes.products)await project("Products",value,inboundProductProjection(value));
  // A newly verified local binding or a revoked directory record can change
  // ownership without a new Deal Modified_Time. Reuse the retained validated
  // observation and merge only its assignment; never manufacture a source
  // timestamp, replay deleted/conflicted records, or overwrite local conflicts.
  const observedDeals=new Set(changes.deals.map(value=>value.externalId));
  for(const previous of Array.from(saved.values())) {
    if(previous.module_api_name!=="Deals"||previous.state!=="active"||!previous.local_id||!previous.applied_json||observedDeals.has(previous.external_id))continue;
    const value=zohoInboundDealSchema.parse(JSON.parse(previous.source_json));assertZohoInboundMissingValues("Deals",value);
    const baseline=JSON.parse(previous.applied_json) as ZohoInboundProjection;
    if(value.missingOptionalFields.includes("VZ_app_user")||!Object.hasOwn(baseline,"assigned_to"))continue;
    const desired=assigned(value.assignedTo?.externalId??null);
    if(baseline.assigned_to!==desired)await project("Deals",value,{assigned_to:desired});
  }
  for(const value of changes.deals)await project("Deals",value,inboundDealProjection(value,assigned(value.assignedTo?.externalId??null)));
  // Full Notes reconciliation must not hold the global application lock for
  // two sequential round trips per note. Read bounded parameterized batches
  // after Deals are applied so newly imported parents are visible. The same
  // transaction/lock keeps these rows stable through all normal merge checks.
  for(let offset=0;offset<changes.notes.length;offset+=200) {
    check();const ids=changes.notes.slice(offset,offset+200).map(value=>value.externalId);
    const rows=await db.prepare(`SELECT zoho_note_id externalId,CAST(id AS CHAR) localId,deal_id parentExternalId,note_title,note_content FROM job_notes WHERE zoho_note_id IN (${ids.map(()=>"?").join(",")})`)
      .all(...ids) as (Row&{externalId:string;parentExternalId:string})[];
    for(const row of rows)noteRows.set(row.externalId,row);
  }
  const parentIds=[...new Set([...changes.notes.map(value=>value.dealId),...Array.from(noteRows.values(),row=>row.parentExternalId)])];
  for(let offset=0;offset<parentIds.length;offset+=200) {
    check();const ids=parentIds.slice(offset,offset+200);
    const rows=await db.prepare(`SELECT zoho_crm_id externalId,CAST(id AS CHAR) id FROM tasks WHERE zoho_crm_id IN (${ids.map(()=>"?").join(",")})`)
      .all(...ids) as {externalId:string;id:string}[];
    for(const row of rows)noteParents.set(row.externalId,row);
  }
  for(const value of changes.notes)await project("Notes",value,inboundNoteProjection(value),value.dealId);
  for(const value of changes.quotes) {
    check();const old=saved.get(key("Quotes",value.externalId));if(older("Quotes",value,old))continue;
    const parent=value.dealId?await db.prepare("SELECT CAST(id AS CHAR) id FROM tasks WHERE zoho_crm_id=?").get(value.dealId) as {id:string}|undefined:undefined;
    const nativeQuote=await db.prepare("SELECT CAST(id AS CHAR) id,CAST(task_id AS CHAR) taskId,snapshot_json,remote_modified_at FROM crm_zoho_quotations WHERE organization_id=? AND external_id=?")
      .get(lease.organizationId,value.externalId) as {id:string;taskId:string;snapshot_json:string;remote_modified_at:string}|undefined;
    const stored=await db.prepare("SELECT CAST(id AS CHAR) id,CAST(task_id AS CHAR) taskId,CAST(native_quote_id AS CHAR) nativeQuoteId,source_created_at FROM crm_zoho_inbound_quotations WHERE organization_id=? AND external_id=?")
      .get(lease.organizationId,value.externalId) as {id:string;taskId:string|null;nativeQuoteId:string|null;source_created_at:string}|undefined;
    const taskId=parent?.id??null,origin=nativeQuote?"native":old?.origin??"imported";
    let reason=stored?.taskId&&stored.taskId!==taskId?"PARENT_CHANGED":old?.source_created_at&&old.source_created_at!==value.createdAt?"SOURCE_IDENTITY_CHANGED":
      value.dealId&&!parent?"PARENT_UNAVAILABLE":blocked("Quotes",value.externalId,taskId)?"PENDING_OUTBOUND_OPERATION":null;
    if(!reason&&old&&Date.parse(old.source_modified_at)===Date.parse(value.modifiedAt)
      &&(old.source_hash!==hash(value)||old.reason==="SAME_TIMESTAMP_CHANGED"))reason="SAME_TIMESTAMP_CHANGED";
    if(nativeQuote&&!reason) {
      try {const parsed=parseZohoV8QuotationReadback({data:[value.source]},value.externalId,ZOHO_V8_QUOTATION_PROFILE);
        if(nativeQuote.taskId!==taskId||JSON.stringify(parsed)!==nativeQuote.snapshot_json)reason="NATIVE_QUOTE_CHANGED";
      }catch{reason="NATIVE_QUOTE_CHANGED";}
    }
    const sourceJson=JSON.stringify(value),financial=quoteFinancials(value);
    let localId=stored?.id??null;
    if(!stored) {
      const result=await db.prepare("INSERT INTO crm_zoho_inbound_quotations(organization_id,external_id,task_id,native_quote_id,quote_number,subject,subtotal,grand_total,tax,discount,adjustment,source_created_at,source_modified_at,snapshot_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(lease.organizationId,value.externalId,taskId,nativeQuote?.id??null,value.quoteNumber,value.subject,...financial,value.createdAt,value.modifiedAt,sourceJson,at);
      localId=String(result.lastInsertRowid);
    }else if(reason!=="PARENT_CHANGED"&&reason!=="SOURCE_IDENTITY_CHANGED"&&reason!=="SAME_TIMESTAMP_CHANGED"
      &&(old?.source_hash!==hash(value)||old?.state==="deleted")) {
      await db.prepare("UPDATE crm_zoho_inbound_quotations SET task_id=?,quote_number=?,subject=?,subtotal=?,grand_total=?,tax=?,discount=?,adjustment=?,source_modified_at=?,snapshot_json=?,observed_at=?,deleted=0,version=version+1 WHERE id=?")
        .run(taskId,value.quoteNumber,value.subject,...financial,value.modifiedAt,sourceJson,at,stored.id);
    }else if(old?.source_hash===hash(value)) {
      await db.prepare("UPDATE crm_zoho_inbound_quotations SET observed_at=? WHERE id=?").run(at,stored.id);
    }
    remember("Quotes",value,old,{origin,localId,taskId:stored?.taskId??taskId,state:reason?"conflict":"active",reason,applied:null},
      reason?"conflict":old?.source_hash===hash(value)?"unchanged":old?"updated":"inserted");
  }
  for(const value of changes.tombstones) {
    check();const recordKey=key(value.module,value.externalId);let old=saved.get(recordKey);
    if(!old) {
      // A deletion may precede the first full observation of an already-owned
      // native record. Bind its existing identity so task guards cannot miss it.
      if(value.module==="Deals"||value.module==="Products") {
        const target=tables[value.module],local=await db.prepare(`SELECT CAST(${target.id} AS CHAR) localId FROM ${target.table} WHERE ${target.external}=?`).get(value.externalId) as Row|undefined;
        if(local)old={organization_id:lease.organizationId,module_api_name:value.module,external_id:value.externalId,local_id:local.localId,
          task_id:value.module==="Deals"?local.localId:null,origin:native(value.module,value.externalId,local)?"native":"imported",state:"active",reason:null,
          source_created_at:null,source_modified_at:value.deletedAt,source_hash:"",source_json:"{}",applied_hash:null,applied_json:null};
      }else if(value.module==="Quotes") {
        const local=await db.prepare("SELECT CAST(task_id AS CHAR) taskId FROM crm_zoho_quotations WHERE organization_id=? AND external_id=?").get(lease.organizationId,value.externalId) as {taskId:string}|undefined;
        if(local)old={organization_id:lease.organizationId,module_api_name:value.module,external_id:value.externalId,local_id:null,task_id:local.taskId,origin:"native",state:"active",reason:null,
          source_created_at:null,source_modified_at:value.deletedAt,source_hash:"",source_json:"{}",applied_hash:null,applied_json:null};
      }
    }
    if(old&&Date.parse(value.deletedAt)<Date.parse(old.source_modified_at)){event(value.module,value,"skipped","OLDER_REMOTE_VERSION",JSON.stringify(value),old.applied_json);continue;}
    const sourceJson=JSON.stringify(value),pending=blocked(value.module,value.externalId,old?.task_id??null);
    const row:Saved=old?{...old,state:pending?"conflict":"deleted",reason:pending?"PENDING_OUTBOUND_OPERATION":null,source_modified_at:value.deletedAt,source_hash:hash(sourceJson),source_json:sourceJson}:
      {organization_id:lease.organizationId,module_api_name:value.module,external_id:value.externalId,local_id:null,task_id:null,origin:value.module==="VZ_app_users"?"directory":"imported",
        state:pending?"conflict":"deleted",reason:pending?"PENDING_OUTBOUND_OPERATION":null,source_created_at:null,source_modified_at:value.deletedAt,source_hash:hash(sourceJson),source_json:sourceJson,applied_hash:null,applied_json:null};
    saved.set(recordKey,row);dirty.set(recordKey,row);
    if(value.module==="Quotes"&&row.local_id&&!pending)await db.prepare("UPDATE crm_zoho_inbound_quotations SET deleted=1,observed_at=? WHERE id=?").run(at,row.local_id);
    event(value.module,value,pending?"conflict":old?.state==="deleted"&&old.source_hash===row.source_hash?"unchanged":"deleted",row.reason,sourceJson,row.applied_json);
  }
  check();
  const partial=Array.from(saved.values()).some(row=>row.state==="conflict");
  await db.prepare("INSERT INTO crm_zoho_sync_runs(run_id,organization_id,principal_id,profile,state,started_at,completed_at,generation_before,generation_after,watermark,source_hash,counts_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(lease.runId,lease.organizationId,lease.principalId,ZOHO_INBOUND_PROFILE,partial?"partial":"completed",lease.startedAt,at,lease.generation,lease.generation+1,changes.nextWatermark,hash(changes),JSON.stringify(counts));
  for(const row of dirty.values()) {
    check();const values=[row.local_id,row.task_id,row.state,row.reason,row.source_created_at,row.source_modified_at,row.source_hash,row.source_json,row.applied_hash,row.applied_json,lease.runId,at];
    const exists=await db.prepare("SELECT 1 FROM crm_zoho_sync_records WHERE organization_id=? AND module_api_name=? AND external_id=?").get(lease.organizationId,row.module_api_name,row.external_id);
    if(exists)await db.prepare("UPDATE crm_zoho_sync_records SET local_id=?,task_id=?,state=?,reason=?,source_created_at=?,source_modified_at=?,source_hash=?,source_json=?,applied_hash=?,applied_json=?,last_run_id=?,last_synced_at=? WHERE organization_id=? AND module_api_name=? AND external_id=?")
      .run(...values,lease.organizationId,row.module_api_name,row.external_id);
    else await db.prepare("INSERT INTO crm_zoho_sync_records(organization_id,module_api_name,external_id,origin,local_id,task_id,state,reason,source_created_at,source_modified_at,source_hash,source_json,applied_hash,applied_json,last_run_id,last_synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(lease.organizationId,row.module_api_name,row.external_id,row.origin,...values);
  }
  for(const value of events) {
    check();await db.prepare("INSERT INTO crm_zoho_sync_events(run_id,organization_id,module_api_name,external_id,outcome,reason,source_hash,source_json,applied_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(lease.runId,lease.organizationId,value.module,value.externalId,value.outcome,value.reason,value.sourceHash,value.sourceJson,value.appliedJson,at);
  }
  return {counts,partial};
}
function quoteFinancials(value:ZohoInboundHistoricalQuote) {
  return [value.totals.subtotal,value.totals.grandTotal,value.totals.tax,value.totals.discount,value.totals.adjustment];
}
