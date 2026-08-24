import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import type { ProbePersistencePort } from "../application/index.js";

const testSchema = pgSchema("wp005_test");
export const wp005Probe = testSchema.table("synthetic_probe", {
  id: text("id").primaryKey(),
  tenantPlaceholder: text("tenant_placeholder").notNull(),
  input: text("input").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export function createPostgresProbeAdapter(pool: Pool): ProbePersistencePort {
  const db = drizzle(pool);
  return {
    save: async (context, probe) => {
      await db.insert(wp005Probe).values({
        id: probe.id,
        tenantPlaceholder: context.tenantPlaceholder,
        input: probe.input
      });
    }
  };
}
