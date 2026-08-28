export function applicationPage(env: Env, nonce: string): string {
  const siteKey = escapeHtml(env.TURNSTILE_SITE_KEY);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>AListServer Testflight</title>
  <style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6f8;color:#18191c}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f6f8}
    main{width:min(100% - 32px,540px);margin:0 auto;padding:max(30px,env(safe-area-inset-top)) 0 max(40px,env(safe-area-inset-bottom))}
    h1{margin:0 0 9px;font-size:28px;line-height:1.25}.lead{margin:0 0 25px;color:#60646c;line-height:1.6}
    form{padding:22px;background:#fff;border:1px solid #dfe1e6;border-radius:16px;box-shadow:0 10px 34px #18191c0d}
    label{display:block;margin:0 0 8px;font-size:14px;font-weight:600}
    input,button{width:100%;font:inherit}input{height:47px;margin:0 0 18px;padding:0 13px;border:1px solid #c8cbd2;border-radius:10px;background:#fff;color:#18191c}
    input:focus{outline:2px solid #1677ff;outline-offset:1px;border-color:transparent}
    button{min-height:48px;border:0;border-radius:10px;background:#1677ff;color:#fff;font-size:16px;font-weight:650;cursor:pointer}
    .actions{display:grid;gap:10px}.actions .secondary{background:#e9ebef;color:#25282d}
    button:disabled{opacity:.55;cursor:wait}.credential-notice{display:none;margin:-7px 0 18px;padding:11px 13px;border-radius:10px;background:#edf5ff;color:#2462a3;font-size:14px}
    .turnstile{min-height:70px;margin:0 0 17px;overflow:hidden}.status{display:none;margin:18px 0 0;padding:12px 14px;border-radius:10px;background:#eef3fb;color:#24456f;line-height:1.55}
    .status.error{background:#fff0f0;color:#8d2424}
    [hidden]{display:none!important}.confirm-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:24px;background:#0008}.confirm-card{width:min(100%,420px);padding:22px;background:#fff;border-radius:16px;box-shadow:0 20px 60px #0004}.confirm-card h2{margin:0 0 12px;font-size:21px}.confirm-card p{margin:0;color:#555b64;line-height:1.65}.confirm-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:22px}.confirm-actions .secondary{background:#e9ebef;color:#25282d}
    @media(prefers-color-scheme:dark){:root,body{background:#111214;color:#f4f4f5}form,.confirm-card{background:#1c1d20;border-color:#34363c;box-shadow:none}input{background:#111214;border-color:#494c54;color:#f4f4f5}.lead,.confirm-card p{color:#a7aab2}.credential-notice{background:#123154;color:#a8d0ff}.status{background:#1c2b3f;color:#bed9ff}.status.error{background:#3a1d20;color:#ffb7bd}.actions .secondary,.confirm-actions .secondary{background:#34363c;color:#f4f4f5}}
    @media(max-width:420px){main{width:min(100% - 20px,540px);padding-top:22px}form{padding:18px}h1{font-size:24px}}
  </style>
</head>
<body>
  <main>
    <h1>AListServer Testflight</h1>
    <p class="lead">验证 App Store 下载凭证后，系统会自动发放 TestFlight 资格。</p>
    <form id="form" autocomplete="off">
      <label for="email">TestFlight 邮箱</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" required>
      <label for="credential">凭证 ID</label>
      <input id="credential" name="credential" type="password" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128" required>
      <p id="credential-notice" class="credential-notice" role="note">已自动填入凭证ID</p>
      <div class="turnstile"><div class="cf-turnstile" data-sitekey="${siteKey}" data-action="tf_apply" data-theme="auto" data-refresh-expired="auto"></div></div>
      <div class="actions">
        <button id="submit" type="submit">申请加入测试</button>
        <button id="repair" class="secondary" type="submit">修复 TestFlight“已被移除”</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </form>
  </main>
  <div id="confirm-overlay" class="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title" hidden>
    <div class="confirm-card">
      <h2 id="confirm-title">确认换绑邮箱</h2>
      <p id="confirm-message"></p>
      <div class="confirm-actions">
        <button id="confirm-cancel" class="secondary" type="button">取消</button>
        <button id="confirm-submit" type="button">确认换绑</button>
      </div>
    </div>
  </div>
  <script nonce="${escapeHtml(nonce)}">
    (() => {
      "use strict";
      const form = document.getElementById("form");
      const email = document.getElementById("email");
      const credential = document.getElementById("credential");
      const notice = document.getElementById("credential-notice");
      const status = document.getElementById("status");
      const submit = document.getElementById("submit");
      const repair = document.getElementById("repair");
      const confirmOverlay = document.getElementById("confirm-overlay");
      const confirmTitle = document.getElementById("confirm-title");
      const confirmMessage = document.getElementById("confirm-message");
      const confirmCancel = document.getElementById("confirm-cancel");
      const confirmSubmit = document.getElementById("confirm-submit");

      const hash = window.location.hash;
      if (hash.startsWith("#tid=")) {
        try {
          const candidate = decodeURIComponent(hash.slice(5)).trim();
          if (/^[A-Za-z0-9._-]{6,128}$/.test(candidate)) {
            credential.value = candidate;
            notice.style.display = "block";
          }
        } catch (_) {}
      }
      history.replaceState(null, "", "/tf");

      credential.addEventListener("input", () => { notice.style.display = "none"; });
      credential.addEventListener("focus", () => { credential.type = "text"; });
      credential.addEventListener("blur", () => { credential.type = "password"; });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const appTransactionId = credential.value.trim();
        const requestedEmail = email.value.trim();
        const turnstileToken = form.querySelector('[name="cf-turnstile-response"]')?.value || "";
        const isRepair = event.submitter === repair;
        if (!appTransactionId) return show("请输入凭证 ID。", true);
        if (!turnstileToken) return show("请先完成人机验证。", true);

        submit.disabled = true;
        repair.disabled = true;
        show("正在验证购买凭证…", false);
        try {
          const sessionResponse = await fetch("/api/tf/session", {
            method: "POST",
            headers: {"content-type":"application/json"},
            cache: "no-store",
            credentials: "same-origin",
            body: JSON.stringify({appTransactionId, turnstileToken})
          });
          const session = await sessionResponse.json();
          if (!sessionResponse.ok) throw new Error(session.message || "无法验证购买凭证。");
          const claimURL = new URL(session.applyURL);
          if (claimURL.origin !== location.origin || claimURL.pathname !== "/tf" || claimURL.search) {
            throw new Error("申请服务返回了无效会话。");
          }
          const claimToken = new URLSearchParams(claimURL.hash.slice(1)).get("claim") || "";
          if (!/^[A-Za-z0-9_-]{32,256}$/.test(claimToken)) throw new Error("申请服务返回了无效会话。");

          show("凭证有效，正在检查绑定状态…", false);
          const previewResponse = await fetch("/api/tf/preview", {
            method: "POST",
            headers: {"content-type":"application/json"},
            cache: "no-store",
            credentials: "same-origin",
            body: JSON.stringify({email: requestedEmail, claimToken})
          });
          const preview = await previewResponse.json();
          if (!previewResponse.ok) throw new Error(preview.message || "无法检查绑定状态。");
          let confirmRebind = false;
          let confirmRepair = false;
          if (isRepair) {
            if (preview.operation !== "existing_binding") {
              throw new Error("当前凭证与邮箱没有可修复的绑定。");
            }
            confirmRepair = await requestRepairConfirmation(requestedEmail, preview.recoveryInProgress);
            if (!confirmRepair) {
              show("已取消修复，当前测试资格保持不变。", false);
              submit.disabled = false;
              repair.disabled = false;
              return;
            }
          } else if (preview.operation === "rebind") {
            confirmRebind = await requestRebindConfirmation(
              requestedEmail,
              preview.remainingRebinds,
              preview.recoveryInProgress
            );
            if (!confirmRebind) {
              show(
                preview.recoveryInProgress
                  ? "已关闭提示；此前已确认的换绑仍会由系统继续恢复。"
                  : "已取消换绑，原邮箱保持不变。",
                false
              );
              submit.disabled = false;
              repair.disabled = false;
              return;
            }
          }

          show(
            confirmRepair
              ? "正在重置并重新发放测试资格…"
              : confirmRebind
                ? "正在换绑并发放测试资格…"
                : "正在发放测试资格…",
            false
          );
          const applyResponse = await fetch("/api/tf/apply", {
            method: "POST",
            headers: {"content-type":"application/json"},
            cache: "no-store",
            credentials: "same-origin",
            body: JSON.stringify({email: requestedEmail, claimToken, confirmRebind, confirmRepair})
          });
          const result = await applyResponse.json();
          if (!applyResponse.ok) throw new Error(result.message || "申请失败。");
          show(
            result.status === "repaired"
              ? "修复成功，请稍后打开 TestFlight 查看。"
              : result.status === "rebound"
              ? "换绑成功，请检查 TestFlight 邀请。"
              : "申请成功，请检查 TestFlight 邀请。",
            false
          );
          form.querySelectorAll("input,button").forEach((element) => { element.disabled = true; });
        } catch (error) {
          show(error instanceof Error ? error.message : "申请失败，请稍后重试。", true);
          submit.disabled = false;
          repair.disabled = false;
          if (window.turnstile) window.turnstile.reset();
        }
      });

      function show(message, isError) {
        status.textContent = message;
        status.classList.toggle("error", Boolean(isError));
        status.style.display = "block";
      }

      function requestRebindConfirmation(newEmail, remainingRebinds, recoveryInProgress) {
        return new Promise((resolve) => {
          confirmTitle.textContent = "确认换绑邮箱";
          const consequences =
            "当前还剩 " + remainingRebinds + " 次换绑机会。旧邮箱在本 App 的 TestFlight 测试权限会被移除。";
          confirmMessage.textContent = recoveryInProgress
            ? "此前已确认换绑到 " + newEmail + "，系统正在恢复该操作。继续后会立即重试。" + consequences
            : "确认将此购买凭证换绑到 " + newEmail + " 吗？" + consequences;
          confirmOverlay.hidden = false;
          const finish = (confirmed) => {
            confirmOverlay.hidden = true;
            confirmCancel.onclick = null;
            confirmSubmit.onclick = null;
            resolve(confirmed);
          };
          confirmCancel.onclick = () => finish(false);
          confirmSubmit.onclick = () => finish(true);
        });
      }

      function requestRepairConfirmation(currentEmail, recoveryInProgress) {
        return new Promise((resolve) => {
          confirmTitle.textContent = "确认修复资格";
          confirmMessage.textContent = recoveryInProgress
            ? "系统正在恢复 " + currentEmail + " 的修复操作。继续后会立即重试。"
            : "确认修复 " + currentEmail + " 的 TestFlight 资格吗？系统会先移除该邮箱在本 App 的测试权限，再重新加入“已购用户”分组。修复不会消耗换绑次数。";
          confirmOverlay.hidden = false;
          const finish = (confirmed) => {
            confirmOverlay.hidden = true;
            confirmCancel.onclick = null;
            confirmSubmit.onclick = null;
            resolve(confirmed);
          };
          confirmCancel.onclick = () => finish(false);
          confirmSubmit.onclick = () => finish(true);
        });
      }
    })();
  </script>
  <!-- 必须在内联脚本同步读取并清除 #tid 后，才允许加载第三方 Turnstile。 -->
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
