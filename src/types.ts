export type Gender = 'M' | 'F'

export interface Person {
  id: string
  name: string
  gender: Gender
  children: Person[]
  wives: string[]
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
  wives: string[]
  updated_at: string
  synced?: boolean
}

