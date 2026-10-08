import {
  ServiceChannels,
  type ClientConfigReadOptions,
  type ClientConfigSnapshot,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 窗口级公开配置读取。业务模块只消费自己的字段，不拥有第二份请求缓存。 */
export interface IClientConfigService {
  getSnapshot(options?: ClientConfigReadOptions): Promise<ClientConfigSnapshot>;
}

export const IClientConfigService = createServiceDescriptor<IClientConfigService>(
  ServiceChannels.ClientConfig,
);
