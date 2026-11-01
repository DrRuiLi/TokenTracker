# Waffo 更新兼容性核对（2026-10-12）

结论：最新 main 的支付实现无需运行时兼容修正。本次增加 9 项回归测试；不改价格、权益策略、SQL、支付配置或 SDK 版本，不合并、不发布、不部署。

后续发布授权：以上是不含发布的原始核对阶段记录。用户随后明确要求发布新版本；基于同一最新 main 选择 1.3.11，并按仓库流程同步版本、执行完整本地及精确提交 CI 门禁，发布 npm 和桌面分发。此次后续授权仍不包含支付配置、收费政策、数据库或真实资金操作。正式结果以对应 GitHub Release、npm 元数据和发布工作流为准。

## 基线与隔离

- 主仓库 `/Users/sunxiufeng/tokentracker` 的 main、已存 origin/main 和本次公开远端 `git ls-remote` 均为 `056b27e0d9621d1a4405f0c66d1b1737fb7697bc`，package.json 为 1.3.10。这是源码版本核对，不是 npm 已发布版本证明。
- 本次独立副本：`/Users/sunxiufeng/Documents/Codex/2026-10-12/task/tokentracker-waffo`；分支 `fix/waffo-webhook-amounts-20261012`。未修改原仓库的分支、索引或文件。
- 原会员工作树在 `feat/cloud-subscriptions` / `83e7e0f1`，package.json 为 1.3.2，较其已存远端分支落后 5 个提交，因此没有用它作基线。
- 已检查所有仍存在的注册工作树。egress-optimization 和 sync-backlog-recovery 有未提交工作；均未触碰，也未混入本次修改。
- 已读 AGENTS.md、其指定的 CLAUDE.md、`.agents/skills/insforge/SKILL.md`、`insforge-debug/SKILL.md`、`insforge-cli/SKILL.md`，以及现有 billing 运维说明和测试夹具。未读凭证文件或调用云端管理接口。

## 官方依据

2026-10-12 直接核对 [Webhooks](https://docs.waffo.ai/api-reference/webhooks)、[Test Mode](https://docs.waffo.ai/features/test-mode) 和 [GraphQL Orders & Payments](https://docs.waffo.ai/api-reference/endpoints/graphql/orders-and-payments)。

- payment event 的 amount 自 2026-09-21 表示实扣；新字段区分 chargedAmount/listPrice、refundedAmount/originalChargedAmount。未报告实扣时新字段省略，零有明确含义。旧金额字段最早于 2027-09-20 后的大版本移除，没有立即下线期限。
- periodNumber 是渠道账期标号，失败也会占号；同账期可有多个事件。扣款与续费状态独立投递，不保证顺序。
- 测试后台可模拟续费成功、失败和逾期恢复；再次失败可终止订阅。操作异步生效且推进订单，不能撤回或重置。

## 真实发现与验证边界

| 检查项 | 最新代码及验证结论 |
| --- | --- |
| 金额来源 | `cloud/waffo.ts` 从签名 GraphQL 读 Payment.amount 和 pspAmountDetails，校验货币、单位及一致性。webhook 金额只是通知，不直接作为账本输入，因此不依赖弃用字段。新字段独立存在、旧字段独立存在以及二者共存均通过 HTTP/SQL 验证。 |
| 部分退款 | 只认供应商已成功的退款，按 REF/PAY 关联逐笔累加，累计不得超过真实付款。退款先到、付款回调重放和多个部分退款不重复入账；未用退款事件的 total 作为本次退款额。 |
| 按比例计费 | 当前产品是固定价格、无供应商试用；校验禁止换计划来源和替代订单，要求实扣等于已验证价格快照。双方金额一致但实扣为 2.99 或 5.99、标价为 4.99 的场景明确拒绝，未给权益。这是现有产品边界，**不代表已支持按比例计费**。开放该能力需要另行设计订单映射和 SQL（当前 SQL 还要求付款不少于基础价），不能仅删除金额比较。 |
| 零扣款 | recurring、period 0、真实金额 0、无退款才进入私有授权审计，不是付款或退款。GraphQL 的 isFullyRefunded=true / refundedAmount=0 不产生退款记录。fixed 或非零账期的零额不会获得权益。 |
| 未报告实扣 | pspAmountDetails 缺失、缺 amount 或空对象会拒绝；不会把 GraphQL 回退的标价当作已确认实扣。此类交易需要供应商补全数据/人工核对，本次不放宽现有策略。 |
| 去重与乱序 | SQL 按事件/动作身份和 PAY、REF 保证幂等，periodNumber 用于绑定期间而非支付去重。验证同一 ORD/同一期间两个 PAY、两个 REF 均保留且不延长两次；退款先于付款通知、renewed/payment_succeeded 两种顺序及重放均通过。 |
| 续费状态 | 成功付款不要求携带订阅时间或状态；从供应商期间和状态复核。P2 失败不生成付费期间，P3 恢复后只有 P1/P3 两笔成功付款；旧 P2 通知不回退状态。第二次失败终止，不补购时间，旧 activated 通知不复活订阅。取消/逾期保留原已购时间，不凭状态生成新付费时间。 |
| 历史缺 periodNumber | 当前需要可验证的付款期间；缺号无法安全绑定时保持待处理，不猜测成功次数或账期。未增加官方提到的历史时间戳关联回退。 |

## 改动及最终验证

- `test/cloud-billing-waffo.test.js`：3 项适配器回归（按比例实扣拒绝、零额 fully-refunded 含义、未知 PSP 金额）。
- `test/cloud-billing-waffo-http.test.js`：6 项真实处理器→签名请求→隔离 HTTP 网关→PGlite SQL 回归，覆盖上述金额载荷和续费流程。
- `node --test test/cloud-billing-*.test.js`：186/186 通过，0 失败、0 跳过。含 Waffo、历史支付渠道、身份验证、账本及数据库保护测试。
- `node scripts/build-cloud-functions.cjs`：通过，18 个本地构建产物。
- `node scripts/build-cloud-functions.cjs --sandbox`：通过，2 个本地构建产物。
- `git diff --check`：通过。

测试使用即时生成的 RSA 密钥、合成用户和内存数据库；HTTP 只在 127.0.0.1 监听，供应商请求由夹具处理。以清空环境的方式运行，未使用实际支付凭证。首次共用依赖软链接使构建器的路径匹配失败；改为在独立副本复制本机依赖后，两个原始构建命令均通过，无需改构建源码。未运行整个项目 npm test 或原生客户端构建，本次没有运行时/UI/原生代码改动。

## 未做的外部验证

未打开商户后台、创建供应商 sandbox 订单、点击模拟按钮、收发真实供应商回调或读取部署源码；本地覆盖不证明供应商当前账户的实际行为，也不证明线上部署与 main 相同。历史真实支付/退款记录只作为仓库已有记录，未在本次重新验收。

如果后续需要服务商 sandbox 验收，需要明确授权：在已确认的 **test** 店铺和专用测试订阅上触发模拟成功/失败（会推进账期或终止测试订单），并允许读取对应 test 回调投递及脱敏订单状态；若 test webhook 指向既有托管 backend，还需要该测试 backend 的写入授权或另建隔离目标。不需要真实扣款、真实退款、生产设置修改或发布权限。本次没有因缺少这些权限阻塞本地验证，也没有擅自执行这些操作。
