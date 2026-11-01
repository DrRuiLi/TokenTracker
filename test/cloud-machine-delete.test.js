const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

test("machine alias migration permits deleting registered and merged accounts without affecting other users", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE tokentracker_cloud_policy(environment text PRIMARY KEY); INSERT INTO tokentracker_cloud_policy VALUES('live');");
    const original = fs.readFileSync(path.join(__dirname, "../migrations/20261004120000_cloud-machine-access.sql"), "utf8");
    await db.exec(original.slice(original.indexOf("CREATE TABLE"), original.indexOf("CREATE INDEX")));
    const owner = randomUUID();
    const other = randomUUID();
    const machine = randomUUID();
    const merged = randomUUID();
    const otherMachine = randomUUID();
    await db.query("INSERT INTO auth.users VALUES($1),($2)", [owner, other]);
    await db.query("INSERT INTO tokentracker_cloud_machines(id,user_id,environment) VALUES($1,$2,'live'),($3,$4,'live')", [machine, owner, otherMachine, other]);
    await db.query("INSERT INTO tokentracker_cloud_machines(id,user_id,environment,status,merged_into) VALUES($1,$2,'live','merged',$3)", [merged, owner, machine]);
    await db.query("INSERT INTO tokentracker_cloud_machine_aliases VALUES($1,'live','device','registered',$2),($1,'live','machine','merged',$3),($4,'live','device','other',$5)", [owner, machine, merged, other, otherMachine]);
    await assert.rejects(db.query("DELETE FROM auth.users WHERE id=$1", [owner]), error => error.code === "23503");
    await db.exec(fs.readFileSync(path.join(__dirname, "../migrations/20261012120000_cloud-machine-alias-cascade.sql"), "utf8"));
    await db.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    assert.deepEqual((await db.query("SELECT user_id FROM tokentracker_cloud_machines")).rows, [{ user_id: other }]);
    assert.deepEqual((await db.query("SELECT user_id FROM tokentracker_cloud_machine_aliases")).rows, [{ user_id: other }]);
    await db.query("DELETE FROM auth.users WHERE id=$1", [other]);
    assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_machine_aliases")).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
