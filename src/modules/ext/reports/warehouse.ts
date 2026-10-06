// Report warehouse_* - đọc qua warehouse.service (cùng query/logic với /api/warehouse). Tham số được trim như bản ext cũ.
import * as warehouse from "../../warehouse/warehouse.service.js";

const opt = (v?: string) => (v ?? "").trim() || undefined;

export const warehouse_vn_board = (params: { customer?: string }) => warehouse.getVnBoard(opt(params.customer));
export const warehouse_stored = (params: { customer?: string }) => warehouse.listStored(opt(params.customer));
export const warehouse_history = (params: { date?: string; vnTrackingCode?: string; code?: string }) =>
  warehouse.searchHistory({ date: opt(params.date), vnTrackingCode: opt(params.vnTrackingCode), code: opt(params.code) });
export const warehouse_recon = () => warehouse.listRecon();
