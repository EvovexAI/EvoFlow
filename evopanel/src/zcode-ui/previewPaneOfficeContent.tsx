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
    fallback: ReactNode;
    resetKey: string;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("[PreviewPane] Office 预览组件渲染失败", {
      error: error.message,
      componentStack: info.componentStack ?? "",
    });
  }

  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
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

  const fallback = <OfficePreviewErrorMessage>{errorMessage}</OfficePreviewErrorMessage>;

  return (
    <OfficePreviewErrorBoundary
      fallback={fallback}
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
