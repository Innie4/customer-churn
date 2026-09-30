/**
 * A small deterministic pseudo-random generator.
 *
 * The simulated world has to be identical on every run, so that a screenshot
 * taken today still matches one taken next week and a failing demo is
 * reproducible. `Math.random` cannot do that, and seeding it globally would
 * affect the rest of the application.
 *
 * This is mulberry32: 32-bit state, uniform enough for generating test
 * populations, and short enough to read. It is not suitable for anything
 * security-relevant, and nothing here is.
 */

export class Rng {
  private state: number;

  constructor(seed: number | string) {
    // A string seed is hashed so callers can use a readable name.
    this.state =
      typeof seed === "number"
        ? seed >>> 0
        : Rng.hash(String(seed));
    // A zero state would make every subsequent draw zero.
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  private static hash(value: string): number {
    let h = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      h ^= value.charCodeAt(index);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** A uniform value in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** A uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** One element of an array, chosen uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("cannot pick from an empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /**
   * One element, chosen by weight.
   *
   * Weights need not be normalised. Returns undefined only for an empty list,
   * which is a programming error rather than a possible outcome.
   */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) throw new Error("weights must sum to more than zero");
    let target = this.next() * total;
    for (const [value, weight] of entries) {
      target -= weight;
      if (target <= 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  /** A value from an approximately normal distribution, by summing uniforms. */
  normal(mean = 0, deviation = 1): number {
    const sum =
      this.next() + this.next() + this.next() + this.next() +
      this.next() + this.next();
    // The sum of six uniforms has mean 3 and a convenient scaling; this is the
    // Irwin-Hall approximation, good enough for generating populations.
    return mean + ((sum - 3) / Math.sqrt(0.5)) * deviation;
  }

  /**
   * `count` distinct values from an array, in random order.
   *
   * This is selection sampling: values are swapped forward from the shrinking
   * tail rather than removed, so the index is always inside the array. Splicing
   * instead would eventually ask for a position past the end, or before the
   * start, and quietly yield undefined.
   */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const howMany = Math.max(0, Math.min(count, pool.length));
    for (let index = 0; index < howMany; index += 1) {
      const at = this.int(index, pool.length - 1);
      const held = pool[index]!;
      pool[index] = pool[at]!;
      pool[at] = held;
    }
    return pool.slice(0, howMany);
  }

  /** A fresh generator derived from this one, so sub-streams stay independent. */
  fork(label: string): Rng {
    return new Rng(`${this.state}:${label}`);
  }

  /**
   * The current state, for deriving another independent stream.
   *
   * Exposed as a method rather than a public field so the state cannot be
   * reassigned from outside.
   */
  currentState(): number {
    return this.state;
  }
}

/** Round to a fixed number of decimals, avoiding float noise in stored values. */
export function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The logistic function, the inverse of the log-odds scale. */
export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

/** The log-odds of a probability. This is what SHAP values add up to. */
export function logit(probability: number): number {
  const clamped = Math.min(Math.max(probability, 1e-9), 1 - 1e-9);
  return Math.log(clamped / (1 - clamped));
}

/**
 * Choose the intercept that makes a set of risk terms average to a target rate.
 *
 * The weights in a churn model are mostly positive once a majority of customers
 * are on a month-to-month contract, so simply adding `logit(rate)` to each
 * customer's terms does not reproduce that rate: the sigmoid is applied after
 * the terms have been added, and the mean of a sigmoid is not the sigmoid of the
 * mean. Getting this wrong pushes the average probability well above one half,
 * and the model then calls most customers a churner.
 *
 * The average predicted probability is strictly increasing in the intercept, so
 * bisection finds it exactly. Sixty iterations takes the interval far below any
 * precision the stored values can show.
 */
export function solveIntercept(terms: readonly number[], targetRate: number): number {
  if (terms.length === 0) return logit(targetRate);
  let low = -20;
  let high = 20;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    let total = 0;
    for (const term of terms) total += sigmoid(middle + term);
    if (total / terms.length < targetRate) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
