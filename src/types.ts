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
  /** Linked spouse (e.g. husband of a daughter branch in unified view) */
  linkedSpouse?: Person
}

export type Phase =
  | 'setup'
  | 'enter-children'
  | 'add-wives'
  | 'assign-mothers'
  | 'complete'

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
  commonFatherName?: string
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

/** Normalized person in the relational database model */
export interface RelationalPerson {
  id: string
  treeId: string
  name: string
  gender: Gender
  fatherId: string | null
  motherId: string | null
  unionId: string | null
  birthOrder: number
  notes?: string
  branchMeta?: BranchMeta
  updated_at: string
  synced?: boolean
}

/** Normalized union (marriage / مصاهرة) in the relational database model */
export interface RelationalUnion {
  id: string
  treeId: string
  husbandId: string
  type: 'tree' | 'external'
  /** If type === 'tree' */
  wifePersonId?: string
  wifeTreeId?: string
  wifeTreeName?: string
  wifePersonName?: string
  wifeLineageLabel?: string
  /** If type === 'external' */
  externalName?: string
  externalFamily?: string
  externalTribute?: string
  marriageOrder: number
  notes?: string
  updated_at: string
  synced?: boolean
}

/** Normalized tree metadata and builder state */
export interface RelationalTree {
  id: string
  name: string
  rootPersonId: string | null
  phase: Phase
  currentPersonId: string | null
  maleCounter: number
  femaleCounter: number
  malesQueue: string[]
  currentMaleIndex: number
  linkedFrom?: TreeLink
  updated_at: string
  synced?: boolean
}

/** Complete relational package of a tree */
export interface RelationalTreeBundle {
  tree: RelationalTree
  persons: RelationalPerson[]
  unions: RelationalUnion[]
}
