# AListServer 自助 TestFlight 申请 Goal 文档

## 1. 目标

为下载付费的 AListServer 提供可上线的自助 TestFlight 申请能力：商店版 App 只负责取得
Apple 下载凭证 ID 并打开网页，其余资格验证、邮箱绑定、App Store Connect 发放和换绑全部
由 AList 独立 Worker 完成。

最终产品规则：

- 有效 Production 下载付费凭证可申请；兑换、限免等拥有 App 的合法凭证同样有资格。
- 家庭共享无法从当前凭证链路可靠区分，不单独限制。
- 当前只支持 iOS 16+/tvOS 16+ 自动取得凭证。
- 每份凭证首次绑定不计次数，之后最多成功换绑邮箱 2 次。
- 换绑全部在网页完成；没有 App 内人工入口，没有飞书应用，也没有后台人工换绑 API。
- 退款撤权本期不实现。商店版公开模型没有可验证的退款字段，不能承诺自动撤权。
- AList 与 tvbox 的 Worker、D1、表、域名、Turnstile、业务密钥、ASC 分组完全独立。

## 2. App 范围

设置页仅增加一个“申请 TestFlight”入口。

点击后：

1. iOS 16+/tvOS 16+ 调用 StoreKit 2 `AppTransaction.shared`。
2. 只接受 `.verified` 结果，并读取 `appTransactionID`。下载付费资格不能复用 tvbox 内购项目的
   `Transaction.currentEntitlements` 或 IAP `Transaction.id`。
3. 成功时打开 `https://alistserver.99999987.xyz/tf#tid=<appTransactionID>`。
4. 系统版本不足、未验证或读取失败时展示独立提示页：

   ```text
   未获取到凭证信息，请从商店下载最新版本
   且使用正确的系统版本：
   iOS ≥ 16.0
   tvOS ≥ 16.0
   ```

   页面包含与当前 App 风格一致的图标和返回/重试操作。

App 不保存、打印或通过 query 参数传递凭证，不输入邮箱，不判断绑定状态，不展示人工换绑入口。
当前仓库只有 iPhone/iPad 的 Xcode target；tvOS 16.0 是 StoreKit API 的可用下限和提示信息，
需要在未来新增 tvOS target 后再完成产物级验证，不能把当前 iOS 构建当作 tvOS 已交付。

## 3. 网页流程

网页从 `#tid` 同步读取凭证，校验格式后填入密码型输入框，显示精确文案
“已自动填入凭证ID”，随后立即用 `history.replaceState` 清除 fragment。必须在此之后才加载
Turnstile 第三方脚本。

提交顺序：

1. `/api/tf/session`：先验证 Turnstile，再由 Worker 向 Apple 查询并验签凭证，返回 5 分钟 claim。
2. `/api/tf/preview`：根据 claim 和目标邮箱只读返回：首次绑定、同邮箱幂等或换绑，以及当前
   剩余次数。这个接口不验证或消费 Turnstile token。
3. 换绑时显示自定义确认框：明确目标邮箱、原邮箱将失去本 App 的 TestFlight 权限，以及当前
   还剩几次换绑机会。取消时不产生任何 ASC 副作用。
4. `/api/tf/apply`：确认后只调用一次并消费短期 claim；换绑请求必须带
   `confirmRebind: true`；用户点击显式修复按钮后网页直接带
   `confirmRepair: true` 执行，不再弹二次确认框。
5. 成功页只提示申请或换绑成功，不显示剩余换绑次数。

目标邮箱若已属于另一份购买凭证，拒绝本次操作并要求更换邮箱。达到两次成功换绑后，任何新邮箱
换绑均拒绝；再次输入当前邮箱可做非破坏性幂等对账。网页另设“修复 TestFlight 已被移除”
按钮，用户确认后执行 App 级移除、等待关系消失并重新加入“已购用户”分组；修复不扣换绑次数。

