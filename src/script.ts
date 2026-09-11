import { concatBytes } from "./bytes.ts";
import {
  MAX_PUBKEYS_PER_SCRIPT,
  OP_1,
  OP_16,
  OP_CHECKMULTISIG,
  OP_CHECKSIG,
  OP_DROP,
  OP_DUP,
  OP_EQUALVERIFY,
  OP_HASH160,
  OP_PUSHDATA1,
  OP_PUSHDATA2,
  OP_PUSHDATA4,
} from "./constants.ts";
import { sha256 } from "./hash.ts";

/** One parsed script element: either a data push or an opcode. */
export type ScriptElement =
  | { type: "push"; op: number; data: Uint8Array }
  | { type: "op"; op: number };

/** Iterate a raw script into pushes and opcodes. Throws on truncated pushes. */
export function parseScript(script: Uint8Array): ScriptElement[] {
  const elements: ScriptElement[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i]!;
    i += 1;
    if (op > 0 && op < OP_PUSHDATA1) {
      const data = script.subarray(i, i + op);
      if (data.length !== op) throw new Error("truncated script push");
      elements.push({ type: "push", op, data });
      i += op;
    } else if (op === OP_PUSHDATA1 || op === OP_PUSHDATA2 || op === OP_PUSHDATA4) {
      const sizeLen = op === OP_PUSHDATA1 ? 1 : op === OP_PUSHDATA2 ? 2 : 4;
      if (i + sizeLen > script.length) throw new Error("truncated script push length");
      let size = 0;
      for (let k = sizeLen - 1; k >= 0; k--) size = size * 256 + script[i + k]!; // little-endian
      i += sizeLen;
      const data = script.subarray(i, i + size);
      if (data.length !== size) throw new Error("truncated script push");
      elements.push({ type: "push", op, data });
      i += size;
    } else {
      elements.push({ type: "op", op });
    }
  }
  return elements;
}

/** Value of OP_1..OP_16, or `null` for any other opcode. */
export function smallIntFromOp(op: number): number | null {
  if (op >= OP_1 && op <= OP_16) return op - (OP_1 - 1);
  return null;
}

/** Minimal-length push of `data` (no minimal-number encoding for small ints). */
export function pushData(data: Uint8Array): Uint8Array {
  if (data.length < OP_PUSHDATA1) {
    return concatBytes(new Uint8Array([data.length]), data);
  }
  if (data.length <= 0xff) {
    return concatBytes(new Uint8Array([OP_PUSHDATA1, data.length]), data);
  }
  if (data.length <= 0xffff) {
    return concatBytes(
      new Uint8Array([OP_PUSHDATA2, data.length & 0xff, (data.length >> 8) & 0xff]),
      data,
    );
  }
  const len = data.length;
  return concatBytes(
    new Uint8Array([
      OP_PUSHDATA4,
      len & 0xff,
      (len >> 8) & 0xff,
      (len >> 16) & 0xff,
      (len >>> 24) & 0xff,
    ]),
    data,
  );
}

/**
 * Build the BPUB data-carrying redeem script:
 *
 *     OP_1 <data_pk_0> ... <data_pk_M> <control_pubkey> OP_(M+2) OP_CHECKMULTISIG
 *
 * Only the control pubkey has a private key, so a 1-of-N spend stays valid.
 */
export function buildMultisigScript(
  dataPubkeys: Uint8Array[],
  controlPubkey: Uint8Array,
): Uint8Array {
  if (controlPubkey.length !== 33) {
    throw new Error("controlPubkey must be a 33-byte compressed SEC pubkey");
  }
  const totalKeys = dataPubkeys.length + 1;
  if (totalKeys > MAX_PUBKEYS_PER_SCRIPT) {
    throw new Error(`too many pubkeys in one script (max ${MAX_PUBKEYS_PER_SCRIPT})`);
  }
  const parts: Uint8Array[] = [new Uint8Array([OP_1])];
  for (const pk of dataPubkeys) {
    if (pk.length !== 33) throw new Error("data pubkeys must be 33 bytes");
    parts.push(new Uint8Array([0x21]), pk);
  }
  parts.push(new Uint8Array([0x21]), controlPubkey);
  parts.push(new Uint8Array([0x50 + totalKeys, OP_CHECKMULTISIG]));
  return concatBytes(...parts);
}

export interface BpubMultisigScript {
  dataPubkeys: Uint8Array[];
  controlPubkey: Uint8Array;
}

/**
 * Recognise a BPUB 1-of-N multisig redeem script and split out the data
 * pubkeys from the trailing control pubkey. Returns `null` when the script is
 * not of that shape, so callers can scan witnesses cheaply.
 */
