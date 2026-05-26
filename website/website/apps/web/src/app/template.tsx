"use client";

import { motion, AnimatePresence } from "motion/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Docs routes skip page transitions — avoids Turbopack/RSC "module factory is not available" on client nav. */
function isDocsPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/docs" || pathname.startsWith("/docs/");
}

export default function Template({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isDocsPath(pathname)) {
    return <>{children}</>;
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
