/**
 * Row-level change detection for relational saves.
 *
 * The app used to upsert the whole tree on every save (~2,200 persons), which
 * bloated the WAL, the indexes and the audit log. These helpers compare the
 * bundle row with the cloud snapshot so only real changes are written.
 */

export interface PersonRowSnapshot {
  id: string
  code: string
  name: string
  gender: string
  father_id: string | null
  mother_union_id: string | null
  sibling_order: number
  branch_meta: unknown
}

export interface PersonRowWrite extends PersonRowSnapshot {
  tree_id: string
  updated_at: string
}

export interface UnionRowSnapshot {
  id: string
  code: string | null
  husband_id: string
  wife_person_id: string | null
  external_name: string | null
  external_family: string | null
  external_tribe: string | null
  marriage_order: number
  legacy: unknown
}

export interface UnionRowWrite extends UnionRowSnapshot {
  tree_id: string
  updated_at: string
}

/** JSON.stringify with sorted object keys, so JSONB key order never matters. */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      // JSON.stringify drops undefined properties; match that so an optional
      // field that is absent and one set to undefined compare as equal.
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function personRowChanged(
  previous: PersonRowSnapshot | undefined,
  next: PersonRowWrite,
): boolean {
  if (!previous) return true
  return (
    previous.code !== next.code ||
    previous.name !== next.name ||
    previous.gender !== next.gender ||
    (previous.father_id ?? null) !== next.father_id ||
    (previous.mother_union_id ?? null) !== next.mother_union_id ||
    previous.sibling_order !== next.sibling_order ||
    stableJson(previous.branch_meta) !== stableJson(next.branch_meta)
  )
}

export function unionRowChanged(
  previous: UnionRowSnapshot | undefined,
  next: UnionRowWrite,
): boolean {
  if (!previous) return true
  return (
    previous.code !== next.code ||
    previous.husband_id !== next.husband_id ||
    (previous.wife_person_id ?? null) !== next.wife_person_id ||
    (previous.external_name ?? null) !== next.external_name ||
    (previous.external_family ?? null) !== next.external_family ||
    (previous.external_tribe ?? null) !== next.external_tribe ||
    previous.marriage_order !== next.marriage_order ||
    stableJson(previous.legacy) !== stableJson(next.legacy)
  )
}
