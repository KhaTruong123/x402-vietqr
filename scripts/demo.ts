// End-to-end run on testnet: start the API, let the agent search, quote and pay with x402,
// then follow the order until it completes. Also checks that the limits refuse what they should.
import { Horizon } from "@stellar/stellar-sdk";
import { createApp } from "../src/server.js";
import { agentFromEnv, BudgetError } from "../src/agent/pay.js";
import { config, LIVE_GAIAN } from "../src/config.js";

const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

async function usdc(pub: string) {
  const acc = await horizon.loadAccount(pub);
  const line = acc.balances.find((b) => "asset_code" in b && b.asset_code === "USDC");
  return line ? Number(line.balance) : 0;
}

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);

async function main() {
  const server = createApp().listen(config.port);
  await new Promise((r) => server.once("listening", r));
  const agent = agentFromEnv();
  try {
    console.log(`API ${config.publicUrl}, Gaian ${LIVE_GAIAN ? "sandbox" : "mock (demo pricing, no VND moves)"}`);

    step(1, "User: 2 nights in Da Lat, quiet, budget 40 USD. Agent searches.");
    const results = await agent.search({ city: "Đà Lạt", kind: "homestay", nights: 2 });
    results.forEach((r) => console.log(`    ${r.id}  ${r.name}  ${r.totalVnd.toLocaleString("en-US")} VND  rating ${r.rating}`));
    const pick = results.find((r) => r.tags.includes("quiet")) ?? results[0];
    if (!pick) throw new Error("no results");
    console.log(`    picked ${pick.id}`);

    step(2, "Limit check: same place with a 5 USD budget must be refused.");
    try {
      await agent.pay(pick.vietQr, 5);
      throw new Error("expected the budget check to refuse");
    } catch (err) {
      if (!(err instanceof BudgetError)) throw err;
      console.log(`    refused: ${err.message}`);
    }

    step(3, "Agent pays with x402 on Stellar testnet.");
    const before = await usdc(config.stellarPayTo);
    const { quote, order, settlement } = await agent.pay(pick.vietQr, 40);
    console.log(`    quote ${quote.usdc} USDC for ${quote.amountVnd.toLocaleString("en-US")} VND`);
    console.log(`    order ${order.id} status ${order.status}`);
    console.log(`    settlement ${JSON.stringify(settlement)}`);
    if (settlement?.transaction) console.log(`    https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`);

    step(4, "Follow the order.");
    let status = "";
    for (let i = 0; i < 20; i++) {
      const o = await agent.order(String(order.id));
      if (o?.status !== status) console.log(`    ${o?.status}${o?.error ? ` (${o.error})` : ""}`);
      status = String(o?.status);
      if (status === "completed" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const after = await usdc(config.stellarPayTo);
    console.log(`    payTo USDC ${before} -> ${after}`);

    step(5, "Limit check: paying the same quote twice must be refused.");
    const reuse = await fetch(`${config.publicUrl}/v1/pay?quoteId=${quote.id}`, { method: "POST" });
    console.log(`    second payment on quote: HTTP ${reuse.status}`);

    if (status !== "completed") throw new Error(`order ended as ${status}`);
    console.log("\nE2E OK");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\nE2E FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
