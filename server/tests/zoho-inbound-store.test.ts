import assert from "node:assert/strict";
import test from "node:test";
import { mergeZohoInboundProjection,inboundProductProjection,inboundNoteProjection,inboundDealProjection } from "../src/integrations/zoho/inbound-projections.js";
import { normalizeZohoInboundRecord } from "../src/integrations/zoho/inbound-snapshot.js";
import { readZohoInboundStatus,createZohoInboundStore,ZohoInboundStoreError } from "../src/integrations/zoho/inbound-store.js";
import { runZohoInboundSync } from "../src/integrations/zoho/inbound-sync.js";
import type { MysqlDatabase } from "../src/crm/db/mysql/database.js";

test("OFFLINE inbound three-way merge preserves missing fields and refuses competing local changes",()=>{
  const current={description:"Local note",product_name:"Original",unit_price:"12.345"};
  assert.deepEqual(mergeZohoInboundProjection(current,{product_name:"Remote"},{product_name:"Original"}),
    {conflict:false,projection:{product_name:"Remote"},changed:true});
  assert.deepEqual(current,{description:"Local note",product_name:"Original",unit_price:"12.345"});
  assert.deepEqual(mergeZohoInboundProjection({product_name:"Local"},{product_name:"Remote"},{product_name:"Original"}),{conflict:true});
  assert.deepEqual(mergeZohoInboundProjection({product_name:"Remote"},{product_name:"Remote"},{product_name:"Original"}),
    {conflict:false,projection:{product_name:"Remote"},changed:false});
  assert.deepEqual(mergeZohoInboundProjection({description:"old"},{description:null},{description:"old"}),
    {conflict:false,projection:{description:null},changed:true});
});
test("OFFLINE inbound source values are never truncated, rounded, or synthesized from absent optional content",()=>{
  const base={externalId:"1001",name:"TEST ONLY",description:null,unitPrice:null,createdAt:"2026-10-19T01:00:00Z",modifiedAt:"2026-10-19T02:00:00Z",missingOptionalFields:["Description","Unit_Price"]};
  assert.deepEqual(inboundProductProjection(base),{product_name:"TEST ONLY"});
  assert.equal(inboundProductProjection({...base,name:"a".repeat(256)}),undefined);
  assert.equal(inboundProductProjection({...base,name:"a".repeat(255)})?.product_name,"a".repeat(255));
  assert.equal(inboundProductProjection({...base,unitPrice:"1000000000000000000"}),undefined);
  assert.deepEqual(inboundProductProjection({...base,missingOptionalFields:[],unitPrice:"12.123456789012345678"}),
    {product_name:"TEST ONLY",description:null,unit_price:"12.123456789012345678"});
  assert.equal(inboundNoteProjection({...base,dealId:"2001",title:null,content:null,createdBy:null,missingOptionalFields:["Note_Content"]}),undefined);
});

test("OFFLINE inbound deal amounts cannot introduce unsupported negative dashboard values",()=>{
  const source={id:"2001",Deal_Name:"TEST ONLY",Stage:"Closed Won",Created_Time:"2026-10-19T01:00:00Z",Modified_Time:"2026-10-19T02:00:00Z"};
  assert.equal(inboundDealProjection(normalizeZohoInboundRecord("Deals",{...source,Amount:"-1.0001"}),null),undefined);
  assert.equal(inboundDealProjection(normalizeZohoInboundRecord("Deals",{...source,Amount:"-0"}),null),undefined);
  assert.equal(inboundDealProjection(normalizeZohoInboundRecord("Deals",{...source,Amount:"0.000000000000000001"}),null)?.service_charge,"0.000000000000000001");
  const absent=inboundDealProjection(normalizeZohoInboundRecord("Deals",source),null)!;
  assert.equal(Object.hasOwn(absent,"service_charge"),false);
});
function db(options:{active?:boolean;grants?:string[];source?:Record<string,unknown>}={}) {
  const statements:string[]=[];
  const value={prepare(sql:string){statements.push(sql);return{
    get:async()=>sql.includes("FROM users")?{status:options.active===false?"inactive":"active"}:sql.includes("FROM crm_zoho_sync_source")?options.source:undefined,
    all:async()=>sql.includes("FROM permissions")?(options.grants??["users.write","permissions.manage"]).map(permissionKey=>({permissionKey})):[],
    run:async()=>assert.fail("No mutation permitted in this fixture"),
  };},transaction(work:()=>Promise<unknown>){const invoke=()=>work();return Object.assign(invoke,{immediate:invoke});}} as unknown as MysqlDatabase;
  return{value,statements};
}
test("OFFLINE inbound status is SELECT-only and validates explicit active administrator authority",async()=>{
  const f=db();const value=await readZohoInboundStatus(f.value,"3001","1");
  assert.equal(value.state,"idle");assert.equal(value.checkpointAvailable,false);assert.equal(value.generation,0);
  assert.ok(f.statements.every(sql=>sql.startsWith("SELECT ")));
  for(const options of [{active:false},{grants:["users.write"]},{grants:[]}])await assert.rejects(readZohoInboundStatus(db(options).value,"3001","1"),
    error=>error instanceof ZohoInboundStoreError&&error.code==="ACCESS_DENIED");
  await assert.rejects(readZohoInboundStatus(f.value,"wrong-org","1"),ZohoInboundStoreError);
});
test("OFFLINE a durable live lease refuses overlapping readers without provider calls or local writes",async()=>{
  const now=Date.parse("2026-10-19T01:00:00Z"),f=db({source:{organization_id:"3001",profile:"voltronix-inbound-v1",lease_id:"synthetic-lease",
    lease_expires_at:new Date(now+60_000).toISOString()}});let reads=0;
  const result=await runZohoInboundSync({database:f.value,organizationId:"3001",principalId:"1",now:()=>now,
    source:{readChanges:async()=>{reads++;assert.fail("Overlapping source read");}}});
  assert.deepEqual(result,{status:"busy"});assert.equal(reads,0);assert.ok(f.statements.every(sql=>sql.startsWith("SELECT ")));
  await assert.rejects(createZohoInboundStore(f.value,{organizationId:"3001"}).acquire("1",{leaseMs:59_999}),ZohoInboundStoreError);
});
test("OFFLINE aborted inbound pass does not authenticate, acquire, read, or mutate",async()=>{
  const f=db(),controller=new AbortController();controller.abort();
  await assert.rejects(runZohoInboundSync({database:f.value,organizationId:"3001",principalId:"1",signal:controller.signal,
    source:{readChanges:async()=>assert.fail("No source read")}}),error=>error instanceof ZohoInboundStoreError&&error.code==="ABORTED");
  assert.deepEqual(f.statements,[]);
});
