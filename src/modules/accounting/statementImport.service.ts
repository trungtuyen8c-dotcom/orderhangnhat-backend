import { createHash } from "crypto";
import { v4 as uuid } from "uuid";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";
import { vnDayEnd, vnDayStart } from "../../app/vnTime.js";
import { writeAudit, type Actor, type Tx } from "./accounting.repository.js";
import { MAX_ROWS, applyMapping, mappingSchema, readStatementFile, type ParsedRow, type StatementMapping } from "./statementImport.parse.js";
import { DEFAULT_TOLERANCE_DAYS, proposeMatches, shiftDate, type MatchTxn } from "./statementImport.match.js";

// Import sao kê để đối soát tự động (M9-2):
// upload file cho 1 ví (draft) -> chọn cột + xem đề xuất ghép -> duyệt -> commit (1 transaction, audit).
// Dòng sao kê không ghép được chỉ liệt kê, KHÔNG tạo giao dịch.

const VN_OFFSET_MS = 7 * 3600 * 1000;
const vnDate = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

export const statementRefOf = (fileName: string, row: { rowIndex: number; reference: string | null }) =>
  `${fileName}#${row.rowIndex + 1}${row.reference ? ` ${row.reference}` : ""}`.slice(0, 500);

async function requireWallet(walletId: string) {
  const w = await prisma.wallet.findUnique({ where: { id: walletId }, select: { id: true, name: true, currency: true } });
  if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
  return w;
}

export async function getWalletMapping(walletId: string): Promise<StatementMapping | null> {
  await requireWallet(walletId);
  const m = await prisma.walletStatementMapping.findUnique({ where: { walletId } });
  if (!m) return null;
  const p = mappingSchema.safeParse(m.mapping);
  return p.success ? p.data : null;
}

export async function createImport(walletId: string, file: { buffer: Buffer; ext: string; fileName: string }, actor: Actor) {
  await requireWallet(walletId);
  const fileHash = createHash("sha256").update(file.buffer).digest("hex");
  const existing = await prisma.statementImport.findUnique({ where: { walletId_fileHash: { walletId, fileHash } } });
  if (existing?.status === "committed") {
    throw AppError.conflict(`File này đã import cho ví này (${existing.fileName})`, "CONFLICT_DUPLICATE_FILE", { importId: existing.id });
  }
  // Cùng file đang ở bước nháp -> mở lại bản nháp cũ, không tạo bản mới.
  if (existing) return { ...(await getImport(existing.id)), resumed: true };

  let rows: string[][];
  try { rows = await readStatementFile(file.buffer, file.ext); }
  catch { throw new AppError("BAD_FILE", 400, "Không đọc được file sao kê"); }
  if (!rows.length) throw new AppError("BAD_FILE", 400, "File không có dữ liệu");
  if (rows.length > MAX_ROWS + 100) throw new AppError("BAD_FILE", 400, `File quá nhiều dòng (tối đa ${MAX_ROWS})`);

  const id = uuid();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.statementImport.create({ data: { id, walletId, fileName: file.fileName, fileHash, rowCount: rows.length, createdBy: actor.id } });
      await tx.statementImportRow.createMany({ data: rows.map((cells, rowIndex) => ({ id: uuid(), importId: id, rowIndex, cells })) });
      await writeAudit(tx, { actorId: actor.id, targetId: id, action: "statement_import.created", requestId: actor.requestId, metadata: { walletId, fileName: file.fileName, rows: rows.length } });
    });
  } catch (e) {
    // 2 request upload cùng file cùng lúc -> unique (walletId, fileHash).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw AppError.conflict("File này đang được import cho ví này", "CONFLICT_DUPLICATE_FILE");
    }
    throw e;
  }
  return { ...(await getImport(id)), resumed: false };
}

export async function getImport(id: string) {
  const imp = await prisma.statementImport.findUnique({
    where: { id },
    include: { wallet: { select: { id: true, name: true, currency: true } }, rows: { orderBy: { rowIndex: "asc" } } },
  });
  if (!imp) throw AppError.notFound("Không tìm thấy lần import");
  const saved = await prisma.walletStatementMapping.findUnique({ where: { walletId: imp.walletId } });
  const savedMapping = saved ? mappingSchema.safeParse(saved.mapping) : null;
  return {
    id: imp.id, walletId: imp.walletId, wallet: imp.wallet, fileName: imp.fileName, status: imp.status, rowCount: imp.rowCount,
    toleranceDays: imp.toleranceDays, mapping: imp.mapping, createdAt: imp.createdAt, committedAt: imp.committedAt,
    savedMapping: savedMapping?.success ? savedMapping.data : null,
    rows: imp.rows.map((r) => ({
      rowIndex: r.rowIndex, cells: r.cells as string[],
      date: r.txnDate ? r.txnDate.toISOString().slice(0, 10) : null, amount: r.amount != null ? Number(r.amount) : null,
      description: r.description, reference: r.reference, matchedTxnId: r.matchedTxnId,
    })),
  };
}

