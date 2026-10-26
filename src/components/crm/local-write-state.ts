/** Keep an operation identifier across a failed identical request, never across edited input. */
export function createLocalWriteState() {
  let pending: { key: string; operationId: string } | undefined;
  let busy = false;
  return {
    async run<Input extends object, Result>(input: Input, send: (value: Input & { operationId: string }) => Promise<Result>, persistence?: CrmPersistence): Promise<Result | undefined> {
      if (busy) return undefined;
      const key = JSON.stringify(input);
      if (pending?.key !== key) pending = { key, operationId: crypto.randomUUID() };
      busy = true;
      try {
        const result = await send({ ...input, operationId: pending.operationId });
        if (persistence) assertPersistenceReceipt(result, { operationId: pending.operationId, persistence });
        pending = undefined;
        return result;
      } finally { busy = false; }
    },
  };
}
import { assertPersistenceReceipt, type CrmPersistence } from "@voltronix/crm-contracts";

