# 系统验证（verification）示例

同一 `roundId` 覆盖一整轮；可先查接口清单，再一键初始化成「待开始」步骤。

## 1. 查全平台接口清单

```json
{ "action": "verification.catalog", "args_json": "{}" }
```

按域 / 风险 / 关键词过滤：

```json
{
  "action": "verification.catalog",
  "args_json": "{\"domain\":\"items,workflow\",\"risk\":\"read,write\",\"query\":\"创建\"}"
}
```

## 2. 新一轮：一键初始化为待开始

```json
{
  "action": "verification.init",
  "args_json": "{\"title\":\"全平台接口验证\",\"confirm\":true}"
}
```

只初始化部分域：

```json
{
  "action": "verification.init",
  "args_json": "{\"title\":\"内容域验证\",\"domains\":[\"items\",\"workflow\",\"knowledge\",\"experience\",\"automation\",\"employees\"],\"confirm\":true}"
}
```

等价写法：`verification.start` + `seed=true`。

初始化后：
- 轮次 `status=queued` / `statusLabel=待开始`
- 每个接口一条步骤：`status=pending` / `result=待开始`

## 3. 执行后回填（同 api 会更新待开始行，不重复插）

```json
{
  "action": "verification.step",
  "args_json": "{\"roundId\":\"svr_xxxx\",\"api\":\"items.create\",\"status\":\"passed\",\"request\":{\"title\":\"…\"},\"response\":{\"ok\":true},\"durationMs\":48,\"confirm\":true}"
}
```

## 4. 查看 / 收尾

```json
{ "action": "verification.get", "args_json": "{\"roundId\":\"svr_xxxx\"}" }
```

```json
{
  "action": "verification.conclude",
  "args_json": "{\"roundId\":\"svr_xxxx\",\"conclusion\":\"…\",\"confirm\":true}"
}
```
