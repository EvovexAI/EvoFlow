class OversizedInlineAttachmentError extends Error {
  readonly filename: string;
  readonly maxSizeBytes: number;
  readonly sizeBytes: number;

  constructor(
    name: string,
    message: string,
    options: { filename: string; maxSizeBytes: number; sizeBytes: number },
  ) {
    super(message);
    this.name = name;
    this.filename = options.filename;
    this.maxSizeBytes = options.maxSizeBytes;
    this.sizeBytes = options.sizeBytes;
  }
}

export class OversizedInlineImageAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlineImageAttachmentError", "oversized-inline-image-attachment", options);
  }
}

export class OversizedInlineVideoAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlineVideoAttachmentError", "oversized-inline-video-attachment", options);
  }
}

export class OversizedInlinePdfAttachmentError extends OversizedInlineAttachmentError {
  constructor(options: { filename: string; maxSizeBytes: number; sizeBytes: number }) {
    super("OversizedInlinePdfAttachmentError", "oversized-inline-pdf-attachment", options);
  }
}

export class MissingInlinePdfContentError extends Error {
  readonly filename: string;
  readonly sizeBytes: number;

  constructor(options: { filename: string; sizeBytes: number }) {
    super("missing-inline-pdf-content");
    this.name = "MissingInlinePdfContentError";
    this.filename = options.filename;
    this.sizeBytes = options.sizeBytes;
  }
}

export class MissingInlineImageContentError extends Error {
  readonly filename: string;
  readonly sizeBytes: number;

  constructor(options: { filename: string; sizeBytes: number }) {
    super("missing-inline-image-content");
    this.name = "MissingInlineImageContentError";
    this.filename = options.filename;
    this.sizeBytes = options.sizeBytes;
  }
}
