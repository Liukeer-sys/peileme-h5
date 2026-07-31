import crypto from "node:crypto";
import { CommerceError } from "../commerce/types.js";
import type {
  CreatePaymentInput,
  CreatedPayment,
  PaymentProvider,
  VerifiedPayment
} from "./provider.js";

type PendingFakePayment = {
  input: CreatePaymentInput;
  transactionId: string;
};

export class FakePaymentProvider implements PaymentProvider {
  readonly channel = "fake" as const;
  private readonly secret = crypto.randomBytes(32);
  private readonly pending = new Map<string, PendingFakePayment>();
  private readonly completed = new Map<string, VerifiedPayment>();
  private readonly processing = new Map<string, VerifiedPayment>();
  private readonly used = new Set<string>();

  constructor(environment: string) {
    if (environment !== "test") {
      throw new Error("Fake payment provider is available only in test");
    }
  }

  private sign(payload: string) {
    return crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const nonce = crypto.randomBytes(24).toString("base64url");
    const payload = `${input.attemptId}.${input.orderNo}.${nonce}`;
    const token = `${nonce}.${this.sign(payload)}`;
    this.pending.set(token, {
      input,
      transactionId: `fake-${crypto.randomUUID()}`
    });
    return {
      prepayId: `fake-prepay-${input.attemptId}`,
      launchUrl:
        `/api/test-payments/${encodeURIComponent(input.orderNo)}/complete` +
        `?token=${encodeURIComponent(token)}`,
      response: {
        provider: "fake",
        attemptId: input.attemptId
      }
    };
  }

  beginCompletion(orderNo: string, token: string): VerifiedPayment {
    if (this.used.has(token) || this.processing.has(token)) {
      throw new CommerceError("PAYMENT_TOKEN_USED");
    }
    const pending = this.pending.get(token);
    if (!pending) {
      throw new CommerceError("PAYMENT_TOKEN_INVALID");
    }
    const [nonce, signature, extra] = token.split(".");
    const expected = this.sign(
      `${pending.input.attemptId}.${pending.input.orderNo}.${nonce}`
    );
    const signatureBytes = Buffer.from(signature || "");
    const expectedBytes = Buffer.from(expected);
    if (
      extra !== undefined ||
      pending.input.orderNo !== orderNo ||
      signatureBytes.length !== expectedBytes.length ||
      !crypto.timingSafeEqual(signatureBytes, expectedBytes)
    ) {
      throw new CommerceError("PAYMENT_TOKEN_INVALID");
    }

    const verified: VerifiedPayment = {
      orderNo: pending.input.orderNo,
      channel: "fake",
      channelTransactionId: pending.transactionId,
      amountFen: pending.input.amountFen,
      currency: "CNY",
      paidAt: new Date().toISOString(),
      raw: {
        provider: "fake",
        attemptId: pending.input.attemptId
      }
    };
    this.processing.set(token, verified);
    return verified;
  }

  commitCompletion(token: string) {
    const verified = this.processing.get(token);
    if (!verified) {
      throw new CommerceError("PAYMENT_TOKEN_INVALID");
    }
    this.processing.delete(token);
    this.pending.delete(token);
    this.used.add(token);
    this.completed.set(verified.orderNo, verified);
  }

  rollbackCompletion(token: string) {
    this.processing.delete(token);
  }

  complete(orderNo: string, token: string): VerifiedPayment {
    const verified = this.beginCompletion(orderNo, token);
    this.commitCompletion(token);
    return verified;
  }

  async queryPayment(orderNo: string) {
    return this.completed.get(orderNo) ?? null;
  }

  async refund(input: {
    orderNo: string;
    refundNo: string;
    amountFen: string;
    totalFen: string;
    reason: string;
  }) {
    return {
      channelRefundId: `fake-refund-${input.refundNo}`,
      raw: {
        provider: "fake",
        orderNo: input.orderNo,
        amountFen: input.amountFen
      }
    };
  }
}
