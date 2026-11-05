"use strict";

const path = require("node:path");

const { readGrokBillingRefreshIntervalMs } = require("./grok-billing-prefs");

/** @type {{ stop: () => void, reschedule: () => void } | null} */
let activeLoop = null;

function startGrokBillingRefreshLoop({
  queuePath,
  refreshBillingAndMerge,
  refreshMergedUsageOnly,
  migrateLegacy,
  platform = process.platform,
}) {
  activeLoop?.stop();

  const trackerDir = path.dirname(queuePath);
  let billingTimer = null;
  let mergeTimer = null;
  let stopped = false;

  const scheduleBilling = () => {
    if (stopped) return;
    if (billingTimer) clearTimeout(billingTimer);
    const delayMs = readGrokBillingRefreshIntervalMs(trackerDir);
    billingTimer = setTimeout(() => {
      void refreshBillingAndMerge()
        .catch(() => {})
        .finally(scheduleBilling);
    }, delayMs);
    if (typeof billingTimer.unref === "function") billingTimer.unref();
  };

  const reschedule = () => {
    if (stopped) return;
    if (billingTimer) clearTimeout(billingTimer);
    scheduleBilling();
  };

  const stop = () => {
    stopped = true;
    if (billingTimer) clearTimeout(billingTimer);
    if (mergeTimer) clearInterval(mergeTimer);
    billingTimer = null;
    mergeTimer = null;
    if (activeLoop?.stop === stop) activeLoop = null;
  };

  if (platform === "win32" && typeof migrateLegacy === "function") {
    migrateLegacy().catch(() => {});
  }

  void refreshBillingAndMerge().catch(() => {}).finally(scheduleBilling);
  mergeTimer = setInterval(() => {
    void refreshMergedUsageOnly().catch(() => {});
  }, 30_000);
  if (typeof mergeTimer.unref === "function") mergeTimer.unref();

  activeLoop = { stop, reschedule };
  return activeLoop;
}

function rescheduleGrokBillingRefresh() {
  activeLoop?.reschedule();
}

module.exports = {
  startGrokBillingRefreshLoop,
  rescheduleGrokBillingRefresh,
};
