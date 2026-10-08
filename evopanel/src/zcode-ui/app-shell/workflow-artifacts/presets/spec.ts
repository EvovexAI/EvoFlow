/**
 * 预置产物（chart / table / metrics / board）的 spec 类型镜像 + 宽松解析。
 *
 * 这里的 `artifact` 是**用户面**的那一个：
 * 脚本经 `artifact.chart(id, spec)` 声明、由 `report(item, id)` 流喂养的看板；不是引擎内部
 * `RunSettlement.artifact` 那个「顶层返回值」。
 *
 * **为什么要在 UI 侧再解析一遍。** spec 的权威校验在引擎（zod，非法形状直接 failRun），
 * 落到 journal 的是 canonical JSON，再经 v4 投影到达 renderer 时类型已经退化成 `unknown`。
 * renderer 拿到的可能是：新 CLI 写的合法 spec、老 CLI 写的少字段 spec、或者一条被截断/篡改的行。
 * 渲染器不该对这些情况抛异常把整个侧板炸掉——所以这一层只做**结构性**判断，
 * 能渲染就返回归一化后的 spec，不能渲染就返回 `undefined`（调用方降级成一张「无法渲染」的卡）。
 *
 * 宽松 = 多余的键原样忽略、坏掉的可选字段丢掉、必填字段缺失才判不可渲染。
 */

/** 从一条 report 条目里取一个值：条目内的点路径（"timing.after"）。 */
export type ArtifactField = {
  field: string;
  label?: string;
  unit?: string;
};

export type ArtifactChartType = "line" | "bar" | "scatter";
export type ArtifactChartScale = "linear" | "log";

const CHART_TYPES: readonly ArtifactChartType[] = ["line", "bar", "scatter"];
const CHART_SCALES: readonly ArtifactChartScale[] = ["linear", "log"];

/** 所有预置 spec 共享的展示字段（facade 的 `ArtifactOptions`）。 */
type ArtifactPresetOptions = {
  title?: string;
  description?: string;
};

export type ChartSpec = ArtifactPresetOptions & {
  /** 默认 "line"。 */
  type?: ArtifactChartType;
  x: ArtifactField;
  /** 多个 = 多条序列。 */
  y: ArtifactField | ArtifactField[];
  /** y 轴，默认 "linear"。 */
  scale?: ArtifactChartScale;
  /** 画成一条水平参考线，取自第一条**带该字段**的条目。 */
  baseline?: ArtifactField;
};

export type TableSpec = ArtifactPresetOptions & {
  columns: ArtifactField[];
  /** 行的身份字段；同 key 的后续条目替换该行。缺席 = 只追加。 */
  key?: string;
};

export type MetricsSpec = ArtifactPresetOptions & {
  /** 每块瓦片显示**最后一条带该字段**的条目里的值。 */
  metrics: ArtifactField[];
};

export type BoardSpec = ArtifactPresetOptions & {
  /** 卡片的身份字段；同 key 的后续条目移动 / 更新该卡。 */
  key: string;
  /** 卡片所在列的字段。 */
  status: string;
  /** 列序。status 不在列表里的条目落到末尾的「其他」列。 */
  columns: string[];
  /** 卡片标题字段（缺省用 key）与卡片上额外展示的字段。 */
  cardTitle?: string;
  detail?: ArtifactField[];
};

export type ArtifactPresetKind = "chart" | "table" | "metrics" | "board";
export type ArtifactPresetSpec = ChartSpec | TableSpec | MetricsSpec | BoardSpec;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串；spec 里所有的字段路径 / 列名都必须是它。 */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * 一个 `ArtifactField`。可以只是一个字符串（"latencyMs"）——脚本作者会这么写，
 * facade 类型不允许但 journal 里可能存着旧形状，这里顺手接住。
 */
