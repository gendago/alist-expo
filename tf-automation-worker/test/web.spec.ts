import { describe, expect, it } from "vitest";
import { html } from "../src/http";
import { applicationPage } from "../src/web";

function env(): Env {
  return Object.assign({} as Env, {
    TURNSTILE_SITE_KEY: "site-key",
  });
}

describe("申请页 CSP", () => {
  it("每个内联脚本都由同一个 nonce 授权", async () => {
    const nonce = "fixed-test-nonce";
    const response = html(applicationPage(env(), nonce), nonce);
    const csp = response.headers.get("content-security-policy");
    const body = await response.text();
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(body).toContain(`<script nonce="${nonce}">`);
  });

  it("从 fragment 自动填入凭证并按预检、确认、单次 apply 完成申请", async () => {
    const body = applicationPage(env(), "fixed-test-nonce");
    expect(body).toContain("<title>AListServer Testflight</title>");
    expect(body).toContain("<h1>AListServer Testflight</h1>");
    expect(body).not.toContain("名额已满时请稍后再试");
    expect(body).not.toContain("每份购买凭证首次绑定后可在此自助换绑邮箱 2 次");
    expect(body).toContain("已自动填入凭证ID");
    expect(body).toContain('name="credential" type="password"');
    expect(body).toContain('hash.startsWith("#tid=")');
    expect(body).toContain('history.replaceState(null, "", "/tf")');
    expect(body.indexOf('history.replaceState(null, "", "/tf")')).toBeLessThan(
      body.indexOf('src="https://challenges.cloudflare.com/turnstile/v0/api.js"'),
    );
    expect(body).not.toMatch(/[?&](?:tid|appTransactionId|transactionId)=/);

    expect(body).toContain('fetch("/api/tf/session"');
    expect(body).toContain('body: JSON.stringify({appTransactionId})');
    expect(body).toContain('/^[A-Za-z0-9_-]{32,256}$/');
    expect(body).toContain('fetch("/api/tf/preview"');
    expect(body).toContain("确认换绑邮箱");
    expect(body).toContain("旧邮箱在本 App 的 TestFlight 测试权限会被移除");
    expect(body).toContain("preview.remainingRebinds");
    expect(body).not.toContain("preview.remainingAfter,");
    expect(body).toContain("当前还剩 \" + remainingRebinds + \" 次换绑机会");
    expect(body).toContain("换绑成功，请检查 TestFlight 邀请。");
    expect(body).toContain("申请成功，请检查 TestFlight 邀请。");
    expect(body).not.toContain('result.remainingRebinds + " 次换绑机会');
    expect(body).toContain("此前已确认的换绑仍会由系统继续恢复");
    expect(body).toContain('fetch("/api/tf/apply"');
    expect(body).toContain('const requestedEmail = email.value.trim()');
    expect(body).toContain(
      'body: JSON.stringify({email: requestedEmail, claimToken, turnstileToken, confirmRebind})',
    );

    expect(body.indexOf('fetch("/api/tf/session"')).toBeLessThan(
      body.indexOf('fetch("/api/tf/preview"'),
    );
    expect(body.indexOf('fetch("/api/tf/preview"')).toBeLessThan(
      body.indexOf('fetch("/api/tf/apply"'),
    );
    expect(body).toContain('body: JSON.stringify({email: requestedEmail, claimToken})');
  });
});
