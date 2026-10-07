-- 2FA TOTP (dang nhap 2 lop): secret ma hoa AES-256-GCM + ma khoi phuc dung 1 lan (chi luu sha256).
-- Chi them cot nullable/bang moi (khong doi du lieu cu) -> an toan khi chay tren production.
BEGIN;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN "totp_secret" TEXT;

-- CreateTable
CREATE TABLE "user_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_recovery_codes_code_hash_key" ON "user_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "user_recovery_codes_user_id_idx" ON "user_recovery_codes"("user_id");

-- AddForeignKey
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
