// Report shipments_* - đọc qua shipments.service. Khác luồng nội bộ: khớp dòng vàng ở chế độ persist=false
// (không bật needsTax / không đăng ký khóa ghi chú) - kênh ext chỉ đọc, không có side-effect ẩn khi AI gọi 1 GET.
import { AppError } from "../../../app/errors/AppError.js";
import * as shipments from "../../shipments/shipments.service.js";

const monthRange = (month?: string) => {
  const range = shipments.parseMonth(month);
  if (!range) throw new AppError("BAD_REQUEST", 400, "month phải dạng YYYY-MM");
  return range;
};

export const shipments_tax_audit = (params: { month?: string }) => shipments.taxAudit(monthRange(params.month));
export const shipments_invoice_checklist = (params: { month?: string }) => shipments.invoiceChecklist(monthRange(params.month));
export const shipments_tax_rows = () => shipments.listTaxRows({ persist: false });
export const shipments_documents = (params: { orderId?: string }) => shipments.listDocumentsPublic(params.orderId);
