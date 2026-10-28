/**
 * 予約連動の消費予測 (0022)。
 *
 * 備品の消費が予約件数に連動する業態では、過去の平均消費 (90日) だけを
 * 見る通常の発注点より「予約」という先行指標の方が早く・正確に読める。
 * ここでは純粋関数として予測計算だけを持ち、DB 読み取りは呼び出し側
 * (index.ts の /api/v1/forecast) が担う。
 *
 * 係数の定義:
 *   1予約あたり消費量 = (予約が記録された日の消費合計) ÷ (同日の予約合計)
 * 記録の無い日の消費は数えない (分母と分子の範囲を揃えるため)。
 * 係数の集計対象は「今日より前」の記録日のみ (当日の消費は未確定なため)。
 *
 * ペースの定義 (今後7日):
 *   各日の予約 = 入力済みの件数 → 無ければ入力済みの今後分の平均 →
 *   それも無ければ直近28日の記録日の平均。どれも無ければ予測不能。
 */

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** epoch ms をタイムゾーンの暦日キー ('YYYY-MM-DD') に変換する */
export function dateKeyInTz(epochMs: number, timeZone: string): string {
  let fmt = dateFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 暦日キーに n 日を足す (UTC 基準の単純計算) */
export function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' として実在する日付か */
export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface ForecastProductInput {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  currentQuantity: number;
  /** 暦日キー → その日の消費量 (OUT の合計、正の数) */
  consumedByDay: ReadonlyMap<string, number>;
}

export interface ForecastItem {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  currentQuantity: number;
  /** 1予約あたりの平均消費量 */
  perReservation: number;
  /** ペースを掛けた1日あたりの予想消費量 */
  expectedDaily: number;
  /** 今後7日の予想消費量 */
  expected7d: number;
  /** 在庫が切れるまでの日数 (小数)。読めない場合は null */
  daysLeft: number | null;
}

export interface ForecastResult {
  status: 'ok' | 'insufficient_data';
  basis: {
    /** 係数に使った記録日の数 */
    recordedDays: number;
    /** 係数に使った予約合計 */
    totalReservations: number;
    /** 集計ウィンドウ (日) */
    windowDays: number;
  };
  pace: {
    /** 今後7日の予約見込み合計 (読めない場合は null) */
    next7Reservations: number | null;
    /** 1日あたりの予約ペース (読めない場合は null) */
    dailyReservations: number | null;
  };
  items: ForecastItem[];
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function computeForecast(opts: {
  todayKey: string;
  /** 暦日キー → 予約件数 (記録分のみ) */
  reservationDays: ReadonlyMap<string, number>;
  products: ForecastProductInput[];
  windowDays?: number;
  minRecordedDays?: number;
}): ForecastResult {
  const windowDays = opts.windowDays ?? 90;
  const minRecordedDays = opts.minRecordedDays ?? 3;
  const { todayKey, reservationDays } = opts;

  // 係数の集計対象: ウィンドウ内の「今日より前」の記録日
  const windowStart = addDaysToKey(todayKey, -windowDays);
  const recordedPastDays = [...reservationDays.keys()]
    .filter((k) => k < todayKey && k >= windowStart)
    .sort();
  const totalReservations = recordedPastDays.reduce((s, k) => s + (reservationDays.get(k) ?? 0), 0);

  // ペース: 今後7日を1日ずつ解決する
  const upcomingKeys: string[] = [];
  for (let i = 0; i < 7; i++) upcomingKeys.push(addDaysToKey(todayKey, i));
  const enteredUpcoming = upcomingKeys
    .map((k) => reservationDays.get(k))
    .filter((v): v is number => v !== undefined);
  const upcomingAvg = enteredUpcoming.length
    ? enteredUpcoming.reduce((a, b) => a + b, 0) / enteredUpcoming.length
    : null;
  const recentStart = addDaysToKey(todayKey, -28);
  const recentDays = recordedPastDays.filter((k) => k >= recentStart);
  const recentAvg = recentDays.length
    ? recentDays.reduce((s, k) => s + (reservationDays.get(k) ?? 0), 0) / recentDays.length
    : null;
  let next7Reservations: number | null = null;
  if (upcomingAvg !== null || recentAvg !== null) {
    next7Reservations = upcomingKeys.reduce((s, k) => {
      const entered = reservationDays.get(k);
      return s + (entered ?? upcomingAvg ?? recentAvg ?? 0);
    }, 0);
  }
  const dailyReservations = next7Reservations !== null ? next7Reservations / 7 : null;

  const basis = { recordedDays: recordedPastDays.length, totalReservations, windowDays };
  if (
    recordedPastDays.length < minRecordedDays ||
    totalReservations <= 0 ||
    dailyReservations === null ||
    next7Reservations === null
  ) {
    return {
      status: 'insufficient_data',
      basis,
      pace: { next7Reservations, dailyReservations },
      items: [],
    };
  }

  const items: ForecastItem[] = [];
  for (const p of opts.products) {
    let consumed = 0;
    for (const day of recordedPastDays) consumed += p.consumedByDay.get(day) ?? 0;
    if (consumed <= 0) continue;
    const perReservation = consumed / totalReservations;
    const expectedDaily = perReservation * dailyReservations;
    const expected7d = perReservation * next7Reservations;
    items.push({
      productId: p.productId,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      currentQuantity: p.currentQuantity,
      perReservation: round(perReservation, 3),
      expectedDaily: round(expectedDaily, 2),
      expected7d: round(expected7d, 1),
      daysLeft: expectedDaily > 0 ? round(p.currentQuantity / expectedDaily, 1) : null,
    });
  }
  items.sort((a, b) => {
    if (a.daysLeft === null && b.daysLeft === null) return a.name.localeCompare(b.name);
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft;
  });
  return { status: 'ok', basis, pace: { next7Reservations, dailyReservations: round(dailyReservations, 2) }, items };
}
