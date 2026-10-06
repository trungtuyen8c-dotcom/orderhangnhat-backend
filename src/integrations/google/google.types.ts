export type RgbColor = { red: number; green: number; blue: number };

export interface GridRange {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

export interface SheetProps {
  title: string;
  sheetId: number;
}

export interface ValueRange {
  values?: string[][];
}

export type CellValue = string | number | boolean;

export interface ValueRangeUpdate {
  range: string;
  values: CellValue[][];
}

export interface GridCell {
  formattedValue?: string;
  userEnteredFormat?: { backgroundColor?: { red?: number; green?: number; blue?: number } };
}

export interface GridData {
  sheets?: { data?: { rowData?: { values?: GridCell[] }[] }[] }[];
}

// Request của spreadsheets.batchUpdate (repeatCell, setDataValidation, addSheet, addProtectedRange...)
export type SheetsRequest = Record<string, unknown>;
