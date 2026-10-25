// Creates and funds testnet wallets for the demo, then writes them to .env.
//   - agent wallet  (Stellar): pays with x402. Gets XLM from Friendbot, then swaps XLM to test USDC on the testnet DEX.
//   - payTo wallet  (Stellar): receives the agent's USDC.
//   - payTo address (Base Sepolia): receives USDC if an agent pays on Base. Fund an agent wallet yourself
//     at https://faucet.circle.com to try Base.
// Secrets go to .env only (gitignored) and are never printed. Re-running keeps existing wallets.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const HORIZON = "https://horizon-testnet.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const SWAP_XLM = process.env.SETUP_SWAP_XLM ?? "300";

const horizon = new Horizon.Server(HORIZON);
const env: Record<string, string> = fs.existsSync(ENV_PATH) ? dotenv.parse(fs.readFileSync(ENV_PATH)) : {};

function keypair(secretVar: string): Keypair {
  if (env[secretVar]) return Keypair.fromSecret(env[secretVar]);
  const kp = Keypair.random();
  env[secretVar] = kp.secret();
  return kp;
}

async function exists(pub: string) {
  try {
    return await horizon.loadAccount(pub);
  } catch {
    return null;
  }
}

async function friendbot(pub: string) {
  if (await exists(pub)) return;
  const res = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${pub}: ${res.status}`);
}

async function submit(kp: Keypair, ops: xdr.Operation[]) {
  const account = await horizon.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.setTimeout(60).build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}

async function usdcBalance(pub: string): Promise<number> {
  const acc = await horizon.loadAccount(pub);
  const line = acc.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === USDC.getIssuer());
  return line ? Number(line.balance) : -1; // -1: no trustline
}

async function ensureTrustline(kp: Keypair) {
  if ((await usdcBalance(kp.publicKey())) >= 0) return;
  await submit(kp, [Operation.changeTrust({ asset: USDC })]);
}

async function main() {
  const agent = keypair("AGENT_STELLAR_SECRET");
  const payTo = keypair("STELLAR_PAY_TO_SECRET");
  env.STELLAR_PAY_TO = payTo.publicKey();

  if (!env.BASE_PAY_TO_PRIVATE_KEY) env.BASE_PAY_TO_PRIVATE_KEY = generatePrivateKey();
  env.BASE_PAY_TO = privateKeyToAccount(env.BASE_PAY_TO_PRIVATE_KEY as `0x${string}`).address;

  env.GAIAN_MODE ??= "mock";
  env.PORT ??= "3010";
  env.AGENT_API_URL ??= `http://localhost:${env.PORT}`;

  // Write early so a failure below does not lose freshly generated keys.
  writeEnv();

  for (const kp of [agent, payTo]) {
    await friendbot(kp.publicKey());
    await ensureTrustline(kp);
  }

  if ((await usdcBalance(agent.publicKey())) < 60) {
    await submit(agent, [
      Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: SWAP_XLM, destination: agent.publicKey(), destAsset: USDC, destMin: "1", path: [] }),
    ]);
  }

  console.log("Testnet wallets ready (secrets saved to .env, not printed):");
  console.log(`  agent  ${agent.publicKey()}  USDC ${await usdcBalance(agent.publicKey())}`);
  console.log(`  payTo  ${payTo.publicKey()}  USDC ${await usdcBalance(payTo.publicKey())}`);
  console.log(`  Base payTo ${env.BASE_PAY_TO} (no agent funds on Base, see README)`);
}

function writeEnv() {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
}

main().catch((err) => {
  console.error("setup failed:", err?.response?.data?.extras?.result_codes ?? err.message ?? err);
  process.exit(1);
});
