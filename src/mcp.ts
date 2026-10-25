// MCP server so Claude Desktop (or any MCP client) can act as the travel agent.
// Tools:
//   find_places  search demo homestays and tours
//   pay_place    pay one of them in test USDC, never above the user's budget or 50 USD per order
//   get_order    check an order's status
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentFromEnv, BudgetError } from "./agent/pay.js";
import { config } from "./config.js";

const agent = agentFromEnv();
const server = new McpServer({ name: "x402-vietqr", version: "0.1.0" });

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

server.registerTool(
  "find_places",
  {
    title: "Find a homestay or tour (demo)",
    description:
      "Search the demo catalogue of Vietnamese homestays and tours. Every result is fake test data with a test VietQR. " +
      "nights means nights for a homestay and people for a tour. Prices are in VND.",
    inputSchema: {
      city: z.string().optional().describe("Da Lat, Hoi An, Sa Pa or Phu Quoc"),
      kind: z.enum(["homestay", "tour"]).optional(),
      nights: z.number().int().min(1).max(14).optional(),
      maxTotalVnd: z.number().int().positive().optional(),
      tags: z.array(z.string()).optional().describe("e.g. view, quiet, beach, couple, family, trekking"),
    },
  },
  async (input) => {
    const results = await agent.search(input);
    return text(results.map(({ vietQr: _qr, ...r }) => r));
  },
);

server.registerTool(
  "pay_place",
  {
    title: "Pay for a place (testnet)",
    description:
      `Pay for one demo place found by find_places, in test USDC over x402. Refuses if the price is above the user's budget ` +
      `(counting what was already paid in this session) or above ${config.maxOrderUsd} USD per order. ` +
      "Only call this after the user gave a budget and the place fits their conditions.",
    inputSchema: {
      placeId: z.string().describe("id from find_places"),
      nights: z.number().int().min(1).max(14).default(1),
      budgetUsd: z.number().positive().describe("The user's total budget in USD for this session"),
    },
  },
  async ({ placeId, nights, budgetUsd }) => {
    const place = (await agent.search({ nights })).find((p) => p.id === placeId);
    if (!place) return { ...text(`No place with id ${placeId}`), isError: true };
    try {
      const { quote, order, settlement } = await agent.pay(place.vietQr, budgetUsd);
      return text({
        paid: `${quote.usdc} USDC for ${place.totalVnd.toLocaleString("en-US")} VND`,
        place: place.name,
        order,
        settlement,
        spentThisSessionUsd: agent.spent,
        note: place.demo,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ...text(err instanceof BudgetError ? `Not paid: ${msg}` : `Payment failed, nothing was charged unless settlement shows otherwise: ${msg}`), isError: true };
    }
  },
);

server.registerTool(
  "get_order",
  {
    title: "Check an order",
    description: "Check the status of an order returned by pay_place.",
    inputSchema: { orderId: z.string() },
  },
  async ({ orderId }) => text(await agent.order(orderId)),
);

await server.connect(new StdioServerTransport());
