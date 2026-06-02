"use client";

import type { AnchorHTMLAttributes } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { staticPageHref } from "@ai-site/content";

const markdownComponents: Partial<Components> = {
  a({ href, children, ...props }) {
    if (href?.startsWith("/")) {
      return (
        <Link
          href={staticPageHref(href)}
          className="font-medium text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary"
        >
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        className="font-medium text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary"
        rel="noreferrer"
        target="_blank"
        {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  },
};

const articleClassName = [
  "docs-markdown max-w-none text-[15px] leading-relaxed text-foreground",
  "[&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:font-display-ui [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-[-0.04em] [&_h1]:text-foreground",
  "[&_h2]:mt-10 [&_h2]:border-b [&_h2]:border-outline-variant/25 [&_h2]:pb-2 [&_h2]:font-display-ui [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground [&_h2]:first:mt-0",
  "[&_h3]:mt-6 [&_h3]:font-display-ui [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground",
  "[&_p]:mt-3 [&_p]:text-foreground-muted [&_p]:first:mt-0",
  "[&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-foreground-muted",
  "[&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_ol]:text-foreground-muted",
  "[&_li]:marker:text-foreground-muted/60",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
  "[&_code]:rounded-md [&_code]:border [&_code]:border-outline-variant/25 [&_code]:bg-surface-high/50 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-foreground",
  "[&_pre]:mt-4 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-outline-variant/25 [&_pre]:bg-surface-lowest [&_pre]:p-4",
  "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px]",
  "[&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-sm",
  "[&_th]:border-b [&_th]:border-outline-variant/30 [&_th]:bg-surface-high/40 [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium [&_th]:text-foreground",
  "[&_td]:border-b [&_td]:border-outline-variant/15 [&_td]:px-3 [&_td]:py-2 [&_td]:text-foreground-muted",
  "[&_blockquote]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-4 [&_blockquote]:text-foreground-muted [&_blockquote]:italic",
  "[&_hr]:my-10 [&_hr]:border-outline-variant/20",
  "[&_img]:mt-4 [&_img]:max-w-full [&_img]:rounded-xl [&_img]:border [&_img]:border-outline-variant/20 [&_img]:shadow-sm",
].join(" ");

export function DocMarkdown({ markdown }: { markdown: string }) {
  return (
    <article className={articleClassName}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
