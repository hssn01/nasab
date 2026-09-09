import { useMemo, useState } from 'react'
import type { Person, Wife } from '../types'
import {
  collectFemales,
  createExternalWife,
  createTreeWife,
  getFemaleFullLineage,
} from '../treeUtils'
import { TreeWifePicker } from './TreeWifePicker'

interface WivesBatchFormProps {
  person: Person
  root: Person
  lineageText: string
  isCurrent: boolean
  progressLabel: string
  onSave: (wives: Wife[]) => void
  onSaveAndContinue: (wives: Wife[]) => void
  onRename: (name: string) => void
  onReturnToCurrent: () => void
  /**
   * Called when the user wants to add a new daughter to a tree male and link
   * her as a wife. The callback must persist the daughter and return her new id.
   */
  onAddDaughter: (fatherId: string, daughterName: string) => string | null
  /** Switch to editing this person's children/kids */
  onSwitchToChildren?: () => void
}

type DraftMode = 'idle' | 'tree' | 'external'

export function WivesBatchForm({
  person,
  root,
  lineageText,
  isCurrent,
  progressLabel,
  onSave,
  onSaveAndContinue,
  onRename,
  onReturnToCurrent,
  onAddDaughter,
  onSwitchToChildren,
}: WivesBatchFormProps) {
  const [personName, setPersonName] = useState(person.name)
  const [wives, setWives] = useState<Wife[]>(() => [...person.wives])
  const [draftMode, setDraftMode] = useState<DraftMode>('idle')
  const [showPicker, setShowPicker] = useState(false)
  const [externalName, setExternalName] = useState('')
  const [externalFamily, setExternalFamily] = useState('')
  const [externalTribute, setExternalTribute] = useState('')

  const females = useMemo(() => collectFemales(root), [root])
  const linkedIds = useMemo(
    () =>
      new Set(
        wives
          .filter((wife) => wife.type === 'tree')
          .map((wife) => wife.personId),
      ),
    [wives],
  )
  const availableFemales = useMemo(
    () => females.filter((female) => !linkedIds.has(female.id)),
    [females, linkedIds],
  )

  function resetDraft() {
    setDraftMode('idle')
    setShowPicker(false)
    setExternalName('')
    setExternalFamily('')
    setExternalTribute('')
  }

  function addTreeWife(personId: string) {
    setWives((prev) => [...prev, createTreeWife(personId)])
    resetDraft()
  }

  function handleCreateAndLink(fatherId: string, daughterName: string): string | null {
    const newId = onAddDaughter(fatherId, daughterName)
    if (newId) {
      setWives((prev) => [...prev, createTreeWife(newId)])
      resetDraft()
    }
    return newId
  }

  function addExternalWife() {
    if (!externalName.trim()) return
    setWives((prev) => [
      ...prev,
      createExternalWife(externalName, externalFamily, externalTribute),
    ])
    resetDraft()
  }

  function updateExternal(
    wifeId: string,
    field: 'name' | 'family' | 'tribute',
    value: string,
  ) {
    setWives((prev) =>
      prev.map((wife) =>
        wife.id === wifeId && wife.type === 'external'
          ? { ...wife, [field]: value }
          : wife,
      ),
    )
  }

  function removeWife(wifeId: string) {
    setWives((prev) => prev.filter((wife) => wife.id !== wifeId))
  }

  function commit(andContinue: boolean) {
    onRename(personName)
    const cleaned = wives.filter((wife) =>
      wife.type === 'tree' ? Boolean(wife.personId) : Boolean(wife.name.trim()),
    )
    if (andContinue) onSaveAndContinue(cleaned)
    else onSave(cleaned)
  }

  return (
    <section className="batch-entry" aria-labelledby="wives-entry-title">
      <div className="batch-heading">
        <div>
          <p className="eyebrow entry-context" title={lineageText}>
            <span>{isCurrent ? 'إدخال الزوجات' : 'تعديل زوجات سابقة'}</span>
            <span className="context-separator">·</span>
            <span className="context-lineage" dir="rtl">
              {lineageText}
            </span>
          </p>
          <div className="editable-person-name">
            <span>زوجات</span>
            <input
              id="wives-entry-title"
              type="text"
              dir="rtl"
              value={personName}
              onChange={(event) => setPersonName(event.target.value)}
              onBlur={() => {
                if (personName.trim()) onRename(personName)
              }}
              aria-label="اسم الشخص"
            />
          </div>
        </div>
        <div className="batch-heading-meta">
          <span className="person-code">{person.id}</span>
          <span className="wives-progress">{progressLabel}</span>
        </div>
      </div>

      <p className="entry-help">
        إن كانت الزوجة من نساء الشجرة فابحثي عنها وحددي نسبتها الكاملة. إن كانت من خارج الشجرة
        فأدخل الاسم والعائلة والنبذة.
      </p>

      <div className="wives-children-summary">
        <div className="wives-children-summary-info">
          <span className="wives-children-badge">
            الذرية والأولاد ({person.children.length.toLocaleString('ar')})
          </span>
          <span className="wives-children-names" dir="rtl">
            {person.children.length > 0
              ? person.children.map((c) => c.name).join('، ')
              : 'لم يُسجّل أولاد لهذا الشخص بعد.'}
          </span>
        </div>
        {onSwitchToChildren && (
          <button
            type="button"
            className="wives-add-kids-btn"
            onClick={onSwitchToChildren}
            title="إضافة أبناء أو بنات لهذا الشخص"
          >
            + إضافة أو تعديل الأولاد
          </button>
        )}
      </div>

      <ul className="wives-editor-list" role="list">
        {wives.length === 0 && (
          <li className="wives-editor-empty">لا زوجات بعد — أضف من الشجرة أو من خارجها.</li>
        )}
        {wives.map((wife, index) => (
          <li key={wife.id} className="wives-editor-card">
            <div className="wives-editor-card-head">
              <span className="wives-editor-index">
                {(index + 1).toLocaleString('ar')}
              </span>
              <span className="wives-editor-kind">
                {wife.type === 'tree' ? 'من الشجرة' : 'من خارج الشجرة'}
              </span>
              <button
                type="button"
                className="ghost danger-text"
                onClick={() => removeWife(wife.id)}
              >
                حذف
              </button>
            </div>

            {wife.type === 'tree' ? (
              <div className="wives-editor-tree-row">
                <span className="person-code female-code">{wife.personId}</span>
                <span dir="rtl" className="twp-result-lineage">
                  {getFemaleFullLineage(root, wife.personId)}
                </span>
              </div>
            ) : (
              <div className="wives-external-fields">
                <label>
                  <span>الاسم</span>
                  <input
                    type="text"
                    dir="rtl"
                    value={wife.name}
                    onChange={(event) =>
                      updateExternal(wife.id, 'name', event.target.value)
                    }
                    placeholder="اسم الزوجة"
                  />
                </label>
                <label>
                  <span>العائلة</span>
                  <input
                    type="text"
                    dir="rtl"
                    value={wife.family}
                    onChange={(event) =>
                      updateExternal(wife.id, 'family', event.target.value)
                    }
                    placeholder="العائلة أو القبيلة"
                  />
                </label>
                <label className="wives-tribute-field">
                  <span>النبذة</span>
                  <textarea
                    dir="rtl"
                    rows={2}
                    value={wife.tribute}
                    onChange={(event) =>
                      updateExternal(wife.id, 'tribute', event.target.value)
                    }
                    placeholder="نبذة أو ملاحظة من الكتاب"
                  />
                </label>
              </div>
            )}
          </li>
        ))}
      </ul>

      {draftMode === 'idle' && (
        <div className="wives-add-actions">
          <button
            type="button"
            className="compact-button"
            onClick={() => {
              setDraftMode('tree')
              setShowPicker(true)
            }}
            title={
              availableFemales.length === 0
                ? 'يمكن إضافة بنت جديدة من الشجرة عبر المنتقي'
                : undefined
            }
          >
            + زوجة من الشجرة
          </button>
          <button
            type="button"
            className="compact-button"
            onClick={() => setDraftMode('external')}
          >
            + زوجة من خارج الشجرة
          </button>
        </div>
      )}

      {draftMode === 'external' && (
        <div className="wives-draft-panel">
          <p className="wives-draft-title">زوجة من خارج الشجرة</p>
          <div className="wives-external-fields">
            <label>
              <span>الاسم</span>
              <input
                type="text"
                dir="rtl"
                value={externalName}
                onChange={(event) => setExternalName(event.target.value)}
                placeholder="اسم الزوجة"
                autoFocus
              />
            </label>
            <label>
              <span>العائلة</span>
              <input
                type="text"
                dir="rtl"
                value={externalFamily}
                onChange={(event) => setExternalFamily(event.target.value)}
                placeholder="العائلة أو القبيلة"
              />
            </label>
            <label className="wives-tribute-field">
              <span>النبذة</span>
              <textarea
                dir="rtl"
                rows={2}
                value={externalTribute}
                onChange={(event) => setExternalTribute(event.target.value)}
                placeholder="نبذة أو ملاحظة من الكتاب"
              />
            </label>
          </div>
          <div className="batch-actions">
            <button
              type="button"
              className="primary"
              disabled={!externalName.trim()}
              onClick={addExternalWife}
            >
              إضافة
            </button>
            <button type="button" onClick={resetDraft}>
              إلغاء
            </button>
          </div>
        </div>
      )}

      <div className="batch-actions">
        {isCurrent ? (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => commit(true)}
            >
              حفظ والانتقال للتالي
            </button>
            <button type="button" onClick={() => commit(false)}>
              حفظ فقط
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => commit(false)}
            >
              حفظ التعديلات
            </button>
            <button type="button" onClick={onReturnToCurrent}>
              العودة إلى موضع الإدخال
            </button>
          </>
        )}
      </div>

      {/* TreeWifePicker modal — rendered outside the normal flow via portal-like rendering */}
      {showPicker && (
        <TreeWifePicker
          root={root}
          linkedIds={linkedIds}
          onSelect={(personId) => addTreeWife(personId)}
          onCreateAndLink={handleCreateAndLink}
          onCancel={resetDraft}
        />
      )}
    </section>
  )
}


