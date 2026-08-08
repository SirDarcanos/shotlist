import { describe, expect, it } from 'vitest'
import { checkCommand, checkPath, checkUrl, hostsFor, secretIn, trustFrom } from '../src/trust.js'

const SITE = 'https://rollful.dev/'
const own = (allow: string[] = []) => trustFrom({ root: '/project', siteUrl: SITE, allow }, false)
const strange = (allow: string[] = []) =>
  trustFrom({ root: '/project', siteUrl: SITE, allow }, true)

// A shot list belongs to a site. Opening something else is a mistake far more often than
// an intention, so it is the config that has to say when it is one.
describe('the site a shot list covers', () => {
  it('covers the site itself and everything under it', () => {
    for (const url of [
      'https://rollful.dev/',
      'https://rollful.dev/docs/api',
      'https://api.rollful.dev/v1/roll',
      'http://staging.eu.rollful.dev/',
    ]) {
      expect(() => checkUrl(own(), url, '`url`')).not.toThrow()
    }
  })

  it('covers the apex when the site is written with www', () => {
    expect(hostsFor('https://www.rollful.dev/')).toContain('rollful.dev')
    const site = trustFrom({ root: '/p', siteUrl: 'https://www.rollful.dev/' }, false)
    expect(() => checkUrl(site, 'https://api.rollful.dev/', '`url`')).not.toThrow()
  })

  it('refuses somewhere else, and says where to say otherwise', () => {
    expect(() => checkUrl(own(), 'https://google.com/', '`url`')).toThrow(
      /google\.com is not this site.*site\.allow/s,
    )
    // A near-miss is still a different site: nothing infers one domain from another.
    expect(() => checkUrl(own(), 'https://rollful.dev.evil.test/', '`url`')).toThrow(
      /not this site/,
    )
  })

  it('opens what the config named as well', () => {
    expect(() =>
      checkUrl(own(['accounts.google.com']), 'https://accounts.google.com/o', 'x'),
    ).not.toThrow()
    // Under it, too — a sign-in provider is rarely one host.
    expect(() =>
      checkUrl(own(['example.test']), 'https://cdn.example.test/x.png', 'x'),
    ).not.toThrow()
  })

  it('leaves a file: page alone, which reaches no network at all', () => {
    expect(() => checkUrl(own(), 'file:///tmp/page.html', '`url`')).not.toThrow()
  })
})

// At a desk the config is one you wrote. In CI on a fork's pull request, or in a service
// shooting what somebody submitted, it arrives from outside — and the machine running it
// has credentials, a network position, and other people's work on it.
describe('a config that is not the operator’s', () => {
  it('is trusted unless the operator says otherwise', () => {
    expect(own().untrusted).toBe(false)
    expect(() => checkCommand(own(), 'site.serve')).not.toThrow()
    expect(() => checkPath(own(), '/etc/hosts', 'x')).not.toThrow()
  })

  it('is settled by the environment too, for automation with a fixed command line', () => {
    const before = process.env['SHOTLIST_UNTRUSTED']
    try {
      process.env['SHOTLIST_UNTRUSTED'] = '1'
      expect(own().untrusted).toBe(true)
      process.env['SHOTLIST_UNTRUSTED'] = '0'
      expect(own().untrusted).toBe(false)
    } finally {
      if (before === undefined) delete process.env['SHOTLIST_UNTRUSTED']
      else process.env['SHOTLIST_UNTRUSTED'] = before
    }
  })

  it('never starts a process', () => {
    expect(() => checkCommand(strange(), 'site.serve')).toThrow(/does not start processes/)
  })

  it('ignores the config widening its own reach', () => {
    // The whole point of the flag: `site.allow` is a claim by the thing being distrusted.
    expect(() => checkUrl(own(['evil.test']), 'https://evil.test/', '`url`')).not.toThrow()
    expect(() => checkUrl(strange(['evil.test']), 'https://evil.test/', '`url`')).toThrow(
      /not this site/,
    )
  })

  it('opens nothing but http(s)', () => {
    expect(() => checkUrl(strange(), 'file:///etc/passwd', '`url`')).toThrow(/may only open http/)
    expect(() => checkUrl(strange(), 'data:text/html,x', '`url`')).toThrow(/may only open http/)
    expect(() => checkUrl(strange(), 'not a url', '`url`')).toThrow(/is not a URL/)
  })

  // A build runner can reach the cloud's metadata endpoint, an internal admin page and a
  // database — none of which is reachable from where the config was written.
  it('opens nothing on the network the runner sits in, even as its own site', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://127.0.0.1:8080/admin',
      'http://localhost:5432/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.20.0.3/',
    ]) {
      const host = new URL(url).hostname
      const inside = trustFrom({ root: '/p', siteUrl: `http://${host}/` }, true)
      expect(() => checkUrl(inside, url, '`site.url`')).toThrow(
        /is on the network the runner sits in/,
      )
    }
  })

  it('reads and writes nothing outside the project', () => {
    expect(() => checkPath(strange(), '/etc/hosts', '`file:`')).toThrow(/outside the project/)
    expect(() => checkPath(strange(), '../../elsewhere', 'install')).toThrow(/outside the project/)
    expect(() => checkPath(strange(), 'screenshots/out', 'paths.out')).not.toThrow()
    expect(() => checkPath(strange(), '/project/images', 'install')).not.toThrow()
  })
})

