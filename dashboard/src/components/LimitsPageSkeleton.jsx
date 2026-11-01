import React from "react";
import { cn } from "../lib/cn";

/** 与 UsageLimitsPanel 的 DEFAULT_ORDER 及每组最多条数一致 */
const PROVIDER_BAR_COUNTS = [3, 2, 3, 3, 2, 2, 3];

function Bone({ className }) {
  return (
    <div
      className={cn(
        "rounded bg-oai-gray-200/70 dark:bg-oai-gray-800/70 animate-pulse",
        className,
      )}
    />
  );
}

/** 对齐 LimitBar 一行：label w-12 + 圆条 + 百分比 w-[30px] + reset w-6 */
function SkeletonBarRow() {
  return (
    <div className="flex items-center gap-2">
      <Bone className="h-3 w-12 shrink-0" />
      <Bone className="flex-1 h-1.5 rounded-full min-w-0" />
      <Bone className="h-3 w-[30px] shrink-0" />
      <Bone className="h-3 w-6 shrink-0" />
    </div>
  );
}

/** Match the provider cards shown after limits load. */
function SkeletonProvider({ bars, index }) {
  const nameW = index % 3 === 0 ? "w-24" : index % 3 === 1 ? "w-20" : "w-[4.5rem]";
  return (
    <div className="rounded-xl border border-oai-gray-200 bg-white dark:border-oai-gray-800 dark:bg-oai-gray-900">
      <div className="flex items-center gap-3 border-b border-oai-gray-200 px-4 py-4 dark:border-oai-gray-800 sm:px-5">
        <Bone className="h-[22px] w-[22px] shrink-0 rounded" />
        <Bone className={cn("h-4", nameW)} />
      </div>
      <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
        {Array.from({ length: bars }, (_, i) => <SkeletonBarRow key={i} />)}
      </div>
    </div>
  );
}

export function LimitsPageSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {PROVIDER_BAR_COUNTS.map((bars, i) => <SkeletonProvider key={i} bars={bars} index={i} />)}
    </div>
  );
}
