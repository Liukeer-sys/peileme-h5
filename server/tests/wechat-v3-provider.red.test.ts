import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type TransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

type TransportResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const merchantKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const platformKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const merchantPrivateKey = merchantKeys.privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();
const merchantPublicKey = merchantKeys.publicKey.export({
  type: "spki",
  format: "pem"
}).toString();
const platformPrivateKey = platformKeys.privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();
const platformPublicKey = platformKeys.publicKey.export({
  type: "spki",
  format: "pem"
}).toString();

const platformSerial = "PUB_KEY_ID_3000000001";
const apiV3Key = "0123456789abcdef0123456789abcdef";
const now = new Date("2026-07-31T12:00:00.000Z");
const providerOrderNo = "PLMW20260731ABCDEF1234567890";

const getHeader = (headers: Record<string, string>, name: string) => {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return entry?.[1];
};

const signedWechatResponse = (
  body: string,
  status = 200
): TransportResponse => {
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const nonce = "provider-response-nonce";
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
    platformPrivateKey
  ).toString("base64");
  return {
    status,
    headers: {
      "Wechatpay-Serial": platformSerial,
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Signature": signature
    },
    body
  };
};

const loadProvider = async (
  responder: (request: TransportRequest) => Promise<TransportResponse>
) => {
  const moduleUrl = pathToFileURL(
    path.resolve("server/modules/payments/wechat-v3.ts")
  ).href;
  const providerModule = await import(/* @vite-ignore */ moduleUrl);
  return new providerModule.WeChatPayV3Provider({
    appId: "wx-test-app-id",
    mchId: "1900000001",
    merchantSerialNo: "MERCHANT-SERIAL-001",
    merchantPrivateKey,
    apiV3Key,
    platformPublicKeys: {
      [platformSerial]: platformPublicKey
    },
    h5AppName: "赔了么",
    h5AppUrl: "https://peileme.art",
    clock: () => now,
    nonce: () => "merchant-request-nonce",
    transport: { request: responder }
  });
};

const createInput = () => ({
  attemptId: "11111111-1111-4111-8111-111111111111",
  orderNo: "PLM-LOCAL-ORDER-1",
  providerOrderNo,
  description: "政策测算服务",
  amountFen: "1990",
  clientIp: "203.0.113.8",
  returnUrl: "https://peileme.art/account/orders/order-id?payment_return=1",
  notifyUrl: "https://peileme.art/api/payments/wechat_h5/notify",
  expiresAt: "2026-07-31T12:20:00.000Z",
  signal: new AbortController().signal
});

