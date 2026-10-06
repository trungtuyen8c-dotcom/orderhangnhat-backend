import { describe, it, expect } from "vitest";
import { checkFile, contentDisposition, decodeOriginalName, DOCUMENT_KINDS, sanitizeFilename, TAX_SCAN_KINDS } from "./documentUpload.js";

const MB = 1024 * 1024;
const PDF = Buffer.from("%PDF-1.7\n...");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EXE = Buffer.from("MZ\x90\x00\x03\x00");
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic")]);

describe("checkFile (documents)", () => {
  it("checkFile_pdfWithPdfMagic_acceptsWithServerMime", () => {
    expect(checkFile("hoa-don.pdf", PDF, 1000, DOCUMENT_KINDS)).toEqual({ ok: true, kind: "pdf", mime: "application/pdf" });
  });

  it("checkFile_uppercaseExtension_isAccepted", () => {
    expect(checkFile("SCAN.JPG", JPG, 1000, DOCUMENT_KINDS)).toMatchObject({ ok: true, mime: "image/jpeg" });
  });

  it("checkFile_pngImage_accepted", () => {
    expect(checkFile("a.png", PNG, 10, DOCUMENT_KINDS)).toMatchObject({ ok: true, kind: "png" });
  });

  it("checkFile_iphoneHeicPhoto_accepted", () => {
    expect(checkFile("IMG_0001.HEIC", HEIC, 10, DOCUMENT_KINDS)).toMatchObject({ ok: true, mime: "image/heic" });
  });

  it("checkFile_xlsxAndDocx_acceptedAsOfficeZip", () => {
    expect(checkFile("packing.xlsx", ZIP, 10, DOCUMENT_KINDS)).toMatchObject({ ok: true, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(checkFile("thanh-phan.docx", ZIP, 10, DOCUMENT_KINDS)).toMatchObject({ ok: true, kind: "office-zip" });
  });

  it("checkFile_legacyXls_acceptedAsOle", () => {
    expect(checkFile("old.xls", OLE, 10, DOCUMENT_KINDS)).toMatchObject({ ok: true, mime: "application/vnd.ms-excel" });
  });

  it("checkFile_executableRenamedToPdf_rejectedByMagicBytes", () => {
    expect(checkFile("invoice.pdf", EXE, 10, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "TYPE" });
  });

  it("checkFile_pngContentWithPdfExtension_rejected", () => {
    expect(checkFile("invoice.pdf", PNG, 10, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "TYPE" });
  });

  it("checkFile_disallowedExtension_rejected", () => {
    expect(checkFile("setup.exe", EXE, 10, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "TYPE" });
    expect(checkFile("page.html", Buffer.from("<html>"), 10, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "TYPE" });
  });

  it("checkFile_noExtension_rejected", () => {
    expect(checkFile("README", PDF, 10, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "TYPE" });
  });

  it("checkFile_csvWithNulBytes_rejectedAsBinary", () => {
    expect(checkFile("data.csv", Buffer.from([0x61, 0x00, 0x62]), 3, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "TYPE" });
    expect(checkFile("data.csv", Buffer.from("a,b\n1,2"), 7, DOCUMENT_KINDS)).toMatchObject({ ok: true, mime: "text/csv" });
  });

  it("checkFile_imageOverPerTypeLimit_rejectedWithSizeAndLimit", () => {
    expect(checkFile("a.png", PNG, 26 * MB, DOCUMENT_KINDS)).toEqual({ ok: false, reason: "SIZE", maxBytes: 25 * MB });
  });

  it("checkFile_pdfUpTo50MB_accepted", () => {
    expect(checkFile("big.pdf", PDF, 50 * MB, DOCUMENT_KINDS)).toMatchObject({ ok: true });
  });
});

describe("checkFile (tax scan)", () => {
  it("taxScan_xlsx_accepted", () => {
    expect(checkFile("GB.123.xlsx", ZIP, 10, TAX_SCAN_KINDS)).toMatchObject({ ok: true });
  });

  it("taxScan_docxEvenThoughZip_rejected", () => {
    expect(checkFile("x.docx", ZIP, 10, TAX_SCAN_KINDS)).toEqual({ ok: false, reason: "TYPE" });
  });

  it("taxScan_pdf_rejected", () => {
    expect(checkFile("x.pdf", PDF, 10, TAX_SCAN_KINDS)).toEqual({ ok: false, reason: "TYPE" });
  });

  it("taxScan_over20MB_rejectedForSize", () => {
    expect(checkFile("x.xlsx", ZIP, 21 * MB, TAX_SCAN_KINDS)).toMatchObject({ ok: false, reason: "SIZE" });
  });
});

describe("sanitizeFilename", () => {
  it("sanitizeFilename_pathTraversal_keepsBaseNameOnly", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("..\\..\\win\\a.pdf")).toBe("a.pdf");
  });

  it("sanitizeFilename_vietnameseAndJapanese_preserved", () => {
    expect(sanitizeFilename("Hóa đơn 請求書.pdf")).toBe("Hóa đơn 請求書.pdf");
  });

  it("sanitizeFilename_quotesAndControlChars_replaced", () => {
    expect(sanitizeFilename('a"b\r\nc.pdf')).toBe("a_b_c.pdf");
  });

  it("sanitizeFilename_onlyDots_fallsBackToFile", () => {
    expect(sanitizeFilename("...pdf")).toBe("file.pdf");
  });

  it("sanitizeFilename_veryLongName_truncatedKeepingExtension", () => {
    const out = sanitizeFilename(`${"a".repeat(300)}.pdf`);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.length).toBe(124);
  });
});

describe("decodeOriginalName", () => {
  it("decodeOriginalName_latin1MojibakeOfUtf8_isRepaired", () => {
    const mojibake = Buffer.from("Hóa đơn.pdf", "utf8").toString("latin1");
    expect(decodeOriginalName(mojibake)).toBe("Hóa đơn.pdf");
  });

  it("decodeOriginalName_plainAscii_unchanged", () => {
    expect(decodeOriginalName("invoice.pdf")).toBe("invoice.pdf");
  });
});

describe("contentDisposition", () => {
  it("contentDisposition_unicodeName_hasAsciiFallbackAndUtf8Star", () => {
    expect(contentDisposition("đơn.pdf")).toBe(`attachment; filename="__n.pdf"; filename*=UTF-8''${encodeURIComponent("đơn.pdf")}`);
  });

  it("contentDisposition_quoteInLegacyKey_cannotBreakHeader", () => {
    expect(contentDisposition('a".pdf')).toContain('filename="a_.pdf"');
  });
});
