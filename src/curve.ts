import { pow as noblePow } from "@noble/curves/abstract/modular.js";

import { CURVE_B, P } from "./constants.ts";

/** Modular exponentiation over bigints, via `@noble/curves`'s field arithmetic. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) throw new Error("modulus must be positive");
  return noblePow(((base % modulus) + modulus) % modulus, exponent, modulus);
}

/** True when `n` is a non-zero quadratic residue mod p (Euler's criterion). */
export function isQuadraticResidue(n: bigint): boolean {
  return modPow(n % P, (P - 1n) / 2n, P) === 1n;
}

/** Square root mod p. Valid because p % 4 === 3 for secp256k1. */
export function sqrtModP(n: bigint): bigint {
  return modPow(n % P, (P + 1n) / 4n, P);
}

/**
 * For an x-coordinate, return the even/odd-resolved y if x is on the curve,
 * or `null` if x^3 + 7 is not a quadratic residue.
 *
 * This folds the upstream `is_quadratic_residue` + `sqrt_mod_p` pair into one
 * modular exponentiation: if rhs is a residue then sqrt(rhs)^2 === rhs, and if
 * it is not then sqrt(rhs)^2 === -rhs !== rhs (for rhs != 0). `rhs === 0` is
 * rejected to match upstream, where Euler's criterion returns 0, not 1.
 */
export function liftX(x: bigint): bigint | null {
  if (x >= P) return null;
  const rhs = (modPow(x, 3n, P) + CURVE_B) % P;
  if (rhs === 0n) return null;
  const y = sqrtModP(rhs);
  if ((y * y) % P !== rhs) return null;
  return y;
}
