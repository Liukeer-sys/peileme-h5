import type { AppConfig } from "../../config.js";
import {
  isRealPaymentChannel,
  type RealPaymentChannel,
  type RealPaymentProvider
} from "./provider.js";

type PaymentRegistryConfig = Pick<
  AppConfig,
  "PAYMENT_MODE" | "PAYMENT_PROVIDERS"
>;

type PaymentProviderFactory = () => RealPaymentProvider;

export type PaymentProviderRegistryDependencies = {
  wechatFactory?: PaymentProviderFactory;
  alipayFactory?: PaymentProviderFactory;
};

const providerLabels: Readonly<Record<RealPaymentChannel, string>> = {
  wechat_h5: "微信支付",
  alipay_wap: "支付宝"
};

const unavailable = () => new Error("PAYMENT_PROVIDER_UNAVAILABLE");

export const createPaymentProviderRegistry = (
  config: PaymentRegistryConfig,
  dependencies: PaymentProviderRegistryDependencies
) => {
  if (config.PAYMENT_MODE === "fake") {
    throw new Error("PAYMENT_MODE=fake is forbidden");
  }

  const providers = new Map<RealPaymentChannel, RealPaymentProvider>();
  if (config.PAYMENT_MODE === "live") {
    if (!config.PAYMENT_PROVIDERS.length) {
      throw new Error("PAYMENT_PROVIDERS must configure at least one provider");
    }
    for (const channel of config.PAYMENT_PROVIDERS) {
      if (!isRealPaymentChannel(channel) || providers.has(channel)) {
        throw new Error(`PAYMENT_PROVIDERS contains invalid channel ${channel}`);
      }
      const factory =
        channel === "wechat_h5"
          ? dependencies.wechatFactory
          : dependencies.alipayFactory;
      if (!factory) {
        throw new Error(`${channel} provider factory is not configured`);
      }
      const provider = factory();
      if (!provider || provider.channel !== channel) {
        throw new Error(`${channel} provider factory is not configured`);
      }
      providers.set(channel, provider);
    }
  }

  const listAvailable = () =>
    [...providers.keys()].map((channel) =>
      Object.freeze({ channel, label: providerLabels[channel] })
    );

  return Object.freeze({
    listAvailable,
    require(channel: RealPaymentChannel) {
      const provider = providers.get(channel);
      if (!provider) throw unavailable();
      return provider;
    }
  });
};
