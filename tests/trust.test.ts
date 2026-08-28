import { describe, expect, it } from 'vitest'
import { checkCommand, checkPath, secretIn, trustFrom } from '../src/trust.js'

const policy = (untrusted = false, deny: readonly string[] = []) =>
  trustFrom({ root: '/project', siteUrl: 'https://example.com/', deny }, untrusted)

describe('a Project that is not the operator’s', () => {
  it('is trusted unless the operator says otherwise', () => {
    expect(policy().untrusted).toBe(false)
    expect(() => checkCommand(policy(), 'site.serve')).not.toThrow()
    expect(() => checkPath(policy(), '/etc/hosts', 'x')).not.toThrow()
  })

  it('is settled by the environment too', () => {
    const before = process.env['SHOTLIST_UNTRUSTED']
    try {
      process.env['SHOTLIST_UNTRUSTED'] = '1'
      expect(policy().untrusted).toBe(true)
      process.env['SHOTLIST_UNTRUSTED'] = '0'
      expect(policy().untrusted).toBe(false)
    } finally {
      if (before === undefined) delete process.env['SHOTLIST_UNTRUSTED']
      else process.env['SHOTLIST_UNTRUSTED'] = before
    }
  })

  it('never starts a process', () => {
    expect(() => checkCommand(policy(true), 'site.serve')).toThrow(/does not start processes/)
  })

  it('reads and writes nothing outside the Project', () => {
    expect(() => checkPath(policy(true), '/etc/hosts', '`file:`')).toThrow(/outside the project/)
    expect(() => checkPath(policy(true), 'screenshots/out', 'paths.out')).not.toThrow()
  })
})

describe('what is never read or written', () => {
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

  it('names the forbidden path segment wherever it sits', () => {
    for (const part of named) {
      expect(secretIn(`/project/${part}`), part).toBe(part)
      expect(secretIn(`/project/${part}/nested/shot.png`), part).toBe(part)
    }
  })

  it('leaves ordinary paths alone', () => {
    for (const path of ['/project/screenshots/out', '/project/docs/environment.png']) {
      expect(secretIn(path), path).toBeNull()
    }
  })

  it('refuses secret paths in trusted mode too', () => {
    expect(() => checkPath(policy(), '/project/.env', '`file:`')).toThrow(/forbidden path/)
  })
})

describe('Operator path grants and deny names', () => {
  it('writes under a directory the operator named in an untrusted Run', () => {
    const granted = trustFrom(
      {
        root: '/project',
        siteUrl: 'https://example.com',
        granted: { paths: ['/shared/docs'] },
      },
      true,
    )
    expect(() => checkPath(granted, '/shared/docs/x.png', 'install')).not.toThrow()
    expect(() => checkPath(granted, '/elsewhere/x.png', 'install')).toThrow(/--allow-path/)
  })

  it('applies Project and environment deny names in every mode', () => {
    const before = process.env['SHOTLIST_DENY']
    try {
      process.env['SHOTLIST_DENY'] = '*.pdf'
      const strict = policy(false, ['fake-secret'])
      expect(() => checkPath(strict, '/project/fake-secret/a.png', 'x')).toThrow(/forbidden path/)
      expect(() => checkPath(strict, '/project/docs/report.pdf', 'x')).toThrow(/forbidden path/)
      expect(() => checkPath(strict, '/project/docs/report.png', 'x')).not.toThrow()
    } finally {
      if (before === undefined) delete process.env['SHOTLIST_DENY']
      else process.env['SHOTLIST_DENY'] = before
    }
  })
})
