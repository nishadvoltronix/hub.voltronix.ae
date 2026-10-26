import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { logAttachmentLimit } from "@voltronix/crm-contracts";
import { readLogMultipart as retained } from "../src/server/departments/log-upload";
import { readLogMultipart as sqlite } from "./sqlite-reference/departments/log-upload";

for (const [runtime, read] of [["retained", retained], ["SQLite", sqlite]] as const) test(`${runtime} source log multipart enforces exact PM and worker file bytes even below total body cap`, async () => {
  for (const department of ["PM", "Electrical"]) {
    const maximum = logAttachmentLimit(department);
    const request = (size: number) => { const form = new FormData(); form.set("payload", "{}"); form.set("file", new File([new Uint8Array(size)], "limit.png", { type: "image/png" })); return new NextRequest("http://127.0.0.1:3001/api/departments/" + department + "/jobs/1/logs", { method: "POST", body: form }); };
    const allowed = await read(request(maximum), department); assert.equal(allowed.file?.content.length, maximum);
    await assert.rejects(read(request(maximum + 1), department), error => !!error && typeof error === "object" && "status" in error && error.status === 413);
  }
});
