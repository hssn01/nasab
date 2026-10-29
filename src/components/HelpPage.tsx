import './HelpPage.css'

interface HelpPageProps {
  treeId?: string | null
  onGoHome: () => void
  onGoToChart?: () => void
}

export function HelpPage({ treeId, onGoHome, onGoToChart }: HelpPageProps) {
  return (
    <main className="help-page" dir="rtl">
      <header className="help-header">
        <div className="help-header-inner">
          <div className="help-brand" title="نَسَب">
            <span className="help-brand-mark">ن</span>
            <div>
              <strong>نَسَب</strong>
              <span>دليل سريع</span>
            </div>
          </div>

          <div className="help-header-actions">
            {treeId && onGoToChart && (
              <button type="button" className="help-btn" onClick={onGoToChart}>
                العودة إلى الشجرة
              </button>
            )}
            <button type="button" className="help-btn" onClick={onGoHome}>
              الرئيسية
            </button>
          </div>
        </div>
      </header>

      <div className="help-content">
        <section className="help-hero">
          <p className="eyebrow">استعراض الشجرة</p>
          <h1>استخدام نَسَب</h1>
          <p>استعرض الشجرة، وابحث عن أي اسم، وافتح تفاصيله.</p>
        </section>

        <div className="help-layout">
          <section className="help-card">
            <h2>خطوات الاستخدام</h2>
            <ol className="help-steps">
              <li>
                <strong>ابحث عن اسم</strong>
                <span>
                  اكتب الاسم أو الرمز أو اسم الأب، ثم اختر النتيجة.
                </span>
              </li>
              <li>
                <strong>تنقّل في المخطط</strong>
                <span>
                  اسحب الشجرة للتنقل. استخدم + و− للتكبير، و«ملاءمة» لعرض
                  الشجرة كاملة.
                </span>
              </li>
              <li>
                <strong>افتح بطاقة الشخص</strong>
                <span>اضغط على البطاقة لعرض النسب والأبناء والزوجات.</span>
              </li>
              <li>
                <strong>اعرض الفروع</strong>
                <span>
                  فعّل «عرض موحد» لرؤية الأشجار المرتبطة في مخطط واحد.
                </span>
              </li>
              <li>
                <strong>اطبع أو احفظ</strong>
                <span>
                  استخدم «طباعة السجل» لطباعة النسب أو حفظه بصيغة PDF.
                </span>
              </li>
            </ol>
          </section>

          <aside className="help-card">
            <h2>أزرار المخطط</h2>
            <dl className="help-controls">
              <div className="help-control-row">
                <dt>+ / −</dt>
                <dd>تكبير وتصغير</dd>
              </div>
              <div className="help-control-row">
                <dt>ملاءمة</dt>
                <dd>عرض الشجرة كاملة</dd>
              </div>
              <div className="help-control-row">
                <dt>توسيع الكل</dt>
                <dd>إظهار كل الفروع</dd>
              </div>
              <div className="help-control-row">
                <dt>طي الكل</dt>
                <dd>إخفاء الفروع</dd>
              </div>
              <div className="help-control-row">
                <dt>عرض موحد</dt>
                <dd>الأشجار المرتبطة</dd>
              </div>
              <div className="help-control-row">
                <dt>طباعة السجل</dt>
                <dd>طباعة أو حفظ PDF</dd>
              </div>
            </dl>
            <p className="help-tip">
              للبحث عن سلسلة نسب، اكتب الاسم ثم اسم الأب أو الجد.
            </p>
          </aside>
        </div>

        <div className="help-note">
          <strong>ملاحظة</strong>
          <span>الاستعراض للقراءة فقط. لا تحتاج إلى تسجيل.</span>
        </div>
      </div>
    </main>
  )
}
