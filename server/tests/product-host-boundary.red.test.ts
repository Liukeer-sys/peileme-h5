import request from "supertest";
import { readdir } from "node:fs/promises";
import net from "node:net";
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
  })),
  startPayment: vi.fn(async (input: { orderId: string }) => ({
    orderId: input.orderId,
    status: "PAYING"
  })),
  createInvoiceRequest: vi.fn(async (input: { orderId: string }) => ({
    id: "00000000-0000-4000-8000-000000000002",
    orderId: input.orderId,
    status: "REQUESTED"
  }))
}));

const databaseMocks = vi.hoisted(() => ({
  query: vi.fn(async () => ({
    rows: [{ now: new Date() }],
    rowCount: 1
  }))
}));

vi.mock("../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db.js")>();
  return { ...actual, query: databaseMocks.query };
});

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
    listOwnedOrders: commerceMocks.listOwnedOrders,
    startPayment: commerceMocks.startPayment,
    createInvoiceRequest: commerceMocks.createInvoiceRequest
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
      if (
        request.path.startsWith("/api/commerce/orders") &&
        request.header("x-b2-skip-auth") !== "1"
      ) {
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

const fakeProvider = {
  channel: "fake" as const,
  async createPayment() {
    throw new Error("mocked startPayment must intercept provider calls");
  },
  async queryPayment() {
    return null;
  },
  async refund() {
    return { channelRefundId: "unused", raw: {} };
  }
};

describe("B2 product host/API boundary contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.query.mockResolvedValue({
      rows: [{ now: new Date() }],
      rowCount: 1
    });
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

  it("rejects main-host multipart data before Multer writes a file", async () => {
    const uploadDir = process.env.UPLOAD_DIR!;
    const before = (await readdir(uploadDir)).sort();
    const response = await request(createApp())
      .post("/api/uploads")
      .set("host", "peileme.art")
      .attach("files", Buffer.from("%PDF-1.4 B2 main host"), {
        filename: "must-not-write.pdf",
        contentType: "application/pdf"
      });

    expect(response.status).toBe(404);
    expect((await readdir(uploadDir)).sort()).toEqual(before);
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

  it("rejects an unknown Host CORS preflight before CORS can terminate it", async () => {
    const response = await request(createApp())
      .options("/api/public/config")
      .set("host", "unknown.example")
      .set("origin", "http://localhost:5173")
      .set("access-control-request-method", "GET");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("PRODUCT_HOST_NOT_FOUND");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each([
    [
      "peileme.art",
      "http://localhost:5173",
      "/api/commerce/orders/00000000-0000-4000-8000-000000000000/pay"
    ],
    [
      "peileme.art",
      "http://localhost:5173",
      "/api/commerce/orders/00000000-0000-4000-8000-000000000000/invoice"
    ],
    [
      "ai.peileme.art",
      "http://ai.localhost:5174",
      "/api/commerce/orders/00000000-0000-4000-8000-000000000000/pay"
    ],
    [
      "ai.peileme.art",
      "http://ai.localhost:5174",
      "/api/commerce/orders/00000000-0000-4000-8000-000000000000/invoice"
    ]
  ])(
    "answers the known-host payment preflight for %s %s before auth and ownership",
    async (host, origin, path) => {
      const response = await request(createApp())
        .options(path)
        .set("host", host)
        .set("origin", origin)
        .set("access-control-request-method", "POST")
        .set("access-control-request-headers", "authorization,content-type");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(commerceMocks.getOwnedOrder).not.toHaveBeenCalled();
    }
  );

  it("keeps only the health endpoint available to an unknown host", async () => {
    const response = await request(createApp())
      .get("/api/health")
      .set("host", "unknown.example")
      .expect(200);

    expect(response.body).toMatchObject({
      status: "healthy",
      database: true
    });
  });

  it("fails closed when a raw HTTP request carries duplicate Host fields", async () => {
    const server = createApp().listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("B2 test server address unavailable");
      }
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(
          { host: "127.0.0.1", port: address.port },
          () => {
            socket.end(
              "GET /api/public/config HTTP/1.1\r\n" +
                "Host: peileme.art\r\n" +
                "Host: ai.peileme.art\r\n" +
                "Connection: close\r\n\r\n"
            );
          }
        );
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          response += chunk;
        });
        socket.once("end", () => resolve(response));
        socket.once("error", reject);
      });

      expect(raw).toMatch(/^HTTP\/1\.1 404 /);
      expect(raw).toContain("PRODUCT_HOST_NOT_FOUND");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each(["POST", "PUT"])(
    "rejects unknown Host %s /api/health before body parsing",
    async (method) => {
      const agent = request(createApp());
      const response = await (method === "POST"
        ? agent.post("/api/health")
        : agent.put("/api/health"))
        .set("host", "unknown.example")
        .set("content-type", "application/json")
        .send('{"broken":');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("PRODUCT_HOST_NOT_FOUND");
    }
  );

  it("fails an unknown host before attempting to parse malformed JSON", async () => {
    const response = await request(createApp())
      .post("/api/events/batch")
      .set("host", "unknown.example")
      .set("content-type", "application/json")
      .send('{"events":');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("PRODUCT_HOST_NOT_FOUND");
  });

  it.each(["/api/uploads", "/api/admin/uploads"])(
    "hides main-host material endpoint %s before malformed JSON parsing",
    async (path) => {
      const response = await request(createApp())
        .post(path)
        .set("host", "peileme.art")
        .set("content-type", "application/json")
        .send('{"broken":');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("NOT_FOUND");
    }
  );

  it.each([
    ["GET", "/api/public/config"],
    ["GET", "/api/auth/me"],
    ["GET", "/api/policy/regions?year=2026"],
    ["POST", "/api/events/batch"],
    ["GET", "/api/admin/overview"]
  ])("fails closed for unknown host business API %s %s", async (method, path) => {
    const agent = request(createApp());
    const response = await (method === "POST" ? agent.post(path) : agent.get(path))
      .set("host", "unknown.example")
      .send(
        method === "POST"
          ? {
              events: [
                {
                  name: "b2_unknown_host",
                  occurredAt: new Date().toISOString()
                }
              ]
            }
          : undefined
      );

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
    ["PEILEME.ART.:443", "main", "POLICY_CALC"],
    ["AI.PEILEME.ART.:8443", "ai", "AI_DOCUMENT_REVIEW"]
  ] as const)(
    "normalizes allowed Host authority %s to %s",
    async (host, channel, sku) => {
      const response = await request(createApp())
        .get(`/api/commerce/catalog?channel=${channel}`)
        .set("host", host);

      expect(response.status).toBe(200);
      expect(response.body.items[0].sku).toBe(sku);
    }
  );

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

  it("rejects a query channel mismatch before order-history authentication", async () => {
    const response = await request(createApp())
      .get("/api/commerce/orders?channel=ai")
      .set("host", "peileme.art")
      .set("x-b2-skip-auth", "1");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
    expect(commerceMocks.listOwnedOrders).not.toHaveBeenCalled();
  });

  it.each([
    ["peileme.art", "main", "POLICY_CALC"],
    ["ai.peileme.art", "ai", "AI_DOCUMENT_REVIEW"]
  ] as const)(
    "allows a legal %s order for the %s product",
    async (host, channel, sku) => {
      const response = await request(createApp())
        .post("/api/commerce/orders")
        .set("host", host)
        .send({
          sku,
          channel,
          idempotencyKey: `b2-legal-${channel}`
        });

      expect(response.status).toBe(201);
      expect(commerceMocks.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({ channel, sku })
      );
    }
  );

  it.each([
    ["peileme.art", "main", "AI_DOCUMENT_REVIEW"],
    ["ai.peileme.art", "ai", "POLICY_CALC"]
  ] as const)(
    "rejects a host-compatible channel carrying the other product SKU",
    async (host, channel, sku) => {
      const response = await request(createApp())
        .post("/api/commerce/orders")
        .set("host", host)
        .send({
          sku,
          channel,
          idempotencyKey: `b2-sku-mismatch-${channel}`
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
      expect(commerceMocks.createOrder).not.toHaveBeenCalled();
    }
  );

  it("rejects a body channel mismatch before authentication or order creation", async () => {
    const response = await request(createApp())
      .post("/api/commerce/orders")
      .set("host", "peileme.art")
      .set("x-b2-skip-auth", "1")
      .send({
        sku: "AI_DOCUMENT_REVIEW",
        channel: "ai",
        idempotencyKey: "b2-pre-auth"
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
    expect(commerceMocks.createOrder).not.toHaveBeenCalled();
  });

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

  it.each([
    "/api/commerce/catalog?channel=main&channel=main",
    "/api/commerce/orders?channel=main&channel=main",
    "/api/commerce/orders/00000000-0000-4000-8000-000000000000?channel=main&channel=main"
  ])("rejects repeated caller channel parameters in %s", async (path) => {
    const response = await request(createApp())
      .get(path)
      .set("host", "peileme.art");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("PRODUCT_CHANNEL_HOST_MISMATCH");
  });

  it.each([
    ["peileme.art", "main"],
    ["ai.peileme.art", "ai"]
  ] as const)(
    "passes the derived %s payment scope through the complete start path",
    async (host, channel) => {
      const response = await request(
        createApp({ paymentProvider: fakeProvider })
      )
        .post(
          "/api/commerce/orders/00000000-0000-4000-8000-000000000000/pay"
        )
        .set("host", host)
        .send({ channel: "fake" });

      expect(response.status).toBe(200);
      expect(commerceMocks.getOwnedOrder).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000099",
        "00000000-0000-4000-8000-000000000000",
        channel
      );
      expect(commerceMocks.startPayment).toHaveBeenCalledWith(
        expect.objectContaining({ productChannel: channel })
      );
    }
  );

  it.each([
    ["peileme.art", "main"],
    ["ai.peileme.art", "ai"]
  ] as const)(
    "passes the derived %s invoice scope into the transaction",
    async (host, channel) => {
      const response = await request(createApp())
        .post(
          "/api/commerce/orders/00000000-0000-4000-8000-000000000000/invoice"
        )
        .set("host", host)
        .send({
          title: "B2 Test",
          email: "b2-invoice@peileme.test"
        });

      expect(response.status).toBe(201);
      expect(commerceMocks.createInvoiceRequest).toHaveBeenCalledWith(
        expect.objectContaining({ productChannel: channel })
      );
    }
  );
});
