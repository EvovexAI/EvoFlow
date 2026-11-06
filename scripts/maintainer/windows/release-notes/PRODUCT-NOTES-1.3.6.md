**EvoFlow v1.3.6 — 修复员工派活 LLM 调用崩溃**

本版相对 **1.3.5**：修复平台控制参数（confirm 等）在模型配置中泄露、导致所有员工 wrap-up / 反思链路 LLM 调用必崩的问题。控制参数现已在入口、存储、持久化、模型工厂、执行全链路被妥善剥离。

---

### 参与本次发版

- 后端工程师：平台控制参数防护层完善，模型配置多层消毒
- 发版工程师：CI/CD 正式包发布

---

### 修复

- **员工派活 wrap-up 必崩**：修复 `TypeError: AsyncCompletions.create() got an unexpected keyword argument 'confirm'`。平台网关的确认标记（confirm / dry_run 等）不再存入模型配置 extra，不再经由 model_kwargs 泄露进 LLM 厂商 SDK；覆盖防护层从配置入口、持久化存储、模型工厂到执行时的最后一道防线

### 覆盖安装即可

无数据迁移，从 **1.3.5** 覆盖安装至 **1.3.6**。
