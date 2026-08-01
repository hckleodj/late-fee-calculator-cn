# 大进车贷助手

当前版本：`v0.9 内部试用版`

本仓库同时保留原 GitHub Pages 工具和新的微信小程序迁移工程。根目录 `index.html` 继续作为旧网页运行，小程序和 CloudBase 代码位于独立目录，不改变旧页面的发布入口。

## 目录

- `index.html`：原 GitHub Pages 版本，保持兼容
- `miniapp/`：微信原生小程序
- `cloudfunctions/api/`：统一 CloudBase 云函数 API
- `cloudbase/`：集合、索引和安全规则清单
- `packages/domain/`：唯一业务计算真源
- `packages/migration/`：旧 localStorage 备份迁移器
- `tests/`：业务、迁移和权限测试
- `docs/`：部署与数据模型说明

## 本地检查

本项目不依赖前端框架。测试使用 Node.js 内置测试运行器。

```bash
npm run check
```

`build:shared` 会把共享业务模块同步到小程序和云函数部署目录。生成文件不能手工修改。

## 安全边界

- 默认只有 `ADMIN_OPENIDS` 白名单中的微信身份可以访问。
- 所有业务集合禁止小程序前端直接读写。
- 云函数从可信调用上下文取得 OpenID，拒绝客户端传入或覆盖 `ownerOpenId`。
- 收款、撤销收款、合同创建和数据迁移使用服务端事务。
- 押金独立记账，不参与贷款额、月供或自动结清计算。
- 金额统一使用整数“分”保存。

完整部署步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，数据结构见 [docs/DATA_MODEL.md](docs/DATA_MODEL.md)。
