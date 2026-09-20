/** Telegram rejects acknowledgements for callbacks older than its response window. */
export async function answerCallbackQueryBestEffort(answer: () => Promise<unknown>): Promise<void> {
    try {
        await answer();
    } catch {
        // The callback update itself is still handled; an expired acknowledgement is non-fatal.
    }
}
