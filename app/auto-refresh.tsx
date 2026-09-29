"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the server page on an interval so new history shows up without a reload.
export function AutoRefresh({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), ms);
    return () => clearInterval(timer);
  }, [router, ms]);
  return null;
}
