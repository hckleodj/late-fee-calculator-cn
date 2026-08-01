# PWA 云端网页版部署清单

## 1. 当前方案

```text
手机桌面 / 电脑浏览器
        ↓ HTTPS
CloudBase HTTP 云函数
        ↓
CloudBase 数据库
```

不使用电脑本地服务器，不需要微信小程序 AppID。原 GitHub Pages 的 `index.html` 保持不变，新的入口位于 `webapp/`。

## 2. 创建 CloudBase 环境

使用腾讯云账号创建独立 CloudBase 环境。创建前先核对控制台当时显示的免费额度、套餐价格、自动续费和超量计费；不要根据旧文档假设永久免费。

创建以下集合并应用 `cloudbase/collections.json` 中的索引：

```text
users
customers
contracts
repayment_plans
payments
deposits
app_settings
audit_logs
migration_jobs
```

全部集合保持客户端禁止读写，只允许云函数访问。

## 3. 配置网页管理员

本地运行：

```bash
npm run hash:admin
```

密码至少12位。脚本只输出不可逆的 scrypt 哈希，真实密码不得写进仓库。

在云函数环境变量中设置：

```text
WEB_OWNER_ID=web:你的内部管理员标识
WEB_ADMIN_PASSWORD_HASH=脚本输出的盐值和哈希
WEB_SESSION_SECRET=至少32位随机字符串
WEB_ALLOWED_ORIGINS=https://实际网页域名
WEB_SESSION_TTL_SECONDS=43200
```

`WEB_ALLOWED_ORIGINS` 多个域名使用英文逗号分隔。不要使用 `*`。

## 4. 部署云函数与HTTP访问

1. 执行 `npm run build:shared`。
2. 部署 `cloudfunctions/api` 并安装云端依赖。
3. 为该云函数创建 HTTPS 访问入口，只允许 `POST` 和 `OPTIONS`。
4. 将访问地址写入 `webapp/config.js` 的 `apiUrl`。
5. 先调用登录接口，确认错误密码被拒绝、正确密码返回短期会话令牌。

网页端令牌只保存到 `sessionStorage`，关闭浏览器标签页后需要重新登录。服务工作线程只缓存静态界面，不缓存客户或收款接口数据。

## 5. 部署网页

优先使用 CloudBase 静态托管，减少跨域和国内访问不稳定问题。也可使用独立的 GitHub Pages 入口，但必须把该真实来源加入 `WEB_ALLOWED_ORIGINS`。

部署后分别验证：

- Safari 和安卓浏览器能打开并登录
- 添加到手机主屏幕后能独立启动
- 电脑浏览器读取同一份客户数据
- 微信内置浏览器能打开网页，但安装 PWA 应转到系统浏览器
- 浏览器刷新和关闭后不会把客户数据写进 `localStorage`

## 6. 上线测试门槛

- 正常还款：建合同、到期提醒、收款、余额归零
- 逾期还款：多期逐期计算滞纳金、部分还款、催款文字
- 中途结清：剩余本金和合同利息与真实样本一致
- 撤销收款：账单余额恢复，原流水保留为已撤销
- 押金：收取/退还独立记账，不进入贷款和月供
- 旧备份：预览、首次导入、重复导入均通过
- 权限：错误密码、过期令牌、非授权来源和跨管理员访问均被拒绝
- 备份：云端导出数量与控制总额一致
