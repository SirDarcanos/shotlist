// Serve a directory over HTTP, so a test can point a recipe at a real URL.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const [, , port, root] = process.argv

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost')
  try {
    response.end(await readFile(join(root, pathname === '/' ? 'index.html' : pathname)))
  } catch {
    response.statusCode = 404
    response.end('not found')
  }
}).listen(Number(port), () => console.log(`ready on ${port}`))
