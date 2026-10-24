import { Component, lazy, Suspense, useMemo, type ErrorInfo, type ReactNode } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { decodeBase64ToArrayBuffer, type OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

const LazyXlsxContent = lazy(async () => {
  const module = await import("@/previewPaneOfficeXlsxContent.js");
  return { default: module.PreviewPaneOfficeXlsxContent };
});

const LazyDocxContent = lazy(async () => {
  const module = await import("@/previewPaneOfficeDocxContent.js");
  return { default: module.PreviewPaneOfficeDocxContent };
});

const LazyLegacyDocContent = lazy(async () => {
  const module = await import("@/previewPaneOfficeLegacyDocContent.js");
  return { default: module.PreviewPaneOfficeLegacyDocContent };
});

class OfficePreviewErrorBoundary extends Component<
  {
    children: ReactNode;
    fallbackMessage: string;
    resetKey: string;
  },
  { detail: string | null; hasError: boolean }
> {
  state = { detail: null as string | null, hasError: false };

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("[PreviewPane] Office 预览组件渲染失败", {
      error: error.message,
      componentStack: info.componentStack ?? "",
    });
  }

  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, detail: null });
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <OfficePreviewErrorMessage>
        <div>{this.props.fallbackMessage}</div>
        {this.state.detail ? (
          <div className="mt-1 text-ui-sm text-foreground-subtle break-all">{this.state.detail}</div>
        ) : null}
      </OfficePreviewErrorMessage>
    );
  }
}

function OfficePreviewLoading() {
  return (
    <div
      aria-busy="true"
      className="h-full min-h-0 w-full bg-background"
      data-office-preview-pending
    />
  );
}

function OfficePreviewErrorMessage({ children }: { children: ReactNode }) {
  return (
    <div className="p-3 text-ui-base text-destructive" role="alert">
      {children}
    </div>
  );
}

export function PreviewPaneOfficeContent({
  error,
  kind,
  loading,
  onOpenBrowserUrl,
  preview,
  resolvedTheme,
  sourcePath,
}: {
  error: string | null;
  kind: OfficeFilePreviewKind;
  loading: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  preview: FileBinaryPreview | null;
  resolvedTheme: "light" | "dark";
  sourcePath: string;
}) {
  const { intl } = useZCodeIntl();
  const errorMessage = intl.formatMessage({
    id: "codeViewer.officeUnavailable",
  });
  const buffer = useMemo(
    () => (preview ? decodeBase64ToArrayBuffer(preview.dataBase64) : null),
    [preview],
  );

  if (loading || (!error && !buffer)) {
    return <OfficePreviewLoading />;
  }
  if (error || !buffer) {
    return <OfficePreviewErrorMessage>{error ?? errorMessage}</OfficePreviewErrorMessage>;
  }

  return (
    <OfficePreviewErrorBoundary
      fallbackMessage={errorMessage}
      resetKey={`${kind}:${sourcePath}:${preview?.totalBytes ?? 0}`}
    >
      <Suspense fallback={<OfficePreviewLoading />}>
        {kind === "excel" ? (
          <LazyXlsxContent
            buffer={buffer}
            errorMessage={errorMessage}
            isDark={resolvedTheme === "dark"}
            onOpenBrowserUrl={onOpenBrowserUrl}
            sourcePath={sourcePath}
          />
        ) : kind === "docx" ? (
          <LazyDocxContent
            buffer={buffer}
            errorMessage={errorMessage}
            onOpenBrowserUrl={onOpenBrowserUrl}
            sourcePath={sourcePath}
          />
        ) : (
          <LazyLegacyDocContent
            buffer={buffer}
            errorMessage={errorMessage}
            onOpenBrowserUrl={onOpenBrowserUrl}
            sourcePath={sourcePath}
          />
        )}
      </Suspense>
    </OfficePreviewErrorBoundary>
  );
}
