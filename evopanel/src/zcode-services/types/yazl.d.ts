declare module "yazl" {
  import { EventEmitter } from "node:events";
  import type { Readable } from "node:stream";

  type LazyReadStreamCallback = (error: Error | null, stream?: Readable) => void;

  export class ZipFile extends EventEmitter {
    readonly outputStream: Readable;

    addFile(realPath: string, metadataPath: string): void;
    addBuffer(buffer: Buffer, metadataPath: string): void;
    addReadStreamLazy(
      metadataPath: string,
      getReadStreamFunction: (callback: LazyReadStreamCallback) => void,
    ): void;
    end(): void;
  }
}
