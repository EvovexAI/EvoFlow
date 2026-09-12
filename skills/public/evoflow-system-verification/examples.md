# 系统验证 platform 调用样例

详见主技能 `evoflow-system-verification`。以下为精简 JSON 样例。

## catalog

```json
{ "action": "verification.catalog", "args_json": "{\"domain\":\"items,workflow\"}" }
```

## init（待开始）

```json
{
  "action": "verification.init",
  "args_json": "{\"title\":\"内容运营全流程\",\"domains\":[\"items\",\"workflow\",\"knowledge\",\"experience\",\"automation\",\"employees\",\"diagnostics\"],\"confirm\":true}"
}
```

## step（回填同 api 待开始行）

```json
{
  "action": "verification.step",
  "args_json": "{\"roundId\":\"svr_xxxx\",\"api\":\"items.create\",\"status\":\"passed\",\"request\":{\"title\":\"…\"},\"response\":{\"ok\":true},\"durationMs\":48,\"confirm\":true}"
}
```

## conclude

```json
{
  "action": "verification.conclude",
  "args_json": "{\"roundId\":\"svr_xxxx\",\"conclusion\":\"…\",\"confirm\":true}"
}
```