## 4. Worker 与数据设计

核心表：

- `tf_claim_sessions`：短期 claim 状态机，只保存 token HMAC。
- `tf_bindings`：凭证 HMAC、邮箱 HMAC/密文、ASC tester、状态和 `rebind_count`。
- `tf_access_operations`：首次申请和显式修复的可恢复阶段、目标分组快照、有限重试及脱敏错误。
- `tf_web_rebind_operations`：跨 D1/ASC 换绑 saga，保存目标邮箱密文、旧/新 tester 快照、预期
  计数、阶段、重试时间和脱敏错误。
- `tf_operation_leases`：以购买凭证 HMAC 为资源的互斥租约。
- 限流、attempt 和 audit 表只保存 HMAC/脱敏元数据。

换绑阶段：

```text
prepared → old_removing → old_removed → new_adding → new_invited → completed
```

必须先持久化 operation，才允许调用 ASC 删除旧关系。新 tester 邀请完成后，D1 条件提交才把
binding 切到新邮箱，并令 `rebind_count = expected + 1`。失败、中断、重复请求和响应丢失均不得
重复扣次数。目标端出现永久错误或重试耗尽时，先自动恢复旧邮箱资格，再取消换绑。5 分钟 Cron
取得同一 binding 租约后从最近阶段恢复首次申请、显式修复和换绑。

并发约束：

- 同一 binding 同时最多一个未完成换绑 operation。
- 同一目标邮箱同时最多被一个未完成换绑 operation 预留。
- 首次绑定不能抢占已被换绑 operation 预留的邮箱，换绑也不能抢占已有 binding 的邮箱。
- 最终提交要求 binding 未撤销、旧邮箱和计数仍等于 operation 快照。

历史 migration `0002`–`0007` 永久保留且不修改，因为生产 D1 可能已经记录它们；旧飞书表可
空置，但不再存在回调、运行时代码、配置或 secret binding。新功能只使用 AList 的 D1 和资源。

## 5. 安全与隐私

- Worker 使用 Apple 官方 App Store Server Library 验证 JWS、证书链和应用标识；OCSP 网络失败
  分类为可重试，明确 revoked/unknown/签名失败分类为无效凭证。
- 完整凭证只存在于客户端到 `/session` 的 POST body 和 Apple 必需查询路径；日志、D1、audit、
  URL query 均不得出现明文。
- 邮箱只在 ASC 调用期间解密；D1 保存独立 AES-GCM 密文和 HMAC。
- Turnstile 校验 hostname 和 action；token 在调用昂贵的 Apple/OCSP 凭证验证前由 session
  消费一次，后续 preview/apply 不重复消费。
- HTML 使用 CSP nonce；动态内容通过 `textContent` 或转义输出。
- 退款链路保持关闭，直到 Apple 提供可验证的下载付费撤销信号并重新设计。

## 6. 资源隔离

AList 专用资源：

- Worker：`alistserver-tf-automation`
- 域名：`alistserver.99999987.xyz`
- D1：`alistserver-tf-automation`
- Durable Object/rate limiter：AList 独立 binding
- Turnstile site/secret
- external TestFlight group
- 所有 `ALIST_TF_` 业务 secret

允许只读引用同一 Secrets Store 容器内的 Apple/ASC 凭证，但不得引用 tvbox 的 D1 ID、Worker、
队列、DO、Turnstile、业务 secret 或 `miraplay` ASC 分组。部署检查必须显式拒绝这些标识。

## 7. 验收门禁

自动验证：

