interface PdfJsDocumentOptions {
  cMapPacked: true;
  cMapUrl: string;
}

export function createPdfJsDocumentOptions(
  viteBaseUrl: string,
  documentUrl: string,
): PdfJsDocumentOptions {
  const applicationBaseUrl = new URL(viteBaseUrl, documentUrl);
  return {
    cMapPacked: true,
    cMapUrl: new URL("pdfjs/cmaps/", applicationBaseUrl).href,
  };
}
