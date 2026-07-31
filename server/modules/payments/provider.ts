import type { Currency, PaymentChannel } from "../commerce/types.js";

export const realPaymentChannels = ["wechat_h5", "alipay_wap"] as const;
export type RealPaymentChannel = (typeof realPaymentChannels)[number];

/** Channels persisted before the live-provider cutover remain readable. */
export type PersistedPaymentChannel = PaymentChannel;

export const isRealPaymentChannel = (
  channel: string
): channel is RealPaymentChannel =>
  (realPaymentChannels as readonly string[]).includes(channel);

export type CreatePaymentInput = {
  attemptId: string;
  orderNo: string;
  providerOrderNo: string;
  description: string;
  amountFen: string;
  clientIp: string;
  returnUrl: string;
  notifyUrl: string;
  expiresAt: string;
  signal: AbortSignal;
};

export type CreatedPayment = {
  prepayId?: string;
  launchUrl: string;
  launchExpiresAt?: string;
  response: Record<string, unknown>;
};

export type VerifiedPayment = {
  providerOrderNo: string;
  channel: PaymentChannel;
  channelTransactionId: string;
  amountFen: string;
  currency: Currency;
  paidAt: string;
  raw: Record<string, unknown>;
};

export interface PaymentProvider<
  Channel extends PaymentChannel = PaymentChannel
> {
  readonly channel: Channel;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  queryPayment(
    providerOrderNo: string,
    signal: AbortSignal
  ): Promise<VerifiedPayment | null>;
  refund(input: {
    providerOrderNo: string;
    refundNo: string;
    amountFen: string;
    totalFen: string;
    reason: string;
  }): Promise<{
    channelRefundId: string;
    raw: Record<string, unknown>;
  }>;
}

export type RealPaymentProvider = PaymentProvider<RealPaymentChannel>;
