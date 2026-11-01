import { describe, expect, it } from 'vitest'
import { getAllFemalesRelations, orderChildrenByCode, resolveWife } from './treeUtils'
import type { Person, TreeWife } from './types'

function person(id: string, gender: 'M' | 'F'): Person {
  return { id, name: id, gender, children: [], wives: [] }
}

const BRANCH_TREE = '3f9cbead-01cf-4e4e-b007-938dad30e2ce'
const BRANCH_PREFIX = `br_${BRANCH_TREE.slice(0, 6)}_`

function male(id: string, name: string, extra: Partial<Person> = {}): Person {
  return { id, name, gender: 'M', children: [], wives: [], ...extra }
}

function female(id: string, name: string, extra: Partial<Person> = {}): Person {
  return { id, name, gender: 'F', children: [], wives: [], ...extra }
}

function crossTreeWife(personId: string, treeId = BRANCH_TREE): TreeWife {
  return {
    id: 'w-cross',
    type: 'tree',
    personId,
    treeId,
    treeName: 'شجرة احبيب (أهل محم)',
    personName: 'السالمة',
  }
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

describe('getAllFemalesRelations — cross-tree wives', () => {
  // F020 is مريم in the main tree and السالمة in شجرة احبيب. The union of
  // M504 points at the branch woman by code only, so the main-tree F020 used
  // to inherit his husband link and his children.
  function mainTreeWithCrossTreeUnion() {
    const localMaryam = female('F020', 'مريم')
    const husband = male('M504', 'أحمد ( امان )', {
      wives: [crossTreeWife('F020')],
      children: [
        male('M505', 'ابن', { mother: 'w-cross' }),
        female('F021', 'بنت', { mother: 'w-cross' }),
      ],
    })
    return { localMaryam, husband, root: male('M001', 'الجذر', { children: [husband, localMaryam] }) }
  }

  it('never attaches a cross-tree husband to a same-coded local woman', () => {
    const { root } = mainTreeWithCrossTreeUnion()

    const map = getAllFemalesRelations(root)

    expect(map.get('F020')?.husbands).toEqual([])
    expect(map.get('F020')?.children).toEqual([])
    const husbands = Array.from(map.values()).flatMap((entry) =>
      entry.husbands.map((person) => person.id),
    )
    expect(husbands).not.toContain('M504')
  })

  it('resolves the cross-tree wife to her branch clone when the branch is merged', () => {
    const { husband, localMaryam, root: baseRoot } = mainTreeWithCrossTreeUnion()
    const branchClone = female(`${BRANCH_PREFIX}F020`, 'السالمة', {
      branchMeta: {
        treeId: BRANCH_TREE,
        treeName: 'شجرة احبيب (أهل محم)',
        type: 'other',
        originalId: 'F020',
      },
    })
    const root = { ...baseRoot, children: [...baseRoot.children, branchClone] }

    const map = getAllFemalesRelations(root)

    expect(map.get(`${BRANCH_PREFIX}F020`)?.husbands.map((person) => person.id)).toEqual([
      husband.id,
    ])
    expect(map.get(`${BRANCH_PREFIX}F020`)?.children.map((person) => person.id)).toEqual([
      'M505',
      'F021',
    ])
    // The local woman with the same code stays untouched.
    expect(map.get('F020')?.husbands).toEqual([])
    expect(map.get('F020')?.children).toEqual([])
    expect(localMaryam.id).toBe('F020')
  })

  it('still resolves a same-tree wife without a treeId', () => {
    const wife = female('F030', 'زوجة')
    const husband = male('M600', 'رجل', {
      wives: [{ id: 'w-same', type: 'tree', personId: 'F030' }],
      children: [male('M601', 'ابن', { mother: 'w-same' })],
    })
    const root = male('M001', 'الجذر', { children: [husband, wife] })

    const map = getAllFemalesRelations(root)

    expect(map.get('F030')?.husbands.map((person) => person.id)).toEqual(['M600'])
    expect(map.get('F030')?.children.map((person) => person.id)).toEqual(['M601'])
  })

  it('resolveWife returns null for a cross-tree wife with no branch clone', () => {
    const { root } = mainTreeWithCrossTreeUnion()

    expect(resolveWife(crossTreeWife('F020'), root)).toBeNull()
  })
})
