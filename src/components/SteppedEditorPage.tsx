import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ChildrenBatchForm } from './ChildrenBatchForm'
import { WivesBatchForm } from './WivesBatchForm'
import { MothersAssignForm } from './MothersAssignForm'
import { PersonEditor } from './PersonEditor'
import { TreeRoot } from './TreeView'
import { LinkTreeModal } from './LinkTreeModal'
import { useSessionList } from '../hooks/useSessionList'
import {
  advanceAfterDone,
  collectMalesDFS,
  countPeople,
  exportOutline,
  findPath,
  findPerson,
} from '../treeUtils'
import { useTreeBuilder } from '../useTreeBuilder'
import { createTree, updateTreeLink } from '../db'
import type { TreeLink, TreeState } from '../types'

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function arabicCount(count: number, singular: string, plural: string) {
  return `${count.toLocaleString('ar')} ${count === 1 ? singular : plural}`
}

// ── Tree App (the main editor) ────────────────────────────────────────────────


export function TreeApp({
  treeId,
  onOpenChart,
  onOpenPrint,
  onOpenTree,
  onGoHome,
}: {
  treeId: string
  onOpenChart: () => void
  onOpenPrint: () => void
  onOpenTree?: (treeId: string) => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)
  const { sessions, refresh } = useSessionList()
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const currentTreeMeta = useMemo(() => sessions.find((s) => s.id === treeId) || null, [sessions, treeId])

  async function handleLinkExistingTree(branchTreeId: string, link: TreeLink | null) {
    await updateTreeLink(branchTreeId, link)
    await refresh()
  }

  async function handleCreateLinkedTree(name: string, state: TreeState, link: TreeLink) {
    const id = await createTree(name, state, link)
    if (id) await refresh()
    return id
  }

  const sidebarRef = useRef<HTMLElement>(null)
  const resizeRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    anchoredLeft: boolean
  } | null>(null)
  const [rootName, setRootName] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reviewFocus, setReviewFocus] = useState<'children' | 'wives' | 'mothers'>(
    'children',
  )
  const [savedId, setSavedId] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('nasab-sidebar-width'))
    return Number.isFinite(saved) && saved >= 260 && saved <= 560 ? saved : 320
  })


  const males = useMemo(
    () => (tree.root ? collectMalesDFS(tree.root) : []),
    [tree.root],
  )
  const counts = tree.root ? countPeople(tree.root) : { males: 0, females: 0 }

  const selectedPerson = useMemo(() => {
    if (!tree.root) return null
    const id = selectedId ?? tree.currentPersonId
    return id ? findPerson(tree.root, id) : null
  }, [selectedId, tree.currentPersonId, tree.root])

  const selectedLineage = useMemo(() => {
    if (!tree.root || !selectedPerson) return []
    return findPath(tree.root, selectedPerson.id)
  }, [selectedPerson, tree.root])

  const lineageText = useMemo(
    () =>
      [...selectedLineage]
        .reverse()
        .map((person) => person.name)
        .join(' بن '),
    [selectedLineage],
  )

  async function importJson(file: File) {
    try {
      const value: unknown = JSON.parse(await file.text())
      if (!tree.importProject(value)) throw new Error('invalid tree')
      setSelectedId(null)
      setImportMessage('تم استيراد الشجرة')
    } catch {
      setImportMessage('تعذّر استيراد الملف')
    }
    window.setTimeout(() => setImportMessage(null), 2500)
  }

  const visitedIds = useMemo(() => {
    if (!tree.currentPersonId) return new Set(males.map((male) => male.id))

    if ((tree.phase === 'add-wives' || tree.phase === 'assign-mothers') && tree.malesQueue.length > 0) {
      const index = tree.malesQueue.indexOf(tree.currentPersonId)
      const visitedCount = index >= 0 ? index : tree.currentMaleIndex
      return new Set(tree.malesQueue.slice(0, Math.max(0, visitedCount)))
    }

    const index = males.findIndex((male) => male.id === tree.currentPersonId)
    return new Set(males.slice(0, Math.max(0, index)).map((male) => male.id))
  }, [males, tree.currentMaleIndex, tree.currentPersonId, tree.malesQueue, tree.phase])

  const childrenContinueLabel = useMemo(() => {
    if (!tree.root || !tree.currentPersonId || tree.phase !== 'enter-children') {
      return undefined
    }
    const next = advanceAfterDone(tree.currentPersonId, tree.root)
    return next === 'phase2'
      ? 'حفظ والانتقال إلى الزوجات'
      : 'حفظ والانتقال للتالي'
  }, [tree.currentPersonId, tree.phase, tree.root])

  function showSaved(personId: string) {
    setSavedId(personId)
    window.setTimeout(() => setSavedId(null), 1800)
  }

  function updateSidebarWidth(width: number) {
    const maximum = Math.max(260, Math.min(560, window.innerWidth - 420))
    const next = Math.round(Math.min(maximum, Math.max(260, width)))
    setSidebarWidth(next)
    localStorage.setItem('nasab-sidebar-width', String(next))
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const bounds = sidebar.getBoundingClientRect()
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: bounds.width,
      anchoredLeft: bounds.left < window.innerWidth / 2,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const movement = event.clientX - resize.startX
    updateSidebarWidth(
      resize.startWidth + (resize.anchoredLeft ? movement : -movement),
    )
  }

  function stopSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const isWivesPhase = tree.phase === 'add-wives'
  const isChildrenPhase = tree.phase === 'enter-children'
  const isMothersPhase = tree.phase === 'assign-mothers'

  const multiWifeCount = useMemo(() => {
    if (!tree.root) return 0
    return collectMalesDFS(tree.root).filter(
      (m) => (m.wives?.length ?? 0) > 1 && (m.children?.length ?? 0) > 0,
    ).length
  }, [tree.root])

  const wivesContinueLabel = useMemo(() => {
    if (!isWivesPhase) return undefined
    const isLast = tree.currentMaleIndex >= tree.malesQueue.length - 1
    if (isLast) {
      return multiWifeCount > 0
        ? 'حفظ والانتقال إلى الأمهات'
        : 'حفظ والإنهاء إلى المراجعة'
    }
    return 'حفظ والانتقال للتالي'
  }, [isWivesPhase, tree.currentMaleIndex, tree.malesQueue.length, multiWifeCount])

  const mothersContinueLabel = useMemo(() => {
    if (!isMothersPhase) return undefined
    const isLast = tree.currentMaleIndex >= tree.malesQueue.length - 1
    return isLast ? 'حفظ والإنهاء إلى المراجعة' : 'حفظ والانتقال للتالي'
  }, [isMothersPhase, tree.currentMaleIndex, tree.malesQueue.length])

  const mothersProgressLabel = useMemo(() => {
    if (!isMothersPhase || tree.malesQueue.length === 0) return ''
    return `رجل ${(tree.currentMaleIndex + 1).toLocaleString('ar')} من ${tree.malesQueue.length.toLocaleString('ar')} (متعدد)`
  }, [isMothersPhase, tree.currentMaleIndex, tree.malesQueue.length])

  const activeFocus = useMemo(() => {
    if (isChildrenPhase) {
      return reviewFocus === 'wives' || reviewFocus === 'mothers' ? reviewFocus : 'children'
    }
    if (isWivesPhase) {
      return reviewFocus === 'children' || reviewFocus === 'mothers' ? reviewFocus : 'wives'
    }
    if (isMothersPhase) {
      return reviewFocus === 'children' || reviewFocus === 'wives' ? reviewFocus : 'mothers'
    }
    return reviewFocus
  }, [isChildrenPhase, isWivesPhase, isMothersPhase, reviewFocus])

  // ── Setup screen (new tree, no root yet) ──
  if (tree.phase === 'setup' || !tree.root) {
    return (
      <main className="setup" dir="rtl">
        <div className="setup-card">
          <button className="back-button" onClick={onGoHome} type="button">
            → العودة إلى الرئيسية
          </button>
          <p className="eyebrow">نَسَب</p>
          <h1>أنشئ شجرة النسب</h1>
          <p className="lede">
            ابدأ بالجد الأعلى، ثم أدخل أبناء وبنات كل رجل كما وردوا في الكتاب.
          </p>
          {tree.linkedFrom && (
            <div className="setup-linked-banner">
              <span className="badge-icon">
                {tree.linkedFrom.type === 'daughter-branch'
                  ? '🧬'
                  : tree.linkedFrom.type === 'brother-branch'
                  ? '🤝'
                  : '🌿'}
              </span>
              <div>
                <strong>
                  {tree.linkedFrom.type === 'daughter-branch'
                    ? `فرع بنت: ${tree.linkedFrom.personName || ''}`
                    : tree.linkedFrom.type === 'brother-branch'
                    ? `فرع أخ الجد الأكبر: ${tree.linkedFrom.personName || ''}`
                    : 'فرع عائلي مرتبط'}
                </strong>
                <p>متصل بالشجرة الرئيسية «{tree.linkedFrom.mainTreeName}»</p>
              </div>
            </div>
          )}
          <form
            className="entry-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (rootName.trim()) tree.startRoot(rootName)
            }}
          >
            <div className="input-row">
              <input
                type="text"
                dir="rtl"
                autoFocus
                value={rootName}
                placeholder="اسم الجد الأعلى"
                onChange={(event) => setRootName(event.target.value)}
                autoComplete="off"
              />
              <button type="submit" className="primary">
                ابدأ
              </button>
            </div>
            <p className="hint">
              سيُسجّل بالمعرّف <span className="badge badge-m">M001</span>
            </p>
          </form>
        </div>
      </main>
    )
  }

  const isComplete = tree.phase === 'complete'
  const isEditingEarlier =
    selectedId !== null && selectedId !== tree.currentPersonId

  const showWivesForm = activeFocus === 'wives'
  const showMothersForm = activeFocus === 'mothers'

  const wivesProgressLabel = isWivesPhase
    ? `${(tree.currentMaleIndex + 1).toLocaleString('ar')} / ${tree.malesQueue.length.toLocaleString('ar')}`
    : ''

  return (
    <div
      className="layout"
      dir="rtl"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <header className="topbar">
        <button
          className="home-nav-button"
          onClick={onGoHome}
          title="الرئيسية"
          aria-label="العودة إلى الرئيسية"
        >
          ←
        </button>
        <div className="brand">
          <span className="brand-mark">ن</span>
          <span>نَسَب</span>
        </div>

        {(() => {
          const activeLink = tree.linkedFrom || currentTreeMeta?.linkedFrom
          if (!activeLink) {
            return (
              <button
                type="button"
                className="compact-button"
                onClick={() => setIsLinkModalOpen(true)}
                title="ربط هذه الشجرة كفرع لشجرة أخرى (مثلاً: أخت الجد الخامس هي أم لهذه الشجرة)"
              >
                🔗 ربط كفرع بشجرة أخرى
              </button>
            )
          }
          return (
            <div className="linked-tree-header-badge">
              <button
                type="button"
                className="linked-tree-nav-btn"
                onClick={() => {
                  if (onOpenTree) onOpenTree(activeLink.mainTreeId)
                }}
                title={`الانتقال إلى الشجرة الرئيسية «${activeLink.mainTreeName}»`}
              >
                <span className="badge-icon">
                  {activeLink.type === 'daughter-branch' ? '🧬' : '🤝'}
                </span>
                <span>
                  متصلة بـ «{activeLink.mainTreeName}»
                  {activeLink.personName ? ` (أم/صلة: ${activeLink.personName})` : ''}
                </span>
              </button>
              <button
                type="button"
                className="unlink-mini-btn"
                onClick={() => {
                  if (window.confirm('هل تريد بالتأكيد فك ارتباط هذه الشجرة وجعلها شجرة مستقلة؟')) {
                    void handleLinkExistingTree(treeId, null)
                  }
                }}
                title="فك الارتباط لتصبح هذه الشجرة مستقلة ومنفصلة تماماً"
              >
                ✂️ فك الارتباط (جعلها مستقلة)
              </button>
            </div>
          )
        })()}

        <button
          type="button"
          className="compact-button"
          onClick={onOpenChart}
          title="فتح مخطط الشجرة المرئي"
        >
          🌳 مخطط الشجرة
        </button>

        <button
          type="button"
          className="compact-button"
          onClick={onOpenPrint}
          title="عرض وطباعة وثيقة وسجل النسب"
        >
          🖨️ وثيقة للطباعة
        </button>


        {tree.isSyncing && (
          <span className="sync-indicator" role="status" aria-live="polite">
            ⟳ جارٍ المزامنة
          </span>
        )}
        <div className="phases" aria-label="مراحل العمل">
          <button
            type="button"
            className={`phase-button phase${isChildrenPhase ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('enter-children')
              setReviewFocus('children')
            }}
            title="الانتقال إلى مرحلة إدخال الأبناء والبنات"
          >
            ١ · الأبناء والبنات
          </button>
          <button
            type="button"
            className={`phase-button phase${isWivesPhase ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('add-wives')
              setReviewFocus('wives')
            }}
            title="الانتقال إلى مرحلة إدخال الزوجات"
          >
            ٢ · الزوجات
          </button>
          <button
            type="button"
            className={`phase-button phase${isMothersPhase ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('assign-mothers')
              setReviewFocus('mothers')
            }}
            title="الانتقال إلى مرحلة ربط الأمهات (للمتزوجين بأكثر من واحدة)"
          >
            ٣ · الأمهات{multiWifeCount > 0 ? ` (${multiWifeCount.toLocaleString('ar')})` : ''}
          </button>
          <button
            type="button"
            className={`phase-button phase${isComplete ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('complete')
            }}
            title="الانتقال إلى مرحلة المراجعة"
          >
            ٤ · المراجعة
          </button>
        </div>
        <div className="counts">
          <span>{arabicCount(counts.males, 'رجل', 'رجال')}</span>
          <span>{arabicCount(counts.females, 'امرأة', 'نساء')}</span>
        </div>
      </header>

      <main className="panel">
        {selectedPerson ? (
          <>
            {savedId === selectedPerson.id && (
              <p className="save-notice" role="status">
                تم الحفظ
              </p>
            )}
            {selectedPerson.gender === 'M' ? (
              <>
                <div className="review-focus" role="tablist" aria-label="نوع التعديل">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFocus === 'children'}
                    className={`compact-button${activeFocus === 'children' ? ' primary' : ''}`}
                    onClick={() => setReviewFocus('children')}
                  >
                    الأبناء والبنات ({selectedPerson.children.length.toLocaleString('ar')})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFocus === 'wives'}
                    className={`compact-button${activeFocus === 'wives' ? ' primary' : ''}`}
                    onClick={() => setReviewFocus('wives')}
                  >
                    الزوجات ({selectedPerson.wives.length.toLocaleString('ar')})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFocus === 'mothers'}
                    className={`compact-button${activeFocus === 'mothers' ? ' primary' : ''}`}
                    onClick={() => setReviewFocus('mothers')}
                  >
                    الأمهات
                  </button>
                </div>
                {showWivesForm ? (
                  <WivesBatchForm
                    key={`wives-${selectedPerson.id}`}
                    person={selectedPerson}
                    root={tree.root}
                    lineageText={lineageText}
                    isCurrent={!isEditingEarlier && isWivesPhase}
                    progressLabel={wivesProgressLabel}
                    continueLabel={wivesContinueLabel}
                    currentTreeId={treeId}
                    currentTreeName={tree.root ? `شجرة ${tree.root.name}` : undefined}
                    availableTrees={sessions}
                    onRename={(name) => tree.renamePerson(selectedPerson.id, name)}
                    onSave={(wives) => {
                      tree.setWives(selectedPerson.id, wives)
                      showSaved(selectedPerson.id)
                    }}
                    onSaveAndContinue={(wives) => {
                      tree.setWivesAndContinue(wives)
                      setSelectedId(null)
                    }}
                    onReturnToCurrent={() => setSelectedId(null)}
                    onSwitchToChildren={() => setReviewFocus('children')}
                    onAddDaughter={(fatherId, daughterName) => {
                      const newId = tree.addChildToPerson(fatherId, daughterName, 'F')
                      if (newId) {
                        showSaved(fatherId)
                      }
                      return newId
                    }}
                  />
                ) : showMothersForm ? (
                  <MothersAssignForm
                    key={`mothers-${selectedPerson.id}-${selectedPerson.wives.map((w) => w.id).join('|')}`}
                    person={selectedPerson}
                    root={tree.root}
                    lineageText={lineageText}
                    isCurrent={!isEditingEarlier && isMothersPhase}
                    progressLabel={mothersProgressLabel}
                    continueLabel={mothersContinueLabel}
                    onSave={(assignments) => {
                      tree.setChildrenMothers(selectedPerson.id, assignments)
                      showSaved(selectedPerson.id)
                    }}
                    onSaveAndContinue={(assignments) => {
                      tree.setMothersAndContinue(selectedPerson.id, assignments)
                      setSelectedId(null)
                    }}
                    onReturnToCurrent={() => setSelectedId(null)}
                    onSkip={isMothersPhase ? () => {
                      tree.skipMotherAndContinue()
                      setSelectedId(null)
                    } : undefined}
                    onBack={() => setReviewFocus(isWivesPhase ? 'wives' : isMothersPhase ? 'mothers' : 'children')}
                  />
                ) : (
                  <ChildrenBatchForm
                    key={`children-${selectedPerson.id}`}
                    person={selectedPerson}
                    lineageText={lineageText}
                    isCurrent={!isEditingEarlier && isChildrenPhase}
                    canDelete={selectedPerson.id !== tree.root.id}
                    continueLabel={childrenContinueLabel}
                    returnToWivesLabel={isWivesPhase ? 'حفظ والعودة إلى الزوجات' : undefined}
                    onReturnToWives={isWivesPhase ? () => setReviewFocus('wives') : undefined}
                    onRename={(name) => tree.renamePerson(selectedPerson.id, name)}
                    onSave={(sons, daughters) => {
                      tree.setChildren(selectedPerson.id, sons, daughters)
                      showSaved(selectedPerson.id)
                    }}
                    onSaveAndContinue={(sons, daughters) => {
                      if (isWivesPhase) {
                        tree.setChildren(selectedPerson.id, sons, daughters)
                        showSaved(selectedPerson.id)
                        setReviewFocus('wives')
                      } else {
                        tree.setChildrenAndContinue(sons, daughters)
                        setSelectedId(null)
                      }
                    }}
                    onDelete={() => {
                      tree.deletePerson(selectedPerson.id)
                      setSelectedId(null)
                    }}
                    onReturnToCurrent={() => setSelectedId(null)}
                  />
                )}
              </>
            ) : (
              <PersonEditor
                key={selectedPerson.id}
                person={selectedPerson}
                onRename={(name) => {
                  tree.renamePerson(selectedPerson.id, name)
                  showSaved(selectedPerson.id)
                }}
                onDelete={() => {
                  tree.deletePerson(selectedPerson.id)
                  setSelectedId(null)
                }}
                onBack={() => setSelectedId(null)}
              />
            )}
          </>
        ) : isMothersPhase && tree.malesQueue.length === 0 ? (
          <section className="stage complete-stage">
            <p className="eyebrow">مرحلة الأمهات</p>
            <h2>لا يوجد رجال متعددو الزوجات</h2>
            <p className="lede">
              جميع الرجال المسجلين في هذه الشجرة لديهم زوجة واحدة فقط أو بدون زوجات.
              تم تعيين أمهات الأبناء تلقائياً لعدم وجود تعدد زوجات يتطلب التحديد اليدوي.
            </p>
            <div className="actions">
              <button
                className="primary"
                type="button"
                onClick={() => tree.goToPhase('complete')}
              >
                الانتقال إلى المراجعة ←
              </button>
              <button
                type="button"
                onClick={() => {
                  tree.goToPhase('add-wives')
                  setReviewFocus('wives')
                }}
              >
                العودة إلى الزوجات
              </button>
            </div>
          </section>
        ) : (
          <section className="stage complete-stage">
            <p className="eyebrow">اكتمل إدخال الأشخاص والزوجات والأمهات</p>
            <h2>أصبحت الشجرة جاهزة للمراجعة</h2>
            <p className="lede">
              سُجّل {arabicCount(counts.males, 'رجل', 'رجال')} و
              {arabicCount(counts.females, 'امرأة', 'نساء')}. اختر أي رجل من
              الشجرة لتعديل أبنائه أو زوجاته أو أمهاتهم.
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={onOpenPrint}
                title="عرض وطباعة وثيقة وسجل النسب"
              >
                🖨️ طباعة وثيقة النسب
              </button>
              <button
                onClick={() => {
                  setReviewFocus('wives')
                  tree.startWivesPhase()
                  setSelectedId(null)
                }}
              >
                مراجعة الزوجات رجلاً برجُل
              </button>
              {multiWifeCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setReviewFocus('mothers')
                    tree.startMothersPhase()
                    setSelectedId(null)
                  }}
                >
                  مراجعة الأمهات لمتعددي الزوجات ({multiWifeCount.toLocaleString('ar')})
                </button>
              )}
              <button
                onClick={() =>
                  download(
                    'nasab.json',
                    tree.exportProject(),
                    'application/json',
                  )
                }
              >
                تنزيل JSON
              </button>
              <button
                onClick={() =>
                  download(
                    'nasab.txt',
                    exportOutline(tree.root!),
                    'text/plain',
                  )
                }
              >
                تنزيل النص
              </button>
              <button className="ghost" onClick={onGoHome}>
                شجرة أخرى
              </button>
            </div>
          </section>
        )}
      </main>

      <aside className="sidebar" ref={sidebarRef}>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="تغيير عرض شجرة الأشخاص"
          aria-orientation="vertical"
          aria-valuemin={260}
          aria-valuemax={560}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
          onDoubleClick={() => updateSidebarWidth(320)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              updateSidebarWidth(sidebarWidth + 20)
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              updateSidebarWidth(sidebarWidth - 20)
            }
            if (event.key === 'Home') updateSidebarWidth(260)
            if (event.key === 'End') updateSidebarWidth(560)
          }}
        />
        <div className="sidebar-heading">
          <div>
            <p className="eyebrow">الفهرس</p>
            <h3>شجرة الأشخاص</h3>
          </div>
          {selectedId && (
            <button className="compact-button" onClick={() => setSelectedId(null)}>
              موضع الإدخال
            </button>
          )}
        </div>
        <div className="data-actions">
          <button
            className="compact-button"
            onClick={() =>
              download(
                'nasab-backup.json',
                tree.exportProject(),
                'application/json',
              )
            }
          >
            تصدير JSON
          </button>
          <label className="compact-button import-button">
            استيراد JSON
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importJson(file)
                event.target.value = ''
              }}
            />
          </label>
          {importMessage && (
            <span className="import-message" role="status">
              {importMessage}
            </span>
          )}
        </div>
        <p className="tree-help">
          {isWivesPhase
            ? 'اختر أي رجل لمراجعة زوجاته أو تعديلها.'
            : isMothersPhase
              ? 'اختر رجلاً لتعديل أمهات أولاده (يتم حصر متعددي الزوجات فقط).'
              : isComplete
                ? 'اختر أي رجل لمراجعة أبنائه أو زوجاته أو أمهاتهم.'
                : 'اختر أي رجل لمراجعة أبنائه وبناته.'}
        </p>
        <TreeRoot
          person={tree.root}
          currentId={tree.currentPersonId}
          selectedId={selectedId ?? tree.currentPersonId}
          visitedIds={visitedIds}
          onSelect={(person) => {
            setSelectedId(person.id)
          }}
        />
      </aside>

      {isLinkModalOpen && (
        <LinkTreeModal
          isOpen={isLinkModalOpen}
          onClose={() => setIsLinkModalOpen(false)}
          mainTree={null}
          allTrees={sessions}
          targetBranchTreeId={treeId}
          onCreateLinkedTree={handleCreateLinkedTree}
          onLinkExistingTree={handleLinkExistingTree}
        />
      )}
    </div>
  )
}
