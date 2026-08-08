import { describe, expect, it } from 'vitest'
import { checkCommand, checkPath, checkUrl, trustFrom } from '../src/trust.js'

const OWN = trustFrom('/project', false)
const STRANGE = trustFrom('/project', true)

// shotlist runs at a desk and in automation, and they are not the same problem. At a
// desk the config is one you wrote. In CI on a fork's pull request, or in a service
// shooting what somebody submitted, it arrives from outside — and the machine running it
// has credentials, a network position, and other people's work on it.
describe('a config that is not the operator’s', () => {
  it('is trusted unless the operator says otherwise', () => {
    expect(OWN.untrusted).toBe(false)
    expect(checkCommand.bind(null, OWN, 'site.serve')).not.toThrow()
    expect(() => checkUrl(OWN, 'file:///etc/passwd', 'x')).not.toThrow()
    expect(() => checkPath(OWN, '/etc/hosts', 'x')).not.toThrow()
  })

  it('is settled by the environment too, for automation with a fixed command line', () => {
    const before = process.env['SHOTLIST_UNTRUSTED']
    try {
      process.env['SHOTLIST_UNTRUSTED'] = '1'
      expect(trustFrom('/project', false).untrusted).toBe(true)
      process.env['SHOTLIST_UNTRUSTED'] = '0'
      expect(trustFrom('/project', false).untrusted).toBe(false)
    } finally {
      if (before === undefined) delete process.env['SHOTLIST_UNTRUSTED']
      else process.env['SHOTLIST_UNTRUSTED'] = before
    }
  })

  it('never starts a process', () => {
    expect(() => checkCommand(STRANGE, 'site.serve')).toThrow(/does not start processes/)
  })

  it('opens nothing but http(s)', () => {
    expect(() => checkUrl(STRANGE, 'file:///etc/passwd', '`url`')).toThrow(/may only open http/)
    expect(() => checkUrl(STRANGE, 'data:text/html,x', '`url`')).toThrow(/may only open http/)
    expect(() => checkUrl(STRANGE, 'not a url', '`url`')).toThrow(/is not a URL/)
    expect(() => checkUrl(STRANGE, 'https://example.com/x', '`url`')).not.toThrow()
  })

  // A build runner can reach the cloud's metadata endpoint, an internal admin page and a
  // database — none of which is reachable from where the config was written.
  it('opens nothing on the network the runner sits in', () => {
    for (const host of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://127.0.0.1:8080/admin',
      'http://localhost:5432/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.20.0.3/',
      'http://[::1]/',
    ]) {
      expect(() => checkUrl(STRANGE, host, '`url`')).toThrow(/is on the network the runner sits in/)
    }
  })

  it('reads and writes nothing outside the project', () => {
    expect(() => checkPath(STRANGE, '/etc/hosts', '`file:`')).toThrow(/outside the project/)
    expect(() => checkPath(STRANGE, '../../elsewhere', 'install')).toThrow(/outside the project/)
    expect(() => checkPath(STRANGE, 'screenshots/out', 'paths.out')).not.toThrow()
    expect(() => checkPath(STRANGE, '/project/images', 'install')).not.toThrow()
  })
})
