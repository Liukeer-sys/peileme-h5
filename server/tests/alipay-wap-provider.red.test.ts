import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

type AlipaySdkPort = {
  pageExecute: ReturnType<typeof vi.fn>;
  curl: ReturnType<typeof vi.fn>;
  checkNotifySignV2: ReturnType<typeof vi.fn>;
};

const providerOrderNo = "PLMA20260731ABCDEF1234567890";

const createSdk = (): AlipaySdkPort => ({
  pageExecute: vi.fn(),
  curl: vi.fn(),
  checkNotifySignV2: vi.fn()
});

const loadProvider = async (sdk: AlipaySdkPort) => {
  const moduleUrl = pathToFileURL(
    path.resolve("server/modules/payments/alipay-wap.ts")
  ).href;
  const providerModule = await import(/* @vite-ignore */ moduleUrl);
  return new providerModule.AlipayWapProvider({
    appId: "2026000000000000",
    sellerId: "2088000000000000",
    sdk,
    clock: () => new Date("2026-07-31T12:00:00.000Z")
  });
};

const createInput = (amountFen = "1990") => ({
  attemptId: "11111111-1111-4111-8111-111111111111",
  orderNo: "PLM-LOCAL-ORDER-1",
  providerOrderNo,
  description: "政策测算服务",
  amountFen,
  clientIp: "203.0.113.8",
  returnUrl: "https://peileme.art/account/orders/order-id?payment_return=1",
  notifyUrl: "https://peileme.art/api/payments/alipay_wap/notify",
  expiresAt: "2026-07-31T12:20:00.000Z",
  signal: new AbortController().signal
});

