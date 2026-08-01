# 数据模型与业务口径

## 通用字段

所有业务文档包含：

```text
ownerOpenId
createdAt
updatedAt
schemaVersion
```

旧网页迁移记录额外包含：

```text
source = legacy-localstorage-v1
legacyId
migrationJobId
```

## 集合职责

### users

管理员身份与状态。第一版以小程序 OpenID 为主身份，后续电脑管理端的 Web UID 必须在此集合显式映射到同一 `ownerOpenId`。

### customers

客户姓名、车牌、车辆和必要备注。不建议收集身份证号、银行卡号等非必要敏感信息。

### contracts

保存不可歧义的合同金融参数，包括：

```text
interestMethod: flat | annuity
vehiclePriceCents
downPaymentRateBps
downPaymentCents
principalCents
monthlyRateBps
quotedMonthlyPaymentCents
terms
dueDay
startDateKey
dailyLateFeeRateBps
depositMonths
calculationVersion
```

合同创建时生成并冻结每期账单。后续修改计算代码不得改变历史合同账单。

### repayment_plans

一份文档代表一期账单，分别保存计划本金、计划利息、已付本金和已付利息。到期日使用 `YYYY-MM-DD` 的上海业务日期键，避免服务器时区导致跨日。

### payments

不可变收款流水。到账金额拆为：

```text
amountCents = lateFeeCents + contractAmountCents
contractAmountCents = allocations 中本金与利息之和
```

撤销采用 `status = reversed`，不物理删除原流水。

### deposits

押金收取、退还和抵扣的独立流水。押金不自动进入贷款、月供和合同结清金额。

### audit_logs

云函数追加的操作审计。前端不能修改或删除。

### migration_jobs

保存旧备份 SHA-256 指纹、预览汇总、逐客户导入结果和失败原因。

## 计算口径

### 平息 / 固定月息

```text
月供报价 = 贷款额 ÷ 期数 + 贷款额 × 月利率
总利息 = 贷款额 × 月利率 × 期数
```

总本金和总利息以分为单位精确分摊到各期，处理每期四舍五入差额。

### 标准等额本息

```text
月供 = P × r × (1+r)^n ÷ ((1+r)^n - 1)
```

每期利息按剩余本金计算，最后一期自动清零剩余本金。

### 滞纳金

```text
每期滞纳金 = 该期剩余合同款 × 日比例 × 逾期天数
```

同一客户多期逾期只在展示层汇总，不能先合并再计算。
