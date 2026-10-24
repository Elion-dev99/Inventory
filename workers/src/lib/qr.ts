import qrcode from 'qrcode-generator';

/**
 * QR コードの SVG 文字列を生成する (ラベル印刷ページ用)。
 * qrcode-generator (MIT) でサーバー側に描画し、印刷ページへ埋め込む。
 * typeNumber 0 = データ長から自動選択。誤り訂正レベルは M。
 */
export function qrSvg(text: string, cellSize = 3, margin = 8): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}