export function parseBpubMultisigScript(script: Uint8Array): BpubMultisigScript | null {
  let elements: ScriptElement[];
  try {
    elements = parseScript(script);
  } catch {
    return null;
  }
  if (elements.length < 4) return null;

  const first = elements[0]!;
  const opN = elements[elements.length - 2]!;
  const last = elements[elements.length - 1]!;

  if (first.type !== "op" || first.op !== OP_1) return null;
  if (last.type !== "op" || last.op !== OP_CHECKMULTISIG) return null;
  if (opN.type !== "op") return null;

  const middle = elements.slice(1, -2);
  const pubkeys: Uint8Array[] = [];
  for (const element of middle) {
    if (element.type !== "push" || element.data.length !== 33) return null;
    pubkeys.push(element.data);
  }
  if (pubkeys.length === 0) return null;

  // 1-of-N, so OP_N must agree with the pubkey count.
  if (smallIntFromOp(opN.op) !== pubkeys.length) return null;

  return {
    dataPubkeys: pubkeys.slice(0, -1),
    controlPubkey: pubkeys[pubkeys.length - 1]!,
  };
}

/**
 * Build a v5 ownership redeem script (P2WPKH semantics inside P2WSH):
 *
 *     <BPUB_ID> OP_DROP OP_DUP OP_HASH160 <owner_h160> OP_EQUALVERIFY OP_CHECKSIG
 */
export function buildOwnerRedeemScript(bpubId: Uint8Array, ownerH160: Uint8Array): Uint8Array {
  if (bpubId.length !== 32) throw new Error("bpubId must be 32 bytes");
  if (ownerH160.length !== 20) throw new Error("ownerH160 must be a 20-byte HASH160");
  return concatBytes(
    new Uint8Array([0x20]),
    bpubId,
    new Uint8Array([OP_DROP, OP_DUP, OP_HASH160, 0x14]),
    ownerH160,
    new Uint8Array([OP_EQUALVERIFY, OP_CHECKSIG]),
  );
}

export interface OwnerRedeemScript {
  bpubId: Uint8Array;
  ownerH160: Uint8Array;
}

/** Decode a v5 ownership redeem script. Throws if the script does not match. */
export function decodeOwnerRedeemScript(script: Uint8Array): OwnerRedeemScript {
  let elements: ScriptElement[];
  try {
    elements = parseScript(script);
  } catch (error) {
    throw new Error(`failed to parse redeemScript: ${(error as Error).message}`);
  }
  if (elements.length !== 7) {
    throw new Error(`unexpected owner redeemScript structure (len=${elements.length})`);
  }
  const [bpubId, opDrop, opDup, opHash160, ownerH160, opEqualVerify, opCheckSig] = elements as [
    ScriptElement,
    ScriptElement,
    ScriptElement,
    ScriptElement,
    ScriptElement,
    ScriptElement,
    ScriptElement,
  ];

  if (bpubId.type !== "push" || bpubId.data.length !== 32) {
    throw new Error("first element is not a 32-byte BPUB_ID push");
  }
  if (opDrop.type !== "op" || opDrop.op !== OP_DROP) {
    throw new Error("expected OP_DROP after BPUB_ID");
  }
  if (opDup.type !== "op" || opDup.op !== OP_DUP) throw new Error("expected OP_DUP");
  if (opHash160.type !== "op" || opHash160.op !== OP_HASH160) {
    throw new Error("expected OP_HASH160");
  }
  if (ownerH160.type !== "push" || ownerH160.data.length !== 20) {
    throw new Error("owner_h160 push is not 20 bytes");
  }
  if (opEqualVerify.type !== "op" || opEqualVerify.op !== OP_EQUALVERIFY) {
    throw new Error("expected OP_EQUALVERIFY");
  }
  if (opCheckSig.type !== "op" || opCheckSig.op !== OP_CHECKSIG) {
    throw new Error("expected OP_CHECKSIG");
  }

  return { bpubId: bpubId.data, ownerH160: ownerH160.data };
}

/** `OP_0 <sha256(redeemScript)>` — the P2WSH scriptPubKey for a redeem script. */
export async function p2wshScriptPubKey(redeemScript: Uint8Array): Promise<Uint8Array> {
  return concatBytes(new Uint8Array([0x00, 0x20]), await sha256(redeemScript));
}

/** `OP_0 <h160>` — the P2WPKH scriptPubKey for a pubkey hash. */
export function p2wpkhScriptPubKey(h160: Uint8Array): Uint8Array {
  if (h160.length !== 20) throw new Error("h160 must be 20 bytes");
  return concatBytes(new Uint8Array([0x00, 0x14]), h160);
}
