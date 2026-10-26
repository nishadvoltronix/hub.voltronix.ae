import type { MysqlDatabase } from "../../crm/db/mysql/database.js";
import type { ZohoInboundSource } from "./inbound-sync-source.js";
import { DEFAULT_ZOHO_INBOUND_LIMITS } from "./inbound-sync-contracts.js";
import { createZohoInboundStore,safeZohoInboundCode,ZohoInboundStoreError } from "./inbound-store.js";

/** One shared CLI/poller pass. The provider is strictly read-only and owned by
 * the caller. A durable lease prevents cross-process overlap; shutdown cancels
 * reads, drains lease renewal, and retains failure evidence without advancing
 * the checkpoint. No HTTP runs inside the application transaction. */
export async function runZohoInboundSync(options:{database:MysqlDatabase;source:Pick<ZohoInboundSource,"readChanges">;
  organizationId:string;principalId:string;signal?:AbortSignal;now?:()=>number}) {
  if(options.signal?.aborted)throw new ZohoInboundStoreError("ABORTED");
  const store=createZohoInboundStore(options.database,{organizationId:options.organizationId,...(options.now?{now:options.now}:{})});
  const lease=await store.acquire(options.principalId);
  if(!lease)return {status:"busy" as const};
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(lease.watermark?300_000:900_000),...(options.signal?[options.signal]:[])]);
  let renewal:Promise<void>|undefined,renewalError:unknown;
  const timer=setInterval(()=>{
    if(renewal||signal.aborted)return;
    renewal=store.renew(lease).catch(error=>{renewalError=error;controller.abort();}).finally(()=>{renewal=undefined;});
  },30_000);timer.unref();
  try {
    const changes=await options.source.readChanges({organizationId:options.organizationId,startedAt:lease.startedAt,
      ...(lease.since?{since:lease.since}:{}),limits:{...DEFAULT_ZOHO_INBOUND_LIMITS}},signal);
    clearInterval(timer);await renewal;
    if(renewalError)throw renewalError;
    if(signal.aborted)throw new ZohoInboundStoreError("ABORTED");
    await store.renew(lease);
    return await store.apply(lease,changes,signal);
  }catch(error) {
    const aborted=signal.aborted;
    clearInterval(timer);controller.abort();await renewal;
    const failure=new ZohoInboundStoreError(aborted&&!renewalError&&!(error instanceof ZohoInboundStoreError)?"ABORTED":safeZohoInboundCode(renewalError??error));
    await store.fail(lease,failure);
    throw failure;
  }finally {clearInterval(timer);controller.abort();await renewal;}
}
