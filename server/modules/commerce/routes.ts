import { Router, type Request } from "express";
import { z } from "zod";
import { writeAdminAudit } from "../../audit.js";
import { ApiError } from "../../errors.js";
import { getConfig } from "../../config.js";
import { query } from "../../db.js";
import {
  requireAdmin,
  requireAuth,
  requireSuperAdmin
} from "../../security.js";
import { getActiveCatalog } from "./catalog.js";
import {
  closeExpiredOrders,
  createInvoiceRequest,
  createOrder,
  getOwnedOrder,
  listOwnedOrders,
  markOrderPaid,
  reconcileAndCloseExpiredOrders,
  startPayment
} from "./orders.js";
import {
  CommerceError,
  type CommerceErrorCode
} from "./types.js";
import {
  FakePaymentProvider
} from "../payments/fake.js";
import type { PaymentProvider } from "../payments/provider.js";

const commerceStatuses: Partial<
  Record<CommerceErrorCode, { status: number; message: string }>
> = {
  INVALID_COMMERCE_CHANNEL: { status: 400, message: "商品渠道无效" },
  INVALID_COMMERCE_INPUT: { status: 400, message: "请求参数无效" },
  INVALID_PRODUCT_SKU: { status: 400, message: "商品无效" },
  PRODUCT_NOT_FOUND: { status: 404, message: "商品不存在或暂不可售" },
  PRODUCT_INACTIVE: { status: 409, message: "商品已停用" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "幂等键对应的下单意图不一致" },
  BUSINESS_DRAFT_NOT_FOUND: { status: 404, message: "业务草稿不存在" },
  ORDER_NOT_FOUND: { status: 404, message: "订单不存在" },
  ORDER_EXPIRED: { status: 409, message: "订单已过期" },
  ORDER_CHANNEL_MISMATCH: { status: 400, message: "商品与站点渠道不匹配" },
  ORDER_STATE_CONFLICT: { status: 409, message: "订单当前状态不可执行该操作" },
  ORDER_NUMBER_GENERATION_FAILED: { status: 503, message: "订单号生成失败，请重试" },
  PAYMENT_PROVIDER_FAILED: { status: 503, message: "支付渠道暂时不可用" },
  PAYMENT_INITIALIZING: { status: 409, message: "支付正在初始化，请稍后重试" },
  PAYMENT_VERIFICATION_FAILED: { status: 400, message: "支付结果校验失败" },
  PAYMENT_TOKEN_INVALID: { status: 404, message: "测试支付凭证无效" },
  PAYMENT_TOKEN_USED: { status: 409, message: "测试支付凭证已使用" },
  INVOICE_NOT_ALLOWED: { status: 409, message: "当前订单不可申请发票" },
  INVOICE_CONFLICT: { status: 409, message: "该订单已有不同的开票资料" },
  INVALID_ENTITLEMENT_POLICY: { status: 500, message: "商品履约配置无效" }
};

export const commerceApiError = (error: unknown) => {
  if (!(error instanceof CommerceError)) return error;
  const mapped = commerceStatuses[error.code] ?? {
    status: 409,
    message: "交易状态冲突"
  };
  return new ApiError(mapped.status, error.code, mapped.message);
};

const uuidSchema = z.string().uuid();
const orderBodySchema = z
  .object({
    sku: z.enum([
      "POLICY_CALC",
      "AI_SEVERANCE_ANALYSIS",
      "AI_DOCUMENT_REVIEW"
    ]),
    channel: z.enum(["main", "ai"]),
    idempotencyKey: z.string().trim().min(1).max(120),
    businessDraftId: z.string().uuid().optional()
  })
  .strict();
const paymentBodySchema = z
  .object({
    channel: z.literal("fake")
  })
  .strict();
const invoiceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    taxNumber: z.string().trim().min(1).max(40).optional(),
    email: z.string().email().max(254)
  })
  .strict();

const requestIp = (request: Request) =>
  request.ip || request.socket.remoteAddress || "127.0.0.1";

const originForChannel = (
  configuredOrigins: string,
  channel: "main" | "ai"
) => {
  const origins = configuredOrigins
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const classifyOrigin = (origin: string) => {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
      return parsed.hostname.split(".")[0] === "ai" ? "ai" : "main";
    } catch {
      return undefined;
    }
  };
  const selected = origins.find(
    (origin) => classifyOrigin(origin) === channel
  );
  if (!selected) {
    throw new CommerceError("PAYMENT_PROVIDER_FAILED");
  }
  return selected;
};