function parseField(value: unknown): ArtifactField | undefined {
  const shorthand = readNonEmptyString(value);
  if (shorthand) {
    return { field: shorthand };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const field = readNonEmptyString(value.field);
  if (!field) {
    return undefined;
  }
  const label = readNonEmptyString(value.label);
  const unit = readNonEmptyString(value.unit);
  return { field, ...(label ? { label } : {}), ...(unit ? { unit } : {}) };
}

/** 一组字段。坏条目单独丢弃（宽松），全空才算不可渲染。 */
function parseFieldList(value: unknown): ArtifactField[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields = value
    .map(parseField)
    .filter((field): field is ArtifactField => field !== undefined);
  return fields.length > 0 ? fields : undefined;
}

function parseOptions(spec: Record<string, unknown>): ArtifactPresetOptions {
  const title = readNonEmptyString(spec.title);
  const description = readNonEmptyString(spec.description);
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

function parseChartSpec(spec: Record<string, unknown>): ChartSpec | undefined {
  const x = parseField(spec.x);
  if (!x) {
    return undefined;
  }
  // y 单个也好、数组也好，都归一化成数组：下游（apply / 渲染器）只认一种形状，
  // 少一处 `Array.isArray` 分叉就少一处「单序列图漏渲染」的机会。
  const single = Array.isArray(spec.y) ? undefined : parseField(spec.y);
  const y = Array.isArray(spec.y) ? parseFieldList(spec.y) : single ? [single] : undefined;
  if (!y) {
    return undefined;
  }
  const type = CHART_TYPES.find((candidate) => candidate === spec.type) ?? "line";
  const scale = CHART_SCALES.find((candidate) => candidate === spec.scale) ?? "linear";
  const baseline = parseField(spec.baseline);
  return {
    ...parseOptions(spec),
    type,
    x,
    y,
    scale,
    ...(baseline ? { baseline } : {}),
  };
}

function parseTableSpec(spec: Record<string, unknown>): TableSpec | undefined {
  const columns = parseFieldList(spec.columns);
  if (!columns) {
    return undefined;
  }
  const key = readNonEmptyString(spec.key);
  return { ...parseOptions(spec), columns, ...(key ? { key } : {}) };
}

function parseMetricsSpec(spec: Record<string, unknown>): MetricsSpec | undefined {
  const metrics = parseFieldList(spec.metrics);
  if (!metrics) {
    return undefined;
  }
  return { ...parseOptions(spec), metrics };
}

function parseBoardSpec(spec: Record<string, unknown>): BoardSpec | undefined {
  const key = readNonEmptyString(spec.key);
  const status = readNonEmptyString(spec.status);
  if (!key || !status) {
    return undefined;
  }
  if (!Array.isArray(spec.columns)) {
    return undefined;
  }
  const columns = spec.columns
    .map(readNonEmptyString)
    .filter((column): column is string => column !== undefined);
  if (columns.length === 0) {
    return undefined;
  }
  const cardTitle = readNonEmptyString(spec.cardTitle);
  const detail = parseFieldList(spec.detail);
  return {
    ...parseOptions(spec),
    key,
    status,
    columns,
    ...(cardTitle ? { cardTitle } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * 把 wire 上的 `unknown` spec 解析成可渲染的形状；`undefined` = 渲染不了。
 *
 * 归一化的部分（下游因此不必再兜底）：`chart.y` 一律是数组、`chart.type` / `chart.scale`
 * 一律有值、空字符串 / 空白串一律当缺席。
 */
export function parseArtifactPresetSpec(
  kind: ArtifactPresetKind,
  spec: unknown,
): ArtifactPresetSpec | undefined {
  if (!isRecord(spec)) {
    return undefined;
  }
  switch (kind) {
    case "chart":
      return parseChartSpec(spec);
    case "table":
      return parseTableSpec(spec);
    case "metrics":
      return parseMetricsSpec(spec);
    case "board":
      return parseBoardSpec(spec);
    default:
      return undefined;
  }
}

/** `chart.y` 归一化后的读法；解析过的 spec 一定是数组，这里只做类型收窄。 */
export function chartSeriesFields(spec: ChartSpec): ArtifactField[] {
  return Array.isArray(spec.y) ? spec.y : [spec.y];
}

/** 字段在界面上的名字：显式 `label` 优先，否则用点路径本身。 */
export function artifactFieldLabel(field: ArtifactField): string {
  return field.label ?? field.field;
}