describe("Task 4 WeChat APIv3 H5 provider protocol (RED)", () => {
  it("signs the exact H5 request and uses the per-attempt provider order number", async () => {
    let observed: TransportRequest | undefined;
    const provider = await loadProvider(async (request) => {
      observed = request;
      return signedWechatResponse(
        JSON.stringify({
          h5_url:
            "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx-test"
        })
      );
    });

    const created = await provider.createPayment(createInput());

    expect(observed?.method).toBe("POST");
    expect(observed?.url).toBe(
      "https://api.mch.weixin.qq.com/v3/pay/transactions/h5"
    );
    const body = JSON.parse(observed!.body);
    expect(body).toMatchObject({
      appid: "wx-test-app-id",
      mchid: "1900000001",
      out_trade_no: providerOrderNo,
      description: "政策测算服务",
      notify_url: "https://peileme.art/api/payments/wechat_h5/notify",
      amount: { total: 1990, currency: "CNY" },
      scene_info: {
        payer_client_ip: "203.0.113.8",
        h5_info: {
          type: "Wap",
          app_name: "赔了么",
          app_url: "https://peileme.art"
        }
      }
    });
    expect(body.time_expire).toBe("2026-07-31T12:20:00Z");

    const authorization = getHeader(observed!.headers, "authorization");
    expect(authorization).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
    const fields = Object.fromEntries(
      [...authorization!.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [
        match[1],
        match[2]
      ])
    );
    const canonicalUrl = new URL(observed!.url);
    const message = [
      "POST",
      `${canonicalUrl.pathname}${canonicalUrl.search}`,
      fields.timestamp,
      fields.nonce_str,
      observed!.body,
      ""
    ].join("\n");
    expect(
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(message),
        merchantPublicKey,
        Buffer.from(fields.signature, "base64")
      )
    ).toBe(true);
    expect(fields).toMatchObject({
      mchid: "1900000001",
      serial_no: "MERCHANT-SERIAL-001",
      nonce_str: "merchant-request-nonce"
    });
    expect(created.launchUrl).toBe(
      "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx-test" +
        `&redirect_url=${encodeURIComponent(createInput().returnUrl)}`
    );
    expect(created.launchExpiresAt).toBe("2026-07-31T12:05:00.000Z");
  });

  it.each([
    {
      label: "NOT_FOUND",
      response: signedWechatResponse(
        JSON.stringify({ code: "ORDER_NOT_EXIST", message: "订单不存在" }),
        404
      ),
      expected: { state: "NOT_FOUND" }
    },
    {
      label: "UNKNOWN",
      response: signedWechatResponse(
        JSON.stringify({ code: "SYSTEM_ERROR", message: "系统错误" }),
        500
      ),
      expected: { state: "UNKNOWN", providerCode: "SYSTEM_ERROR" }
    },
    {
      label: "REFUND with original payment evidence",
      response: signedWechatResponse(
        JSON.stringify({
          appid: "wx-test-app-id",
          mchid: "1900000001",
          out_trade_no: providerOrderNo,
          transaction_id: "4200000000202607310000000001",
          trade_type: "MWEB",
          trade_state: "REFUND",
          success_time: "2026-07-31T20:05:00+08:00",
          amount: { total: 1990, currency: "CNY" }
        })
      ),
      expected: {
        state: "REFUND",
        payment: expect.objectContaining({
          channel: "wechat_h5",
          providerOrderNo,
          channelTransactionId: "4200000000202607310000000001",
          amountFen: "1990",
          currency: "CNY",
          paidAt: "2026-07-31T12:05:00.000Z"
        })
      }
    }
  ])("maps provider query state $label explicitly", async ({ response, expected }) => {
    const provider = await loadProvider(async () => response);

    const result = await provider.queryPayment({
      providerOrderNo,
      signal: new AbortController().signal
    });

    expect(result).toEqual(expected);
  });

  it.each(["unsigned", "tampered"])(
    "keeps an %s 404 response UNKNOWN and never releases the payment lock",
    async (signatureCase) => {
      const body = JSON.stringify({
        code: "ORDER_NOT_EXIST",
        message: "订单不存在"
      });
      const response = signedWechatResponse(body, 404);
      if (signatureCase === "unsigned") {
        response.headers = {};
      } else {
        response.headers["Wechatpay-Signature"] = Buffer.from(
          "tampered-signature"
        ).toString("base64");
      }
      const provider = await loadProvider(async () => response);

      await expect(
        provider.queryPayment({
          providerOrderNo,
          signal: new AbortController().signal
        })
      ).resolves.toEqual({
        state: "UNKNOWN",
        providerCode: "UNVERIFIED_PROVIDER_RESPONSE"
      });
    }
  );

  it("rejects an unverified raw provider response before parsing it", async () => {
    const body = JSON.stringify({
      h5_url:
        "https://attacker.invalid/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=forged"
    });
    const response = signedWechatResponse(body);
    response.headers["Wechatpay-Signature"] = Buffer.from(
      "forged-signature"
    ).toString("base64");
    const provider = await loadProvider(async () => response);

    await expect(
      provider.createPayment(createInput())
    ).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_RESPONSE_SIGNATURE_INVALID",
      state: "CREATE_UNKNOWN"
    });
  });

  it("queries and maps a successful provider order without using the local order number", async () => {
    const provider = await loadProvider(async (request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe(
        `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/${providerOrderNo}?mchid=1900000001`
      );
      return signedWechatResponse(
        JSON.stringify({
          appid: "wx-test-app-id",
          mchid: "1900000001",
          out_trade_no: providerOrderNo,
          transaction_id: "4200000000202607310000000001",
          trade_type: "MWEB",
          trade_state: "SUCCESS",
          success_time: "2026-07-31T20:05:00+08:00",
          amount: { total: 1990, currency: "CNY" }
        })
      );
    });

    const result = await provider.queryPayment({
      providerOrderNo,
      signal: new AbortController().signal
    });

    expect(result).toEqual({
      state: "SUCCEEDED",
      payment: expect.objectContaining({
        channel: "wechat_h5",
        providerOrderNo,
        channelTransactionId: "4200000000202607310000000001",
        amountFen: "1990",
        currency: "CNY",
        paidAt: "2026-07-31T12:05:00.000Z"
      })
    });
  });

  it("calls the official close and refund endpoints with stable merchant numbers", async () => {
    const requests: TransportRequest[] = [];
    const provider = await loadProvider(async (request) => {
      requests.push(request);
      if (request.url.endsWith("/close")) {
        return signedWechatResponse("", 204);
      }
      return signedWechatResponse(
        JSON.stringify({
          refund_id: "5030000000202607310000000001",
          out_refund_no: "PLMR20260731ABCDEF1234567890",
          out_trade_no: providerOrderNo,
          status: "PROCESSING",
          amount: {
            refund: 1990,
            total: 1990,
            currency: "CNY"
          }
        })
      );
    });

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
      notifyUrl: "https://peileme.art/api/payments/wechat_h5/notify",
      signal: new AbortController().signal
    });

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: "POST",
        url:
          `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/${providerOrderNo}/close`
      },
      {
        method: "POST",
        url: "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds"
      }
    ]);
    expect(JSON.parse(requests[0].body)).toEqual({ mchid: "1900000001" });
    expect(JSON.parse(requests[1].body)).toMatchObject({
      out_trade_no: providerOrderNo,
      out_refund_no: "PLMR20260731ABCDEF1234567890",
      reason: "重复付款自动退款",
      notify_url: "https://peileme.art/api/payments/wechat_h5/notify",
      amount: { refund: 1990, total: 1990, currency: "CNY" }
    });
    expect(refunded).toMatchObject({
      state: "PROCESSING",
      providerRefundNo: "PLMR20260731ABCDEF1234567890",
      channelRefundId: "5030000000202607310000000001"
    });
  });

  it("verifies the raw notification before AES-256-GCM decryption", async () => {
    const provider = await loadProvider(async () => {
      throw new Error("notification verification must not use the network");
    });
    const plaintext = JSON.stringify({
      appid: "wx-test-app-id",
      mchid: "1900000001",
      out_trade_no: providerOrderNo,
      transaction_id: "4200000000202607310000000001",
      trade_state: "SUCCESS",
      trade_type: "MWEB",
      success_time: "2026-07-31T20:05:00+08:00",
      amount: { total: 1990, currency: "CNY" }
    });
    const notificationNonce = "abcdefghijkl";
    const associatedData = "transaction";
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(apiV3Key),
      Buffer.from(notificationNonce)
    );
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag()
    ]).toString("base64");
    const rawBody = JSON.stringify({
      id: "EV-20260731-0001",
      create_time: "2026-07-31T20:05:01+08:00",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      summary: "支付成功",
      resource: {
        original_type: "transaction",
        algorithm: "AEAD_AES_256_GCM",
        ciphertext,
        associated_data: associatedData,
        nonce: notificationNonce
      }
    });
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const nonce = "notification-signature-nonce";
    const signature = crypto.sign(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`),
      platformPrivateKey
    ).toString("base64");

    const verified = await provider.verifyNotification({
      rawBody: Buffer.from(rawBody),
      headers: {
        "wechatpay-serial": platformSerial,
        "wechatpay-timestamp": timestamp,
        "wechatpay-nonce": nonce,
        "wechatpay-signature": signature
      }
    });

    expect(verified).toMatchObject({
      providerEventId: "EV-20260731-0001",
      eventType: "PAYMENT_SUCCEEDED",
      payment: {
        channel: "wechat_h5",
        providerOrderNo,
        channelTransactionId: "4200000000202607310000000001",
        amountFen: "1990",
        currency: "CNY",
        paidAt: "2026-07-31T12:05:00.000Z"
      }
    });
  });

  it("rejects a tampered or signature-probe notification before business parsing", async () => {
    const provider = await loadProvider(async () => {
      throw new Error("notification verification must not use the network");
    });
    const rawBody = Buffer.from('{"id":"tampered"}');
    const headers = {
      "wechatpay-serial": platformSerial,
      "wechatpay-timestamp": Math.floor(now.getTime() / 1_000).toString(),
      "wechatpay-nonce": "notification-signature-nonce",
      "wechatpay-signature": "WECHATPAY/SIGNTEST/not-a-valid-signature"
    };

    await expect(
      provider.verifyNotification({ rawBody, headers })
    ).rejects.toMatchObject({
      code: "PAYMENT_NOTIFICATION_SIGNATURE_INVALID"
    });
  });
});
