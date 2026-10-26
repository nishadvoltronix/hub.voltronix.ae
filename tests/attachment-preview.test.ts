import assert from "node:assert/strict";
import test from "node:test";
import { privateAttachmentPreview } from "../src/server/attachments/preview";
import { AttachmentError } from "../src/server/attachments/service";
import { HttpError } from "../src/server/http-security";
import { syntheticGif } from "./gif-fixture";
import { syntheticActionPdf } from "./helpers/pdf-upload-fixture";

// Response-helper evidence only. Actual authentication/parent scope is exercised
// separately by the normal-login SQLite HTTP tests, never mocked by this helper.
test("private task and log previews preserve validated static image bytes and isolation headers", async () => {
  const content = syntheticGif(), before = Buffer.from(content);
  for (const source of ["task", "log"] as const) {
    const response = privateAttachmentPreview({ name: "private fixture.gif", mediaType: "image/gif", size: content.length, content }, source);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/gif");
    assert.match(response.headers.get("content-disposition")!, /^inline;.*private%20fixture\.gif$/);
    assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(response.headers.get("content-length"), String(content.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  }
  assert.deepEqual(content, before);
});

test("private CSV and task TXT preview uses inert UTF-8 plain text without rewriting bytes", async () => {
  const content = Buffer.from("label,value\n<script>inert</script>,7\n");
  for (const [source, name, mediaType] of [["task", "fixture.txt", "text/plain"], ["task", "fixture.csv", "text/csv"], ["log", "fixture.csv", "text/csv"]] as const) {
    const response = privateAttachmentPreview({ name, mediaType, size: content.length, content }, source);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  }
});

test("private PDF preview refusal leaves original PDF bytes unchanged and advises download", () => {
  const content = syntheticActionPdf(), before = Buffer.from(content);
  for (const source of ["task", "log"] as const) assert.throws(() => privateAttachmentPreview({ name: "fixture.pdf", mediaType: "application/pdf", size: content.length, content }, source),
    (error: unknown) => error instanceof HttpError && error.status === 415 && error.message.includes("Use Download"));
  assert.deepEqual(content, before);
});

test("private log TXT and mismatched saved image content cannot render inline", () => {
  const content = Buffer.from("<script>inert</script>");
  assert.throws(() => privateAttachmentPreview({ name: "fixture.txt", mediaType: "text/plain", size: content.length, content }, "log"),
    (error: unknown) => error instanceof HttpError && error.status === 415);
  for (const source of ["task", "log"] as const) assert.throws(() => privateAttachmentPreview({ name: "fixture.gif", mediaType: "image/gif", size: content.length, content }, source),
    (error: unknown) => error instanceof AttachmentError && error.status === 415);
});
