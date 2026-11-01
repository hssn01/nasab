import { describe, expect, it } from 'vitest'
import { relationalToTree, treeToRelational } from './relationalAdapter'
import {
  personRowChanged,
  unionRowChanged,
  type PersonRowSnapshot,
  type UnionRowSnapshot,
} from './rowDiff'
import { buildUnifiedTree, normalizePersonTree, resolveWife } from './treeUtils'
import type { Person, RelationalPerson, RelationalUnion, TreeState } from './types'

function makeState(): TreeState {
  const root: Person = {
    id: 'M001',
    name: 'Root',
    gender: 'M',
    children: [
      {
        id: 'M002',
        name: 'Son',
        gender: 'M',
        children: [],
        wives: [
          {
            id: 'wife-2',
            type: 'tree',
            personId: 'F001',
            treeId: 'other-tree',
            treeName: 'Other',
            personName: 'Cousin',
          },
        ],
      },
      {
        id: 'F001',
        name: 'Daughter',
        gender: 'F',
        children: [],
        wives: [],
      },
    ],
    wives: [
      {
        id: 'wife-1',
        type: 'external',
        name: 'Mother',
        family: 'Family',
        tribute: '',
      },
    ],
  }

  root.children[0].mother = 'wife-1'
  root.children[1].mother = 'wife-1'

  return {
    root,
    phase: 'complete',
    currentPersonId: null,
    maleCounter: 3,
    femaleCounter: 1,
    malesQueue: [],
    currentMaleIndex: 0,
  }
}

describe('relational adapter', () => {
  it('round-trips persons, children, and external wives', () => {
    const state = makeState()
    const bundle = treeToRelational('main-tree', 'Main', state, '2026-01-01T00:00:00.000Z')

    expect(bundle.persons).toHaveLength(3)
    expect(bundle.unions).toHaveLength(2)
    expect(bundle.tree.rootPersonId).toBe(bundle.persons.find((p) => p.code === 'M001')?.id)

    const rootRow = bundle.persons.find((p) => p.code === 'M001')!
    const sonRow = bundle.persons.find((p) => p.code === 'M002')!
    expect(sonRow.fatherId).toBe(rootRow.id)

    const back = relationalToTree(bundle)
    expect(back.root?.name).toBe('Root')
    expect(back.root?.children.map((c) => c.name)).toEqual(['Son', 'Daughter'])
    expect(back.root?.wives[0]).toMatchObject({
      type: 'external',
      name: 'Mother',
      family: 'Family',
    })
  })

  it('canonicalizes child order when saving an unsorted in-memory tree', () => {
    const state = makeState()
    const root = state.root!
    root.children = [root.children[1], root.children[0]]

    const bundle = treeToRelational(
      'main-tree',
      'Main',
      state,
      '2026-01-01T00:00:00.000Z',
    )
    const rootRow = bundle.persons.find((p) => p.code === 'M001')!
    const children = bundle.persons
      .filter((p) => p.fatherId === rootRow.id)
      .sort((a, b) => a.siblingOrder - b.siblingOrder)

    expect(children.map((p) => p.code)).toEqual(['M002', 'F001'])
    expect(children.map((p) => p.siblingOrder)).toEqual([0, 1])
  })

  it('reloads children in persisted sibling order, not fetch order', () => {
    const state = makeState()
    const bundle = treeToRelational(
      'main-tree',
      'Main',
      state,
      '2026-01-01T00:00:00.000Z',
    )

    bundle.persons.reverse()

    const back = relationalToTree(bundle)
    expect(back.root?.children.map((child) => child.name)).toEqual([
      'Son',
      'Daughter',
    ])
  })

  it('keeps a cross-tree wife unlinked while preserving her source tree', () => {
    const state = makeState()
    const bundle = treeToRelational('main-tree', 'Main', state, '2026-01-01T00:00:00.000Z')

    const crossUnion = bundle.unions.find((u) => u.code === 'wife-2')!
    expect(crossUnion.wifePersonId ?? null).toBeNull()
    expect((crossUnion.legacy as any).treeId).toBe('other-tree')

    const back = relationalToTree(bundle)
    const son = back.root?.children.find((c) => c.id === 'M002')
    expect(son?.wives[0]).toMatchObject({
      type: 'tree',
      personId: 'F001',
      treeId: 'other-tree',
      personName: 'Cousin',
    })
  })

  it('does not resolve a cross-tree wife to a same-coded woman in the local tree', () => {
    const state = makeState()
    const root = state.root!
    const son = root.children[0]
    const crossWife = son.wives[0]

    expect(resolveWife(crossWife, root)).toBeNull()
    expect(resolveWife({ id: 'wife-3', type: 'tree', personId: 'F001' }, root)?.name).toBe(
      'Daughter',
    )
  })

  it('preserves union cloud ids when normalizing a loaded wife list', () => {
    const state = makeState()
    state.root!.wives[0] = {
      ...state.root!.wives[0],
      dbId: 'union-uuid',
    }

    const normalized = normalizePersonTree(state.root!)
    expect(normalized.wives[0].dbId).toBe('union-uuid')
  })

  it('reports no changed rows when a loaded tree is saved unchanged', () => {
    const bundle = treeToRelational(
      'main-tree',
      'Main',
      makeState(),
      '2026-01-01T00:00:00.000Z',
    )
    const reloaded = relationalToTree(bundle)
    const resaved = treeToRelational(
      'main-tree',
      'Main',
      reloaded,
      '2026-01-02T00:00:00.000Z',
    )

    const personSnapshot = (row: RelationalPerson): PersonRowSnapshot => ({
      id: row.id,
      code: row.code,
      name: row.name,
      gender: row.gender,
      father_id: row.fatherId ?? null,
      mother_union_id: row.motherUnionId ?? null,
      sibling_order: row.siblingOrder,
      branch_meta: row.branchMeta ?? null,
    })
    const personWrite = (row: RelationalPerson) => ({
      ...personSnapshot(row),
      tree_id: row.treeId,
      updated_at: row.updated_at,
    })
    const unionSnapshot = (row: RelationalUnion): UnionRowSnapshot => ({
      id: row.id,
      code: row.code,
      husband_id: row.husbandId,
      wife_person_id: row.wifePersonId ?? null,
      external_name: row.externalName ?? null,
      external_family: row.externalFamily ?? null,
      external_tribe: row.externalTribute ?? null,
      marriage_order: row.marriageOrder,
      legacy: row.legacy ?? null,
    })
    const unionWrite = (row: RelationalUnion) => ({
      ...unionSnapshot(row),
      tree_id: row.treeId,
      updated_at: row.updated_at,
    })

    const personsBefore = new Map(
      bundle.persons.map((row) => [row.id, personSnapshot(row)]),
    )
    const unionsBefore = new Map(
      bundle.unions.map((row) => [row.id, unionSnapshot(row)]),
    )

    const changedPersons = resaved.persons.filter((row) =>
      personRowChanged(personsBefore.get(row.id), personWrite(row)),
    )
    const changedUnions = resaved.unions.filter((row) => {
      return unionRowChanged(unionsBefore.get(row.id), unionWrite(row))
    })

    expect(changedPersons.map((row) => row.code)).toEqual([])
    expect(changedUnions.map((row) => row.code)).toEqual([])
  })
})

describe('unified tree', () => {
  it('returns the main root unchanged when there are no connected branches', () => {
    const root = makeState().root!
    const result = buildUnifiedTree('main-tree', root, 'Main', [])
    expect(result.root).toBe(root)
    expect(result.isUnified).toBe(false)
    expect(result.branchCount).toBe(0)
  })
})
