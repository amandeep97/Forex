// Generates realistic mock OHLC + volume candles for any instrument.
// Volatility is derived from the instrument's price magnitude and change%.

const TF_MINS = { '1M': 1, '5M': 5, '15M': 15, '1H': 60, '4H': 240, 'D': 1440 };

export function generateCandles(instrument, timeframe = '1H', count = 80) {
  const tf      = TF_MINS[timeframe] || 60;
  const price   = instrument.bid;
  const change  = instrument.change || 0;
  // Volatility per candle — scales with price and timeframe
  const vol     = price * 0.0012 * Math.sqrt(tf / 60);
  const trend   = (change / 100) / count;

  const candles = [];
  let p = price * (1 - (change / 100));   // start price before today's move

  const now = Date.now();
  const tfMs = tf * 60_000;

  for (let i = 0; i < count; i++) {
    const t = now - (count - i) * tfMs;
    p += p * trend;
    const o = p + (Math.random() - 0.5) * vol;
    const move = (Math.random() - 0.48) * vol * 1.5;
    const c = o + move;
    const wigH = Math.random() * vol * 0.8;
    const wigL = Math.random() * vol * 0.8;
    const h = Math.max(o, c) + wigH;
    const l = Math.min(o, c) - wigL;
    const v = Math.round(instrument.volume * (0.4 + Math.random() * 1.2) / count);
    candles.push({ t, o, h, l, c, v });
    p = c;
  }
  return candles;
}
