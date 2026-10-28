#!/usr/bin/env python3
"""過去在庫 Excel (棚卸しスナップショット) を product_stock_history 用に正規化する。

使い方:
  python3 tools/import_history.py <upload.xlsx>            # 検証レポートのみ
  python3 tools/import_history.py <upload.xlsx> --sql out.sql

名寄せはユーザーが 2026-10-28 に確定した対応表に従う (history-import-mapping 参照)。
値は自由文混じり: 先頭の数量 (「A+B」は合算、「半」は +0.5) を読み、
数値のないセル ('多', '済み', '次回', '-' 始まりの注記) は「不明」として
レコード自体を作らない。
"""
import json
import re
import sys
from datetime import datetime, timedelta

import openpyxl

STORE_ID = 1
SOURCE = 'excel-history-2024-2026'

# Excel 品名 -> システム product_id。None は取り込み対象外。
NAME_TO_PRODUCT = {
    'イソジン': 17, 'カビキラー': 11, 'ガラスクリーナー': 10, 'コロコロ': 15,
    'コンディショナー': 34, 'シャンプー': 33, 'トイレクイックル': 29,
    'トイレシャット': 36, 'トイレットペーパー': 9, 'ハンドソープ': 28,
    'パイプユニッシュ': 23, 'ブルーレット': 26, 'ペーパータオル': 30,
    'ボディソープ': 35, 'ボールド': 32, 'リステリン': 18, 'ローション': 22,
    '消臭スプレー': 12, '激落ちくん': 13, 'マジックリン': 16,
    '歯みがき粉': 31, 'ティッシュペーパー': 6, '歯ブラシ(500本)': 7,
    'ウエットティッシュ(80枚)': 24, 'クイックル替え(40枚)': 25,
    'プラコップ(100個)': 14, 'コンドームM': 19, 'コンドームL': 20,
    'コンドームXL': 21, '個室に置く消臭剤': 27,
    'トイレットペーパー(8ロール)': 9, 'トイレットペーパー(12L)': 9,
    'ソープ用ビオレ': 1, 'ソープ用ボディ': 1,
    'ゴミ袋 個室用(50枚)': 3, 'ゴミ袋 個室用(50枚)/(150枚)': 3,
    'ゴミ袋控室 «15L»(20枚)': 4, 'ゴミ袋控室 «70L»(10枚)': 5,
    'リステリン«出張用» 25個': 8, 'バスマジックリン': 16,
    'ブルーレット本体': 26,
    'その他': None, 'コンドームLL': None, 'イソジン【VIP】': None,
    'アルタン(タンク)': None, 'アルタン(タンク)半分から': None,
    'リセッシュ(タンク)': None, 'オレンジジュース': None, 'ビール': None,
    '烏龍茶': None, '緑茶': None, '紙コップ': None,
    '業務用ローション(20L)': None, 'ゴミ袋控室 «30L»(10枚)': None,
}

TARGET_SHEETS = ['24,5-2', '25,2-終', '26,1-']


def xl_date(value, sheet_title):
    if isinstance(value, (int, float)) and value > 30000:
        return (datetime(1899, 12, 30) + timedelta(days=int(value))).strftime('%Y-%m-%d')
    if isinstance(value, str):
        m = re.match(r'(\d+)月(\d+)日', value)
        if m:
            year = 2024 if sheet_title.startswith('24') else 2025
            return f'{year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}'
    return None


def parse_quantity(cell):
    if cell is None:
        return None
    if isinstance(cell, (int, float)):
        return float(cell)
    s = str(cell).strip()
    if not s or s.startswith('-'):
        return None
    if s.startswith('次注'):
        return None
    s = s.replace('注済', '').replace('使用中', '')
    if not re.search(r'\d', s):
        return None
    total = 0.0
    found = False
    for part in s.split('+'):
        m = re.search(r'(\d+(?:\.\d+)?)', part)
        if m:
            total += float(m.group(1))
            found = True
            if '半' in part:
                total += 0.5
    return total if found else None


def extract(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    records = {}
    conflicts = []
    unknown_names = set()
    for title in TARGET_SHEETS:
        ws = wb[title]
        rows = list(ws.iter_rows(values_only=True))
        dates = [xl_date(v, title) for v in rows[0]]
        for row in rows[1:]:
            name = row[0]
            if not name:
                continue
            if name not in NAME_TO_PRODUCT:
                unknown_names.add(name)
                continue
            pid = NAME_TO_PRODUCT[name]
            if pid is None:
                continue
            for col, cell in enumerate(row):
                if col >= len(dates) or dates[col] is None:
                    continue
                qty = parse_quantity(cell)
                if qty is None:
                    continue
                key = (pid, dates[col])
                if key in records and records[key] != qty:
                    conflicts.append((name, dates[col], records[key], qty))
                    records[key] = max(records[key], qty)
                else:
                    records.setdefault(key, qty)
    return records, conflicts, unknown_names


def main():
    path = sys.argv[1]
    records, conflicts, unknown_names = extract(path)
    per_product = {}
    for (pid, date), qty in sorted(records.items()):
        per_product.setdefault(pid, []).append((date, qty))
    print(f'総レコード: {len(records)} 件 / 商品: {len(per_product)} 品')
    for pid in sorted(per_product):
        pts = per_product[pid]
        print(f'  product {pid}: {len(pts)} 点, {pts[0][0]} .. {pts[-1][0]}')
    if conflicts:
        print('同一日で値が割れたセル (大きい方を採用):')
        for c in conflicts:
            print('  ', c)
    if unknown_names:
        print('対応表に無い品名:', sorted(unknown_names))
    if '--sql' in sys.argv:
        out = sys.argv[sys.argv.index('--sql') + 1]
        now = int(datetime.now().timestamp() * 1000)
        lines = [
            f"DELETE FROM product_stock_history WHERE store_id = {STORE_ID} AND source = '{SOURCE}';"
        ]
        for (pid, date), qty in sorted(records.items()):
            lines.append(
                'INSERT INTO product_stock_history (store_id, product_id, date, quantity, source, created_at) '
                f"VALUES ({STORE_ID}, {pid}, '{date}', {qty}, '{SOURCE}', {now});"
            )
        with open(out, 'w') as f:
            f.write('\n'.join(lines) + '\n')
        print('SQL written:', out, len(lines) - 1, 'inserts')
    json.dump(
        {f'{pid}|{date}': qty for (pid, date), qty in records.items()},
        open('/tmp/history-parsed.json', 'w'),
    )


if __name__ == '__main__':
    main()
