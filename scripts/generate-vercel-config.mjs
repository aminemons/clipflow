import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
const config = {
  framework: 'vite',
  installCommand: 'npm ci --prefix frontend',
  buildCommand: 'npm run build --prefix frontend',
  outputDirectory: 'frontend/dist',
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

writeFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), `${JSON.stringify(config, null, 2)}\n`)
