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
}
