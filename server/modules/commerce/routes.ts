import { Router, type Request, type RequestHandler } from "express";
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
import type { PaymentProvider } from "../payments/provider.js";
import type { ProductChannel } from "../../product-host.js";

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
  PAYMENT_CHANNEL_LOCKED: { status: 409, message: "已有支付渠道正在处理，请稍后重试" },
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
    channel: z.enum(["wechat_h5", "alipay_wap"])
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

const productChannelFrom = (request: Request): ProductChannel => {
  if (!request.productChannel) {
    throw new ApiError(404, "PRODUCT_HOST_NOT_FOUND", "产品站点不存在");
  }
  return request.productChannel;
};

const assertRequestedProductChannel = (
  requested: unknown,
  derived: ProductChannel
) => {
  if (requested === undefined) return;
  if (
    typeof requested !== "string" ||
    (requested !== "main" && requested !== "ai") ||
    requested !== derived
  ) {
    throw new ApiError(
      400,
      "PRODUCT_CHANNEL_HOST_MISMATCH",
      "请求渠道与产品站点不一致"
    );
  }
};

const assertSkuForProductChannel = (
  requested: unknown,
  channel: ProductChannel
) => {
  const mainSkus = new Set(["POLICY_CALC"]);
  const aiSkus = new Set([
    "AI_SEVERANCE_ANALYSIS",
    "AI_DOCUMENT_REVIEW"
  ]);
  if (
    typeof requested === "string" &&
    ((mainSkus.has(requested) && channel !== "main") ||
      (aiSkus.has(requested) && channel !== "ai"))
  ) {
    throw new ApiError(
      400,
      "PRODUCT_CHANNEL_HOST_MISMATCH",
      "商品与产品站点不一致"
    );
  }
};

const requireOrderProductBoundary: RequestHandler = (
  request,
  _response,
  next
) => {
  try {
    const channel = productChannelFrom(request);
    if (request.body && typeof request.body === "object") {
      const body = request.body as Record<string, unknown>;
      assertRequestedProductChannel(body.channel, channel);
      assertSkuForProductChannel(body.sku, channel);
    }
    next();
  } catch (error) {
    next(commerceApiError(error));
  }
};

const requireQueryProductBoundary: RequestHandler = (
  request,
  _response,
  next
) => {
  try {
    assertRequestedProductChannel(
      request.query.channel,
      productChannelFrom(request)
    );
    next();
  } catch (error) {
    next(commerceApiError(error));
  }
};

export const createCommerceRouters = (
  provider?: PaymentProvider
) => {
  const config = getConfig();
  const paymentProvider = provider;
  const router = Router();
  const testRouter = Router();
  const adminRouter = Router();

  router.get("/catalog", async (request, response, next) => {
    try {
      const channel = productChannelFrom(request);
      assertRequestedProductChannel(request.query.channel, channel);
      response.json({ items: await getActiveCatalog(channel) });
    } catch (error) {
      next(commerceApiError(error));
    }
  });

  router.post(
    "/orders",
    requireOrderProductBoundary,
    requireAuth,
    async (request, response, next) => {
      try {
        const body = orderBodySchema.parse(request.body);
        const channel = productChannelFrom(request);
        assertRequestedProductChannel(body.channel, channel);
        assertSkuForProductChannel(body.sku, channel);
        response.status(201).json(
          await createOrder({
            userId: request.authUser!.id,
            ...body,
            channel
          })
        );
      } catch (error) {
        next(commerceApiError(error));
      }
    }
  );

  router.post(
    "/orders/:id/pay",
    requireAuth,
    async (request, response, next) => {
      try {
        const orderId = uuidSchema.parse(request.params.id);
        const productChannel = productChannelFrom(request);
        await getOwnedOrder(
          request.authUser!.id,
          orderId,
          productChannel
        );
        const payment = paymentBodySchema.parse(request.body);
        if (!paymentProvider || paymentProvider.channel !== payment.channel) {
          throw new CommerceError("PAYMENT_PROVIDER_FAILED");
        }
        const returnOrigin =
          productChannel === "main"
            ? config.MAIN_APP_ORIGIN
            : config.AI_APP_ORIGIN;
        response.json(
          await startPayment({
            userId: request.authUser!.id,
            orderId,
            productChannel,
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

  router.get(
    "/orders",
    requireQueryProductBoundary,
    requireAuth,
    async (request, response, next) => {
    try {
      const channel = productChannelFrom(request);
      assertRequestedProductChannel(request.query.channel, channel);
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
          pagination.pageSize,
          channel
        )
      );
    } catch (error) {
      next(commerceApiError(error));
    }
    }
  );

  router.get(
    "/orders/:id",
    requireQueryProductBoundary,
    requireAuth,
    async (request, response, next) => {
    try {
      const channel = productChannelFrom(request);
      assertRequestedProductChannel(request.query.channel, channel);
      response.json(
        await getOwnedOrder(
          request.authUser!.id,
          uuidSchema.parse(request.params.id),
          channel
        )
      );
    } catch (error) {
      next(commerceApiError(error));
    }
    }
  );

  router.post(
    "/orders/:id/invoice",
    requireAuth,
    async (request, response, next) => {
      try {
        const orderId = uuidSchema.parse(request.params.id);
        const productChannel = productChannelFrom(request);
        await getOwnedOrder(
          request.authUser!.id,
          orderId,
          productChannel
        );
        const body = invoiceBodySchema.parse(request.body);
        response.status(201).json(
          await createInvoiceRequest({
            userId: request.authUser!.id,
            orderId,
            productChannel,
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
          pending_payment_anomalies: string;
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
             ) AS pending_attempts,
             (
               SELECT count(*)::text
               FROM payment_anomalies
               WHERE status = 'PENDING_REVIEW'
             ) AS pending_payment_anomalies`
        );
        response.json({
          paymentMode: config.PAYMENT_MODE,
          counts: {
            openOrders: result.rows[0]?.open_orders ?? "0",
            pendingAttempts: result.rows[0]?.pending_attempts ?? "0",
            pendingPaymentAnomalies:
              result.rows[0]?.pending_payment_anomalies ?? "0"
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
        const reconciliation = await reconcileAndCloseExpiredOrders({
          provider: paymentProvider,
          limit: body.limit,
          onClosed: async (client, ids, summary) => {
            await writeAdminAudit(
              request,
              "commerce.orders.close_expired",
              "orders",
              undefined,
              {
                limit: body.limit,
                closedCount: ids.length,
                closedOrderIds: ids,
                reconciliation: summary
              },
              client
            );
          }
        });
        response.json({
          closedCount: reconciliation.closedOrderIds.length,
          closedOrderIds: reconciliation.closedOrderIds,
          reconciliation: reconciliation.summary
        });
      } catch (error) {
        next(commerceApiError(error));
      }
    }
  );

  return { router, testRouter, adminRouter };
};

export { closeExpiredOrders };
