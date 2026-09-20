import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const frontendRoot = resolve(repositoryRoot, 'frontend')

function outputArgument() {
  const equals = process.argv.find((argument) => argument.startsWith('--output='))
  if (equals) return equals.slice('--output='.length)
  const index = process.argv.indexOf('--output')
  if (index === -1) return ''
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error('--output requires a destination file path.')
  }
  return value
}

const raw = (process.env.CLIPFLOW_WORKER_ORIGIN || '').trim().replace(/\/$/, '')
if (!raw) {
  throw new Error('CLIPFLOW_WORKER_ORIGIN is required; refusing a localhost fallback.')
}

let origin
try {
  origin = new URL(raw)
} catch {
  throw new Error('CLIPFLOW_WORKER_ORIGIN must be a valid HTTPS origin.')
}

if (
  origin.protocol !== 'https:' ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  /^(localhost\.?|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)$/i.test(origin.hostname.replace(/^\[|\]$/g, ''))
) {
  throw new Error('CLIPFLOW_WORKER_ORIGIN must be a public HTTPS origin, never localhost.')
}

const workerOrigin = origin.origin
const outputPath = resolve(
  process.cwd(),
  outputArgument() || process.env.CLIPFLOW_VERCEL_CONFIG || resolve(repositoryRoot, 'vercel.json'),
)
const frontendProject = resolve(dirname(outputPath)) === frontendRoot
const config = {
  framework: 'vite',
  installCommand: frontendProject ? 'npm ci' : 'npm ci --prefix frontend',
  buildCommand: frontendProject ? 'npm run build' : 'npm run build --prefix frontend',
  outputDirectory: frontendProject ? 'dist' : 'frontend/dist',
  rewrites: [
    { source: '/api/:path*', destination: `${workerOrigin}/api/:path*` },
    { source: '/media/:path*', destination: `${workerOrigin}/media/:path*` },
    { source: '/((?!api/|media/|assets/|fonts/).*)', destination: '/index.html' },
  ],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
      ],
    },
  ],
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Wrote ${outputPath}`)
