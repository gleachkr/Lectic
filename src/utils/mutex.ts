export class AsyncMutex {
  private locked = false
  private waiters: Array<() => void> = []

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return () => this.release()
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.locked = true
        resolve(() => this.release())
      })
    })
  }

  private release() {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.locked = false
  }

  isIdle(): boolean {
    return !this.locked && this.waiters.length === 0
  }
}

export class KeyedMutex {
  private mutexes = new Map<string, AsyncMutex>()

  async acquire(key: string): Promise<() => void> {
    let m = this.mutexes.get(key)
    if (!m) {
      m = new AsyncMutex()
      this.mutexes.set(key, m)
    }

    const release = await m.acquire()
    return () => {
      release()
      if (m && m.isIdle()) this.mutexes.delete(key)
    }
  }
}