- TypeScript typecheck、Worker 全量单测、真实 workerd/D1 migration 测试。
- 从 `0001` 顺序应用到最新 migration；历史迁移不被修改。
- Turnstile 只在 session 验证一次；preview/apply 不重复消费。
- 普通同邮箱申请不删除权限；显式修复执行 App 级移除、等待消失、重新加组，且不扣换绑次数。
- 首次绑定剩余 2 次；两次成功换绑依次剩余 1、0；第三次拒绝。
- ASC 删除后失败、创建 tester 后失败、邀请后响应丢失均可恢复，最终只扣一次。
- 任何 ASC 副作用前失败或用户取消都不扣次数。
- 同一凭证并发换绑、目标邮箱与首次绑定并发时只有一个操作胜出。
- 页面清除 fragment 后才加载 Turnstile，且日志/数据库无凭证或邮箱明文。
- `wrangler check startup`、生产配置隔离检查和 deploy dry-run 全部通过。

生产验证：

- 只对 AList D1 应用 migration，只部署 AList Worker。
- `/health`、`/tf`、无效 session/preview/apply 边界正常；旧飞书路径返回 404。
- 页面展示自动填入提示、两次规则和换绑确认文案。
- 部署后再次确认 tvbox 健康状态和资源未变化。

真实样本仍需人工验收：Production 下载凭证、Family Sharing/兑换/限免来源、真实 tester 首次邀请、
两次换绑、旧邮箱权限移除、第三次拒绝及 Apple OCSP 线上行为。

## 8. Goal 执行顺序

1. 核对 tvbox 最新实现和 AList 工作区，固定可复用与不可复用边界。
2. 完成 App 轻入口、StoreKit 2 凭证读取和不可用提示页。
3. 完成 Apple 验证、网页申请、两次换绑 saga、Cron 恢复和资源隔离。
4. 删除飞书运行时入口与配置，保留历史 migration。
5. 运行全部自动门禁，并进行独立安全/并发复审。
6. 只迁移和部署 AList，完成生产冒烟与 tvbox 无影响核对。
7. 记录真实购买样本仍待人工完成的验收项，不把它们误报为自动验证通过。

## 9. 生产执行记录

2026-08-10 已将 `0008_web_rebind_limit.sql` 应用于 AList 独立 D1，并部署
`alistserver-tf-automation` 版本 `4b3292fd-91a6-47d0-a046-af8bce67443e`。部署前 Worker
类型检查、61 项测试、资源隔离检查、启动分析和 dry-run 均通过。部署后确认健康检查、申请页、
preview 错误边界与 D1 状态正常，旧飞书路径返回 404，`miraplay.99999987.xyz/health` 保持正常。

2026-08-28 已顺序应用 `0009_tf_access_reliability.sql`、
`0010_reconcile_purchased_group.sql` 与 `0011_pending_email_retry.sql`，并部署 Worker 版本
`a2a99ef4-a24e-41bd-978c-b9c8c0c28eb5`。部署前类型检查、10 个测试文件/78 项测试、生产资源
隔离检查、启动分析和显式 `wrangler deploy --dry-run` 全部通过。生产 3 条历史 binding 保持不变；
其中 2 条已收敛为 active 且分组快照统一到“已购用户”，另 1 条跨 App tester 被 ASC 明确以
`409 STATE_ERROR` 拒绝并进入脱敏终态，不会无限重试或影响其他 App。

同日进一步确认该终态源于账号级邮箱回退误选了只属于其他 App 的 tester。AList 已停止复用
任何未关联 AListServer App/目标分组的 tester，并通过
`0012_retry_cross_app_tester.sql` 精确恢复该操作，部署 Worker 版本
`417413c0-07b2-431e-9a73-1f5f558384f9`。类型检查、10 个测试文件/80 项测试、生产隔离检查、
启动分析和显式 dry-run 均通过。恢复后原有 3 条 binding 均为 `active / invited`；部署期间新增的
第 4 条 binding 也已正常完成。当前 4 条记录全部属于“已购用户”分组；修复流程新建的
AListServer tester ID 与原其他 App tester ID 不同，换绑次数均保持 0。

本记录不代表真实购买样本验收已完成；Production 凭证和真实 TestFlight 邮箱仍按上一节由人工验收。
