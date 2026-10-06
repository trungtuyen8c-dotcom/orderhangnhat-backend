import request from "supertest";
import { v4 as uuid } from "uuid";
import { api, createUser, createWallet, login, prisma, server } from "./helpers.js";

// M9-2: import sao kê -> chọn cột -> đề xuất ghép -> duyệt -> commit 1 transaction.
const vn = (d: string) => new Date(`${d}T10:00:00+07:00`);

describe("M9-2: import sao kê đối soát", () => {
  let admin: string;
  beforeAll(async () => { admin = (await login()).token; });

  const upload = (token: string, walletId: string, csv: string, name = "saoke.csv") =>
    request(server).post("/api/accounting/statement-imports").set("Authorization", `Bearer ${token}`)
      .field("walletId", walletId).attach("file", Buffer.from(csv), { filename: name });

  async function txn(walletId: string, amount: number, date: string, reconciled = false) {
    return prisma.walletTxn.create({ data: { id: uuid(), walletId, amount, type: amount > 0 ? "in" : "out", createdAt: vn(date), reconciled } });
  }

  const CSV = [
    "Sao ke tai khoan",
    "Ngay;No;Co;Noi dung;Ma GD",
    "07/10/2026;100.000;;Mua hang;FT001",
    "08/10/2026;;250.000;Khach CK;FT002",
    "09/10/2026;;999.000;Khong khop;FT003",
    "xx;1;;Loi ngay;",
  ].join("\n");
  const MAPPING = { headerRow: 2, dateCol: 0, dateFormat: "DMY", amountMode: "debitCredit", debitCol: 1, creditCol: 2, descriptionCol: 3, referenceCol: 4 };

  it("fullFlow_proposes_commitsAccepted_onlyOnce", async () => {
    const w = await createWallet(admin);
    const t1 = await txn(w.id, -100000, "2026-10-06");
    const t2 = await txn(w.id, 250000, "2026-10-08");
    const tOther = await txn(w.id, 250000, "2026-10-20"); // ngoài ngưỡng 2 ngày
    await txn(w.id, -100000, "2026-10-07", true); // đã đối soát -> không là ứng viên

    const up = await upload(admin, w.id, CSV);
    expect(up.status).toBe(201);
    expect(up.body.rows).toHaveLength(6);
    expect(up.body.savedMapping).toBeNull();

    const pv = await api(admin).post(`/accounting/statement-imports/${up.body.id}/preview`, { mapping: MAPPING });
    expect(pv.status).toBe(200);
    expect(pv.body.toleranceDays).toBe(2);
    const byRow = Object.fromEntries(pv.body.rows.map((r: { rowIndex: number }) => [r.rowIndex, r]));
    expect(byRow[2].proposal).toMatchObject({ txnId: t1.id, dayDiff: 1 });
    expect(byRow[3].proposal).toMatchObject({ txnId: t2.id, dayDiff: 0 });
    expect(byRow[4].proposal).toBeNull();
    expect(byRow[5].error).toBe("DATE");
    // Preview không đổi gì trên sổ
    expect(await prisma.walletTxn.count({ where: { walletId: w.id, reconciled: true } })).toBe(1);

    // Mapping đã lưu theo ví
    const saved = await api(admin).get(`/accounting/wallets/${w.id}/statement-mapping`);
    expect(saved.body.mapping).toMatchObject({ headerRow: 2, debitCol: 1 });

    // Người dùng chỉ chấp nhận 1 cặp
    const cm = await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, { matches: [{ rowIndex: 2, txnId: t1.id }] });
    expect(cm.status).toBe(200);
    expect(cm.body.matched).toBe(1);
    expect(cm.body.unmatched.map((r: { rowIndex: number }) => r.rowIndex)).toEqual([3, 4, 5]);
    const r1 = await prisma.walletTxn.findUniqueOrThrow({ where: { id: t1.id } });
    expect(r1).toMatchObject({ reconciled: true, statementRef: "saoke.csv#3 FT001" });
    expect((await prisma.walletTxn.findUniqueOrThrow({ where: { id: t2.id } })).reconciled).toBe(false);
    expect((await prisma.walletTxn.findUniqueOrThrow({ where: { id: tOther.id } })).reconciled).toBe(false);
    expect(await prisma.walletTxn.count({ where: { walletId: w.id } })).toBe(4); // không tạo giao dịch mới
    expect(await prisma.accessAudit.count({ where: { targetId: up.body.id, action: "statement_import.committed" } })).toBe(1);
    expect(await prisma.accessAudit.count({ where: { targetId: t1.id, action: "wallet_txn.reconciled" } })).toBe(1);
    const row2 = await prisma.statementImportRow.findFirstOrThrow({ where: { importId: up.body.id, rowIndex: 2 } });
    expect(row2.matchedTxnId).toBe(t1.id);
    expect(Number(row2.amount)).toBe(-100000);

    // Cùng file, cùng ví -> 409; commit lại -> 409; xóa bản đã chốt -> 409
    const again = await upload(admin, w.id, CSV, "doi-ten.csv");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("CONFLICT_DUPLICATE_FILE");
    expect((await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, { matches: [] })).status).toBe(409);
    expect((await api(admin).delete(`/accounting/statement-imports/${up.body.id}`)).status).toBe(409);

    // Cùng file cho ví khác -> được
    const w2 = await createWallet(admin);
    const other = await upload(admin, w2.id, CSV);
    expect(other.status).toBe(201);
    expect(other.body.savedMapping).toBeNull();

    const list = await api(admin).get(`/accounting/statement-imports?walletId=${w.id}`);
    expect(list.body).toEqual([expect.objectContaining({ id: up.body.id, status: "committed", matchedCount: 1 })]);
  });

  it("commit_rejectsInvalidPairs_atomically", async () => {
    const w = await createWallet(admin);
    const ok = await txn(w.id, -100000, "2026-10-07");
    const wrongAmount = await txn(w.id, 250001, "2026-10-08");
    const up = await upload(admin, w.id, CSV);
    // Commit trước khi chọn cột -> 400
    expect((await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, { matches: [] })).status).toBe(400);
    await api(admin).post(`/accounting/statement-imports/${up.body.id}/preview`, { mapping: MAPPING, toleranceDays: 0 });
    const bad = await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, {
      matches: [{ rowIndex: 2, txnId: ok.id }, { rowIndex: 3, txnId: wrongAmount.id }],
    });
    expect(bad.status).toBe(400);
    expect((await prisma.walletTxn.findUniqueOrThrow({ where: { id: ok.id } })).reconciled).toBe(false);
    // Giao dịch ví khác
    const w2 = await createWallet(admin);
    const foreign = await txn(w2.id, -100000, "2026-10-07");
    expect((await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, { matches: [{ rowIndex: 2, txnId: foreign.id }] })).status).toBe(400);
    // Trùng 1 giao dịch cho 2 dòng
    expect((await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, { matches: [{ rowIndex: 2, txnId: ok.id }, { rowIndex: 3, txnId: ok.id }] })).status).toBe(400);
    // Đã bị đối soát tay trong lúc đang duyệt -> 409, không ghi gì
    await api(admin).post(`/accounting/wallet-txns/${ok.id}/reconcile`, { statementRef: "tay" });
    const conflict = await api(admin).post(`/accounting/statement-imports/${up.body.id}/commit`, { matches: [{ rowIndex: 2, txnId: ok.id }] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("CONFLICT_ALREADY_RECONCILED");
    expect((await prisma.walletTxn.findUniqueOrThrow({ where: { id: ok.id } })).statementRef).toBe("tay");
    expect((await prisma.statementImport.findUniqueOrThrow({ where: { id: up.body.id } })).status).toBe("draft");
  });

  it("draft_resumedOnReupload_andDeletable", async () => {
    const w = await createWallet(admin);
    const a = await upload(admin, w.id, "Ngay,Tien\n2026-10-07,5\n");
    const b = await upload(admin, w.id, "Ngay,Tien\n2026-10-07,5\n");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id: a.body.id, resumed: true });
    expect((await api(admin).delete(`/accounting/statement-imports/${a.body.id}`)).status).toBe(200);
    expect((await upload(admin, w.id, "Ngay,Tien\n2026-10-07,5\n")).status).toBe(201);
  });

  it("validation_and_permissions", async () => {
    const w = await createWallet(admin);
    expect((await upload(admin, w.id, "%PDF-1.4", "x.pdf")).status).toBe(400);
    expect((await upload(admin, uuid(), "a,b\n1,2")).status).toBe(404);
    const up = await upload(admin, w.id, "a,b\n1,2\n");
    expect((await api(admin).post(`/accounting/statement-imports/${up.body.id}/preview`, { mapping: { headerRow: 1, dateCol: 0, amountMode: "signed" } })).status).toBe(400);
    const sale = await createUser(admin, "sale");
    expect((await upload(sale.token, w.id, "a,b\n3,4\n")).status).toBe(403);
    expect((await api(sale.token).get(`/accounting/statement-imports/${up.body.id}`)).status).toBe(403);
    const acc = await createUser(admin, "accountant");
    expect((await api(acc.token).get(`/accounting/statement-imports/${up.body.id}`)).status).toBe(200);
  });
});