export async function listImports(walletId?: string) {
  const imps = await prisma.statementImport.findMany({
    where: walletId ? { walletId } : {}, orderBy: { createdAt: "desc" }, take: 100,
    include: { wallet: { select: { name: true } }, _count: { select: { rows: { where: { matchedTxnId: { not: null } } } } } },
  });
  return imps.map((i) => ({
    id: i.id, walletId: i.walletId, walletName: i.wallet.name, fileName: i.fileName, status: i.status, rowCount: i.rowCount,
    matchedCount: i._count.rows, createdAt: i.createdAt, committedAt: i.committedAt,
  }));
}

function parsedRowsOf(rows: { rowIndex: number; cells: Prisma.JsonValue }[], mapping: StatementMapping) {
  return applyMapping(rows.map((r) => ({ rowIndex: r.rowIndex, cells: Array.isArray(r.cells) ? (r.cells as unknown[]).map((c) => String(c ?? "")) : [] })), mapping);
}

// Giao dịch chưa đối soát của ví trong khung [ngày sớm nhất - N, ngày muộn nhất + N] của sao kê.
async function candidateTxns(db: Tx | typeof prisma, walletId: string, parsed: ParsedRow[], toleranceDays: number) {
  const dates = parsed.filter((r) => r.date).map((r) => r.date!).sort();
  if (!dates.length) return [];
  const from = vnDayStart(shiftDate(dates[0], -toleranceDays));
  const to = vnDayEnd(shiftDate(dates[dates.length - 1], toleranceDays));
  return db.walletTxn.findMany({
    where: { walletId, reconciled: false, createdAt: { gte: from, lte: to } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, amount: true, type: true, category: true, note: true, createdAt: true },
  });
}

const toMatchTxn = (t: { id: string; amount: Prisma.Decimal; createdAt: Date }): MatchTxn => ({ id: t.id, amount: Number(t.amount), date: vnDate(t.createdAt) });

async function requireDraft(id: string) {
  const imp = await prisma.statementImport.findUnique({ where: { id }, include: { rows: { select: { rowIndex: true, cells: true }, orderBy: { rowIndex: "asc" } } } });
  if (!imp) throw AppError.notFound("Không tìm thấy lần import");
  if (imp.status !== "draft") throw AppError.conflict("Lần import này đã chốt", "STATE_CONFLICT");
  return imp;
}

// Lưu mapping (cho ví + cho lần import) rồi trả dòng đã đọc + đề xuất ghép. Không đổi WalletTxn.
export async function previewMatches(id: string, input: { mapping: StatementMapping; toleranceDays?: number }, actor: Actor) {
  const imp = await requireDraft(id);
  const toleranceDays = input.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  const mapping = input.mapping;
  await prisma.$transaction([
    prisma.walletStatementMapping.upsert({
      where: { walletId: imp.walletId },
      update: { mapping, updatedBy: actor.id },
      create: { walletId: imp.walletId, mapping, updatedBy: actor.id },
    }),
    prisma.statementImport.update({ where: { id }, data: { mapping, toleranceDays } }),
  ]);
  const parsed = parsedRowsOf(imp.rows, mapping);
  const txns = await candidateTxns(prisma, imp.walletId, parsed, toleranceDays);
  const proposals = proposeMatches(parsed, txns.map(toMatchTxn), toleranceDays);
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const proposalByRow = new Map(proposals.map((p) => [p.rowIndex, p]));
  return {
    toleranceDays,
    rows: parsed.map((r) => {
      const p = proposalByRow.get(r.rowIndex);
      const t = p ? txnById.get(p.txnId)! : null;
      return {
        ...r,
        proposal: p && t ? { txnId: t.id, dayDiff: p.dayDiff, amount: Number(t.amount), date: vnDate(t.createdAt), type: t.type, category: t.category, note: t.note } : null,
      };
    }),
    candidateTxnCount: txns.length,
  };
}

