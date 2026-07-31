export const productSkus = [
  "POLICY_CALC",
  "AI_SEVERANCE_ANALYSIS",
  "AI_DOCUMENT_REVIEW"
] as const;
export type ProductSku = (typeof productSkus)[number];

export const productChannels = ["main", "ai", "all"] as const;
export type ProductChannel = (typeof productChannels)[number];
export type OrderProductChannel = "main" | "ai";

export const fulfillmentTypes = [
  "policy_calculation",
  "ai_analysis",
  "document_review"
] as const;
export type FulfillmentType = (typeof fulfillmentTypes)[number];

export type ProductStatus = "active" | "inactive";
export type PromotionTriggerType =
  | "first_verified_user"
  | "invite_redemption"
  | "admin_grant";
export type PromotionStatus = "active" | "inactive";
export type Currency = "CNY";

export type OrderStatus =
  | "CREATED"
  | "PAYING"
  | "PAID"
  | "FULFILLING"
  | "COMPLETED"
  | "CLOSED"
  | "PAYMENT_FAILED"
  | "REFUND_PENDING"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "REFUND_FAILED";

export const paymentChannels = ["wechat_h5", "alipay_wap", "fake"] as const;
export type PaymentChannel = (typeof paymentChannels)[number];

export type PaymentAttemptStatus =
  | "CREATED"
  | "REDIRECT_READY"
  | "PENDING"
  | "SUCCEEDED"
  | "FAILED"
  | "CLOSED";

export type PaymentTransactionStatus = "SUCCESS" | "CLOSED" | "REFUND";
export type EntitlementSourceType = "first_free" | "order" | "invite" | "admin";
export type EntitlementStatus = "active" | "reserved" | "consumed" | "revoked";
export type EntitlementUsageStatus = "reserved" | "consumed" | "released";
export type RefundStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED";
export type ReconciliationStatus =
  | "RUNNING"
  | "MATCHED"
  | "DIFFERENCES"
  | "FAILED";
export type InvoiceRequestStatus =
  | "SUBMITTED"
  | "PROCESSING"
  | "ISSUED"
  | "REJECTED";

export const commerceErrorCodes = [
  "INVALID_COMMERCE_CHANNEL",
  "INVALID_COMMERCE_INPUT",
  "INVALID_PRODUCT_SKU",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_INACTIVE",
  "IDENTITY_VERIFICATION_REQUIRED",
  "ENTITLEMENT_NOT_AVAILABLE",
  "BUSINESS_ID_CONFLICT",
  "ENTITLEMENT_USAGE_NOT_FOUND",
  "ENTITLEMENT_USAGE_CLOSED",
  "IDEMPOTENCY_CONFLICT",
  "BUSINESS_DRAFT_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "ORDER_EXPIRED",
  "ORDER_CHANNEL_MISMATCH",
  "ORDER_STATE_CONFLICT",
  "ORDER_NUMBER_GENERATION_FAILED",
  "INVALID_ENTITLEMENT_POLICY",
  "PAYMENT_VERIFICATION_FAILED",
  "PAYMENT_PROVIDER_FAILED",
  "PAYMENT_INITIALIZING",
  "PAYMENT_TOKEN_INVALID",
  "PAYMENT_TOKEN_USED",
  "INVOICE_NOT_ALLOWED"
] as const;
export type CommerceErrorCode = (typeof commerceErrorCodes)[number];

export class CommerceError extends Error {
  readonly code: CommerceErrorCode;

  constructor(code: CommerceErrorCode) {
    super(code);
    this.name = "CommerceError";
    this.code = code;
  }
}