describe("Task 4 Alipay WAP provider protocol (RED)", () => {
  it.each([
    ["1", "0.01"],
    ["10", "0.10"],
    ["1990", "19.90"],
    ["10000000000", "100000000.00"]
  ])(
    "creates a WAP payment with exact decimal conversion %s fen -> %s yuan",
    async (amountFen, amountYuan) => {
      const sdk = createSdk();
      sdk.pageExecute.mockReturnValue(
        "https://openapi.alipay.com/gateway.do?method=alipay.trade.wap.pay&sign=test"
      );
      const provider = await loadProvider(sdk);

      const created = await provider.createPayment(createInput(amountFen));

      expect(sdk.pageExecute).toHaveBeenCalledWith(
        "alipay.trade.wap.pay",
        "GET",
        {
          bizContent: {
            out_trade_no: providerOrderNo,
            product_code: "QUICK_WAP_WAY",
            subject: "政策测算服务",
            total_amount: amountYuan,
            quit_url:
              "https://peileme.art/account/orders/order-id?payment_return=1",
            time_expire: "2026-07-31 20:20:00"
          },
          returnUrl:
            "https://peileme.art/account/orders/order-id?payment_return=1",
          notifyUrl:
            "https://peileme.art/api/payments/alipay_wap/notify"
        }
      );
      expect(created).toMatchObject({
        launchUrl:
          "https://openapi.alipay.com/gateway.do?method=alipay.trade.wap.pay&sign=test",
        launchExpiresAt: "2026-07-31T12:20:00.000Z"
      });
    }
  );

  it.each(["0", "-1", "1.5", "10000000001"])(
    "rejects invalid or over-limit amount %s fen before invoking the SDK",
    async (amountFen) => {
      const sdk = createSdk();
      const provider = await loadProvider(sdk);

      await expect(
        provider.createPayment(createInput(amountFen))
      ).rejects.toMatchObject({ code: "INVALID_PAYMENT_AMOUNT" });
      expect(sdk.pageExecute).not.toHaveBeenCalled();
    }
  );

  it("uses official SDK query and maps a successful provider order", async () => {
    const sdk = createSdk();
    sdk.curl.mockResolvedValue({
      responseHttpStatus: 200,
      traceId: "trace-query-1",
      data: {
        trade_no: "2026073122000000000000000001",
        out_trade_no: providerOrderNo,
        trade_status: "TRADE_SUCCESS",
        total_amount: "19.90",
        send_pay_date: "2026-07-31 20:05:00"
      }
    });
    const provider = await loadProvider(sdk);

    const result = await provider.queryPayment({
      providerOrderNo,
      signal: new AbortController().signal
    });

    expect(sdk.curl).toHaveBeenCalledWith(
      "POST",
      "/v3/alipay/trade/query",
      expect.objectContaining({
        body: { out_trade_no: providerOrderNo }
      })
    );
    expect(result).toEqual({
      state: "SUCCEEDED",
      payment: expect.objectContaining({
        channel: "alipay_wap",
        providerOrderNo,
        channelTransactionId: "2026073122000000000000000001",
        amountFen: "1990",
        currency: "CNY",
        paidAt: "2026-07-31T12:05:00.000Z"
      })
    });
  });

  it.each([
    {
      responseHttpStatus: 404,
      data: { code: "ACQ.TRADE_NOT_EXIST" },
      expected: { state: "NOT_FOUND" }
    },
    {
      responseHttpStatus: 500,
      data: { code: "SYSTEM_ERROR" },
      expected: { state: "UNKNOWN", providerCode: "SYSTEM_ERROR" }
    }
  ])(
    "maps non-success query responses without releasing an unknown payment lock",
    async ({ responseHttpStatus, data, expected }) => {
      const sdk = createSdk();
      sdk.curl.mockResolvedValue({
        responseHttpStatus,
        traceId: "trace-query-state",
        data
      });
      const provider = await loadProvider(sdk);

      await expect(
        provider.queryPayment({
          providerOrderNo,
          signal: new AbortController().signal
        })
      ).resolves.toEqual(expected);
    }
  );

  it("uses official SDK close and refund calls with stable merchant numbers", async () => {
    const sdk = createSdk();
    sdk.curl
      .mockResolvedValueOnce({
        responseHttpStatus: 200,
        traceId: "trace-close-1",
        data: { out_trade_no: providerOrderNo }
      })
      .mockResolvedValueOnce({
        responseHttpStatus: 200,
        traceId: "trace-refund-1",
        data: {
          trade_no: "2026073122000000000000000001",
          out_trade_no: providerOrderNo,
          out_request_no: "PLMR20260731ABCDEF1234567890",
          refund_fee: "19.90",
          fund_change: "Y"
        }
      });
    const provider = await loadProvider(sdk);

    await provider.closePayment({
      providerOrderNo,
      signal: new AbortController().signal
    });
    const refunded = await provider.refund({
      providerOrderNo,
      providerRefundNo: "PLMR20260731ABCDEF1234567890",
      amountFen: "1990",
      totalFen: "1990",
      reason: "重复付款自动退款",
      notifyUrl: "https://peileme.art/api/payments/alipay_wap/notify",
      signal: new AbortController().signal
    });

    expect(sdk.curl.mock.calls).toEqual([
      [
        "POST",
        "/v3/alipay/trade/close",
        expect.objectContaining({
          body: { out_trade_no: providerOrderNo }
        })
      ],
      [
        "POST",
        "/v3/alipay/trade/refund",
        expect.objectContaining({
          body: {
            out_trade_no: providerOrderNo,
            out_request_no: "PLMR20260731ABCDEF1234567890",
            refund_amount: "19.90",
            refund_reason: "重复付款自动退款"
          }
        })
      ]
    ]);
    expect(refunded).toMatchObject({
      state: "SUCCEEDED",
      providerRefundNo: "PLMR20260731ABCDEF1234567890"
    });
  });

  it.each(["N", undefined])(
    "keeps an Alipay refund UNKNOWN when fund_change is %s",
    async (fundChange) => {
      const sdk = createSdk();
      sdk.curl.mockResolvedValue({
        responseHttpStatus: 200,
        traceId: "trace-refund-unknown",
        data: {
          trade_no: "2026073122000000000000000001",
          out_trade_no: providerOrderNo,
          out_request_no: "PLMR20260731ABCDEF1234567890",
          refund_fee: "19.90",
          ...(fundChange === undefined
            ? {}
            : { fund_change: fundChange })
        }
      });
      const provider = await loadProvider(sdk);

      const result = await provider.refund({
        providerOrderNo,
        providerRefundNo: "PLMR20260731ABCDEF1234567890",
        amountFen: "1990",
        totalFen: "1990",
        reason: "重复付款自动退款",
        notifyUrl: "https://peileme.art/api/payments/alipay_wap/notify",
        signal: new AbortController().signal
      });

      expect(result).toMatchObject({
        state: "UNKNOWN",
        providerRefundNo: "PLMR20260731ABCDEF1234567890"
      });
    }
  );

  it("recovers an uncertain Alipay refund with fastpay.refund.query", async () => {
    const sdk = createSdk();
    sdk.curl.mockResolvedValue({
      responseHttpStatus: 200,
      traceId: "trace-refund-query-1",
      data: {
        out_trade_no: providerOrderNo,
        out_request_no: "PLMR20260731ABCDEF1234567890",
        refund_amount: "19.90",
        refund_status: "REFUND_SUCCESS"
      }
    });
    const provider = await loadProvider(sdk);

    const result = await provider.queryRefund({
      providerOrderNo,
      providerRefundNo: "PLMR20260731ABCDEF1234567890",
      signal: new AbortController().signal
    });

    expect(sdk.curl).toHaveBeenCalledWith(
      "POST",
      "/v3/alipay/trade/fastpay/refund/query",
      expect.objectContaining({
        body: {
          out_trade_no: providerOrderNo,
          out_request_no: "PLMR20260731ABCDEF1234567890"
        }
      })
    );
    expect(result).toMatchObject({
      state: "SUCCEEDED",
      providerRefundNo: "PLMR20260731ABCDEF1234567890",
      amountFen: "1990"
    });
  });

  it("verifies an Alipay form notification and validates merchant identity", async () => {
    const sdk = createSdk();
    sdk.checkNotifySignV2.mockReturnValue(true);
    const provider = await loadProvider(sdk);
    const rawBody = Buffer.from(
      new URLSearchParams({
        notify_id: "2026073100222000000000000001",
        notify_type: "trade_status_sync",
        app_id: "2026000000000000",
        seller_id: "2088000000000000",
        out_trade_no: providerOrderNo,
        trade_no: "2026073122000000000000000001",
        trade_status: "TRADE_SUCCESS",
        total_amount: "19.90",
        gmt_payment: "2026-07-31 20:05:00",
        sign_type: "RSA2",
        sign: "test-signature"
      }).toString()
    );

    const verified = await provider.verifyNotification({
      rawBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });

    expect(sdk.checkNotifySignV2).toHaveBeenCalledOnce();
    expect(verified).toMatchObject({
      providerEventId: "2026073100222000000000000001",
      eventType: "PAYMENT_SUCCEEDED",
      payment: {
        channel: "alipay_wap",
        providerOrderNo,
        channelTransactionId: "2026073122000000000000000001",
        amountFen: "1990",
        currency: "CNY",
        paidAt: "2026-07-31T12:05:00.000Z"
      }
    });
  });

  it("rejects duplicate form keys before signature verification", async () => {
    const duplicateSdk = createSdk();
    duplicateSdk.checkNotifySignV2.mockReturnValue(true);
    const duplicateProvider = await loadProvider(duplicateSdk);
    await expect(
      duplicateProvider.verifyNotification({
        rawBody: Buffer.from(
          `out_trade_no=${providerOrderNo}&out_trade_no=OTHER&sign=x&sign_type=RSA2`
        ),
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        }
      })
    ).rejects.toMatchObject({
      code: "PAYMENT_NOTIFICATION_MALFORMED"
    });
    expect(duplicateSdk.checkNotifySignV2).not.toHaveBeenCalled();
  });

  it("returns cryptographically verified merchant fields for durable business validation", async () => {
    const merchantSdk = createSdk();
    merchantSdk.checkNotifySignV2.mockReturnValue(true);
    const merchantProvider = await loadProvider(merchantSdk);
    const verified = await merchantProvider.verifyNotification({
        rawBody: Buffer.from(
          new URLSearchParams({
            notify_id: "bad-merchant-event",
            app_id: "2026000000000000",
            seller_id: "2088999999999999",
            out_trade_no: providerOrderNo,
            trade_no: "2026073122000000000000000001",
            trade_status: "TRADE_SUCCESS",
            total_amount: "19.90",
            gmt_payment: "2026-07-31 20:05:00",
            sign_type: "RSA2",
            sign: "test-signature"
          }).toString()
        ),
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        }
    });

    expect(verified).toMatchObject({
      cryptographicallyVerified: true,
      merchant: {
        appId: "2026000000000000",
        sellerId: "2088999999999999"
      },
      providerEventId: "bad-merchant-event"
    });
  });
});
