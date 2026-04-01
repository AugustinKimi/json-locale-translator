export function chunkObject(
  obj: Record<string, string>,
  size: number,
): Array<Record<string, string>> {
  const chunks: Array<Record<string, string>> = []
  const entries = Object.entries(obj)
  for (let i = 0; i < entries.length; i += size) {
    const chunk: Record<string, string> = {}
    for (const [key, value] of entries.slice(i, i + size)) {
      chunk[key] = value
    }
    chunks.push(chunk)
  }
  return chunks
}

export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let index = 0

  const worker = async (): Promise<void> => {
    while (index < tasks.length) {
      const current = index++
      results[current] = await tasks[current]()
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}
