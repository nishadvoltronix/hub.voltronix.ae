import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService, SESSION_LIFETIME_MS } from "./sqlite-reference/auth/service";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase } from "./sqlite-reference/db/migrations";
import { createAttachmentsService, AttachmentError, MAX_ATTACHMENT_BYTES } from "./sqlite-reference/attachments/service";
import { filesystemFixture } from "./database-fixture";
import { syntheticGif } from "./gif-fixture";
import { syntheticActionPdf } from "./helpers/pdf-upload-fixture";

const password = "Synthetic attachment fixture password", hash = hashSync(password, 4);
const initialNow = Date.parse("2026-10-10T12:00:00Z");
const text = Buffer.from("Synthetic attachment\nNo customer records");
const metadata = { expectedVersion: 1, name: "fixture.txt", mediaType: "text/plain" };
function error(code: number) { return (value: unknown) => value instanceof AttachmentError && value.status === code; }
async function populate(db: Database.Database) {
  let clock = initialNow;
  for (let id = 1; id <= 5; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(?,?,?,?,?,'active')")
    .run(id, `external-${id}`, `Attachment fixture ${id}`, `attachment-${id}@example.invalid`, hash);
  const grant = (id: number, key: string) => {
    db.prepare('INSERT INTO permissions(key,label) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(key, key);
    db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE key=?').run(id, key);
  };
  grant(1, "dashboard.view"); grant(2, "leads.manage.agents"); grant(3, "leads.view"); grant(4, "electrical.manage");
  for (const [id, owner, status] of [[1, "external-2", "Qualification"], [2, "external-5", "Qualification"],
    [3, "external-5", "Close to Won"], [4, "external-5", "Closed Won"]] as const)
    db.prepare("INSERT INTO tasks(id,assigned_to,deal_name,status) VALUES(?,?,?,?)").run(id, owner, `Synthetic task ${id}`, status);
  db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(2,4,'Electrical','Assigned')").run();
  const auth = createAuthService(db, { now: () => clock });
  const login = async (id: number) => (await auth.login(`attachment-${id}@example.invalid`, password, "fixture")).sessionToken;
  return { db, auth, grant, service: createAttachmentsService(db, { now: () => clock }),
    manager: await login(1), agent: await login(2), reader: await login(3), worker: await login(4), denied: await login(5),
    setNow: (value: number) => { clock = value; } };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  return populate(db);
}
function counts(db: Database.Database) {
  return { files: (db.prepare("SELECT COUNT(*) n FROM task_attachment").get() as { n: number }).n,
    audits: (db.prepare("SELECT COUNT(*) n FROM crm_attachment_audit_events").get() as { n: number }).n };
}
function chunk(type: string, content: Buffer) {
  const header = Buffer.alloc(8), check = Buffer.alloc(4); header.writeUInt32BE(content.length); header.write(type, 4);
  check.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), content])));
  return Buffer.concat([header, content, check]);
}
function png(width = 1, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
function pdf(extra = "") {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of ["<< /Type /Catalog /Pages 2 0 R " + extra + " >>", "<< /Type /Pages /Count 0 /Kids [] >>"].entries()) {
    offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 3\n0000000000 65535 f \n${offsets.map((offset) => offset.toString().padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test("attachment upload persists bytes, hash, parent version and actor audit in one transaction", async (t) => {
  const f = await fixture(t), result = f.service.upload(f.agent, "1", metadata, text);
  assert.equal(result.version, 2); assert.match(result.id, /^[0-9a-f-]{36}$/);
  const stored = f.db.prepare("SELECT user_id,uploaded_by,content_sha256 FROM task_attachment WHERE id=?").get(result.id);
  assert.deepEqual(stored, { user_id: "external-2", uploaded_by: 2, content_sha256: createHash("sha256").update(text).digest("hex") });
  const listed = f.service.list(f.reader, "1");
  assert.equal(listed.version, 2); assert.equal(listed.canUpload, false); assert.equal(listed.items.length, 1);
  assert.deepEqual(Object.keys(listed.items[0]!).sort(), ["createdAt", "id", "mediaType", "name", "size"]);
  assert.deepEqual(f.service.download(f.reader, result.id).content, text);
  assert.deepEqual(counts(f.db), { files: 1, audits: 1 });
  assert.deepEqual(f.db.prepare("SELECT actor_user_id,task_id,action FROM crm_attachment_audit_events").get(),
    { actor_user_id: 2, task_id: 1, action: "attachments.create" });
});
test("static GIF task files preserve exact private bytes, versions and audit while malformed or unauthorized requests persist nothing", async (t) => {
  const f = await fixture(t), bytes = syntheticGif(), data = { ...metadata, name: "synthetic.gif", mediaType: "image/gif" };
  assert.throws(() => f.service.upload(f.denied, "1", data, bytes), error(404));
  assert.throws(() => f.service.upload(f.reader, "1", data, bytes), error(403));
  assert.throws(() => f.service.upload(f.agent, "1", data, Buffer.concat([bytes, text])), error(415));
  assert.deepEqual(counts(f.db), { files: 0, audits: 0 });
  const saved = f.service.upload(f.agent, "1", data, bytes);
  assert.equal(saved.version, 2); assert.deepEqual(f.service.download(f.reader, saved.id).content, bytes);
  assert.equal(f.service.download(f.reader, saved.id).mediaType, "image/gif");
  assert.throws(() => f.service.download(f.denied, saved.id), error(404));
  assert.throws(() => f.service.upload(f.agent, "1", data, bytes), error(409));
  assert.deepEqual(counts(f.db), { files: 1, audits: 1 });
});
test("attachment operations authenticate and authorize parent before input; readers cannot upload and unrelated owners cannot enumerate/download", async (t) => {
  const f = await fixture(t), result = f.service.upload(f.agent, "1", metadata, text);
  assert.throws(() => f.service.upload(null, "bad", {}, text), error(401));
  assert.throws(() => f.service.upload(f.reader, "1", {}, text), error(403));
  assert.throws(() => f.service.authorizeUpload(f.reader, "1"), error(403));
  assert.throws(() => f.service.upload(f.agent, "2", metadata, text), error(404));
  assert.throws(() => f.service.list(f.reader, "bad"), error(404));
  assert.throws(() => f.service.list(f.denied, "1"), error(404));
  assert.throws(() => f.service.download(f.denied, result.id), error(404));
  assert.throws(() => f.service.upload(f.manager, "1", metadata, text), error(404));
  assert.equal(f.service.upload(f.manager, "3", metadata, text).version, 2);
  assert.equal(f.service.upload(f.worker, "2", metadata, text).version, 2);
  assert.deepEqual(counts(f.db), { files: 3, audits: 3 });
});
test("current assignments, grant revocation, disabled accounts and expiry revoke attachment access", async (t) => {
  const f = await fixture(t), attachment = f.service.upload(f.worker, "2", metadata, text);
  f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(2,NULL,'Electrical','Unassigned')").run();
  assert.throws(() => f.service.download(f.worker, attachment.id), error(404));
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=2").run();
  assert.throws(() => f.service.upload(f.agent, "1", metadata, text), error(404));
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=3").run();
  assert.throws(() => f.service.list(f.reader, "1"), error(401));
  f.setNow(initialNow + SESSION_LIFETIME_MS);
  assert.throws(() => f.service.list(f.manager, "3"), error(401));
});
test("stale parent versions and simultaneous logical edits cannot append unreviewed attachments", async (t) => {
  const f = await fixture(t);
  f.service.upload(f.agent, "1", metadata, text);
  assert.throws(() => f.service.upload(f.agent, "1", metadata, text), error(409));
  assert.deepEqual(counts(f.db), { files: 1, audits: 1 });
  const second = f.service.upload(f.agent, "1", { ...metadata, expectedVersion: 2, name: "second.txt" }, text);
  assert.equal(second.version, 3);
  assert.equal(f.service.list(f.agent, "1", { page: 1, pageSize: 1 }).items.length, 1);
  assert.equal(f.service.list(f.agent, "1", { page: 2, pageSize: 1 }).items.length, 1);
  assert.equal(f.service.list(f.agent, "1", { page: 3, pageSize: 1 }).items.length, 0);
});
test("attachment metadata rejects paths, reserved names, control characters, unsupported extensions and MIME mismatches", async (t) => {
  const f = await fixture(t);
  for (const name of ["../x.txt", "C:\\x.txt", "bad\nname.txt", " x.txt", "x.txt.", "NUL.txt", "COM1.txt", "a:b.txt", "", "bad\ud800.txt", "bad\u202E.txt"]) {
    assert.throws(() => f.service.upload(f.agent, "1", { ...metadata, name }, text), error(400));
  }
  for (const patch of [{ name: "x.svg", mediaType: "image/svg+xml" }, { name: "x.html", mediaType: "text/html" },
    { name: "x.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { name: "x.zip", mediaType: "application/zip" }, { mediaType: "application/pdf" }]) {
    assert.throws(() => f.service.upload(f.agent, "1", { ...metadata, ...patch }, text), error(415));
  }
  assert.throws(() => f.service.upload(f.agent, "1", { ...metadata, taskId: "2" }, text), error(400));
  assert.deepEqual(counts(f.db), { files: 0, audits: 0 });
});
test("text upload bounds UTF-8, control bytes, empty/oversize files and spreadsheet formulas", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.upload(f.agent, "1", metadata, Buffer.alloc(0)), error(400));
  assert.throws(() => f.service.upload(f.agent, "1", metadata, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 65)), error(413));
  assert.throws(() => f.service.upload(f.agent, "1", metadata, Buffer.from([255, 254, 0])), error(415));
  assert.throws(() => f.service.upload(f.agent, "1", metadata, Buffer.from("bad\0text")), error(415));
  for (const contents of ['name,value\nfixture,=1+1', '"fixture","  +SUM(1,2)"', 'name\n@SUM(1,2)', 'name;\t-1+1']) {
    assert.throws(() => f.service.upload(f.agent, "1", { ...metadata, name: "fixture.csv", mediaType: "text/csv" }, Buffer.from(contents)), error(415));
  }
  const csv = Buffer.from("name,value\nfixture,123.45\n");
  const result = f.service.upload(f.agent, "1", { ...metadata, name: "fixture.csv", mediaType: "application/vnd.ms-excel" }, csv);
  assert.equal(f.service.download(f.agent, result.id).mediaType, "text/csv");
});
test("PNG upload checks full chunk bounds/CRC/dimensions/ending, and JPEG rejects signature-only spoofs", async (t) => {
  const f = await fixture(t), valid = png();
  const result = f.service.upload(f.agent, "1", { ...metadata, name: "pixel.png", mediaType: "image/png" }, valid);
  assert.deepEqual(f.service.download(f.agent, result.id).content, valid);
  const corrupted = Buffer.from(valid); corrupted[29] = corrupted[29]! ^ 1;
  for (const bytes of [corrupted, valid.subarray(0, valid.length - 5), Buffer.concat([valid, text]), png(100_000, 100_000)]) {
    assert.throws(() => f.service.upload(f.agent, "1", { ...metadata, expectedVersion: 2, name: "pixel.png", mediaType: "image/png" }, bytes), error(415));
  }
  assert.throws(() => f.service.upload(f.agent, "1", { ...metadata, expectedVersion: 2, name: "fake.jpg", mediaType: "image/jpeg" },
    Buffer.from([255, 216, 255, 217])), error(415));
  // One white pixel generated by Chromium canvas, not an imported customer image.
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z", "base64");
  const photo = f.service.upload(f.agent, "1", { ...metadata, expectedVersion: 2, name: "pixel.jpg", mediaType: "image/jpeg" }, jpeg);
  assert.deepEqual(f.service.download(f.agent, photo.id).content, jpeg);
});
test("conservative PDF profile rejects active content including escaped names and malformed documents", async (t) => {
  const f = await fixture(t), file = pdf();
  const value = { ...metadata, name: "fixture.pdf", mediaType: "application/pdf" };
  const result = f.service.upload(f.agent, "1", value, file);
  assert.deepEqual(f.service.download(f.agent, result.id).content, file);
  for (const bytes of [Buffer.from("%PDF-1.4\n%%EOF"), pdf("/OpenAction << /S /JavaScript /JS (x) >>"),
    pdf("/Open#41ction << /S /Java#53cript /J#53 (x) >>"), pdf("/Encrypt 9 0 R"), pdf("/AcroForm 9 0 R"),
    Buffer.concat([file, text])]) {
    assert.throws(() => f.service.upload(f.agent, "1", { ...value, expectedVersion: 2 }, bytes), error(415));
  }
});

test("active PDF annotations cannot create task files, audit rows or parent version changes", async (t) => {
  const f = await fixture(t), value = { ...metadata, name: "synthetic.pdf", mediaType: "application/pdf" };
  for (const [action, key] of [
    ["/S /Named /N /Print", "A"], ["/S /Named /N /Print", "#41"],
    ["/S /GoToE /F (synthetic.pdf) /D [0 /Fit]", "A"],
    ["/S /Rendition /OP 0", "A"], ["/S /UnknownFutureAction", "A"],
  ]) {
    assert.throws(() => f.service.upload(f.agent, "1", value, syntheticActionPdf(action, key)), error(415));
  }
  assert.deepEqual(counts(f.db), { files: 0, audits: 0 });
  assert.equal((f.db.prepare("SELECT version FROM tasks WHERE id=1").get() as { version: number }).version, 1);
  assert.equal(f.service.upload(f.agent, "1", value, syntheticActionPdf()).version, 2);
});
test("attachment audit failure rolls back bytes, metadata and task version and existing audit is immutable", async (t) => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER reject_attachment_audit BEFORE INSERT ON crm_attachment_audit_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => f.service.upload(f.agent, "1", metadata, text), error(503));
  assert.deepEqual(counts(f.db), { files: 0, audits: 0 });
  assert.equal((f.db.prepare("SELECT version FROM tasks WHERE id=1").get() as { version: number }).version, 1);
  f.db.exec("DROP TRIGGER reject_attachment_audit");
  f.service.upload(f.agent, "1", metadata, text);
  assert.throws(() => f.db.exec("UPDATE crm_attachment_audit_events SET action='attachments.create'"), /immutable/);
  assert.throws(() => f.db.exec("DELETE FROM crm_attachment_audit_events"), /immutable/);
});
test("corrupt stored attachment bytes return a safe unavailable response and never leak content", async (t) => {
  const f = await fixture(t), result = f.service.upload(f.agent, "1", metadata, text);
  f.db.prepare("UPDATE task_attachment SET content=? WHERE id=?").run(Buffer.alloc(text.length, 88), result.id);
  assert.throws(() => f.service.download(f.reader, result.id), error(503));
  assert.throws(() => f.service.download(f.reader, "../../private"), error(404));
});
test("attachments persist after closing/reopening an isolated SQLite file", async () => {
  const file = filesystemFixture(); let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(file.config, { create: true }); migrateDatabase(db);
    const f = await populate(db), result = f.service.upload(f.agent, "1", metadata, text);
    db.close(); db = openDatabase(file.config);
    const reopened = createAttachmentsService(db, { now: () => initialNow });
    assert.deepEqual(reopened.download(f.agent, result.id).content, text);
    assert.deepEqual(counts(db), { files: 1, audits: 1 }); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db?.close(); file.cleanup(); }
});
