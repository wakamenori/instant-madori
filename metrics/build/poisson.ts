// Invert P(X <= k) at each tail. Summing in log space also handles a zero count.
function limit(k: number, probability: number) {
  function cdf(mean: number) {
    let logTerm = -mean;
    let total = Math.exp(logTerm);
    for (let i = 1; i <= k; i++) {
      logTerm += Math.log(mean / i);
      total += Math.exp(logTerm);
    }
    return total;
  }
  let low = 0;
  let high = 2 * (k + 4);
  while (cdf(high) > probability) high *= 2;
  for (let i = 0; i < 55; i++) {
    const mid = (low + high) / 2;
    if (cdf(mid) > probability) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function poissonBounds(count: number) {
  return { lower: count === 0 ? 0 : limit(count - 1, 0.975), upper: limit(count, 0.025) };
}
