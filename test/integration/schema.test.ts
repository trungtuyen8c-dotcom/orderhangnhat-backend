import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { api, createCustomer, createOrder, createWallet, login, prisma } from "./helpers.js";

const MIGRATIONS_DIR = "prisma/migrations";

describe("schema: migration + FK trên PostgreSQL thật", () => {
  let token: string;
  beforeAll(async () => { token = (await login()).token; });

  it("migrations_allApplied_noFailedOrRolledBack", async () => {
    const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => statSync(`${MIGRATIONS_DIR}/${d}`).isDirectory());
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
    expect(rows.map((r) => r.migration_name).sort()).toEqual(dirs.sort());
    expect(rows.every((r) => r.finished_at && !r.rolled_back_at)).toBe(true);
  });

  it("schema_afterMigrateDeploy_noDriftAgainstSchemaPrisma", () => {
    // --exit-code: 0 = khớp, 2 = lệch (migration thiếu so với schema.prisma)
    const run = () => execFileSync("node_modules/.bin/prisma", [
      "migrate", "diff", "--from-url", process.env.DATABASE_URL!, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    try { out = run(); } catch (e) {
      const err = e as { status?: number; stdout?: string };
      throw new Error(`Schema drift (exit ${err.status}):\n${err.stdout}`);
    }
    expect(out).toMatch(/No difference|empty migration/i);
  });

  it("deleteOrder_withDebtRow_succeedsWithoutFkViolation", async () => {
    const c = await createCustomer(token);
    const o = await createOrder(token, c.id, [{ name: "B", unitPriceJpy: 500, qty: 1 }]);
    const res = await api(token).delete(`/orders/${o.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.order.findUnique({ where: { id: o.id } })).toBeNull();
  });

  it("deleteWallet_withTransactions_409HasTxns", async () => {
    const c = await createCustomer(token);
    const w = await createWallet(token);
    const dep = await api(token).post(`/accounting/customers/${c.id}/deposits`, { amount: 100000, walletId: w.id });
    expect(dep.status).toBe(201);
    expect((await api(token).post(`/accounting/customer-deposits/${dep.body.id}/confirm`)).status).toBe(200);
    const res = await api(token).delete(`/accounting/wallets/${w.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("HAS_TXNS");
    expect(await prisma.wallet.findUnique({ where: { id: w.id } })).not.toBeNull();
  });

  it("deleteWallet_unused_succeeds", async () => {
    const w = await createWallet(token);
    expect((await api(token).delete(`/accounting/wallets/${w.id}`)).status).toBe(200);
  });

  it("deleteCustomer_withOrders_409", async () => {
    const c = await createCustomer(token);
    await createOrder(token, c.id);
    const res = await api(token).delete(`/customers/${c.id}`);
    expect(res.status).toBe(409);
    expect(await prisma.customer.findUnique({ where: { id: c.id } })).not.toBeNull();
  });

  it("deleteCustomer_withoutOrders_succeeds", async () => {
    const c = await createCustomer(token);
    expect((await api(token).delete(`/customers/${c.id}`)).status).toBe(200);
  });
});
