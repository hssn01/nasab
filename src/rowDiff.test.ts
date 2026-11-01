import { describe, expect, it } from 'vitest'
import {
  personRowChanged,
  stableJson,
  unionRowChanged,
  type PersonRowSnapshot,
  type PersonRowWrite,
  type UnionRowSnapshot,
  type UnionRowWrite,
} from './rowDiff'

function person(overrides: Partial<PersonRowWrite> = {}): PersonRowWrite {
  return {
    id: 'person-1',
    tree_id: 'tree-1',
    code: 'M001',
    name: 'محمد',
    gender: 'M',
    father_id: null,
    mother_union_id: null,
    sibling_order: 0,
    branch_meta: null,
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function personSnapshot(row: PersonRowWrite): PersonRowSnapshot {
  const { tree_id: _treeId, updated_at: _updatedAt, ...snapshot } = row
  return snapshot
}

function union(overrides: Partial<UnionRowWrite> = {}): UnionRowWrite {
  return {
    id: 'union-1',
    tree_id: 'tree-1',
    code: 'w-1',
    husband_id: 'person-1',
    wife_person_id: null,
    external_name: 'مريم',
    external_family: 'البصادية',
    external_tribe: '',
    marriage_order: 0,
    legacy: { type: 'external', name: 'مريم', family: 'البصادية', tribute: '' },
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function unionSnapshot(row: UnionRowWrite): UnionRowSnapshot {
  const { tree_id: _treeId, updated_at: _updatedAt, ...snapshot } = row
  return snapshot
}

describe('stableJson', () => {
  it('ignores object key order', () => {
    expect(stableJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableJson({ b: { d: 3, c: 2 }, a: 1 }),
    )
  })

  it('keeps array order', () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]))
  })

  it('ignores properties that JSON.stringify would drop', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }))
  })
})

describe('personRowChanged', () => {
  it('treats an identical row as unchanged even when updated_at moves', () => {
    const row = person()
    expect(
      personRowChanged(personSnapshot(row), {
        ...row,
        updated_at: '2026-11-02T00:00:00.000Z',
      }),
    ).toBe(false)
  })

  it('detects a rename', () => {
    const row = person()
    expect(personRowChanged(personSnapshot(row), { ...row, name: 'أحمد' })).toBe(true)
  })

  it('detects a father or mother change', () => {
    const row = person()
    expect(
      personRowChanged(personSnapshot(row), { ...row, father_id: 'father-1' }),
    ).toBe(true)
    expect(
      personRowChanged(personSnapshot(row), { ...row, mother_union_id: 'union-1' }),
    ).toBe(true)
  })

  it('detects a sibling reorder', () => {
    const row = person()
    expect(personRowChanged(personSnapshot(row), { ...row, sibling_order: 2 })).toBe(true)
  })

  it('ignores branch_meta key order', () => {
    const row = person({ branch_meta: { type: 'branch', name: 'فرع' } })
    expect(
      personRowChanged(personSnapshot(row), {
        ...row,
        branch_meta: { name: 'فرع', type: 'branch' },
      }),
    ).toBe(false)
  })

  it('writes rows that do not exist in the cloud yet', () => {
    expect(personRowChanged(undefined, person())).toBe(true)
  })
})

describe('unionRowChanged', () => {
  it('treats an identical union as unchanged', () => {
    const row = union()
    expect(
      unionRowChanged(unionSnapshot(row), {
        ...row,
        updated_at: '2026-11-02T00:00:00.000Z',
      }),
    ).toBe(false)
  })

  it('detects a wife or marriage order change', () => {
    const row = union()
    expect(
      unionRowChanged(unionSnapshot(row), { ...row, wife_person_id: 'person-2' }),
    ).toBe(true)
    expect(
      unionRowChanged(unionSnapshot(row), { ...row, marriage_order: 1 }),
    ).toBe(true)
  })

  it('ignores legacy key order', () => {
    const row = union({
      legacy: { type: 'external', name: 'مريم', family: 'البصادية', tribute: '' },
    })
    expect(
      unionRowChanged(unionSnapshot(row), {
        ...row,
        legacy: { tribute: '', family: 'البصادية', name: 'مريم', type: 'external' },
      }),
    ).toBe(false)
  })

  it('writes unions that do not exist in the cloud yet', () => {
    expect(unionRowChanged(undefined, union())).toBe(true)
  })
})
