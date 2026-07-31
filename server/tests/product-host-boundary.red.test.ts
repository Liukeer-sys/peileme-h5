import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";

const commerceMocks = vi.hoisted(() => ({
  createOrder: vi.fn(async () => ({
    id: "00000000-0000-4000-8000-000000000001",
    channel: "main"
  })),
  getOwnedOrder: vi.fn(async (
    _userId: string,
    _orderId: string,
    channel?: "main" | "ai"
  ) => ({
    id: "00000000-0000-4000-8000-000000000000",
    channel: channel ?? "unscoped"
  })),
  listOwnedOrders: vi.fn(async (
    _userId: string,
    _page: number,
    _pageSize: number,
    channel?: "main" | "ai"
  ) => ({
    items: channel
      ? [{ id: `${channel}-order`, channel }]
      : [
          { id: "main-order", channel: "main" },
          { id: "ai-order", channel: "ai" }
        ],
    pagination: { page: 1, pageSize: 20, total: channel ? 1 : 2 }
  }))
}));

vi.mock("../modules/commerce/catalog.js", () => ({
  getActiveCatalog: vi.fn(async (channel: "main" | "ai") => [
    { sku: channel === "main" ? "POLICY_CALC" : "AI_DOCUMENT_REVIEW" }
  ])
}));

vi.mock("../modules/commerce/orders.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../modules/commerce/orders.js")
  >();
  return {
    ...actual,
    createOrder: commerceMocks.createOrder,
    getOwnedOrder: commerceMocks.getOwnedOrder,
    listOwnedOrders: commerceMocks.listOwnedOrders
  };
});

vi.mock("../security.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security.js")>();
  return {
    ...actual,
    optionalAuth: (
      request: Parameters<typeof actual.optionalAuth>[0],
      response: Parameters<typeof actual.optionalAuth>[1],
      next: Parameters<typeof actual.optionalAuth>[2]
    ) => {
      if (request.path.startsWith("/api/commerce/orders")) {
        request.authUser = {
          id: "00000000-0000-4000-8000-000000000099",
          role: "user",
          email: "b2-contract@peileme.test",
          phone: null,
          displayName: "B2 contract",
          status: "active"
        };
        next();
        return;
      }
      return actual.optionalAuth(request, response, next);
    }
  };
});

const runB2Red = process.env.RUN_B2_PRODUCT_HOST_RED === "1";

describe.runIf(runB2Red)("B2 product host/API boundary contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["POST", "/api/uploads"],
    ["GET", "/api/uploads/mine"],
    ["GET", "/api/uploads/00000000-0000-4000-8000-000000000000/download"],
    ["GET", "/api/admin/uploads?pageSize=1"],
    ["GET", "/api/admin/uploads/00000000-0000-4000-8000-000000000000/download"]
  ])("hides %s %s from the main host", async (method, path) => {
    const agent = request(createApp());
    const response = await (method === "POST" ? agent.post(path) : agent.get(path))
      .set("host", "peileme.art");

    expect(response.status).toBe(404);
  });

  it("keeps the AI upload API mounted on the AI host", async () => {
    const response = await request(createApp())
      .get("/api/uploads/mine")
      .set("host", "ai.peileme.art");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("AUTH_REQUIRED");
  });

  it("rejects caller-selected AI catalog access on the main host", async () => {
    const response = await request(createApp())
      .get("/api/commerce/catalog?channel=ai")
      .set("host", "peileme.art");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
  });

  it("fails closed before catalog access for an unknown production host", async () => {
    const response = await request(createApp())
      .get("/api/commerce/catalog?channel=main")
      .set("host", "unknown.example");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("PRODUCT_HOST_NOT_FOUND");
  });

  it("does not let a forwarded host override the externally received main host", async () => {
    const response = await request(createApp())
      .get("/api/commerce/catalog?channel=ai")
      .set("host", "peileme.art")
      .set("x-forwarded-host", "ai.peileme.art");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
  });

  it.each([
    ["peileme.art", "ai", "AI_DOCUMENT_REVIEW"],
    ["ai.peileme.art", "main", "POLICY_CALC"]
  ])(
    "rejects a %s order carrying the %s channel",
    async (host, channel, sku) => {
      const response = await request(createApp())
        .post("/api/commerce/orders")
        .set("host", host)
        .send({
          sku,
          channel,
          idempotencyKey: "b2-cross-host-order"
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
    }
  );

  it.each([
    ["peileme.art", "main"],
    ["ai.peileme.art", "ai"]
  ] as const)(
    "scopes normal %s order list responses to %s",
    async (host, channel) => {
      const list = await request(createApp())
        .get("/api/commerce/orders")
        .set("host", host);

      expect(list.status).toBe(200);
      expect(
        list.body.items.every(
          (item: { channel: string }) => item.channel === channel
        )
      ).toBe(true);
      expect(commerceMocks.listOwnedOrders).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000099",
        1,
        20,
        channel
      );
    }
  );

  it.each([
    ["peileme.art", "main"],
    ["ai.peileme.art", "ai"]
  ] as const)(
    "scopes normal %s order detail responses to %s",
    async (host, channel) => {
      const detail = await request(createApp())
        .get(
          "/api/commerce/orders/00000000-0000-4000-8000-000000000000"
        )
        .set("host", host);

      expect(detail.status).toBe(200);
      expect(detail.body.channel).toBe(channel);
      expect(commerceMocks.getOwnedOrder).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000099",
        "00000000-0000-4000-8000-000000000000",
        channel
      );
    }
  );

  it.each([
    ["peileme.art", "ai", "/api/commerce/orders"],
    [
      "peileme.art",
      "ai",
      "/api/commerce/orders/00000000-0000-4000-8000-000000000000"
    ],
    ["ai.peileme.art", "main", "/api/commerce/orders"],
    [
      "ai.peileme.art",
      "main",
      "/api/commerce/orders/00000000-0000-4000-8000-000000000000"
    ]
  ])(
    "rejects %s history access carrying the %s channel",
    async (host, channel, path) => {
      const response = await request(createApp())
        .get(`${path}?channel=${channel}`)
        .set("host", host);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
    }
  );
});
