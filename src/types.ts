export type Gender = 'M' | 'F'

/** Wife linked by female person id — from this tree or another tree in the user's trees. */
export interface TreeWife {
  id: string
  type: 'tree'
  personId: string
  /** Optional tree ID if chosen from another tree */
  treeId?: string
  /** Display name of the source tree */
  treeName?: string
  /** Cached name of the female */
  personName?: string
  /** Cached full patronymic lineage label of the female */
  lineageLabel?: string
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

export interface BranchMeta {
  treeId: string
  treeName: string
  type: TreeLinkType | 'main'
  personName?: string
  originalId?: string
  isVirtualContainer?: boolean
}

export interface Person {
  id: string
  name: string
  gender: Gender
  children: Person[]
  wives: Wife[]
  /** Mother key — usually a Wife.id of the father; may be a legacy name string. */
  mother?: string | null
  /** Metadata attached when displayed in a unified multi-tree web view */
  branchMeta?: BranchMeta
}

export type Phase = 'setup' | 'enter-children' | 'add-wives' | 'complete'

export type TreeLinkType = 'daughter-branch' | 'brother-branch' | 'other'

export interface TreeLink {
  /** ID of the main tree this one is linked from */
  mainTreeId: string
  /** Human label of the main tree (cached for offline display) */
  mainTreeName: string
  /** Type of relationship */
  type: TreeLinkType
  /** Person ID in the main tree if linked to a specific person (e.g. daughter) */
  personId?: string
  /** Name of the daughter or brother linking this tree */
  personName?: string
  /** Optional custom note */
  note?: string
}

export interface TreeState {
  root: Person | null
  phase: Phase
  currentPersonId: string | null
  maleCounter: number
  femaleCounter: number
  malesQueue: string[]
  currentMaleIndex: number
  linkedFrom?: TreeLink
}

export interface TreeMeta {
  id: string
  name: string
  updated_at: string
  downloaded?: boolean
  synced?: boolean
  rootAncestor?: string
  linkedFrom?: TreeLink
}

export interface Session {
  id: string
  name: string
  state: TreeState
  updated_at: string
  downloaded?: boolean
  synced?: boolean
  rootAncestor?: string
  linkedFrom?: TreeLink
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
