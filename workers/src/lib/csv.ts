/**
 * CSV の生成と解析 (RFC 4180 の最小実装)。
 * 生成: カンマ・ダブルクォート・改行を含む値は引用し、クォートは二重化する。
 * 解析: 引用フィールド内のカンマ・改行・二重化クォートを扱う。BOM は除去する。
 */

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 1 レコード分の CSV 行 (末尾の改行は含まない) */
export function csvRow(values: readonly unknown[]): string {
  return values.map(escapeField).join(',');
}

/** ヘッダ + レコード群を CSV テキストにする (改行は CRLF) */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [csvRow(header), ...rows.map((r) => csvRow(r))].join('\r\n') + '\r\n';
}

/** CSV テキストをレコード配列に分解する */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, ''); // 先頭の BOM を除去
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let recordStarted = false;

  const pushField = (): void => {
    record.push(field);
    field = '';
  };
  const pushRecord = (): void => {
    pushField();
    records.push(record);
    record = [];
    recordStarted = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      recordStarted = true;
    } else if (ch === ',') {
      pushField();
      recordStarted = true;
    } else if (ch === '\r') {
      // CRLF は LF 側でまとめて処理する
    } else if (ch === '\n') {
      pushRecord();
    } else {
      field += ch;
      recordStarted = true;
    }
  }
  if (recordStarted || field.length > 0 || record.length > 0) pushRecord();
  return records;
}
