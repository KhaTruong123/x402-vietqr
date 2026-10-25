import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load .env from the project folder, not the caller's cwd (Claude Desktop starts MCP servers elsewhere).
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export type GaianMode = "sandbox" | "mock";

export const config = {
  port: num("PORT", 3010),
  publicUrl: str("PUBLIC_URL", `http://localhost:${num("PORT", 3010)}`),

  // x402
  facilitatorUrl: str("FACILITATOR_URL", "https://x402.org/facilitator"),
  stellarNetwork: str("STELLAR_NETWORK", "stellar:testnet"),
  stellarPayTo: str("STELLAR_PAY_TO"),
  baseNetwork: str("BASE_NETWORK", "eip155:84532"),
  basePayTo: str("BASE_PAY_TO"),

  // Hard limits. One order never exceeds this, on the server and in the agent.
  maxOrderUsd: num("MAX_ORDER_USD", 50),
  quoteTtlSeconds: num("QUOTE_TTL_SECONDS", 300),

  // Gaian
  gaianMode: (str("GAIAN_MODE", "mock") as GaianMode),
  gaianHost: str("GAIAN_HOST", "https://sandbox.gaian.network"),
  gaianKey: str("GAIAN_KEY"),
  gaianSecret: str("GAIAN_SECRET"),
  // A KYC-approved sandbox user that owns the treasury wallet Gaian quotes against.
  gaianTreasuryUserId: str("GAIAN_TREASURY_USER_ID"),
  gaianTreasuryWallet: str("GAIAN_TREASURY_WALLET"),
  gaianChainId: num("GAIAN_CHAIN_ID", 148),

  // Mock pricing, only used when GAIAN_MODE=mock. Labelled as demo in every response.
  // The rate is a round demo number and no fee is added unless MOCK_FEE_RATE is set.
  mockVndPerUsdc: num("MOCK_VND_PER_USDC", 26300),
  mockFeeRate: num("MOCK_FEE_RATE", 0),
};

export const LIVE_GAIAN = config.gaianMode === "sandbox";
