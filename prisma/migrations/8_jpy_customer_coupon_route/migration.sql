-- Khach tra yen, % cong mac dinh, gia can bien, kupon, phi khach chiu, tuyen kien, du an cua giao dich vi.
-- Chi them cot co default/nullable -> an toan tren production.
BEGIN;

ALTER TABLE "customers" ADD COLUMN "ship_rate_sea_per_kg" DECIMAL(14,2),
ADD COLUMN "pay_currency" TEXT NOT NULL DEFAULT 'VND',
ADD COLUMN "commission_percent_default" DECIMAL(5,2) NOT NULL DEFAULT 0;

ALTER TABLE "orders" ADD COLUMN "coupon_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "coupon_currency" TEXT NOT NULL DEFAULT 'JPY',
ADD COLUMN "service_fee_customer_pays" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "due_jpy" DECIMAL(14,2);

ALTER TABLE "cartons" ADD COLUMN "route" TEXT NOT NULL DEFAULT 'air';

ALTER TABLE "wallet_txns" ADD COLUMN "project" TEXT NOT NULL DEFAULT 'order';

COMMIT;
