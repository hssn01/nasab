import { useState, useMemo } from 'react'
import type { Person } from '../types'
import { findRelationship, getLineageText } from '../treeUtils'

interface RelationshipModalProps {
  root: Person
  initialPersonAId?: string | null
  onClose: () => void
  onSelectPerson?: (person: Person) => void
}

function collectAllPeople(root: Person): Person[] {
  const result: Person[] = []
  function walk(node: Person) {
    result.push(node)
    node.children.forEach(walk)
  }
  walk(root)
  return result
}

export function RelationshipModal({
  root,
  initialPersonAId,
  onClose,
  onSelectPerson,
}: RelationshipModalProps) {
  const allPeople = useMemo(() => collectAllPeople(root), [root])

  const [idA, setIdA] = useState<string>(
    initialPersonAId && allPeople.some((p) => p.id === initialPersonAId)
      ? initialPersonAId
      : root.id,
  )
  const [idB, setIdB] = useState<string>(() => {
    const second = allPeople.find((p) => p.id !== (initialPersonAId || root.id))
    return second ? second.id : root.id
  })

  const [searchA, setSearchA] = useState('')
  const [searchB, setSearchB] = useState('')

  const filteredA = useMemo(() => {
    if (!searchA.trim()) return allPeople.slice(0, 50)
    const q = searchA.toLowerCase()
    return allPeople.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        getLineageText(root, p.id).toLowerCase().includes(q),
    )
  }, [allPeople, searchA, root])

  const filteredB = useMemo(() => {
    if (!searchB.trim()) return allPeople.slice(0, 50)
    const q = searchB.toLowerCase()
    return allPeople.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        getLineageText(root, p.id).toLowerCase().includes(q),
    )
  }, [allPeople, searchB, root])

  const lineageA = useMemo(() => (idA ? getLineageText(root, idA) : ''), [root, idA])
  const lineageB = useMemo(() => (idB ? getLineageText(root, idB) : ''), [root, idB])

  const kinship = useMemo(() => {
    if (!idA || !idB || idA === idB) return null
    return findRelationship(root, idA, idB)
  }, [root, idA, idB])

  return (
    <div className="modal-backdrop" onClick={onClose} dir="rtl">
      <div className="modal-card relationship-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">حاسبة النسب والقرابة</p>
            <h3 className="modal-title">معرفة صلة القرابة بين شخصين</h3>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="relationship-selectors">
          {/* Person A selector */}
          <div className="kinship-selector-box">
            <label className="modal-label">الشخص الأول (أ):</label>
            <input
              type="search"
              dir="rtl"
              placeholder="ابحث بالاسم أو النسب..."
              value={searchA}
              onChange={(e) => setSearchA(e.target.value)}
              className="kinship-search-input"
            />
            <select
              dir="rtl"
              size={5}
              className="kinship-select"
              value={idA}
              onChange={(e) => setIdA(e.target.value)}
            >
              {filteredA.map((p) => (
                <option key={p.id} value={p.id}>
                  {getLineageText(root, p.id)} ({p.id})
                </option>
              ))}
            </select>
            {lineageA && <div className="kinship-lineage-preview">سلسلة النسب: {lineageA}</div>}
          </div>

          {/* Person B selector */}
          <div className="kinship-selector-box">
            <label className="modal-label">الشخص الثاني (ب):</label>
            <input
              type="search"
              dir="rtl"
              placeholder="ابحث بالاسم أو النسب..."
              value={searchB}
              onChange={(e) => setSearchB(e.target.value)}
              className="kinship-search-input"
            />
            <select
              dir="rtl"
              size={5}
              className="kinship-select"
              value={idB}
              onChange={(e) => setIdB(e.target.value)}
            >
              {filteredB.map((p) => (
                <option key={p.id} value={p.id}>
                  {getLineageText(root, p.id)} ({p.id})
                </option>
              ))}
            </select>
            {lineageB && <div className="kinship-lineage-preview">سلسلة النسب: {lineageB}</div>}
          </div>
        </div>


        {/* Kinship Output Result */}
        {kinship ? (
          <div className="kinship-result-box">
            <div className="kinship-summary">
              <span className="kinship-badge">{kinship.relationshipTitle}</span>
              <p className="kinship-text">
                <strong>{kinship.personB.name}</strong> ({kinship.personB.id}) هو{' '}
                <mark>{kinship.relationshipTitle}</mark> لـ{' '}
                <strong>{kinship.personA.name}</strong> ({kinship.personA.id})
              </p>
            </div>

            {kinship.commonAncestor && (
              <div className="kinship-ancestor-row">
                <span className="ancestor-label">الجد المشترك الأعلى:</span>
                <button
                  type="button"
                  className="wife-link-tag"
                  onClick={() => {
                    if (onSelectPerson && kinship.commonAncestor) {
                      onSelectPerson(kinship.commonAncestor)
                      onClose()
                    }
                  }}
                >
                  👑 {kinship.commonAncestor.name} ({kinship.commonAncestor.id})
                </button>
              </div>
            )}

            <div className="kinship-lineages">
              <div className="lineage-column">
                <h5>نسب {kinship.personA.name}:</h5>
                <ol className="lineage-list">
                  {kinship.lineageA.map((p) => (
                    <li key={p.id}>
                      {p.name} <span className="chip-id">({p.id})</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="lineage-column">
                <h5>نسب {kinship.personB.name}:</h5>
                <ol className="lineage-list">
                  {kinship.lineageB.map((p) => (
                    <li key={p.id}>
                      {p.name} <span className="chip-id">({p.id})</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        ) : (
          <div className="kinship-empty">
            اختر شخصين مختلفين لعرض صلة القرابة والنسب بينهما.
          </div>
        )}
      </div>
    </div>
  )
}
