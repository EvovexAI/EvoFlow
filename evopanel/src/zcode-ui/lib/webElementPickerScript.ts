/* eslint-disable max-lines -- Electron webview 注入脚本需要在单个函数内自包含运行，避免跨文件依赖在页面上下文里失效。 */
import type {
  WebElementContextPayload,
  WebElementRect,
  WebElementStyleSummary,
} from "@/lib/webElementContext.js";

export type WebElementPickerScriptResult =
  | { status: "cancelled" }
  | { status: "selected"; element: Omit<WebElementContextPayload, "workspacePath"> };

interface WebElementPickerScriptOptions {
  maxTextChars: number;
  maxHtmlChars: number;
  maxAttributeChars: number;
  labels: WebElementPickerScriptLabels;
}

export interface WebElementPickerScriptLabels {
  background: string;
  color: string;
  font: string;
}

type WebElementPickerScriptBuildOptions = Partial<Omit<WebElementPickerScriptOptions, "labels">> & {
  labels?: Partial<WebElementPickerScriptLabels>;
};

const DEFAULT_OPTIONS: WebElementPickerScriptOptions = {
  maxTextChars: 4_000,
  maxHtmlChars: 6_000,
  maxAttributeChars: 500,
  labels: {
    background: "Background",
    color: "Color",
    font: "Font",
  },
};

