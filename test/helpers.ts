import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));

export function readDataFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(dataDir + name));
}

/** Pull the raw transaction hex out of `data/transaction.txt`. */
export function readTransactionHex(name = "transaction.txt"): string {
  const text = readFileSync(dataDir + name, "utf8");
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^[0-9a-fA-F]{400,}$/.test(l));
  if (!line) throw new Error(`no raw transaction hex found in ${name}`);
  return line;
}
