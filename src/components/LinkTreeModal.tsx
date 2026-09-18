import { useState, useEffect, useId, useMemo } from 'react'
import type { Person, TreeLink, TreeLinkType, TreeMeta, TreeState } from '../types'
import { initialState } from '../useTreeBuilder'
import { collectFemales, getLineageText } from '../treeUtils'
import { fetchTreeState, getCachedState } from '../db'
import { getSession } from '../localDb'

interface LinkTreeModalProps {
  isOpen: boolean
  onClose: () => void
  mainTree: TreeMeta | null
  allTrees: TreeMeta[]
  initialPerson?: Person | null
  targetBranchTreeId?: string | null
  onCreateLinkedTree: (name: string, state: TreeState, link: TreeLink) => Promise<string | null>
  onLinkExistingTree: (treeId: string, link: TreeLink | null) => Promise<void>
}

export function LinkTreeModal({
  isOpen,
  onClose,
  mainTree,
  allTrees,
  initialPerson,
  targetBranchTreeId,
  onCreateLinkedTree,
  onLinkExistingTree,
}: LinkTreeModalProps) {
  const [mode, setMode] = useState<'create' | 'link_existing'>('create')
  const [selectedMainId, setSelectedMainId] = useState<string>(mainTree?.id || '')
  const [linkType, setLinkType] = useState<TreeLinkType>('daughter-branch')
  const [personName, setPersonName] = useState('')
  const [personId, setPersonId] = useState('')
  const [treeName, setTreeName] = useState('')
  const [note, setNote] = useState('')
  const [selectedExistingTreeId, setSelectedExistingTreeId] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Daughters from the selected main tree
  const [mainTreeRoot, setMainTreeRoot] = useState<Person | null>(null)
  const [females, setFemales] = useState<Person[]>([])
  const [loadingFemales, setLoadingFemales] = useState(false)
  const [femaleFilter, setFemaleFilter] = useState('')
  const [selectedFemale, setSelectedFemale] = useState<Person | null>(null)

  const titleId = useId()

  const currentMainTree = allTrees.find((t) => t.id === selectedMainId) || mainTree

  // Handle targetBranchTreeId prop (e.g. linking THIS tree as a branch to another tree)
  useEffect(() => {
    if (targetBranchTreeId && isOpen) {
      setMode('link_existing')
      setSelectedExistingTreeId(targetBranchTreeId)
      // If current main tree is the same as the branch, pick another main tree
      if (selectedMainId === targetBranchTreeId || !selectedMainId) {
        const candidate = allTrees.find((t) => t.id !== targetBranchTreeId && !t.linkedFrom) || allTrees.find((t) => t.id !== targetBranchTreeId)
        if (candidate) setSelectedMainId(candidate.id)
      }
    }
  }, [targetBranchTreeId, isOpen, allTrees, selectedMainId])

  // Handle initialPerson prop if supplied
  useEffect(() => {
    if (initialPerson) {
      setLinkType('daughter-branch')
      setSelectedFemale(initialPerson)
      setPersonId(initialPerson.id)
      setPersonName(initialPerson.name)
      setTreeName(`شجرة ذرية ${initialPerson.name}`)
    }
  }, [initialPerson, isOpen])

  // Load females from the selected main tree
  useEffect(() => {
    if (!isOpen || !selectedMainId) return
    let cancelled = false
    setLoadingFemales(true)

    async function loadFemales() {
      try {
        const cached = getCachedState(selectedMainId)
        let root = cached?.root
        if (!root) {
          const local = await getSession(selectedMainId)
          root = local?.state?.root
        }
        if (!root) {
          const remote = await fetchTreeState(selectedMainId)
          root = remote?.root
        }
        if (!cancelled && root) {
          setMainTreeRoot(root)
          setFemales(collectFemales(root))
        }
      } catch (err) {
        console.error('[LinkTreeModal] Failed to load females:', err)
      } finally {
        if (!cancelled) setLoadingFemales(false)
      }
    }

    void loadFemales()
    return () => {
      cancelled = true
    }
  }, [isOpen, selectedMainId])

  // Auto-generate suggested tree name when type or personName changes
  useEffect(() => {
    if (mode === 'create') {
      if (linkType === 'daughter-branch') {
        setTreeName(personName.trim() ? `شجرة ذرية ${personName.trim()}` : 'شجرة فرع البنت')
      } else if (linkType === 'brother-branch') {
        setTreeName(personName.trim() ? `شجرة ذرية ${personName.trim()} (أخ الجد)` : 'شجرة فرع أخ الجد')
      } else {
        setTreeName(personName.trim() ? `شجرة فرع ${personName.trim()}` : 'شجرة فرعية مرتبطة')
      }
    }
  }, [linkType, personName, mode])

  useEffect(() => {
    if (mainTree?.id && !targetBranchTreeId) {
      setSelectedMainId(mainTree.id)
    } else if (allTrees.length > 0 && !selectedMainId) {
      const firstMain = allTrees.find((t) => !t.linkedFrom) || allTrees[0]
      setSelectedMainId(firstMain.id)
    }
  }, [mainTree, allTrees, selectedMainId, targetBranchTreeId])

  if (!isOpen) return null

  // Filter candidates for "link existing tree": trees that are not the current main tree
  const existingCandidates = allTrees.filter((t) => t.id !== selectedMainId)

  // Enriched females with lineage chain (e.g. sister of 5th great grandfather)
  const femalesWithLineage = useMemo(() => {
    return females.map((f) => {
      const lineage = mainTreeRoot ? getLineageText(mainTreeRoot, f.id) : f.name
      return { person: f, lineage }
    })
  }, [females, mainTreeRoot])

  const filteredFemales = femalesWithLineage.filter(({ person, lineage }) => {
    if (!femaleFilter.trim()) return true
    const q = femaleFilter.trim().toLowerCase()
    return (
      person.name.toLowerCase().includes(q) ||
      person.id.toLowerCase().includes(q) ||
      lineage.toLowerCase().includes(q)
    )
  })

  function handleSelectFemale(f: Person) {
    setSelectedFemale(f)
    setPersonId(f.id)
    setPersonName(f.name)
    setTreeName(`شجرة ذرية ${f.name}`)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrorMsg(null)

    if (!selectedMainId || !currentMainTree) {
      setErrorMsg('يرجى تحديد الشجرة الأساسية للربط.')
      return
    }

    setIsSubmitting(true)
    try {
      const linkData: TreeLink = {
        mainTreeId: currentMainTree.id,
        mainTreeName: currentMainTree.name,
        type: linkType,
        personName: personName.trim() || undefined,
        personId: personId.trim() || undefined,
        note: note.trim() || undefined,
      }

      if (mode === 'create') {
        const finalName = treeName.trim() || 'شجرة فرعية مرتبطة'
        let customInitialState: TreeState = {
          ...initialState,
          linkedFrom: linkData,
        }

        if (linkType === 'brother-branch' && personName.trim()) {
          customInitialState = {
            ...customInitialState,
            root: {
              id: 'M001',
              name: personName.trim(),
              gender: 'M',
              children: [],
              wives: [],
              mother: null,
            },
            phase: 'enter-children',
            currentPersonId: 'M001',
            maleCounter: 2,
            femaleCounter: 0,
            malesQueue: ['M001'],
            currentMaleIndex: 0,
          }
        } else if (linkType === 'daughter-branch' && personName.trim()) {
          customInitialState = {
            ...customInitialState,
            root: {
              id: 'M001',
              name: `أبناء ${personName.trim()}`,
              gender: 'M',
              children: [],
              wives: [],
              mother: null,
            },
            phase: 'enter-children',
            currentPersonId: 'M001',
            maleCounter: 2,
            femaleCounter: 0,
            malesQueue: ['M001'],
            currentMaleIndex: 0,
          }
        }

        await onCreateLinkedTree(finalName, customInitialState, linkData)
        onClose()
      } else {
        if (!selectedExistingTreeId) {
          setErrorMsg('يرجى اختيار الشجرة المراد ربطها.')
          setIsSubmitting(false)
          return
        }
        await onLinkExistingTree(selectedExistingTreeId, linkData)
        onClose()
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'حدث خطأ أثناء حفظ الرابط.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        className="modal-content link-tree-modal"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon-badge">🔗</span>
            <div>
              <h2 id={titleId} className="modal-title">
                {mode === 'create' ? 'إنشاء شجرة فرعية مرتبطة' : 'ربط شجرة قائمة'}
              </h2>
              <p className="modal-subtitle">
                ربط فرع عائلي بالشجرة الأساسية «{currentMainTree?.name || 'الأساسية'}»
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="إغلاق"
          >
            ✕
          </button>
        </div>

        {/* Mode Selector */}
        <div className="link-mode-tabs">
          <button
            type="button"
            className={`link-tab-btn ${mode === 'create' ? 'active' : ''}`}
            onClick={() => setMode('create')}
          >
            ✨ إنشاء شجرة فرع جديدة
          </button>
          <button
            type="button"
            className={`link-tab-btn ${mode === 'link_existing' ? 'active' : ''}`}
            onClick={() => setMode('link_existing')}
          >
            📎 ربط شجرة منفصلة موجودة بالفعل
          </button>
        </div>

        {mode === 'link_existing' && (
          <div className="link-mode-help-banner">
            💡 <strong>ربط شجرة مستقلة قائمة:</strong> يمكنك بناء أي شجرة عائلة كشجرة منفصلة ومستقلة تماماً، ثم ربطها بالشجرة الأساسية التي تختارها (مثلاً: أخت الجد الخامس هي أم لشجرة العائلة المنفصلة)، كما يمكنك فك الارتباط في أي وقت متى شئت لتعود مستقلة.
          </div>
        )}

        <form onSubmit={handleSubmit} className="link-tree-form">
          {errorMsg && <div className="form-error-banner">{errorMsg}</div>}

          {/* Main Tree Select */}
          <div className="form-group">
            <label className="form-label">الشجرة الرئيسية (الأصل):</label>
            <select
              className="form-select"
              value={selectedMainId}
              onChange={(e) => setSelectedMainId(e.target.value)}
              disabled={isSubmitting}
            >
              {(
                allTrees.filter((t) => t.id !== targetBranchTreeId && !t.linkedFrom).length > 0
                  ? allTrees.filter((t) => t.id !== targetBranchTreeId && !t.linkedFrom)
                  : allTrees.filter((t) => t.id !== targetBranchTreeId)
              ).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.rootAncestor ? `(الأصل: ${t.rootAncestor})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Link Type Selector Cards */}
          <div className="form-group">
            <label className="form-label">نوع الصلة بالشجرة الرئيسية:</label>
            <div className="link-type-cards">
              <label
                className={`link-type-card ${
                  linkType === 'daughter-branch' ? 'selected' : ''
                }`}
              >
                <input
                  type="radio"
                  name="linkType"
                  value="daughter-branch"
                  checked={linkType === 'daughter-branch'}
                  onChange={() => setLinkType('daughter-branch')}
                />
                <span className="card-icon">🧬</span>
                <div className="card-body">
                  <strong>فرع أم / بنت من العائلة (أبناؤها وذريتهم)</strong>
                  <p>توثيق ذرية إحدى نساء العائلة (أخت الجد، عمة، خالة، أو بنت) كأم لشجرة عائلة أخرى</p>
                </div>
              </label>

              <label
                className={`link-type-card ${
                  linkType === 'brother-branch' ? 'selected' : ''
                }`}
              >
                <input
                  type="radio"
                  name="linkType"
                  value="brother-branch"
                  checked={linkType === 'brother-branch'}
                  onChange={() => setLinkType('brother-branch')}
                />
                <span className="card-icon">🤝</span>
                <div className="card-body">
                  <strong>فرع أخ للجد الأكبر</strong>
                  <p>شجرة لذرية أخ الجد الأساسي كنسب موازٍ</p>
                </div>
              </label>

              <label
                className={`link-type-card ${linkType === 'other' ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="linkType"
                  value="other"
                  checked={linkType === 'other'}
                  onChange={() => setLinkType('other')}
                />
                <span className="card-icon">🌿</span>
                <div className="card-body">
                  <strong>فرع أو نسب آخر</strong>
                  <p>صلة قرابة أو مصاهرة أخرى محددة</p>
                </div>
              </label>
            </div>
          </div>

          {/* Context details depending on branch type */}
          <div className="link-details-box">
            {linkType === 'daughter-branch' ? (
              <>
                <div className="form-group">
                  <label className="form-label">
                    اختيار الأم / البنت من الشجرة الرئيسية ({currentMainTree?.name || 'الأساسية'}):
                  </label>
                  {selectedFemale ? (
                    <div className="selected-female-card">
                      <div className="selected-female-info">
                        <span className="badge badge-f">{selectedFemale.id}</span>
                        <div className="selected-female-text-wrap">
                          <strong className="selected-female-name">{selectedFemale.name}</strong>
                          {mainTreeRoot && (
                            <span className="selected-female-lineage">
                              {getLineageText(mainTreeRoot, selectedFemale.id)}
                            </span>
                          )}
                        </div>
                        <span className="selected-female-check">✓ تم التحديد للربط المباشر</span>
                      </div>
                      <button
                        type="button"
                        className="compact-button"
                        onClick={() => {
                          setSelectedFemale(null)
                          setPersonId('')
                        }}
                      >
                        تغيير
                      </button>
                    </div>
                  ) : (
                    <div className="female-search-picker">
                      <input
                        type="search"
                        className="form-input"
                        placeholder={loadingFemales ? 'جارٍ تحميل قائمة الأمهات والبنات…' : '🔍 ابحث باسمها، رمزها، أو اسم أبيها/جدها (مثال: فاطمة أو F015 أو أحمد)…'}
                        value={femaleFilter}
                        onChange={(e) => setFemaleFilter(e.target.value)}
                        disabled={loadingFemales}
                      />
                      {females.length > 0 && femaleFilter.trim() && (
                        <div className="female-picker-dropdown">
                          {filteredFemales.slice(0, 15).map(({ person, lineage }) => (
                            <button
                              key={person.id}
                              type="button"
                              className="female-picker-item"
                              onClick={() => handleSelectFemale(person)}
                            >
                              <span className="badge badge-f">{person.id}</span>
                              <div className="female-picker-details">
                                <span className="female-picker-name">{person.name}</span>
                                {lineage && lineage !== person.name && (
                                  <span className="female-picker-lineage">{lineage}</span>
                                )}
                              </div>
                              <span className="female-picker-action">تحديد ↵</span>
                            </button>
                          ))}
                          {filteredFemales.length === 0 && (
                            <div className="female-picker-empty">لا توجد نتائج مطابقة لبنات/أمهات هذه الشجرة</div>
                          )}
                        </div>
                      )}
                      <span className="form-hint">
                        💡 للعثور على أخت الجد الخامس أو عمة أو خالة، اكتب اسم والدها ليظهر اسمها مع نسبها الكامل لاختيارها مباشرة.
                      </span>
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">اسم البنت (للتأكيد أو إدخال يدوي):</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="مثال: فاطمة"
                    value={personName}
                    onChange={(e) => setPersonName(e.target.value)}
                    required={mode === 'create'}
                  />
                  <span className="form-hint">
                    سيتم عرض هذا الفرع كأبناء وذرية هذه البنت وربطه بها مباشرة في المخطط.
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    رمز البنت في الشجرة الأصلية (يضمن دقة الربط):
                  </label>
                  <input
                    type="text"
                    className="form-input text-ltr"
                    placeholder="مثال: F015"
                    value={personId}
                    onChange={(e) => setPersonId(e.target.value)}
                  />
                </div>
              </>
            ) : linkType === 'brother-branch' ? (
              <div className="form-group">
                <label className="form-label">اسم أخ الجد الأكبر:</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="مثال: إبراهيم بن علي"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                  required={mode === 'create'}
                />
                <span className="form-hint">
                  سيتم تعيينه تلقائياً كجد أساسي في الشجرة الجديدة لبدء إدخال أبنائه وأحفاده فوراً.
                </span>
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">اسم الشخص أو جهة الصلة:</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="مثال: أبناء العم فلان"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                />
              </div>
            )}

            {/* Note */}
            <div className="form-group">
              <label className="form-label">ملاحظة أو توثيق إضافي (اختياري):</label>
              <input
                type="text"
                className="form-input"
                placeholder="مثال: تزوجت خارج القبيلة وذريتها مستقرة في الرياض..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>

          {/* Mode specific fields */}
          {mode === 'create' ? (
            <div className="form-group">
              <label className="form-label">اسم الشجرة الجديدة:</label>
              <input
                type="text"
                className="form-input"
                value={treeName}
                onChange={(e) => setTreeName(e.target.value)}
                required
              />
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">
                {targetBranchTreeId ? 'الشجرة المراد ربطها كفرع:' : 'اختر الشجرة المراد ربطها:'}
              </label>
              {targetBranchTreeId ? (
                <div className="selected-target-tree-badge">
                  <span>🌳 <strong>{allTrees.find((t) => t.id === targetBranchTreeId)?.name || 'هذه الشجرة'}</strong></span>
                  <span className="badge-hint">(سيتم ربط هذه الشجرة كفرع تحت الشجرة الرئيسية المختارة أعلاه)</span>
                </div>
              ) : existingCandidates.length === 0 ? (
                <p className="empty-inline-hint">
                  لا توجد أشجار أخرى متاحة للربط حالياً. استخدم خيار «إنشاء شجرة فرع جديدة».
                </p>
              ) : (
                <select
                  className="form-select"
                  value={selectedExistingTreeId}
                  onChange={(e) => setSelectedExistingTreeId(e.target.value)}
                  required
                >
                  <option value="">-- اختر من الأشجار --</option>
                  {existingCandidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} {t.linkedFrom ? `(مرتبطة مسبقاً بـ ${t.linkedFrom.mainTreeName})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="compact-button"
              onClick={onClose}
              disabled={isSubmitting}
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="primary submit-link-btn"
              disabled={isSubmitting || (mode === 'link_existing' && !selectedExistingTreeId)}
            >
              {isSubmitting
                ? 'جارٍ الحفظ…'
                : mode === 'create'
                ? '✨ إنشاء وفتح الشجرة'
                : '🔗 ربط الشجرة الآن'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
