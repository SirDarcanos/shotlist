import safeRegex from 'safe-regex2'

export const MAX_MATCHING_CHARACTERS = 256

/** Refuse a text pattern whose syntax or shape cannot be run with bounded risk. */
export function validateMatching(pattern: string, limit = MAX_MATCHING_CHARACTERS): string {
  const characters = [...pattern].length
  if (characters > limit) {
    throw new Error(
      `matching contains more than ${limit} characters; use text, contains, startsWith, or a shorter pattern`,
    )
  }
  try {
    new RegExp(pattern)
  } catch {
    throw new Error('matching must be a valid text pattern')
  }

  const backreference = /\\(?:[1-9]|k<)/.test(pattern)
  const lookbehind = /\(\?<([=!])/.test(pattern)
  const ambiguousRepeatedAlternation = [...pattern.matchAll(/\(([^()]*)\)([+*]|\{\d+,\})/g)].some(
    (match) => {
      const alternatives = match[1]!.split('|')
      return alternatives.some((left, index) =>
        alternatives.some(
          (right, other) => index !== other && left.length > 0 && right.startsWith(left),
        ),
      )
    },
  )
  if (backreference || lookbehind || ambiguousRepeatedAlternation || !safeRegex(pattern)) {
    throw new Error(
      'matching uses a pattern form that shotlist cannot run safely; use text, contains, startsWith, or a simpler pattern',
    )
  }
  return pattern
}

export interface MatchingMeasurement {
  readonly path: string
  readonly characters: number
}

/** Find matching patterns and their authored paths without recursive traversal. */
export function matchingMeasurementsIn(value: unknown): MatchingMeasurement[] {
  const found: MatchingMeasurement[] = []
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: '' }]
  while (pending.length) {
    const current = pending.pop()!
    if (typeof current.value !== 'object' || current.value === null) continue
    if (Array.isArray(current.value)) {
      current.value.forEach((nested, index) =>
        pending.push({ value: nested, path: `${current.path}[${index}]` }),
      )
      continue
    }
    for (const [key, nested] of Object.entries(current.value)) {
      const path = current.path ? `${current.path}.${key}` : key
      if (key === 'matching' && typeof nested === 'string') {
        found.push({ path, characters: [...nested].length })
      } else pending.push({ value: nested, path })
    }
  }
  return found
}

/** Validate every matching pattern in a raw or interpolated value. */
export function validateMatchingIn(value: unknown, limit = MAX_MATCHING_CHARACTERS): void {
  const patterns: string[] = []
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current !== 'object' || current === null) continue
    if (Array.isArray(current)) pending.push(...current)
    else {
      for (const [key, nested] of Object.entries(current)) {
        if (key === 'matching' && typeof nested === 'string') patterns.push(nested)
        else pending.push(nested)
      }
    }
  }
  for (const pattern of patterns) validateMatching(pattern, limit)
}
