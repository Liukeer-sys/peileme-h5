import AliyunCore from "@alicloud/pop-core";
import nodemailer from "nodemailer";
import { getConfig } from "./config.js";
import { ApiError } from "./errors.js";

type OtpDelivery = {
  provider: "debug" | "smtp" | "aliyun-directmail" | "aliyun-sms";
  messageId?: string;
};

export const getChannelStatus = () => {
  const config = getConfig();
  const smtpConfigured = Boolean(
    config.SMTP_HOST &&
      config.SMTP_USER &&
      config.SMTP_PASSWORD &&
      config.SMTP_FROM
  );
  const aliyunDirectMailConfigured = Boolean(
    config.ALIYUN_DM_ACCESS_KEY_ID &&
      config.ALIYUN_DM_ACCESS_KEY_SECRET &&
      config.ALIYUN_DM_ACCOUNT_NAME
  );
  return {
    email: {
      configured: smtpConfigured || aliyunDirectMailConfigured,
      provider: aliyunDirectMailConfigured ? "阿里云邮件推送" : "SMTP"
    },
    sms: {
      configured: Boolean(
        config.ALIYUN_SMS_ACCESS_KEY_ID &&
          config.ALIYUN_SMS_ACCESS_KEY_SECRET &&
          config.ALIYUN_SMS_SIGN_NAME &&
          config.ALIYUN_SMS_TEMPLATE_CODE
      ),
      provider: "阿里云短信"
    },
    debug: config.OTP_DEBUG
  };
};

const deliverEmail = async (target: string, code: string): Promise<OtpDelivery> => {
  const config = getConfig();
  if (!getChannelStatus().email.configured) {
    throw new ApiError(503, "EMAIL_CHANNEL_NOT_CONFIGURED", "邮箱验证码渠道尚未配置");
  }
  const subject = "赔了么验证码";
  const text = `你的验证码是 ${code}，${config.OTP_TTL_MINUTES} 分钟内有效。请勿转发给他人。`;
  const html = `<div style="font-family:sans-serif;line-height:1.7"><h2>赔了么验证码</h2><p>你的验证码是：</p><p style="font-size:30px;font-weight:800;letter-spacing:8px">${code}</p><p>${config.OTP_TTL_MINUTES} 分钟内有效，请勿转发给他人。</p></div>`;
  if (
    config.ALIYUN_DM_ACCESS_KEY_ID &&
    config.ALIYUN_DM_ACCESS_KEY_SECRET &&
    config.ALIYUN_DM_ACCOUNT_NAME
  ) {
    const client = new AliyunCore({
      accessKeyId: config.ALIYUN_DM_ACCESS_KEY_ID,
      accessKeySecret: config.ALIYUN_DM_ACCESS_KEY_SECRET,
      endpoint: "https://dm.aliyuncs.com",
      apiVersion: "2015-11-23"
    });
    const result = (await client.request(
      "SingleSendMail",
      {
        AccountName: config.ALIYUN_DM_ACCOUNT_NAME,
        AddressType: 1,
        ReplyToAddress: false,
        ToAddress: target,
        Subject: subject,
        TextBody: text,
        HtmlBody: html
      },
      { method: "POST" }
    )) as { RequestId?: string; EnvId?: string };
    return {
      provider: "aliyun-directmail",
      messageId: result.EnvId || result.RequestId
    };
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASSWORD
    }
  });
  const result = await transport.sendMail({
    from: config.SMTP_FROM,
    to: target,
    subject,
    text,
    html
  });
  return { provider: "smtp", messageId: result.messageId };
};

const deliverSms = async (target: string, code: string): Promise<OtpDelivery> => {
  const config = getConfig();
  if (!getChannelStatus().sms.configured) {
    throw new ApiError(503, "SMS_CHANNEL_NOT_CONFIGURED", "短信验证码渠道尚未配置");
  }
  const client = new AliyunCore({
    accessKeyId: config.ALIYUN_SMS_ACCESS_KEY_ID!,
    accessKeySecret: config.ALIYUN_SMS_ACCESS_KEY_SECRET!,
    endpoint: "https://dysmsapi.aliyuncs.com",
    apiVersion: "2017-05-25"
  });
  const response = (await client.request(
    "SendSms",
    {
      PhoneNumbers: target.replace(/^\+86/, ""),
      SignName: config.ALIYUN_SMS_SIGN_NAME,
      TemplateCode: config.ALIYUN_SMS_TEMPLATE_CODE,
      TemplateParam: JSON.stringify({ code })
    },
    { method: "POST" }
  )) as { Code?: string; Message?: string; BizId?: string; RequestId?: string };
  if (response.Code !== "OK") {
    throw new ApiError(502, "SMS_PROVIDER_ERROR", response.Message || "短信发送失败");
  }
  return { provider: "aliyun-sms", messageId: response.BizId || response.RequestId };
};

export const deliverOtp = async (
  channel: "email" | "sms",
  target: string,
  code: string
): Promise<OtpDelivery> => {
  if (getConfig().OTP_DEBUG) return { provider: "debug" };
  return channel === "email" ? deliverEmail(target, code) : deliverSms(target, code);
};
