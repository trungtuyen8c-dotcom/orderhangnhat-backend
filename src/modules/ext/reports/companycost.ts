// Report companycost_* - đọc qua companycost.service (cùng logic với /api/company-costs).
import * as cc from "../../companycost/companycost.service.js";

export const companycost_report = (params: { month?: string }) => cc.report(cc.monthOrCurrent(params.month));
export const companycost_settlement = (params: { month?: string }) => cc.settlement(cc.monthOrCurrent(params.month));
export async function companycost_reinforce_price() { return { unit: await cc.reinforceUnit() }; }
export async function companycost_electronics_price() { return { unit: await cc.electronicsUnit() }; }