// Not about trust: a config you wrote has no reason to read your keys either, and a typo
// in an install destination should not be able to write into `.git`.
describe('what is never read or written, in any mode', () => {
  const named = [
    '.env',
    '.env.production',
    '.git',
    '.ssh',
    '.aws',
    '.gnupg',
    '.npmrc',
    '.netrc',
    '.htpasswd',
    'credentials',
    'id_rsa',
    'id_ed25519.pub',
    'server.pem',
    'private.key',
    'store.p12',
  ]

  it('names the part of the path that stopped it, wherever it sits', () => {
    for (const part of named) {
      expect(secretIn(`/project/${part}`), part).toEqual({ part, by: 'shotlist' })
      expect(secretIn(`/project/${part}/nested/shot.png`), part).toEqual({ part, by: 'shotlist' })
    }
  })

  it('leaves ordinary paths alone', () => {
    for (const path of [
      '/project/screenshots/out',
      '/project/docs/environment.png',
      '/p/keys.md',
    ]) {
      expect(secretIn(path), path).toBeNull()
    }
  })

  it('refuses them with the config trusted, which is the point', () => {
    expect(() => checkPath(own(), '/project/.env', '`file:`')).toThrow(/never read or written/)
    expect(() => checkPath(own(), '/project/.git/objects', 'install."x"')).toThrow(/"\.git"/)
  })
})

// The config saying it may go somewhere is worth nothing when the config is the thing in
// question. What the operator typed is worth something in both modes.
describe('what the operator grants', () => {
  const granted = (hosts: string[], paths: string[] = []) =>
    trustFrom({ root: '/project', siteUrl: SITE, granted: { hosts, paths } }, true)

  it('opens a host the command line named, even untrusted', () => {
    expect(() => checkUrl(granted(['google.com']), 'https://google.com/', '`url`')).not.toThrow()
    expect(() =>
      checkUrl(granted(['google.com']), 'https://www.google.com/', '`url`'),
    ).not.toThrow()
  })

  it('writes under a directory the command line named, even untrusted', () => {
    expect(() => checkPath(granted([], ['/shared/docs']), '/shared/docs/x.png', 'install')).not
      .toThrow
    expect(() => checkPath(granted([], ['/shared/docs']), '/shared/docs/x.png', 'i')).not.toThrow()
    expect(() => checkPath(granted([], ['/shared/docs']), '/elsewhere/x.png', 'i')).toThrow(
      /--allow-path/,
    )
  })
})

/**
 * The case this exists for. An administrator sets shotlist up and puts `/fake-secret`
 * out of bounds. Later somebody writes a recipe that shoots it, not knowing. They should
 * be told, in terms that say it is a decision rather than a bug.
 */
describe('a name the project put out of bounds', () => {
  const policy = (deny: string[]) => trustFrom({ root: '/project', siteUrl: SITE, deny }, false)

  it('stops a folder, and everything under it, on the disk', () => {
    expect(() => checkPath(policy(['fake-secret']), '/project/fake-secret/a.png', 'i')).toThrow(
      /forbidden path/,
    )
    expect(() => checkPath(policy(['fake-secret']), '/project/public/a.png', 'i')).not.toThrow()
  })

  // "That folder" is as likely to mean a path on the site as one on the disk.
  it('stops the same name served over http', () => {
    for (const url of [
      'https://rollful.dev/fake-secret/',
      'https://rollful.dev/fake-secret/reports/q3',
      'https://api.rollful.dev/fake-secret',
    ]) {
      expect(() => checkUrl(policy(['fake-secret']), url, '`url`'), url).toThrow(/forbidden path/)
    }
    expect(() => checkUrl(policy(['fake-secret']), 'https://rollful.dev/public', 'x')).not.toThrow()
  })

  it('stops a name written as a glob, for files as well as folders', () => {
    expect(() => checkPath(policy(['*.sqlite']), '/project/db/customers.sqlite', 'x')).toThrow(
      /forbidden path/,
    )
    expect(() => checkPath(policy(['*.sqlite']), '/project/db/notes.md', 'x')).not.toThrow()
  })

  it('says it is a decision, and whose, rather than reading as a bug', () => {
    expect(() => checkPath(policy(['fake-secret']), '/project/fake-secret/a', 'x')).toThrow(
      /ask your administrator/,
    )
    // The built-in list is not the project's doing, and does not claim to be.
    expect(() => checkPath(policy([]), '/project/.env', 'x')).toThrow(/never read or written/)
  })

  it('holds when the config is not trusted, because it can only refuse more', () => {
    const strict = trustFrom({ root: '/project', siteUrl: SITE, deny: ['fake-secret'] }, true)
    expect(() => checkUrl(strict, 'https://rollful.dev/fake-secret/', 'x')).toThrow(
      /forbidden path/,
    )
  })

  // The config and the flags are both things a recipe author can edit. Whoever set the
  // machine up can set this, and nothing in the project takes it back out.
  it('can come from the environment, which a recipe cannot edit', () => {
    const before = process.env['SHOTLIST_DENY']
    try {
      process.env['SHOTLIST_DENY'] = '/fake-secret, *.pdf'
      const fromEnv = trustFrom({ root: '/project', siteUrl: SITE }, false)
      expect(() => checkUrl(fromEnv, 'https://rollful.dev/fake-secret/x', 'x')).toThrow(
        /forbidden path/,
      )
      expect(() => checkPath(fromEnv, '/project/docs/report.pdf', 'x')).toThrow(/forbidden path/)
      expect(() => checkPath(fromEnv, '/project/docs/report.png', 'x')).not.toThrow()
    } finally {
      if (before === undefined) delete process.env['SHOTLIST_DENY']
      else process.env['SHOTLIST_DENY'] = before
    }
  })
})
