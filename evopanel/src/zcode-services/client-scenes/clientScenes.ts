import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ClientSceneResponseBody<T> {
  code: number;
  msg: string;
  data: T;
}

export interface ClientSceneConfig {
  namespace: string;
  scene: string;
  options: Record<string, ClientSceneOption>;
  created_at?: number;
  updated_at?: number;
}

export interface ClientSceneOption {
  id: string;
  type: string;
  /** 选项标题 i18n。 */
  contents: Record<string, string>;
  /** 提示词 i18n。 */
  prompts?: Record<string, string>;
  /** 无筛选时展示的选项。 */
  items?: ClientSceneItem[];
  /** 受哪个 option.type 筛选。 */
  refer?: string;
  /** 其他 option 的 itemId 到筛选后选项的映射。 */
  cascades?: Record<string, ClientSceneItem[]>;
  /** prompt 模板 i18n。 */
  templates?: Record<string, string>;
}

export interface ClientSceneItem {
  id: string;
  type: string;
  /** 选项标题 i18n。 */
  contents: Record<string, string>;
  /** 选项描述 i18n。 */
  descs?: Record<string, string>;
  /** 选项标签 i18n。 */
  labels: Record<string, string>;
  /** 对话完成后的触发事件。 */
  on_finish?: string | null;
  /** Lucide canonical 图标名（kebab-case）。 */
  img?: string | null;
  /** 兼容保留字段；当前首页与 Automations 图标不消费。 */
  imgs?: {
    cn?: string;
    en?: string;
  };
  share_urls?: Record<string, string>;
  defaults?: Record<string, string[]>;
}

export type ClientScenesResponse = ClientSceneResponseBody<ClientSceneConfig[]>;

export interface IClientScenesService {
  list(): Promise<ClientScenesResponse>;
}

export const IClientScenesService = createServiceDescriptor<IClientScenesService>(
  ServiceChannels.ClientScenes,
);
