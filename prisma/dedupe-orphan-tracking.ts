import { PrismaClient } from "@prisma/client";

// Gop Tracking trung ma do race giua cron syncPackedFromWarehouse (2 phut) va webhook syncPackedOne
// (tuc thi) - ca 2 deu "tim khong thay thi tao moi" khong khoa nhau, sinh 2 dong cung code.
// Chi gop cap co DUNG 1 dong co orderId (dong "chinh") + cac dong con lai orphan (orderId null) cung ma -
// copy field con thieu tu orphan sang dong chinh roi xoa orphan. Bo qua case nhieu dong deu co orderId
// KHAC nhau (shop gop nhieu don chung 1 tracking - hop le theo trackingClaim.ts, khong phai bug).
// Mac dinh DRY-RUN (chi in ra). Gop that: DEDUPE_APPLY=1
const prisma = new PrismaClient();
const APPLY = process.env.DEDUPE_APPLY === "1";

const MERGE_FIELDS = [
  "cartonId", "cartonManual", "vnWeightKg", "vnTrackingCode", "deliveredAt", "jpWeightKg",
  "jpName", "jpPriceJpy", "review", "packRow", "customsName", "unitPriceVndPerKg", "taxCollected",
] as const;

async function main() {
  const dup = await prisma.tracking.groupBy({
    by: ["code"],
    _count: { code: true },
    having: { code: { _count: { gt: 1 } } },
  });
  console.log(`Ma trung: ${dup.length}`);

  let mergedGroups = 0, deletedRows = 0, skippedMultiOrder = 0, skippedNoWinner = 0, skippedHasCost = 0;

  for (const g of dup) {
    const rows = await prisma.tracking.findMany({ where: { code: g.code }, orderBy: { createdAt: "asc" } });
    const withOrder = rows.filter((r) => r.orderId != null);
    const orphans = rows.filter((r) => r.orderId == null);

    let winner: (typeof rows)[number] | null = null;
    let losers: (typeof rows)[number][] = [];

    // Luôn rút gọn các dòng MỒ CÔI (orderId null) trùng mã về tối đa 1 dòng trước - đây là phần thật sự vi phạm
    // unique index (WHERE order_id IS NULL), bất kể có bao nhiêu dòng khác đã gắn đơn khác nhau cùng mã.
    let remainOrphan: (typeof rows)[number] | null = null;
    if (orphans.length >= 2) {
      remainOrphan = orphans.find((o) => o.cartonId) ?? orphans[0];
      losers.push(...orphans.filter((o) => o.id !== remainOrphan!.id));
    } else if (orphans.length === 1) {
      remainOrphan = orphans[0];
    }

    if (withOrder.length === 1 && remainOrphan) {
      // Đúng 1 đơn thật -> gộp luôn orphan còn lại vào đó cho sạch (không chỉ để vừa đủ unique index)
      winner = withOrder[0];
      losers.push(remainOrphan);
    } else if (withOrder.length === 0 && remainOrphan) {
      winner = remainOrphan;
    } else if (withOrder.length >= 2) {
      // Nhiều đơn khác nhau dùng chung mã - hợp lệ, không đụng; phần orphan dư (nếu có) đã rút gọn ở trên rồi
      skippedMultiOrder++;
      if (!losers.length) continue;
      winner = remainOrphan; // chỉ để log dòng giữ lại cho phần orphan, các dòng withOrder không đổi
    } else {
      skippedNoWinner++;
      continue;
    }
    if (!losers.length || !winner) continue;
    mergedGroups++;

    console.log(`\n[${g.code}] giu id=${winner.id} (order=${winner.orderId ?? "-"} carton=${winner.cartonId ?? "-"})`);
    const patch: Record<string, unknown> = {};
    for (const loser of losers) {
      for (const f of MERGE_FIELDS) {
        if ((winner as any)[f] == null && (loser as any)[f] != null) patch[f] = (loser as any)[f];
      }
      console.log(`  xoa id=${loser.id} (order=${loser.orderId ?? "-"} carton=${loser.cartonId ?? "-"} vnWeightKg=${loser.vnWeightKg ?? "-"} vnTrackingCode=${loser.vnTrackingCode ?? "-"})`);
    }
    if (Object.keys(patch).length) console.log(`  -> copy sang dong giu lai: ${JSON.stringify(patch)}`);

    if (!APPLY) continue;
    if (Object.keys(patch).length) await prisma.tracking.update({ where: { id: winner.id }, data: patch });
    for (const loser of losers) {
      const stuckCost = await prisma.companyCost.findFirst({ where: { refId: loser.id } });
      if (stuckCost) { console.log(`  BO QUA xoa id=${loser.id} - co CompanyCost gan vao, can xu ly tay`); skippedHasCost++; continue; }
      await prisma.trackingLog.deleteMany({ where: { trackingId: loser.id } });
      await prisma.tracking.delete({ where: { id: loser.id } });
      deletedRows++;
    }
  }

  console.log(`\n=== ${APPLY ? "DA GOP" : "DRY-RUN (chua gop)"} ===`);
  console.log(`Nhom xu ly: ${mergedGroups} | xoa: ${deletedRows} dong | bo qua vi co CompanyCost: ${skippedHasCost}`);
  console.log(`Bo qua (nhieu don khac nhau - hop le, khong dung): ${skippedMultiOrder}`);
  console.log(`Bo qua (khong xac dinh dong chinh): ${skippedNoWinner}`);
  if (!APPLY) console.log("\n(DRY-RUN. Chay lai voi DEDUPE_APPLY=1 de gop that.)\n");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
