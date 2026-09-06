/**
 * The deploy allowlist.
 *
 * Uploading a build directory blind is how a scratch page reaches a public URL:
 * anything that has ever been dropped in `public/`, any second entry point
 * added while debugging, any stray file left by a tool. None of it is visible
 * in a diff of the app, and none of it announces itself once it is live.
 *
 * So the deploy publishes a NAMED set of top-level entries, and an entry that
 * is neither named nor exempted fails the build. Adding a page to the site is
 * then a deliberate line in this file with a reason next to it, which is the
 * point: the default answer to "should this be on the internet" is no.
 *
 * Run: npm run deploy:check   (after `npm run build`)
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const DIST = resolve(process.cwd(), 'dist')

/**
 * What is allowed to reach the public URL, and why.
 *
 * `shader.html` is the deliberate case. It is a development tool that ships,
 * because dragging the pressure slider is the fastest possible explanation of
 * what this project is — but the app never links to it and it carries
 * `<meta name="robots" content="noindex">`, so it is reachable rather than
 * published.
 */
const ALLOWED = new Map<string, string>([
  ['index.html', 'the app'],
  ['shader.html', 'the surface lab: linked from the README, never from the app, noindex'],
  ['assets', "Vite's hashed bundle output"],
  ['favicon.svg', 'the tab icon, from public/'],
  ['og.jpg', 'the link preview: a frame of our own shader, captured per docs/og.md'],
])

function main(): void {
  if (!existsSync(DIST)) {
    console.error('No dist/. Run `npm run build` first.')
    process.exit(1)
  }

  const entries = readdirSync(DIST).sort()
  const unexpected = entries.filter((entry) => !ALLOWED.has(entry))
  const missing = [...ALLOWED.keys()].filter((entry) => !entries.includes(entry))

  console.log(`Deploy manifest — ${entries.length} top-level entries in dist/`)
  console.log('')
  for (const entry of entries) {
    const kind = statSync(resolve(DIST, entry)).isDirectory() ? 'dir ' : 'file'
    const reason = ALLOWED.get(entry)
    console.log(`  ${kind}  ${entry.padEnd(16)}${reason ?? 'NOT ALLOWED'}`)
  }
  console.log('')

  for (const entry of unexpected) {
    console.error(
      `  ${entry} is not in the deploy allowlist. Add it to scripts/deploy-manifest.ts ` +
        `with a reason, or keep it out of the build.`,
    )
  }
  for (const entry of missing) {
    console.error(`  ${entry} is allowlisted but the build did not produce it.`)
  }

  if (unexpected.length > 0 || missing.length > 0) process.exit(1)
  console.log('  every entry is accounted for.')
}

main()
