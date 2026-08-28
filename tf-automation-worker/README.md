# AListServer TestFlight Worker

这是 AListServer 独立的自助 TestFlight Worker。它不与 tvbox 共用 Worker、D1、
Durable Object、域名、Turnstile、业务密钥、数据库表或 App Store Connect 测试分组。

Cloudflare 账户当前只有一个 Secrets Store 容器，因此两者仅共享容器。Apple/ASC 凭证以只读
binding 方式复用；AList 自有密钥全部使用 `ALIST_TF_` 前缀。Worker 没有修改、轮换或删除
Secrets Store 条目的代码路径。

ASC 的 `betaTesters` 是账号级资源，因此按邮箱全局查询可能看到其他 App 的 tester。AList 只会
复用已明确关联 AListServer App 或“已购用户”分组的 tester；只属于其他 App 的同邮箱记录会被
忽略，并为 AListServer 创建独立 tester，绝不把跨 App tester ID 用于加组、邀请或撤权。

## 用户流程

1. 商店版 App 在 iOS 16+/tvOS 16+ 读取 verified `AppTransaction.shared.appTransactionID`。
2. App 仅打开 `https://alistserver.99999987.xyz/tf#tid=<凭证ID>`。凭证在 URL fragment 中，
   不进入 HTTP 请求或访问日志；网页同步读取后立即清除地址栏，并显示“已自动填入凭证ID”。
3. 网页先完成 Turnstile，Worker 才向 Apple 查询并验签下载付费凭证，随后签发 5 分钟、
   一次性的 claim。
4. 用户输入 TestFlight 邮箱；网页先预览绑定状态。首次绑定直接申请，同一邮箱普通申请只做
   非破坏性的幂等对账；“修复 TestFlight 已被移除”是独立操作，会先移除本 App 权限、确认
   关系消失，再重新加入“已购用户”分组，且不消耗换绑次数。
5. 若凭证已绑定其他邮箱，网页明确提示旧邮箱将失去本 App 的测试权限，并显示当前还剩几次
   换绑机会。用户确认后才执行；换绑成功后只提示成功，不再显示剩余次数。

每份购买凭证在首次绑定成功后可成功换绑两次。取消、输入错误、目标邮箱冲突以及执行失败均不
扣次数；只有新邮箱已成功加入 AList TestFlight 分组并完成 D1 最终提交时才扣一次。没有人工
换绑入口，也不依赖飞书应用、Cloudflare Access 或管理 Bearer Token。

## 接口与恢复

- `GET /tf`：申请页面。
- `POST /api/tf/session`：先验证 Turnstile，再验证 `appTransactionId` 并返回短期 claim。
- `POST /api/tf/preview`：只读预览首次绑定、同邮箱或换绑，以及剩余次数；不消费 Turnstile。
- `POST /api/tf/apply`：使用同一来源的短期 claim，只执行一次首次绑定、显式修复或已确认的换绑。
- 5 分钟 Cron：有界恢复跨 D1/ASC 的首次申请、显式修复和换绑任务。
- 每日 Cron：分批清理过期 claim、限流记录、租约、审计和已完成的旧换绑任务。

首次申请和显式修复使用 `tf_access_operations` 持久化阶段；显式修复严格执行 App 级移除、
等待关系消失、重新加组和按 ASC 实际状态决定是否邀请。换绑使用持久化 saga：先加密保存目标
邮箱和旧 tester 快照，再移除旧资格、确保新 tester、邀请
到 AList 分组，最后用条件更新把绑定切换到新邮箱并将 `rebind_count` 加一。Worker 中断或 ASC
暂时失败时，原任务会从最近阶段继续；永久错误或重试耗尽后会先恢复旧邮箱资格，且不会因中间
失败提前扣次数。数据库仅保存购买凭证 HMAC、
邮箱 HMAC/独立 AES-GCM 密文和脱敏审计，不保存凭证明文或 Apple JWS。

退款撤权接口当前未开放。Apple 的公开下载付费 `AppTransaction` 模型没有可验证的退款字段，
客户端启动检查也保持禁用，避免把永久无效的链路误认为已实现。

历史 migration `0002`–`0007` 属于已部署记录，必须保持原样以确保 D1 可从任意旧版本顺序升级；
对应旧表不再有路由或运行时代码使用。生产配置检查会拒绝任何 `FEISHU_` 变量或 secret binding。

## 本地与部署门禁

```sh
npm run typecheck
npm test
npm run check:startup
npx wrangler deploy --dry-run
npm run check:production-config
```

`npm run deploy` 固定执行：生产隔离检查 → 对精确的 AList D1 应用远端 migration → 列出迁移
状态 → 部署 Worker → 检查生产 `/health`。不要绕过脚本直接部署。迁移和部署只允许指向
`alistserver-tf-automation`，不得出现 tvbox 的 D1 ID、队列、Worker 或分组。

## 上线后仍需真实样本验收

- 用真实 Production ownership 样本确认 `appTransactionId` 稳定性和 Apple 查询/JWS/OCSP 路径。
- 验证 Family Sharing、兑换、限免和 ABM 等来源均符合产品资格策略。
- 用真实 tester 验证首次绑定、两次换绑、旧邮箱移除、第三次被拒绝以及故障恢复。
- 当前复用 ASC key 具备写 TestFlight 权限；理想状态仍是为 AList 创建尽可能限制到本 App 的
  独立 key。运行时的 bundle/group 检查不能替代凭证级隔离。
