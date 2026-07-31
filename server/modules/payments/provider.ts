import type { Currency, PaymentChannel } from "../commerce/types.js";

export type CreatePaymentInput = {
  attemptId: string;
  orderNo: string;
  description: string;
  amountFen: string;
  clientIp: string;
  returnUrl: string;
  notifyUrl: string;
  signal: AbortSignal;
};

export type CreatedPayment = {
  prepayId?: string;
  launchUrl: string;
  response: Record<string, unknown>;
};

export type VerifiedPayment = {
  orderNo: string;
  channel: PaymentChannel;
  channelTransactionId: string;
  amountFen: string;
  currency: Currency;
  paidAt: string;
  raw: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly channel: PaymentChannel;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  queryPayment(
    orderNo: string,
    signal: AbortSignal
  ): Promise<VerifiedPayment | null>;
  refund(input: {
    orderNo: string;
    refundNo: string;
    amountFen: string;
    totalFen: string;
    reason: string;
  }): Promise<{
    channelRefundId: string;
    raw: Record<string, unknown>;
  }>;
}
