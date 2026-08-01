import AliyunCore from "@alicloud/pop-core";
import nodemailer from "nodemailer";
import { getConfig } from "./config.js";
import { ApiError } from "./errors.js";

type OtpDelivery = {
  provider: "debug" | "smtp" | "aliyun-directmail" | "aliyun-sms";
  messageId?: string;
};

export const buildOtpEmail = (code: string, ttlMinutes: number) => {
  const subject = "赔了么验证码｜登录验证";
  const text = [
    "赔了么登录验证",
    "",
    `你的验证码是 ${code}，${ttlMinutes} 分钟内有效。`,
    "请勿将验证码转发给任何人。若非本人操作，可以忽略这封邮件。"
  ].join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f1e8;color:#352e3d;font-family:Inter,'PingFang SC','Microsoft YaHei',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${ttlMinutes} 分钟内有效的赔了么登录验证码</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f6f1e8;">
      <tr>
        <td align="center" style="padding:32px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border:1px solid #e6dce9;border-radius:24px;background:#fffdf8;box-shadow:0 18px 50px rgba(70,55,84,.10);overflow:hidden;">
            <tr>
              <td style="height:8px;background:linear-gradient(90deg,#9fd8ae,#bca8f0,#f2c985);font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:30px 34px 12px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="width:14px;height:14px;border-radius:50%;background:#7d6ac7;font-size:0;line-height:0;">&nbsp;</td>
                    <td style="padding-left:9px;font-size:18px;line-height:1.2;font-weight:800;color:#352e3d;">赔了么</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 34px 8px;">
                <div style="font-size:12px;line-height:1.4;font-weight:800;letter-spacing:.08em;color:#6654aa;">登录安全提示</div>
                <h1 style="margin:10px 0 8px;font-size:26px;line-height:1.35;color:#2f2936;">请完成身份验证</h1>
                <p style="margin:0;font-size:15px;line-height:1.8;color:#685e70;">请在赔了么登录页面输入下方验证码：</p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 34px;">
                <div style="padding:18px 16px;border:1px solid #ded3ee;border-radius:18px;background:#f7f2ff;text-align:center;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:34px;line-height:1.2;font-weight:800;letter-spacing:10px;color:#51408f;">${code}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 34px 30px;">
                <p style="margin:0 0 8px;font-size:14px;line-height:1.8;color:#5f5667;"><strong style="color:#3f3747;">${ttlMinutes} 分钟内有效</strong>，使用一次后自动失效。</p>
                <p style="margin:0;font-size:13px;line-height:1.8;color:#8a7f91;">赔了么工作人员不会向你索要验证码。若非本人操作，可以安全忽略这封邮件。</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 34px;border-top:1px solid #eee6ef;background:#faf7f1;font-size:12px;line-height:1.7;color:#978d9d;">这是一封自动发送的验证邮件，请勿直接回复。</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject, text, html };
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
  const { subject, text, html } = buildOtpEmail(
    code,
    config.OTP_TTL_MINUTES
  );
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
