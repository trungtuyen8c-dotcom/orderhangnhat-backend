-- Boc transaction: FK nao vi pham (du lieu mo coi) thi rollback toan bo, khong ap do dang.
-- Chay prisma/checks/fk-orphans.sql truoc tren production.
BEGIN;

-- CreateIndex
CREATE INDEX "documents_order_id_idx" ON "documents"("order_id");

-- CreateIndex
CREATE INDEX "fund_txns_wallet_id_idx" ON "fund_txns"("wallet_id");

-- CreateIndex
CREATE INDEX "wallet_txns_ref_order_id_idx" ON "wallet_txns"("ref_order_id");

-- CreateIndex
CREATE INDEX "wallet_txns_ref_deposit_id_idx" ON "wallet_txns"("ref_deposit_id");

-- CreateIndex
CREATE INDEX "wallet_txns_ref_fund_txn_id_idx" ON "wallet_txns"("ref_fund_txn_id");

-- CreateIndex
CREATE INDEX "customer_deposits_wallet_id_idx" ON "customer_deposits"("wallet_id");

-- CreateIndex
CREATE INDEX "company_costs_ref_id_idx" ON "company_costs"("ref_id");

-- CreateIndex
CREATE INDEX "weight_recon_order_id_idx" ON "weight_recon"("order_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fund_txns" ADD CONSTRAINT "fund_txns_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_ref_order_id_fkey" FOREIGN KEY ("ref_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_ref_deposit_id_fkey" FOREIGN KEY ("ref_deposit_id") REFERENCES "customer_deposits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_ref_fund_txn_id_fkey" FOREIGN KEY ("ref_fund_txn_id") REFERENCES "fund_txns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_deposits" ADD CONSTRAINT "customer_deposits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_deposits" ADD CONSTRAINT "customer_deposits_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_costs" ADD CONSTRAINT "company_costs_ref_id_fkey" FOREIGN KEY ("ref_id") REFERENCES "trackings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weight_recon" ADD CONSTRAINT "weight_recon_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
