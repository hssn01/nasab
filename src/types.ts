export type Gender = 'M' | 'F'

/** Wife from the same tree — linked by female person id. */
export interface TreeWife {
  id: string
  type: 'tree'
  personId: string
}

/** Wife from outside the tree — free-text archival fields. */
export interface ExternalWife {
  id: string
  type: 'external'
  name: string
  family: string
  tribute: string
}

export type Wife = TreeWife | ExternalWife

export interface Person {
  id: string
  name: string
  gender: Gender
  children: Person[]
  wives: Wife[]
  /** Mother key — usually a Wife.id of the father; may be a legacy name string. */
  mother?: string | null
}

export type Phase = 'setup' | 'enter-children' | 'add-wives' | 'complete'

export interface TreeState {
  root: Person | null
  phase: Phase
  currentPersonId: string | null
  maleCounter: number
  femaleCounter: number
  malesQueue: string[]
  currentMaleIndex: number
}

export interface TreeMeta {
  id: string
  name: string
  updated_at: string
  downloaded?: boolean
  synced?: boolean
  rootAncestor?: string
}

export interface Session {
  id: string
  name: string
  state: TreeState
  updated_at: string
  downloaded?: boolean
  synced?: boolean
  rootAncestor?: string
}

export interface DbPerson {
  id: string
  sessionId: string
  name: string
  gender: Gender
  children: Person[]
  wives: Wife[]
  mother?: string | null
  updated_at: string
  synced?: boolean
}