// Ghi các cặp người dùng chấp nhận trong 1 transaction. Kiểm tra lại mọi điều kiện ở server (không tin FE):
// cùng ví, chưa đối soát, cùng số tiền, ngày trong ngưỡng, 1-1. Sai 1 cặp -> không ghi gì.
export async function commitImport(id: string, input: { matches: { rowIndex: number; txnId: string }[] }, actor: Actor) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM statement_imports WHERE id = ${id}::uuid FOR UPDATE`;
    const imp = await tx.statementImport.findUnique({ where: { id }, include: { rows: { select: { rowIndex: true, cells: true }, orderBy: { rowIndex: "asc" } } } });
    if (!imp) throw AppError.notFound("Không tìm thấy lần import");
    if (imp.status !== "draft") throw AppError.conflict("Lần import này đã chốt", "STATE_CONFLICT");
    const m = mappingSchema.safeParse(imp.mapping);
    if (!m.success) throw AppError.badRequest("Chưa chọn cột cho file sao kê");
    const toleranceDays = imp.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
    const parsed = parsedRowsOf(imp.rows, m.data);
    const rowByIndex = new Map(parsed.map((r) => [r.rowIndex, r]));

    const rowSeen = new Set<number>(), txnSeen = new Set<string>();
    for (const x of input.matches) {
      if (rowSeen.has(x.rowIndex) || txnSeen.has(x.txnId)) throw AppError.badRequest("Mỗi dòng sao kê / giao dịch chỉ được ghép 1 lần");
      rowSeen.add(x.rowIndex); txnSeen.add(x.txnId);
    }
    const txns = input.matches.length
      ? await tx.walletTxn.findMany({ where: { id: { in: [...txnSeen] } }, select: { id: true, walletId: true, amount: true, reconciled: true, createdAt: true } })
      : [];
    const txnById = new Map(txns.map((t) => [t.id, t]));
    const proposals = new Map<number, string>();
    for (const x of input.matches) {
      const row = rowByIndex.get(x.rowIndex);
      const t = txnById.get(x.txnId);
      if (!row || row.error || !t || t.walletId !== imp.walletId) throw AppError.badRequest(`Cặp ghép không hợp lệ (dòng ${x.rowIndex + 1})`);
      if (t.reconciled) throw AppError.conflict(`Giao dịch ở dòng ${x.rowIndex + 1} đã được đối soát`, "CONFLICT_ALREADY_RECONCILED");
      const ok = proposeMatches([row], [toMatchTxn(t)], toleranceDays).length === 1;
      if (!ok) throw AppError.badRequest(`Dòng ${x.rowIndex + 1} lệch số tiền hoặc quá ${toleranceDays} ngày`);
      proposals.set(x.rowIndex, x.txnId);
    }

    for (const [rowIndex, txnId] of proposals) {
      const statementRef = statementRefOf(imp.fileName, rowByIndex.get(rowIndex)!);
      // Điều kiện reconciled=false ngay trong UPDATE: đối soát tay đồng thời -> count 0 -> rollback cả lô.
      const { count } = await tx.walletTxn.updateMany({ where: { id: txnId, walletId: imp.walletId, reconciled: false }, data: { reconciled: true, statementRef } });
      if (count !== 1) throw AppError.conflict(`Giao dịch ở dòng ${rowIndex + 1} đã được đối soát`, "CONFLICT_ALREADY_RECONCILED");
      await writeAudit(tx, { actorId: actor.id, targetId: txnId, action: "wallet_txn.reconciled", requestId: actor.requestId, metadata: { statementRef, importId: id } });
    }

    // Lưu kết quả đọc từng dòng (ngày/số tiền/mô tả/mã) + dòng nào đã ghép với giao dịch nào.
    for (const r of parsed) {
      await tx.statementImportRow.update({
        where: { importId_rowIndex: { importId: id, rowIndex: r.rowIndex } },
        data: {
          txnDate: r.date ? new Date(`${r.date}T00:00:00Z`) : null, amount: r.amount,
          description: r.description, reference: r.reference, matchedTxnId: proposals.get(r.rowIndex) ?? null,
        },
      });
    }
    await tx.statementImport.update({ where: { id }, data: { status: "committed", committedAt: new Date(), committedBy: actor.id } });
    const unmatched = parsed.filter((r) => !proposals.has(r.rowIndex));
    await writeAudit(tx, {
      actorId: actor.id, targetId: id, action: "statement_import.committed", requestId: actor.requestId,
      metadata: { walletId: imp.walletId, fileName: imp.fileName, matched: proposals.size, unmatched: unmatched.length, txnIds: [...proposals.values()] },
    });
    return { matched: proposals.size, unmatched };
  }, { timeout: 60_000 });
  return result;
}

// Chỉ xóa được bản nháp (để upload lại cho ví khác / sửa file). Bản đã chốt giữ làm lịch sử + chống import trùng.
export async function deleteImport(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM statement_imports WHERE id = ${id}::uuid FOR UPDATE`;
    const imp = await tx.statementImport.findUnique({ where: { id } });
    if (!imp) throw AppError.notFound("Không tìm thấy lần import");
    if (imp.status !== "draft") throw AppError.conflict("Lần import đã chốt, không xóa được", "STATE_CONFLICT");
    await tx.statementImport.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, targetId: id, action: "statement_import.deleted", requestId: actor.requestId, metadata: { walletId: imp.walletId, fileName: imp.fileName } });
  });
  return { ok: true };
}
