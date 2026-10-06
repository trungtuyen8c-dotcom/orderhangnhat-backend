-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'quoted', 'deposited', 'purchasing', 'purchased', 'jp_warehouse', 'customs', 'tax_done', 'vn_warehouse', 'delivered', 'completed', 'closed', 'cancelled');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" INTEGER NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "jti" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rate_limit" INTEGER NOT NULL DEFAULT 120,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_audit" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "target_id" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" BIGSERIAL NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "fb_zalo" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "note" TEXT,
    "sheet_id" TEXT,
    "ship_rate_per_kg" DECIMAL(14,2),
    "skip_vn_weighing_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "sale_id" UUID,
    "total_quote" DECIMAL(14,2),
    "exchange_rate" DECIMAL(12,4),
    "ship_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ship_currency" TEXT NOT NULL DEFAULT 'JPY',
    "surcharge_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "surcharge_currency" TEXT NOT NULL DEFAULT 'VND',
    "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_currency" TEXT NOT NULL DEFAULT 'VND',
    "service_fee_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "service_fee_currency" TEXT NOT NULL DEFAULT 'VND',
    "jp_domestic_ship_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "jp_domestic_ship_currency" TEXT NOT NULL DEFAULT 'JPY',
    "intl_ship_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "intl_ship_currency" TEXT NOT NULL DEFAULT 'VND',
    "commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "total_vnd" DECIMAL(16,2),
    "deposit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMP(3),
    "needs_check" BOOLEAN NOT NULL DEFAULT false,
    "check_note" TEXT,
    "external_warehouse" BOOLEAN NOT NULL DEFAULT false,
    "skip_vn_weighing" BOOLEAN NOT NULL DEFAULT false,
    "public_token" TEXT NOT NULL,
    "order_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'normal',
    "nick" TEXT,
    "yahoo_paid_at" TIMESTAMP(3),
    "fix_request" TEXT,
    "fix_requested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_logs" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price_jpy" DECIMAL(12,2) NOT NULL,
    "ship_jpy" DECIMAL(12,2),
    "purchase_date" TIMESTAMP(3),
    "payment_method" TEXT,
    "note" TEXT,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trackings" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "code" TEXT NOT NULL,
    "jp_name" TEXT,
    "jp_price_jpy" DECIMAL(12,2),
    "jp_weight_kg" DECIMAL(8,3),
    "vn_weight_kg" DECIMAL(8,3),
    "unit_price_vnd_per_kg" DECIMAL(14,2),
    "ship_rate_currency" TEXT NOT NULL DEFAULT 'VND',
    "vn_tracking_code" TEXT,
    "delivered_at" TIMESTAMP(3),
    "stored_at" TIMESTAMP(3),
    "customer_received_at" TIMESTAMP(3),
    "carton_id" UUID,
    "carton_manual" BOOLEAN NOT NULL DEFAULT false,
    "review" TEXT,
    "url" TEXT,
    "packed_at" TIMESTAMP(3),
    "pack_row" INTEGER,
    "customs_name" TEXT,
    "late_after_lock" BOOLEAN NOT NULL DEFAULT false,
    "needs_tax" BOOLEAN NOT NULL DEFAULT false,
    "tax_collected" BOOLEAN NOT NULL DEFAULT false,
    "tax_audit_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trackings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_day_locks" (
    "date" DATE NOT NULL,
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" UUID,

    CONSTRAINT "pack_day_locks_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "cartons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "declared_weight_kg" DECIMAL(8,3),
    "vn_total_weight_kg" DECIMAL(8,3),
    "weight_confirmed_at" TIMESTAMP(3),
    "electronics_count" INTEGER,
    "electronics_confirmed_at" TIMESTAMP(3),
    "packed_date" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cartons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_logs" (
    "id" BIGSERIAL NOT NULL,
    "tracking_id" UUID NOT NULL,
    "actor_id" UUID,
    "old_value" JSONB,
    "new_value" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "type" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "invoice_date" DATE,
    "uploaded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount_vnd" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "amount_orig" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exchange_rate" DECIMAL(12,4),
    "method" TEXT,
    "wallet_id" UUID,
    "recorded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "balance" DECIMAL(16,2) NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_daily_actuals" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "actual_balance" DECIMAL(16,2) NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_daily_actuals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "balance" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund_txns" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount_yen" DECIMAL(16,2) NOT NULL,
    "rate" DECIMAL(12,4),
    "wallet_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_balance" DECIMAL(16,2),
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "recorded_by" UUID,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMP(3),
    "fix_request" TEXT,
    "fix_requested_at" TIMESTAMP(3),

    CONSTRAINT "fund_txns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_txns" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT,
    "note" TEXT,
    "transfer_ref" UUID,
    "ref_order_id" UUID,
    "ref_deposit_id" UUID,
    "ref_fund_txn_id" UUID,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "statement_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_txns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_deposits" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount_vnd" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "amount_orig" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exchange_rate" DECIMAL(12,4),
    "payer_name" TEXT,
    "method" TEXT,
    "wallet_id" UUID,
    "note" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "is_opening" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMP(3),
    "recorded_by" UUID,
    "fix_request" TEXT,
    "fix_requested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL,
    "value" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "tax_row_notes" (
    "tracking_code" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "tax_collected" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tax_row_notes_pkey" PRIMARY KEY ("tracking_code")
);

-- CreateTable
CREATE TABLE "bill_invoice_status" (
    "key" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "bill_invoice_status_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "backup_runs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scope_db" BOOLEAN NOT NULL DEFAULT true,
    "scope_files" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "remote_path" TEXT,
    "error" TEXT,
    "log_tail" TEXT,
    "triggered_by" UUID,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_costs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount_vnd" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "amount_orig" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exchange_rate" DECIMAL(12,4),
    "ref_id" UUID,
    "note" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "late_after_lock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "kind" TEXT NOT NULL DEFAULT 'compensation',
    "amount_vnd" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "amount_orig" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exchange_rate" DECIMAL(12,4),
    "note" TEXT,
    "incurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount_vnd" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weight_recon" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "jp_weight" DECIMAL(8,3),
    "vn_weight" DECIMAL(8,3),
    "diff_kg" DECIMAL(8,3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weight_recon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "access_audit_actor_id_created_at_idx" ON "access_audit"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "access_audit_action_created_at_idx" ON "access_audit"("action", "created_at");

-- CreateIndex
CREATE INDEX "system_logs_created_at_idx" ON "system_logs"("created_at");

-- CreateIndex
CREATE INDEX "system_logs_level_created_at_idx" ON "system_logs"("level", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_code_key" ON "orders"("code");

-- CreateIndex
CREATE UNIQUE INDEX "orders_public_token_key" ON "orders"("public_token");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "order_logs_order_id_idx" ON "order_logs"("order_id");

-- CreateIndex
CREATE INDEX "trackings_code_idx" ON "trackings"("code");

-- CreateIndex
CREATE INDEX "debts_customer_id_idx" ON "debts"("customer_id");

-- CreateIndex
CREATE INDEX "debts_order_id_idx" ON "debts"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_name_key" ON "wallets"("name");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_daily_actuals_wallet_id_date_key" ON "wallet_daily_actuals"("wallet_id", "date");

-- CreateIndex
CREATE INDEX "customer_deposits_customer_id_idx" ON "customer_deposits"("customer_id");

-- CreateIndex
CREATE INDEX "customer_deposits_confirmed_idx" ON "customer_deposits"("confirmed");

-- CreateIndex
CREATE INDEX "backup_runs_started_at_idx" ON "backup_runs"("started_at");

-- CreateIndex
CREATE INDEX "company_costs_month_idx" ON "company_costs"("month");

-- CreateIndex
CREATE INDEX "expenses_order_id_idx" ON "expenses"("order_id");

-- CreateIndex
CREATE INDEX "payrolls_month_idx" ON "payrolls"("month");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_logs" ADD CONSTRAINT "order_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trackings" ADD CONSTRAINT "trackings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trackings" ADD CONSTRAINT "trackings_carton_id_fkey" FOREIGN KEY ("carton_id") REFERENCES "cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_logs" ADD CONSTRAINT "tracking_logs_tracking_id_fkey" FOREIGN KEY ("tracking_id") REFERENCES "trackings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_daily_actuals" ADD CONSTRAINT "wallet_daily_actuals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

