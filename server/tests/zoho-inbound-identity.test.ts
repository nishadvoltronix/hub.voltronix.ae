import assert from "node:assert/strict";
import test from "node:test";
import type { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import { applyZohoInboundChanges } from "../src/integrations/zoho/inbound-apply.js";
import { parseZohoInboundChangeSet } from "../src/integrations/zoho/inbound-sync-contracts.js";
import type { ZohoInboundLease } from "../src/integrations/zoho/inbound-store.js";

test("OFFLINE repeated replacement identities never replace the first source creation anchor or applied product",async()=>{
  const saved=new Map<string,Record<string,unknown>>(),products=new Map<string,{localId:string;product_name:string;version:number}>();
  const identity=(module:unknown,id:unknown)=>`${String(module)}:${String(id)}`;
  const fields=["local_id","task_id","state","reason","source_created_at","source_modified_at","source_hash","source_json","applied_hash","applied_json","last_run_id","last_synced_at"];
  const db={inTransaction:true,prepare(sql:string){return{
    all:async()=>{
      if(sql.includes("FROM crm_zoho_sync_records WHERE organization_id=?"))return [...saved.values()];
      if(sql.includes("FROM crm_lead_operations")||sql.includes("FROM crm_commercial_operations")||sql.includes("FROM crm_zoho_user_bindings"))return [];
      assert.fail("Unexpected identity fixture read");
    },
    get:async(...values:unknown[])=>{
      if(sql.includes("FROM products WHERE product_id=?"))return products.get(String(values[0]));
      if(sql.startsWith("SELECT 1 FROM crm_zoho_sync_records"))return saved.has(identity(values[1],values[2]))?{exists:1}:undefined;
      assert.fail("Unexpected identity fixture lookup");
    },
    run:async(...values:unknown[])=>{
      if(sql.startsWith("INSERT INTO products(")){
        products.set(String(values[1]),{localId:String(values[1]),product_name:String(values[0]),version:1});
      }else if(sql.startsWith("UPDATE products"))assert.fail("Conflicting creation identity must never update the product");
      else if(sql.startsWith("INSERT INTO crm_zoho_sync_records")){
        saved.set(identity(values[1],values[2]),{organization_id:values[0],module_api_name:values[1],external_id:values[2],origin:values[3],
          ...Object.fromEntries(fields.map((field,index)=>[field,values[index+4]]))});
      }else if(sql.startsWith("UPDATE crm_zoho_sync_records")){
        const key=identity(values.at(-2),values.at(-1)),previous=saved.get(key)!;
        saved.set(key,{...previous,...Object.fromEntries(fields.map((field,index)=>[field,values[index]]))});
      }else if(!sql.startsWith("INSERT INTO crm_zoho_sync_runs")&&!sql.startsWith("INSERT INTO crm_zoho_sync_events"))assert.fail("Unexpected identity fixture mutation");
      return{changes:1,lastInsertRowid:1};
    },
  };}} as unknown as MysqlDatabase;
  const original="2026-10-18T01:00:00.000Z",replacement="2026-10-18T02:00:00.000Z",startedAt="2026-10-19T01:00:00.000Z";
  for(let generation=0;generation<3;generation++){
    const changed=generation>0,createdAt=changed?replacement:original,modifiedAt=`2026-10-18T03:0${generation}:00.000Z`;
    const changes=parseZohoInboundChangeSet({schemaVersion:1,profile:"voltronix-inbound-v1",organizationId:"3001",startedAt,since:null,nextWatermark:startedAt,
      complete:true,snapshotConsistent:false,requestsPerformed:11,excludedOtherModuleNotes:0,coverage:{notesDeletions:false,quoteFinancials:"source-only",deletionRetentionDays:60},
      products:[{externalId:"1001",name:changed?"TEST ONLY replacement":"TEST ONLY original",description:null,unitPrice:null,createdAt,modifiedAt,missingOptionalFields:["Description","Unit_Price"]}],
      appUsers:[{externalId:"4001",name:"TEST ONLY directory",email:"synthetic@example.invalid",status:"active",createdAt,modifiedAt,missingOptionalFields:[]}],
      deals:[],notes:[],quotes:[],tombstones:[]});
    const lease:ZohoInboundLease={organizationId:"3001",principalId:"1",runId:"01234567-89ab-4def-8123-456789abcdef",generation,startedAt,watermark:null,since:null,leaseMs:120_000};
    const result=await applyZohoInboundChanges(db,lease,changes,startedAt);
    assert.equal(result.counts.conflicts,changed?2:0);
    assert.equal(result.partial,changed);
    for(const module of ["Products","VZ_app_users"]){
      const record=saved.get(identity(module,module==="Products"?"1001":"4001"))!;
      assert.equal(record.source_created_at,original);
      assert.equal(record.reason,changed?"SOURCE_IDENTITY_CHANGED":null);
    }
    assert.equal(products.get("1001")?.product_name,"TEST ONLY original");
  }
});
