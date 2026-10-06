-- Pre-check truoc khi apply migration 2_add_foreign_keys tren production.
-- Moi dong = 1 FK moi; orphan_count phai = 0 het thi ALTER TABLE ... ADD CONSTRAINT moi chay duoc.
-- Read-only, chay: psql "$DATABASE_URL" -f prisma/checks/fk-orphans.sql
SELECT 'documents.order_id -> orders' AS fk, count(*) AS orphan_count
  FROM documents c WHERE c.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.id = c.order_id)
UNION ALL
SELECT 'debts.customer_id -> customers', count(*)
  FROM debts c WHERE NOT EXISTS (SELECT 1 FROM customers p WHERE p.id = c.customer_id)
UNION ALL
SELECT 'debts.order_id -> orders', count(*)
  FROM debts c WHERE c.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.id = c.order_id)
UNION ALL
SELECT 'fund_txns.wallet_id -> wallets', count(*)
  FROM fund_txns c WHERE c.wallet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallets p WHERE p.id = c.wallet_id)
UNION ALL
SELECT 'wallet_txns.ref_order_id -> orders', count(*)
  FROM wallet_txns c WHERE c.ref_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.id = c.ref_order_id)
UNION ALL
SELECT 'wallet_txns.ref_deposit_id -> customer_deposits', count(*)
  FROM wallet_txns c WHERE c.ref_deposit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_deposits p WHERE p.id = c.ref_deposit_id)
UNION ALL
SELECT 'wallet_txns.ref_fund_txn_id -> fund_txns', count(*)
  FROM wallet_txns c WHERE c.ref_fund_txn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fund_txns p WHERE p.id = c.ref_fund_txn_id)
UNION ALL
SELECT 'customer_deposits.customer_id -> customers', count(*)
  FROM customer_deposits c WHERE NOT EXISTS (SELECT 1 FROM customers p WHERE p.id = c.customer_id)
UNION ALL
SELECT 'customer_deposits.wallet_id -> wallets', count(*)
  FROM customer_deposits c WHERE c.wallet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wallets p WHERE p.id = c.wallet_id)
UNION ALL
SELECT 'company_costs.ref_id -> trackings', count(*)
  FROM company_costs c WHERE c.ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trackings p WHERE p.id = c.ref_id)
UNION ALL
SELECT 'expenses.order_id -> orders', count(*)
  FROM expenses c WHERE c.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.id = c.order_id)
UNION ALL
SELECT 'weight_recon.order_id -> orders', count(*)
  FROM weight_recon c WHERE NOT EXISTS (SELECT 1 FROM orders p WHERE p.id = c.order_id)
ORDER BY 1;

-- Kiem tra partial index 1_orphan_tracking_unique_index: phai tra 0 dong (neu co -> chay prisma/dedupe-orphan-tracking.ts)
SELECT code, count(*) FROM trackings WHERE order_id IS NULL GROUP BY code HAVING count(*) > 1;
-- Index da ton tai chua (co -> resolve --applied 1_orphan_tracking_unique_index)
SELECT indexname FROM pg_indexes WHERE tablename = 'trackings' AND indexname = 'trackings_code_orphan_uniq';
