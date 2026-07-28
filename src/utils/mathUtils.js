// src/utils/mathUtils.js
// Shared numeric helpers.
//
// pearson() existed in four copies (CorrelationMatrix, MetalsDashboard,
// flowFeed, intermarket) with identical maths but two different minimum-sample
// guards — two required 5 points, two required 10. Merging them naively would
// have changed what two of those screens display, so the threshold is a
// parameter and every call site passes the value it already used. Output is
// therefore identical to before at every call site.

export function pearson(a, b, minN = 5) {
  const n = Math.min(a.length, b.length);
  if (n < minN) return null;
  const ax = a.slice(-n), bx = b.slice(-n);
  const mA = ax.reduce((s, v) => s + v, 0) / n;
  const mB = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - mA, y = bx[i] - mB;
    num += x * y; dA += x * x; dB += y * y;
  }
  const denom = Math.sqrt(dA * dB);
  return denom === 0 ? null : +(num / denom).toFixed(2);
}
