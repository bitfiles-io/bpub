/**
 * bpub — a TypeScript port of the `bpub` Python library.
 *
 * BPUB embeds arbitrary data in Bitcoin by encoding it into fake compressed
 * secp256k1 pubkeys held in 1-of-N P2WSH multisig redeem scripts. This module
 * covers the full data format (v3.5, v4 and v5 streams), the script and
 * transaction plumbing needed to read inscriptions back off-chain, and the
 * pure parts of the encode side.
 *
 * It has no runtime dependencies and works in Node (>= 22) and modern
 * browsers: hashing uses Web Crypto, DEFLATE uses Compression Streams, and
 * curve arithmetic uses `BigInt`.
 *
 * @example Extract a file from a reveal transaction
 * ```ts
 * import { recoverFromRawTransaction } from "bpub";
 *
 * const { meta, content } = await recoverFromRawTransaction(rawTxHex);
 * console.log(meta.filename, meta.mime, content.length);
 * ```
 */

export {
  bytesEqual,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  reverseBytes,
  utf8ToBytes,
} from "./bytes.ts";

export {
  CHUNK_SIZE,
  CURVE_B,
  DUST,
  FLAG_COMPRESSED,
  FLAG_METADATA,
  MAX_DATA_PUBKEYS_PER_SCRIPT,
  MAX_PUBKEYS_PER_SCRIPT,
  P,
  V4_XOR_SALT,
} from "./constants.ts";

export { isQuadraticResidue, liftX, modPow, sqrtModP } from "./curve.ts";
export { rawDeflate, rawInflate, zlibDeflate, zlibInflate } from "./compress.ts";
export { hash160, ripemd160, sha256, sha256d } from "./hash.ts";

export { chunkDataPubkeys, decodePubkeysToStream, encodeStreamToPubkeys } from "./pubkeys.ts";

export {
  buildStreamV35,
  buildStreamV4,
  buildStreamV5,
  computeBpubV5Id,
  decodeStream,
  xorObfuscate,
} from "./stream.ts";
export type { BpubMeta, BuildStreamOptions, DecodedStream } from "./stream.ts";

export {
  buildMultisigScript,
  buildOwnerRedeemScript,
  decodeOwnerRedeemScript,
  p2wpkhScriptPubKey,
  p2wshScriptPubKey,
  parseBpubMultisigScript,
  parseScript,
  pushData,
  smallIntFromOp,
} from "./script.ts";
export type { BpubMultisigScript, OwnerRedeemScript, ScriptElement } from "./script.ts";

export {
  addressFromOwnerH160,
  addressToScriptPubKey,
  bech32Decode,
  bech32Encode,
  decodeSegwitAddress,
  encodeSegwitAddress,
  ownerH160FromAddress,
  scriptPubKeyToAddress,
} from "./bech32.ts";
export type { Bech32Decoded, Bech32Encoding, WitnessProgram } from "./bech32.ts";

export {
  deserializeTransaction,
  encodeVarInt,
  prevTxidHex,
  serializeTransaction,
  transactionId,
  txidToBytes,
} from "./tx.ts";
export type { Transaction, TxInput, TxOutput } from "./tx.ts";

export {
  decodeOwnerTransfer,
  recoverFromRawTransaction,
  recoverFromTransaction,
} from "./recover.ts";
export type {
  OwnerOutput,
  OwnerTransfer,
  RecoverOptions,
  RecoveredInput,
  RecoverResult,
} from "./recover.ts";

export {
  CHAIN_SOURCES,
  DEFAULT_CHAIN,
  fetchRawTransaction,
  isChain,
  isRawTransactionHex,
  isTxid,
  recoverFromTxid,
  resolveRawTransaction,
} from "./fetch.ts";
export type {
  Chain,
  FetchedTransaction,
  FetchTransactionOptions,
  ResolvedTransaction,
} from "./fetch.ts";

export {
  estimateFee,
  estimateFeeFunding,
  estimateFeeOwnerTransfer,
  estimateFeeReveal,
} from "./fees.ts";

export { buildFundingTransaction, buildInscription } from "./txbuild.ts";
export type {
  BpubVersion,
  FundingTransaction,
  FundingTransactionOptions,
  Inscription,
  InscriptionOptions,
  Utxo,
} from "./txbuild.ts";
