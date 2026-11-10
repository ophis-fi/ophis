/** Bounded concurrency for independent read-only RPC work; stop scheduling after the first failure. */
export async function pooledCreditReads<T, R>(items: readonly T[], work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0, failed = false, failure: unknown
  const workers = Array.from({ length: Math.min(16, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await work(items[index], index) }
      catch (error) { failed = true; failure ??= error }
    }
  })
  await Promise.all(workers)
  if (failed) throw failure
  return results
}
