import assert from "node:assert/strict";
import test from "node:test";
import { createPushPersistence, withTenantTransaction } from "@kavaroutes/postgres-persistence";
import { withFreshDatabase } from "../../postgres-persistence/scripts/database-fixture.mjs";

const connectionString = process.env.WP012_DATABASE_URL;
if (!connectionString) throw new Error("WP012_DATABASE_URL is required");
const ids = Object.freeze({ tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  registration: "51000000-0000-4000-8000-000000000001", organization: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  principal: "10000000-0000-4000-8000-000000000002", subject: "30000000-0000-4000-8000-000000000001", installation: "50000000-0000-4000-8000-000000000001" });

test("push registrations persist encrypted under forced tenant isolation and exact-generation revocation", async () => {
  await withFreshDatabase(connectionString, "push_registration", async (pool) => {
    for (const tenantId of [ids.tenant, ids.other]) await withTenantTransaction(pool, tenantId, "kavaroutes_api", (client) =>
      client.query("INSERT INTO platform.organization (tenant_id,id,synthetic_name) VALUES ($1,$1,$2)", [tenantId, `Synthetic ${tenantId.slice(0, 4)}`]));
    const persistence = createPushPersistence(pool);
    const result = await persistence.upsertRegistration({ tenantId: ids.tenant, id: ids.registration, organizationId: ids.organization,
      principalId: ids.principal, subjectId: ids.subject, installationId: ids.installation, generation: "gen_synthetic000001",
      platform: "android", provider: "fcm", environment: "development", appId: "com.kavaroutes.driver.synthetic",
      tokenCiphertext: Buffer.alloc(48, 7), tokenKeyedHash: Buffer.alloc(32, 9), permission: "granted", channelEnabled: true });
    assert.equal(result.lifecycle, "ACTIVE"); assert.equal(await persistence.activeRegistrationCount(ids.tenant, ids.principal), 1);
    assert.equal(await persistence.activeRegistrationCount(ids.other, ids.principal), 0);
    await withTenantTransaction(pool, ids.tenant, "kavaroutes_migration", async (client) => {
      const row = (await client.query("SELECT token_ciphertext,token_keyed_hash FROM notification.installation_registration WHERE id=$1", [ids.registration])).rows[0];
      assert.equal(row.token_ciphertext.equals(Buffer.alloc(48, 7)), true); assert.equal(row.token_keyed_hash.equals(Buffer.alloc(32, 9)), true);
    });
    await persistence.deactivateRegistration({ tenantId: ids.tenant, organizationId: ids.organization, principalId: ids.principal,
      subjectId: ids.subject, installationId: ids.installation, generation: "gen_synthetic000001", reason: "logout" });
    assert.equal(await persistence.activeRegistrationCount(ids.tenant, ids.principal), 0);
  });
});
