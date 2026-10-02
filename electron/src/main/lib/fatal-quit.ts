export async function quitAfterDialog(
  show: () => Promise<void>,
  quit: () => void,
  log: (message: string) => void,
): Promise<void> {
  try {
    await show();
  } catch (err) {
    log(`[fatal dialog error] ${(err as Error)?.message ?? String(err)}\n`);
  } finally {
    quit();
  }
}

export async function runStartupAfterBootstrap(
  bootstrap: () => Promise<void>,
  isShuttingDown: () => boolean,
  continueStartup: () => Promise<void>,
): Promise<'continued' | 'shutdown'> {
  await bootstrap();
  if (isShuttingDown()) return 'shutdown';
  await continueStartup();
  return 'continued';
}