export const createCommerceRouters = (
  provider?: PaymentProvider
) => {
  const config = getConfig();
  const paymentProvider =
    provider ??
    (config.PAYMENT_MODE === "fake"
      ? new FakePaymentProvider(config.NODE_ENV)
      : undefined);
  const router = Router();
  const testRouter = Router();
  const adminRouter = Router();

  router.get("/catalog", async (request, response, next) => {
    try {
      const channel = z
        .enum(["main", "ai"])
        .parse(request.query.channel);
      response.json({ items: await getActiveCatalog(channel) });
    } catch (error) {
      next(commerceApiError(error));
    }
  });

  router.post("/orders", requireAuth, async (request, response, next) => {
    try {
      const body = orderBodySchema.parse(request.body);
      response.status(201).json(
        await createOrder({
          userId: request.authUser!.id,
          ...body
        })
      );
    } catch (error) {
      next(commerceApiError(error));
    }
  });

  router.post(
    "/orders/:id/pay",
    requireAuth,
    async (request, response, next) => {
      try {
        paymentBodySchema.parse(request.body);
        if (!paymentProvider || paymentProvider.channel !== "fake") {
          throw new CommerceError("PAYMENT_PROVIDER_FAILED");
        }
        const orderId = uuidSchema.parse(request.params.id);
        const order = await getOwnedOrder(request.authUser!.id, orderId);
        const returnOrigin = originForChannel(
          config.APP_ORIGIN,
          order.channel
        );
        response.json(
          await startPayment({
            userId: request.authUser!.id,
            orderId,
            provider: paymentProvider,
            clientIp: requestIp(request),
            returnUrl: `${returnOrigin}/orders/${orderId}`,
            notifyUrl: "/api/test-payments/notify"
          })
        );
      } catch (error) {
        next(commerceApiError(error));
      }
    }
  );

  router.get("/orders", requireAuth, async (request, response, next) => {
    try {
      const pagination = z
        .object({
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().positive().max(100).default(20)
        })
        .parse(request.query);
      response.json(
        await listOwnedOrders(
          request.authUser!.id,
          pagination.page,
          pagination.pageSize
        )
      );
    } catch (error) {
      next(commerceApiError(error));
    }
  });

  router.get("/orders/:id", requireAuth, async (request, response, next) => {
    try {
      response.json(
        await getOwnedOrder(
          request.authUser!.id,
          uuidSchema.parse(request.params.id)
        )
      );
    } catch (error) {
      next(commerceApiError(error));
    }
  });

  router.post(
    "/orders/:id/invoice",
    requireAuth,
    async (request, response, next) => {
      try {
        const body = invoiceBodySchema.parse(request.body);
        response.status(201).json(
          await createInvoiceRequest({
            userId: request.authUser!.id,
            orderId: uuidSchema.parse(request.params.id),
            ...body
          })
        );
      } catch (error) {
        next(commerceApiError(error));
      }
    }
  );

  adminRouter.get(
    "/status",
    requireAuth,
    requireAdmin,
    async (_request, response, next) => {
      try {
        const result = await query<{
          open_orders: string;
          pending_attempts: string;
        }>(
          `SELECT
             (
               SELECT count(*)::text
               FROM orders
               WHERE status IN (
                 'CREATED',
                 'PAYING',
                 'PAYMENT_FAILED',
                 'PAID',
                 'FULFILLING'
               )
             ) AS open_orders,
             (
               SELECT count(*)::text
               FROM payment_attempts
               WHERE status IN ('CREATED', 'REDIRECT_READY', 'PENDING')
             ) AS pending_attempts`
        );
        response.json({
          paymentMode: config.PAYMENT_MODE,
          counts: {
            openOrders: result.rows[0]?.open_orders ?? "0",
            pendingAttempts: result.rows[0]?.pending_attempts ?? "0"
          }
        });
      } catch (error) {
        next(commerceApiError(error));
      }
    }
  );

  adminRouter.post(
    "/close-expired",
    requireAuth,
    requireSuperAdmin,
    async (request, response, next) => {
      try {
        const body = z
          .object({
            limit: z.number().int().min(1).max(500).default(200)
          })
          .strict()
          .parse(request.body);
        const closedOrderIds = await reconcileAndCloseExpiredOrders({
          provider: paymentProvider,
          limit: body.limit,
          onClosed: async (client, ids) => {
            await writeAdminAudit(
              request,
              "commerce.orders.close_expired",
              "orders",
              undefined,
              {
                limit: body.limit,
                closedCount: ids.length,
                closedOrderIds: ids
              },
              client
            );
          }
        });
        response.json({
          closedCount: closedOrderIds.length,
          closedOrderIds
        });
      } catch (error) {
        next(commerceApiError(error));
      }
    }
  );

  if (config.NODE_ENV === "test" && paymentProvider instanceof FakePaymentProvider) {
    testRouter.post(
      "/:orderNo/complete",
      async (request, response, next) => {
        let token: string | undefined;
        let completionStarted = false;
        try {
          z.object({}).strict().parse(request.body);
          const orderNo = z.string().trim().min(1).max(80).parse(
            request.params.orderNo
          );
          token = z.string().min(20).max(300).parse(
            request.query.token
          );
          const verified = paymentProvider.beginCompletion(orderNo, token);
          completionStarted = true;
          const attemptId = z.string().uuid().parse(
            verified.raw.attemptId
          );
          const order = await queryOrderId(orderNo);
          const completed = await markOrderPaid({
            orderId: order,
            paymentAttemptId: attemptId,
            verified
          });
          paymentProvider.commitCompletion(token);
          completionStarted = false;
          response.json(completed);
        } catch (error) {
          if (completionStarted && token) {
            paymentProvider.rollbackCompletion(token);
          }
          next(commerceApiError(error));
        }
      }
    );
  }

  return { router, testRouter, adminRouter };
};

const queryOrderId = async (orderNo: string) => {
  const result = await query<{ id: string }>(
    "SELECT id FROM orders WHERE order_no = $1",
    [orderNo]
  );
  if (!result.rows[0]) throw new CommerceError("ORDER_NOT_FOUND");
  return result.rows[0].id;
};

export { closeExpiredOrders };
