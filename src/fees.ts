/**
 * Rough fee estimators ported verbatim from upstream. They are deliberately
 * conservative; verify real transactions with `testmempoolaccept`.
 */

/** Generic SegWit estimate: ~100 vbytes of overhead, 100 per input, 34 per output. */
export function estimateFee(inputs: number, outputs: number, feerate: number): number {
  return (100 + inputs * 100 + outputs * 34) * feerate;
}

/** Funding transaction: P2WPKH inputs, P2WSH data outputs, optional P2WPKH change. */
export function estimateFeeFunding(
  p2wpkhInputs: number,
  p2wshOutputs: number,
  p2wpkhOutputs: number,
  feerate: number,
): number {
  return (12 + 68 * p2wpkhInputs + 43 * p2wshOutputs + 31 * p2wpkhOutputs) * feerate;
}

/** Reveal transaction: large witnesses, ~188 vbytes per input. */
export function estimateFeeReveal(inputs: number, outputs: number, feerate: number): number {
  return (100 + inputs * 188 + outputs * 34) * feerate;
}

/** Owner-transfer transaction: ~94 vbytes per input. */
export function estimateFeeOwnerTransfer(
  inputs: number,
  outputs: number,
  feerate: number,
): number {
  return (10 + inputs * 94 + outputs * 34) * feerate;
}
