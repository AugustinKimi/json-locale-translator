import { flattenJson, unflattenJson, mergeJson } from '../src/json-utils'

describe('flattenJson', () => {
  test('correctly flattens nested objects', () => {
    const input = {
      a: {
        b: 'hello',
        c: {
          d: 'world',
        },
      },
      e: 'top',
    }
    expect(flattenJson(input)).toEqual({
      'a.b': 'hello',
      'a.c.d': 'world',
      e: 'top',
    })
  })

  test('skips non-string values', () => {
    const input = {
      name: 'Alice',
      age: 30,
      active: true,
      tags: ['a', 'b'],
      extra: null,
    }
    expect(flattenJson(input as Record<string, unknown>)).toEqual({ name: 'Alice' })
  })

  test('handles empty object', () => {
    expect(flattenJson({})).toEqual({})
  })

  test('uses prefix when provided', () => {
    expect(flattenJson({ x: 'val' }, 'pre')).toEqual({ 'pre.x': 'val' })
  })
})

describe('unflattenJson', () => {
  test('correctly restores nested structure', () => {
    const flat = {
      'a.b': 'hello',
      'a.c.d': 'world',
      e: 'top',
    }
    expect(unflattenJson(flat)).toEqual({
      a: {
        b: 'hello',
        c: {
          d: 'world',
        },
      },
      e: 'top',
    })
  })

  test('handles empty flat object', () => {
    expect(unflattenJson({})).toEqual({})
  })
})

describe('flattenJson → unflattenJson round-trip', () => {
  test('is lossless for string-only nested objects', () => {
    const original = {
      greeting: {
        hello: 'Hello',
        bye: 'Goodbye',
      },
      common: {
        yes: 'Yes',
        no: 'No',
        nested: {
          deep: 'Deep value',
        },
      },
    }
    const flat = flattenJson(original)
    const restored = unflattenJson(flat)
    expect(restored).toEqual(original)
  })
})

describe('mergeJson', () => {
  test('translated values win over existing', () => {
    const existing = { a: 'old', b: 'keep' }
    const translated = { a: 'new' }
    expect(mergeJson(existing, translated)).toEqual({ a: 'new', b: 'keep' })
  })

  test('deep merges nested objects', () => {
    const existing = { level1: { a: 'old', b: 'keep' } }
    const translated = { level1: { a: 'new' } }
    expect(mergeJson(existing, translated)).toEqual({ level1: { a: 'new', b: 'keep' } })
  })

  test('preserves existing keys not in translated', () => {
    const existing = { x: 'exists', y: 'also exists' }
    const translated = { x: 'translated' }
    const result = mergeJson(existing, translated)
    expect(result.y).toBe('also exists')
  })
})
