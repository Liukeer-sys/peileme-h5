import { describe, expect, it } from "vitest";
import { buildOtpEmail } from "../notifier.js";

describe("OTP email presentation", () => {
  it("builds a branded, client-compatible email with text fallback", () => {
    const email = buildOtpEmail("482913", 10);

    expect(email.subject).toBe("赔了么验证码｜登录验证");
    expect(email.subject).toContain("赔了么验证码");
    expect(email.text).toContain("482913");
    expect(email.text).toContain("10 分钟内有效");
    expect(email.html).toContain("赔了么");
    expect(email.html).toContain("482913");
    expect(email.html).toContain("10 分钟内有效");
    expect(email.html).toContain('role="presentation"');
    expect(email.html).toContain("font-family");
    expect(email.html).toContain("登录安全提示");
    expect(email.html).not.toContain("<script");
  });
});
