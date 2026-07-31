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
const providerMethodNames = [
  "createPayment",
  "queryPayment",
  "refund"
] as const;

const factoryForChannel = (
  channel: RealPaymentChannel,
  dependencies: PaymentProviderRegistryDependencies
) =>
  channel === "wechat_h5"
    ? dependencies.wechatFactory
    : dependencies.alipayFactory;

const assertProviderContract = (
  channel: RealPaymentChannel,
  provider: RealPaymentProvider | undefined
) => {
  if (
    !provider ||
    provider.channel !== channel ||
    providerMethodNames.some(
      (methodName) => typeof provider[methodName] !== "function"
    )
  ) {
    throw new Error(`${channel} provider does not satisfy the runtime contract`);
  }
};

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
    const channels = [...config.PAYMENT_PROVIDERS];
    const seenChannels = new Set<RealPaymentChannel>();
    for (const channel of channels) {
      if (!isRealPaymentChannel(channel) || seenChannels.has(channel)) {
        throw new Error(`PAYMENT_PROVIDERS contains invalid channel ${channel}`);
      }
      const factory = factoryForChannel(channel, dependencies);
      if (!factory) {
        throw new Error(`${channel} provider factory is not configured`);
      }
      seenChannels.add(channel);
    }
    for (const channel of channels) {
      const factory = factoryForChannel(channel, dependencies)!;
      const provider = factory();
      assertProviderContract(channel, provider);
      providers.set(channel, provider);
    }
  }

  const availableProviders = Object.freeze(
    [...providers.keys()].map((channel) =>
      Object.freeze({ channel, label: providerLabels[channel] })
    )
  );

  const listAvailable = () => availableProviders;

  return Object.freeze({
    listAvailable,
    require(channel: RealPaymentChannel) {
      const provider = providers.get(channel);
      if (!provider) throw unavailable();
      return provider;
    }
  });
};
