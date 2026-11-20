const recheckMs = 30_000;

export async function runAlarmCycle({
  storage,
  now,
  reconcile,
  failed,
}: {
  storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">;
  now: () => number;
  reconcile: () => Promise<boolean>;
  failed: (error: unknown) => void;
}) {
  const armed = now() + recheckMs;
  await storage.setAlarm(armed);
  let watching: boolean;
  try {
    watching = await reconcile();
  } catch (error) {
    failed(error);
    return;
  }
  if (!watching && (await storage.getAlarm()) === armed) await storage.deleteAlarm();
}
