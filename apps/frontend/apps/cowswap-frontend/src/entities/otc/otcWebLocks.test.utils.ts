/** A shared exclusive lock across Jotai stores; mirrors native ifAvailable semantics. */
export function installOtcWebLocksMock(): void {
  const active = new Set<string>()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (name: string, options: LockOptions, callback: LockGrantedCallback<void>) => {
        if (!options.ifAvailable) throw new Error('The OTC lock must not queue wallet actions')
        if (active.has(name)) return callback(null)
        active.add(name)
        try {
          return await callback({ name, mode: 'exclusive' })
        } finally {
          active.delete(name)
        }
      }),
    },
  })
}
