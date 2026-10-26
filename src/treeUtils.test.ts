import { describe, expect, it } from 'vitest'
import { orderChildrenByCode } from './treeUtils'
import type { Person } from './types'

function person(id: string, gender: 'M' | 'F'): Person {
  return { id, name: id, gender, children: [], wives: [] }
}

describe('orderChildrenByCode', () => {
  it('puts sons first and orders each gender by numeric code', () => {
    const ordered = orderChildrenByCode([
      person('F010', 'F'),
      person('M016', 'M'),
      person('F011', 'F'),
      person('M015', 'M'),
      person('M1008', 'M'),
      person('F002', 'F'),
      person('M028', 'M'),
    ])

    expect(ordered.map((child) => child.id)).toEqual([
      'M015',
      'M016',
      'M028',
      'M1008',
      'F002',
      'F010',
      'F011',
    ])
  })

  it('does not mutate the input list', () => {
    const input = [person('F002', 'F'), person('M002', 'M')]

    const ordered = orderChildrenByCode(input)

    expect(input.map((child) => child.id)).toEqual(['F002', 'M002'])
    expect(ordered.map((child) => child.id)).toEqual(['M002', 'F002'])
  })
})
