/**
 * 棚卸し履歴ベースの持ち日数推定 (0023)。
 *
 * 過去の棚卸しスナップショット (日付ごとの在庫数) から、連続する2点間の
 * 「減った分」を消費とみなしてペース (個/日) を出す。区間の途中に入庫が
 * あると消費は過小に出るため、持ち日数は長めに出る前提の推定。
 *
 * ペースは3種:
 *   typical: 全期間の平均
 *   busy:    月別ペースの高い方3ヶ月の平均 (繁忙期)
 *   slow:    月別ペースの低い方3ヶ月の平均 (閑散期)
 * 月別ペースは区間を「終了日の月」に寄せて集計し、2年分の同じ月を束ねる。
 * 長すぎる区間 (データの空白) は分母・分子の両方から除く。
 *
 * 単発の異常値ガード: 元データには数え方の違う日 (個数で数えた等) が
 * 混ざっており、中央値の3倍を超える点から始まる区間は、その落差が
 * 丸ごと見かけの消費になってしまうため集計から除く。
 */

export interface HistoryPoint {
  date: string; // 'YYYY-MM-DD'
  quantity: number;
}

export interface HistoryProductInput {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  currentQuantity: number;
  points: HistoryPoint[];
}

export interface HistoryPace {
  typical: number | null;
  busy: number | null;
  slow: number | null;
}

export interface HistoryForecastItem {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  currentQuantity: number;
  /** 1日あたり消費ペース */
  pace: HistoryPace;
  /** ペース別の持ち日数 */
  daysLeft: HistoryPace;
  snapshots: number;
  firstDate: string | null;
  lastDate: string | null;
}

const DAY_MS = 86_400_000;
/** これより長い区間はデータの空白として集計から除く */
export const MAX_INTERVAL_DAYS = 62;
/** 月別ペースを採用するのに必要な、その月の区間カバー日数 */
const MIN_MONTH_DAYS = 20;

function dayNumber(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function paceOf(decrease: number, days: number): number | null {
  if (days <= 0 || decrease <= 0) return null;
  return decrease / days;
}

function daysLeftFor(qty: number, pace: number | null): number | null {
  if (pace === null || pace <= 0) return null;
  return round(qty / pace, 1);
}

export interface HistorySeasonOptions {
  /** 繁忙期として扱う月 (店舗設定)。指定時はその月の区間だけでペースを出す */
  busyMonths?: number[] | null;
  /** 閑散期として扱う月 (店舗設定) */
  slowMonths?: number[] | null;
}

export function computeHistoryForecast(
  products: HistoryProductInput[],
  seasonOpts: HistorySeasonOptions = {},
): HistoryForecastItem[] {
  const items: HistoryForecastItem[] = [];
  for (const p of products) {
    const points = [...p.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const quantities = points.map((pt) => pt.quantity).sort((a, b) => a - b);
    const median = quantities.length ? quantities[Math.floor(quantities.length / 2)]! : 0;
    const spikeThreshold = Math.max(3 * median, median + 10);
    let totalDecrease = 0;
    let totalDays = 0;
    const monthDecrease = new Map<number, number>();
    const monthDays = new Map<number, number>();
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const cur = points[i]!;
      const days = dayNumber(cur.date) - dayNumber(prev.date);
      if (days <= 0 || days > MAX_INTERVAL_DAYS) continue;
      if (prev.quantity > spikeThreshold) continue;
      const decrease = Math.max(0, prev.quantity - cur.quantity);
      totalDecrease += decrease;
      totalDays += days;
      const month = Number(cur.date.slice(5, 7));
      monthDecrease.set(month, (monthDecrease.get(month) ?? 0) + decrease);
      monthDays.set(month, (monthDays.get(month) ?? 0) + days);
    }
    const typical = paceOf(totalDecrease, totalDays);
    const monthly: number[] = [];
    for (const [month, dec] of monthDecrease) {
      const days = monthDays.get(month) ?? 0;
      if (days < MIN_MONTH_DAYS) continue;
      const mp = paceOf(dec, days);
      if (mp !== null) monthly.push(mp);
    }
    monthly.sort((a, b) => a - b);
    // 設定された季節の月があれば、その月の区間だけでペースを出す。
    // カバー不足・減少なしで読めない場合はデータ由来 (上下3ヶ月) に落とす。
    const seasonPace = (months: number[] | null | undefined): number | null => {
      if (!months || months.length === 0) return null;
      let dec = 0;
      let days = 0;
      for (const m of months) {
        dec += monthDecrease.get(m) ?? 0;
        days += monthDays.get(m) ?? 0;
      }
      if (days < MIN_MONTH_DAYS) return null;
      return paceOf(dec, days);
    };
    let busy: number | null = null;
    let slow: number | null = null;
    if (monthly.length > 0) {
      const low = monthly.slice(0, Math.min(3, monthly.length));
      const high = monthly.slice(-Math.min(3, monthly.length));
      slow = low.reduce((a, b) => a + b, 0) / low.length;
      busy = high.reduce((a, b) => a + b, 0) / high.length;
    }
    busy = seasonPace(seasonOpts.busyMonths) ?? busy;
    slow = seasonPace(seasonOpts.slowMonths) ?? slow;
    if (typical !== null) {
      // 月別カバーが疎だと「閑散期なのに通常より速い」逆転が起きるため、
      // 繁忙期は通常以上・閑散期は通常以下に収める。
      if (busy !== null) busy = Math.max(busy, typical);
      if (slow !== null) slow = Math.min(slow, typical);
    }
    const pace: HistoryPace = {
      typical: typical !== null ? round(typical, 3) : null,
      busy: busy !== null ? round(busy, 3) : null,
      slow: slow !== null ? round(slow, 3) : null,
    };
    items.push({
      productId: p.productId,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      currentQuantity: p.currentQuantity,
      pace,
      daysLeft: {
        typical: daysLeftFor(p.currentQuantity, typical),
        busy: daysLeftFor(p.currentQuantity, busy),
        slow: daysLeftFor(p.currentQuantity, slow),
      },
      snapshots: points.length,
      firstDate: points.length ? points[0]!.date : null,
      lastDate: points.length ? points[points.length - 1]!.date : null,
    });
  }
  // 繁忙期の持ち日数が短い順 (読めない品は末尾、名前順)
  items.sort((a, b) => {
    const ka = a.daysLeft.busy ?? a.daysLeft.typical;
    const kb = b.daysLeft.busy ?? b.daysLeft.typical;
    if (ka === null && kb === null) return a.name.localeCompare(b.name);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  });
  return items;
}
