export async function readBody(request: Request | Response, maximum: number): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('JSON body required.')
  const parts: Uint8Array[] = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error('RPC body exceeds its supported size.')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}
