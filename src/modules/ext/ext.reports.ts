import * as reportsStats from "./reports/stats.js";
import * as reportsControl from "./reports/control.js";
import * as reportsWarehouse from "./reports/warehouse.js";
import * as reportsAdmin from "./reports/admin.js";
import * as reportsCompanycost from "./reports/companycost.js";
import * as reportsShipments from "./reports/shipments.js";
import * as reportsAccounting from "./reports/accounting.js";

export type ReportParams = Record<string, string | undefined>;

// Toàn bộ report chỉ đọc. params đọc thẳng từ req.query, mỗi hàm tự đọc field nó cần.
export const REPORTS: Record<string, (params: ReportParams) => Promise<unknown>> = {
  stats_overview: reportsStats.stats_overview,
  stats_alerts: reportsStats.stats_alerts,
  control_overview: reportsControl.control_overview,
  control_debt_config: reportsControl.control_debt_config,
  control_overdue_debts: reportsControl.control_overdue_debts,
  control_cartons: reportsControl.control_cartons,
  control_unmatched: reportsControl.control_unmatched,
  warehouse_vn_board: reportsWarehouse.warehouse_vn_board,
  warehouse_stored: reportsWarehouse.warehouse_stored,
  warehouse_history: reportsWarehouse.warehouse_history,
  warehouse_recon: reportsWarehouse.warehouse_recon,
  users_list: reportsAdmin.users_list,
  roles_list: reportsAdmin.roles_list,
  permissions_list: reportsAdmin.permissions_list,
  audit_log: (p) => reportsAdmin.audit_log({ limit: p.limit ? Number(p.limit) : undefined }),
  companycost_report: reportsCompanycost.companycost_report,
  companycost_settlement: reportsCompanycost.companycost_settlement,
  companycost_reinforce_price: reportsCompanycost.companycost_reinforce_price,
  companycost_electronics_price: reportsCompanycost.companycost_electronics_price,
  shipments_tax_audit: reportsShipments.shipments_tax_audit,
  shipments_invoice_checklist: reportsShipments.shipments_invoice_checklist,
  shipments_tax_rows: reportsShipments.shipments_tax_rows,
  shipments_documents: reportsShipments.shipments_documents,
  accounting_debts: reportsAccounting.accounting_debts,
  accounting_deposits: reportsAccounting.accounting_deposits,
  accounting_deposits_counts: reportsAccounting.accounting_deposits_counts,
  accounting_opening_balances: reportsAccounting.accounting_opening_balances,
  accounting_customer_summary: reportsAccounting.accounting_customer_summary,
  accounting_monthly_report: reportsAccounting.accounting_monthly_report,
  accounting_wallets: reportsAccounting.accounting_wallets,
  accounting_fund: reportsAccounting.accounting_fund,
  accounting_fund_counts: reportsAccounting.accounting_fund_counts,
  accounting_reconcile: reportsAccounting.accounting_reconcile,
  accounting_statement: reportsAccounting.accounting_statement,
};

// Mỗi report thuộc 1 scope riêng theo mảng (kế toán/kho VN/công ty phí/...) - để phân quyền được
// theo nhân viên (vd Kho VN chỉ xin reports:warehouse, không xin được reports:accounting).
export const REPORT_SCOPE: Record<string, string> = {
  stats_overview: "reports:stats", stats_alerts: "reports:stats",
  control_overview: "reports:control", control_debt_config: "reports:control", control_overdue_debts: "reports:control", control_cartons: "reports:control", control_unmatched: "reports:control",
  warehouse_vn_board: "reports:warehouse", warehouse_stored: "reports:warehouse", warehouse_history: "reports:warehouse", warehouse_recon: "reports:warehouse",
  users_list: "reports:admin", roles_list: "reports:admin", permissions_list: "reports:admin", audit_log: "reports:admin",
  companycost_report: "reports:companycost", companycost_settlement: "reports:companycost", companycost_reinforce_price: "reports:companycost", companycost_electronics_price: "reports:companycost",
  shipments_tax_audit: "reports:shipments", shipments_invoice_checklist: "reports:shipments", shipments_tax_rows: "reports:shipments", shipments_documents: "reports:shipments",
  accounting_debts: "reports:accounting", accounting_deposits: "reports:accounting", accounting_deposits_counts: "reports:accounting", accounting_opening_balances: "reports:accounting",
  accounting_customer_summary: "reports:accounting", accounting_monthly_report: "reports:accounting", accounting_wallets: "reports:accounting", accounting_fund: "reports:accounting",
  accounting_fund_counts: "reports:accounting", accounting_reconcile: "reports:accounting", accounting_statement: "reports:accounting",
};