function webElementPickerScript(options: WebElementPickerScriptOptions) {
  const stateKey = "__zcodeWebElementPicker";
  const existing = (window as unknown as Record<string, { cancel?: () => void }>)[stateKey];
  existing?.cancel?.();

  const truncate = (value: string | null | undefined, maxLength: number) => {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  };

  const clampColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

  const toHexColor = (red: number, green: number, blue: number) =>
    `#${[red, green, blue]
      .map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;

  const parseAlpha = (value: string | undefined) => {
    if (!value) {
      return 1;
    }
    if (value.endsWith("%")) {
      return Number(value.slice(0, -1)) / 100;
    }
    return Number(value);
  };

  const formatComputedColor = (value: string) => {
    const normalized = value.trim();
    const match =
      /^rgba?\(\s*([0-9.]+)(?:,|\s)+([0-9.]+)(?:,|\s)+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/iu.exec(
        normalized,
      );
    if (!match) {
      return normalized;
    }

    const redValue = match[1];
    const greenValue = match[2];
    const blueValue = match[3];
    if (!redValue || !greenValue || !blueValue) {
      return normalized;
    }

    const red = Number(redValue);
    const green = Number(greenValue);
    const blue = Number(blueValue);
    const alpha = parseAlpha(match[4]);
    if ([red, green, blue, alpha].some((channel) => Number.isNaN(channel))) {
      return normalized;
    }
    if (alpha <= 0) {
      return "transparent";
    }

    return toHexColor(red, green, blue);
  };

  const readStyleSummary = (element: Element): WebElementStyleSummary => {
    const style = window.getComputedStyle(element);
    const backgroundColor = formatComputedColor(style.backgroundColor);
    return {
      ...(backgroundColor !== "transparent" ? { backgroundColor } : {}),
      color: formatComputedColor(style.color),
      display: style.display,
      fontFamily: truncate(style.fontFamily, 160),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  };

  const formatFont = (style: WebElementStyleSummary) =>
    truncate([style.fontSize, style.fontFamily].filter(Boolean).join(" "), 96);

  const formatElementSize = (rect: DOMRect) =>
    `${Math.round(rect.width)}x${Math.round(rect.height)}`;

  const hasVisibleBackground = (style: WebElementStyleSummary) =>
    Boolean(
      style.backgroundColor &&
      style.backgroundColor !== "transparent" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)",
    );

  const cssEscape = (value: string) => {
    const escape = (window.CSS as { escape?: (input: string) => string } | undefined)?.escape;
    if (escape) {
      return escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const readElementText = (element: Element) => {
    if (element instanceof HTMLInputElement) {
      if (element.type.toLowerCase() === "password") {
        return "[masked password input]";
      }
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          element.type,
        options.maxTextChars,
      );
    }

    if (element instanceof HTMLTextAreaElement) {
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          "textarea",
        options.maxTextChars,
      );
    }

    return truncate(
      (element as HTMLElement).innerText || element.textContent,
      options.maxTextChars,
    );
  };

  const getImplicitRole = (element: Element) => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") return "button";
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "img") return "img";
    if (tagName === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (tagName === "textarea") return "textbox";
    if (tagName === "select") return "combobox";
    if (tagName === "nav") return "navigation";
    if (tagName === "main") return "main";
    if (tagName === "form") return "form";
    if (/^h[1-6]$/u.test(tagName)) return "heading";
    return "";
  };

  const getAccessibleName = (element: Element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const normalizedLabel = truncate(label, options.maxTextChars);
      if (normalizedLabel) return normalizedLabel;
    }

    return truncate(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        readElementText(element),
      options.maxTextChars,
    );
  };

  const getAttributes = (element: Element) => {
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed =
        name === "id" ||
        name === "class" ||
        name === "href" ||
        name === "src" ||
        name === "alt" ||
        name === "title" ||
        name === "name" ||
        name === "type" ||
        name === "placeholder" ||
        name.startsWith("aria-");
      if (!allowed || name === "value") {
        continue;
      }
      attributes[name] = truncate(attribute.value, options.maxAttributeChars);
    }
    return attributes;
  };

  const getSelector = (element: Element) => {
    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const tagName = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${tagName}#${cssEscape(current.id)}`);
        break;
      }

      const currentTagName = current.tagName;
      const classNames = Array.from(current.classList)
        .filter(Boolean)
        .slice(0, 2)
        .map((className) => `.${cssEscape(className)}`)
        .join("");
      let part = `${tagName}${classNames}`;
      const parentElement: Element | null = current.parentElement;
      if (parentElement) {
        const sameTagSiblings = Array.from(parentElement.children).filter(
          (sibling): sibling is Element =>
            sibling instanceof Element && sibling.tagName === currentTagName,
        );
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parentElement;
    }

    return parts.join(" > ");
  };

  const getXPath = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 12) {
      const tagName = current.tagName.toLowerCase();
      const currentTagName = current.tagName;
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) {
        parts.unshift(`/${tagName}`);
        break;
      }
      const sameTagSiblings = Array.from(parentElement.children).filter(
        (sibling): sibling is Element =>
          sibling instanceof Element && sibling.tagName === currentTagName,
      );
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(`${tagName}[${index}]`);
      current = parentElement;
    }
    return `/${parts.join("/")}`.replace(/^\/\//u, "/");
  };

  const getNearbyText = (element: Element) => {
    const container =
      element.closest("article, section, main, form, li, tr, dialog") ||
      element.parentElement ||
      element;
    return truncate(
      (container as HTMLElement).innerText || container.textContent,
      options.maxTextChars,
    );
  };

  const getHtmlExcerpt = (element: Element) => {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) {
      return "";
    }
    clone.querySelectorAll("script, style, noscript, template").forEach((node) => {
      node.remove();
    });
    clone.querySelectorAll("input, textarea").forEach((node) => {
      if (node instanceof HTMLInputElement) {
        node.removeAttribute("value");
        if (node.type.toLowerCase() === "password") {
          node.setAttribute("type", "password");
        }
      }
      if (node instanceof HTMLTextAreaElement) {
        node.textContent = "";
      }
    });
    return truncate(clone.outerHTML, options.maxHtmlChars);
  };

  const rectToPlainObject = (rect: DOMRect): WebElementRect => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });

  const overlay = document.createElement("div");
  overlay.setAttribute("data-zcode-web-element-picker", "overlay");
  Object.assign(overlay.style, {
    background: "rgba(37, 99, 235, 0.12)",
    border: "2px solid #2563eb",
    borderRadius: "4px",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.10)",
    boxSizing: "border-box",
    display: "none",
    left: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement("div");
  Object.assign(label.style, {
    backdropFilter: "blur(10px)",
    background: "rgba(17, 24, 39, 0.92)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    borderRadius: "18px",
    boxShadow: "0 18px 38px rgba(15, 23, 42, 0.28)",
    boxSizing: "border-box",
    color: "#f9fafb",
    display: "none",
    font: "12px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    left: "0",
    maxWidth: "calc(100vw - 16px)",
    minWidth: "214px",
    padding: "12px 18px 14px",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "min(320px, calc(100vw - 16px))",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  document.documentElement.append(overlay, label);

  let hoveredElement: Element | null = null;
  let settled = false;
  let finishPicker: ((result: WebElementPickerScriptResult) => void) | null = null;

  const cleanup = () => {
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    overlay.remove();
    label.remove();
    delete (window as unknown as Record<string, unknown>)[stateKey];
    document.documentElement.style.cursor = "";
  };

  const appendPopoverRow = (name: string, value: string | undefined) => {
    if (!value) {
      return;
    }

    const row = document.createElement("div");
    Object.assign(row.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr)",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const nameNode = document.createElement("span");
    nameNode.textContent = name;
    Object.assign(nameNode.style, {
      color: "rgba(255, 255, 255, 0.62)",
      fontSize: "15px",
      fontWeight: "600",
      minWidth: "0",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const valueNode = document.createElement("span");
    valueNode.textContent = value;
    Object.assign(valueNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "700",
      minWidth: "0",
      overflow: "hidden",
      textAlign: "right",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    row.append(nameNode, valueNode);
    label.append(row);
  };

  const renderPopover = (target: Element, rect: DOMRect) => {
    const style = readStyleSummary(target);
    label.replaceChildren();

    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const tagNode = document.createElement("span");
    tagNode.textContent = target.tagName.toLowerCase();
    Object.assign(tagNode.style, {
      color: "#ffffff",
      fontSize: "16px",
      fontWeight: "800",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const sizeNode = document.createElement("span");
    sizeNode.textContent = formatElementSize(rect);
    Object.assign(sizeNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "800",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    header.append(tagNode, sizeNode);
    label.append(header);
    appendPopoverRow(options.labels.color, style.color);
    if (hasVisibleBackground(style)) {
      appendPopoverRow(options.labels.background, style.backgroundColor);
    }
    appendPopoverRow(options.labels.font, formatFont(style));
  };

  const clampPosition = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  const getPopoverPosition = (rect: DOMRect, labelWidth: number, labelHeight: number) => {
    const padding = 8;
    const gap = 12;
    const maxLeft = Math.max(padding, window.innerWidth - labelWidth - padding);
    const maxTop = Math.max(padding, window.innerHeight - labelHeight - padding);
    const centeredLeft = rect.left + rect.width / 2 - labelWidth / 2;
    const centeredTop = rect.top + rect.height / 2 - labelHeight / 2;
    const candidates = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.bottom + gap,
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.top - labelHeight - gap,
      },
      {
        left: rect.right + gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: rect.left - labelWidth - gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ];
    const viewportSafeCandidate = candidates.find(
      (candidate) =>
        candidate.left >= padding &&
        candidate.top >= padding &&
        candidate.left + labelWidth <= window.innerWidth - padding &&
        candidate.top + labelHeight <= window.innerHeight - padding,
    );

    if (viewportSafeCandidate) {
      return viewportSafeCandidate;
    }

    const availableSpaces = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: window.innerHeight - rect.bottom - padding,
        top: clampPosition(rect.bottom + gap, padding, maxTop),
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: rect.top - padding,
        top: clampPosition(rect.top - labelHeight - gap, padding, maxTop),
      },
      {
        left: clampPosition(rect.right + gap, padding, maxLeft),
        size: window.innerWidth - rect.right - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: clampPosition(rect.left - labelWidth - gap, padding, maxLeft),
        size: rect.left - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ].sort((a, b) => b.size - a.size);

    // 交互修正：目标元素靠近边缘或几乎铺满视口时，浮窗无法完全放到元素外侧。
    // 这时选择可用空间最大的方向，并继续夹在视口内，尽量减少对当前选区的遮挡。
    return availableSpaces[0] ?? { left: padding, top: padding };
  };

  const updateOverlay = (target: Element | null) => {
    if (!target || target === overlay || target === label || label.contains(target)) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    overlay.style.display = "block";
    overlay.style.left = `${Math.max(0, rect.left)}px`;
    overlay.style.top = `${Math.max(0, rect.top)}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    label.style.display = "block";
    renderPopover(target, rect);

    const labelWidth = label.offsetWidth || 240;
    const labelHeight = label.offsetHeight || 90;
    const position = getPopoverPosition(rect, labelWidth, labelHeight);
    label.style.left = `${position.left}px`;
    label.style.top = `${position.top}px`;
  };

  function handleMouseMove(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    hoveredElement = target;
    updateOverlay(target);
  }

  function collectElement(element: Element): Omit<WebElementContextPayload, "workspacePath"> {
    const rect = element.getBoundingClientRect();
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || getImplicitRole(element) || undefined,
      accessibleName: getAccessibleName(element) || undefined,
      selector: getSelector(element),
      xpath: getXPath(element),
      text: readElementText(element) || undefined,
      nearbyText: getNearbyText(element) || undefined,
      htmlExcerpt: getHtmlExcerpt(element) || undefined,
      attributes: getAttributes(element),
      rect: rectToPlainObject(rect),
      style: readStyleSummary(element),
      capturedAt: Date.now(),
    };
  }

  function handleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!hoveredElement) {
      finishPicker?.({ status: "cancelled" });
      return;
    }
    finishPicker?.({
      status: "selected",
      element: collectElement(hoveredElement),
    });
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    finishPicker?.({ status: "cancelled" });
  }

  return new Promise<WebElementPickerScriptResult>((resolve) => {
    const finish = (result: WebElementPickerScriptResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    finishPicker = finish;

    function cancel() {
      finish({ status: "cancelled" });
    }

    (window as unknown as Record<string, { cancel: () => void }>)[stateKey] = {
      cancel,
    };

    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
  });
}

export function buildWebElementPickerScript(options: WebElementPickerScriptBuildOptions = {}) {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    labels: {
      ...DEFAULT_OPTIONS.labels,
      ...options.labels,
    },
  };
  return `(${webElementPickerScript.toString()})(${JSON.stringify(resolvedOptions)})`;
}

export function buildCancelWebElementPickerScript() {
  return [
    "(() => {",
    "const picker = window.__zcodeWebElementPicker;",
    "if (picker && typeof picker.cancel === 'function') picker.cancel();",
    "})()",
  ].join("\n");
}
