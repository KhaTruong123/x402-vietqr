// HTTP API the agent talks to.
//   GET  /v1/places          search the demo catalogue (free)
//   POST /v1/quote           price a VietQR in USDC (free)
//   POST /v1/pay?quoteId=    pay the quote with x402 (Stellar testnet or Base Sepolia USDC)
//   GET  /v1/orders/:id      order status (free)
//
// /v1/pay uses the x402 "authorization" flow: the payment is verified first, the handler
// reserves the Gaian order, and only then is the agent's payment settled on chain. If the
// handler fails, settlement is cancelled and the agent keeps its money. Funding the Gaian
// order happens after settlement succeeds.
import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type HTTPTransportContext } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { config, LIVE_GAIAN } from "./config.js";
import { createQuote, failOrder, fundOrder, getOrder, getQuote, PayoutError, quoteAlreadyUsed, reserveOrder } from "./payout.js";
import { DEMO_LABEL, searchPlaces, type PlaceKind } from "./places.js";

const ORDER_HEADER = "x-order-id";

function quoteIdFrom(ctx: HTTPRequestContext): string {
  const raw = ctx.adapter.getQueryParam?.("quoteId");
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value) return value;
  return new URL(ctx.adapter.getUrl(), "http://local").searchParams.get("quoteId") ?? "";
}

function priceFor(ctx: HTTPRequestContext): string {
  const quote = getQuote(quoteIdFrom(ctx));
  // The pre-check below rejects unknown quotes before this runs. The fallback only
  // exists so a race with quote expiry still produces a valid (and unpayable) 402.
  return `$${(quote?.usdc ?? config.maxOrderUsd).toFixed(2)}`;
}

function orderIdFromSettlement(transportContext: unknown): string | undefined {
  const t = transportContext as HTTPTransportContext | undefined;
  const headers = t?.responseHeaders ?? {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === ORDER_HEADER) return v;
  if (t?.responseBody) {
    try {
      return JSON.parse(t.responseBody.toString("utf8"))?.order?.id;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function paymentOptions() {
  if (!config.stellarPayTo) throw new Error("STELLAR_PAY_TO is not set, run npm run setup:testnet");
  const extra = { paymentFlow: "authorization" };
  const accepts = [
    { scheme: "exact", price: priceFor, network: config.stellarNetwork as `${string}:${string}`, payTo: config.stellarPayTo, maxTimeoutSeconds: 120, extra },
  ];
  if (config.basePayTo) {
    accepts.push({ scheme: "exact", price: priceFor, network: config.baseNetwork as `${string}:${string}`, payTo: config.basePayTo, maxTimeoutSeconds: 120, extra });
  }
  return accepts;
}

export function createApp(opts: { syncFacilitatorOnStart?: boolean } = {}) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, gaian: LIVE_GAIAN ? "sandbox" : "mock", networks: paymentOptions().map((a) => a.network), maxOrderUsd: config.maxOrderUsd });
  });

  app.get("/v1/places", (req, res) => {
    const q = req.query;
    const tags = typeof q.tags === "string" && q.tags ? q.tags.split(",") : undefined;
    const results = searchPlaces({
      city: typeof q.city === "string" ? q.city : undefined,
      kind: q.kind === "homestay" || q.kind === "tour" ? (q.kind as PlaceKind) : undefined,
      nights: q.nights ? Number(q.nights) : undefined,
      maxTotalVnd: q.maxTotalVnd ? Number(q.maxTotalVnd) : undefined,
      tags,
    });
    res.json({ demo: DEMO_LABEL, results });
  });

  app.post("/v1/quote", async (req, res, next) => {
    try {
      const { qrString, amountVnd } = req.body ?? {};
      if (typeof qrString !== "string" || !qrString) throw new PayoutError("qrString is required");
      const quote = await createQuote(qrString, typeof amountVnd === "number" ? amountVnd : undefined);
      const { qrString: _omit, ...publicQuote } = quote;
      res.json({ quote: publicQuote, payUrl: `${config.publicUrl}/v1/pay?quoteId=${quote.id}` });
    } catch (err) {
      next(err);
    }
  });

  // Reject unknown, expired or used quotes before asking anyone to pay.
  app.post("/v1/pay", (req: Request, res: Response, next: NextFunction) => {
    const quoteId = typeof req.query.quoteId === "string" ? req.query.quoteId : "";
    if (!getQuote(quoteId)) return res.status(410).json({ error: "Quote not found or expired, request a new one" });
    if (quoteAlreadyUsed(quoteId)) return res.status(409).json({ error: "This quote was already used" });
    next();
  });

  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl }))
    .register(config.stellarNetwork as `${string}:${string}`, new ExactStellarScheme())
    .register(config.baseNetwork as `${string}:${string}`, new ExactEvmScheme())
    .onAfterSettle(async (ctx) => {
      if (ctx.phase !== "after-handler" || !ctx.result.success) return;
      const orderId = orderIdFromSettlement(ctx.transportContext);
      if (!orderId) return;
      await fundOrder(orderId, { transaction: ctx.result.transaction, network: ctx.result.network, payer: ctx.result.payer });
    })
    .onSettleFailure(async (ctx) => {
      const orderId = orderIdFromSettlement(ctx.transportContext);
      if (orderId) failOrder(orderId, `x402 settlement failed: ${ctx.error.message}`);
    });

  app.use(
    paymentMiddleware(
      {
        "POST /v1/pay": {
          accepts: paymentOptions(),
          description: "Pay a Vietnamese VietQR in USDC (testnet demo)",
          mimeType: "application/json",
        },
      },
      resourceServer,
      undefined,
      undefined,
      opts.syncFacilitatorOnStart ?? true,
    ),
  );

  app.post("/v1/pay", async (req, res, next) => {
    try {
      const order = await reserveOrder(String(req.query.quoteId));
      res.setHeader(ORDER_HEADER, order.id);
      res.json({ order: publicOrder(order) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/v1/orders/:id", async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ order: publicOrder(order) });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof PayoutError ? err.httpStatus : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}

function publicOrder<T extends { encodedTransaction?: string }>(order: T): Omit<T, "encodedTransaction"> {
  const { encodedTransaction: _omit, ...rest } = order;
  return rest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  createApp().listen(config.port, () => {
    console.log(`x402-vietqr listening on ${config.publicUrl} (Gaian ${LIVE_GAIAN ? "sandbox" : "mock"} mode)`);
  });
}
