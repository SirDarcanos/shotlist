import { describe, expect, it } from 'vitest'
import {
  NetworkPolicyError,
  compileNetworkPolicy,
  type NetworkPolicy,
} from '../src/network-policy.js'

/** Build one policy without opening a filesystem-backed Project. */
function policy(
  operator: readonly string[] = [],
  project: readonly string[] = [],
  untrusted = false,
): NetworkPolicy {
  return compileNetworkPolicy({ operator, project, untrusted, deny: [] })
}

describe('Network destination approvals', () => {
  it('normalizes shorthand, exact destinations, and proper-subdomain wildcards', () => {
    const compiled = policy([
      'assets.example.com',
      'http://localhost:3000',
      'https://assets.example.com:8443',
      '*.static.example.com',
    ])

    expect(compiled.operatorDestinations).toEqual([
      { protocol: 'https:', host: 'assets.example.com', port: 443, subdomains: false },
      { protocol: 'http:', host: 'localhost', port: 3000, subdomains: false },
      { protocol: 'https:', host: 'assets.example.com', port: 8443, subdomains: false },
      { protocol: 'https:', host: 'static.example.com', port: 443, subdomains: true },
    ])
    expect(() =>
      compiled.forOperation('test').check('https://assets.example.com/a?q=secret'),
    ).not.toThrow()
    expect(() => compiled.forOperation('test').check('https://a.static.example.com/')).not.toThrow()
    expect(() => compiled.forOperation('test').check('https://static.example.com/')).toThrow(
      NetworkPolicyError,
    )
    expect(() => compiled.forOperation('test').check('http://assets.example.com/')).toThrow(
      NetworkPolicyError,
    )
  })

  it('rejects malformed approvals and credentials before a network effect', () => {
    for (const approval of [
      'https://user:pass@example.com',
      'https://example.com/path',
      'ftp://example.com',
      'example.com:8443',
      '*example.com',
    ]) {
      expect(() => policy([approval]), approval).toThrow(/Network destination approval/)
    }
    expect(() =>
      policy(['example.com']).forOperation('test').check('https://u:p@example.com/'),
    ).toThrow(/username or password/)
  })

  it('ignores every Project approval in an untrusted Run', () => {
    const compiled = policy(['operator.example'], ['project.example'], true)

    expect(() => compiled.forOperation('test').check('https://operator.example/')).not.toThrow()
    expect(() => compiled.forOperation('test').check('https://project.example/')).toThrow(
      /not approved/,
    )
  })

  it('allows a same-host HTTP to HTTPS redirect but no downgrade', () => {
    const access = policy(['http://example.com:80']).forOperation('test')
    const http = access.check('http://example.com/start')!

    expect(() => access.check('https://example.com/next', http)).not.toThrow()
    expect(() =>
      policy(['example.com']).forOperation('test').check('http://example.com/', {
        protocol: 'https:',
        host: 'example.com',
        port: 443,
      }),
    ).toThrow(/not approved/)
  })

  it('allows browser-contained content and refuses local-file navigation', () => {
    const access = policy().forRecipe('home')

    expect(access.check('data:text/plain,hello')).toBeUndefined()
    expect(access.check('blob:https://example.com/id')).toBeUndefined()
    expect(() => access.check('file:///tmp/page.html')).toThrow(/local file/)
  })

  it('checks forbidden paths after nested URL decoding', () => {
    const access = compileNetworkPolicy({
      operator: ['example.com'],
      project: [],
      untrusted: true,
      deny: [],
    }).forOperation('test')

    expect(() => access.check('https://example.com/%252eenv')).toThrow(/forbidden path/)
    expect(() =>
      policy(['example.com']).forOperation('test').check('https://example.com/%252f.git/config'),
    ).toThrow(/forbidden path/)
  })

  it('collects a bounded unique sanitized list and latches the failure', () => {
    const access = policy().forRecipe('checkout')
    for (let index = 0; index < 25; index++) {
      access.record(`https://user:secret@blocked-${index}.example/path?token=secret#fragment`)
    }
    access.record('https://blocked-0.example/another?different=secret')

    expect(() => access.throwIfBlocked()).toThrowError(
      expect.objectContaining({
        blocked: expect.arrayContaining(['https://blocked-0.example']),
        omitted: 5,
      }),
    )
    expect(() => access.check('https://approved-later.example/')).toThrow(NetworkPolicyError)
  })
})
