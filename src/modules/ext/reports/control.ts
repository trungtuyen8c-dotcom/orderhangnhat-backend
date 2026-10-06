// Report control_* - đọc qua control.service (cùng logic với /api/control).
import * as control from "../../control/control.service.js";

export const control_overview = () => control.overview();
export const control_debt_config = () => control.getDebtConfig();
export const control_overdue_debts = () => control.overdueDebts();
export const control_cartons = () => control.listCartons();
export const control_unmatched = () => control.listUnmatched();
