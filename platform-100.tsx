import { useState, useEffect, useCallback } from "react";
import mammoth from "mammoth";

// ---------- Constants ----------
const STAGE_COUNT = 6;
const COURSES_PER_STAGE = 2;
const ADMIN_CODE = "100";
const YEAR_WORDS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Subjects for Stage 2 / Course 1, as read from the batch's material list.
// Content text is empty (the source list didn't expose it) — admin can paste text
// or upload a file for each one to generate its MCQs.
const STAGE2_COURSE1_SUBJECTS = [
  "HSF 2 - Head & Neck",
  "HSF 2 - Neuroanatomy",
  "NS - Histology",
  "NS - Physiology",
  "NS - Embryology",
  "NS - Medicine",
  "CLS - Pathology",
  "CLS - Microbiology",
  "CLS - GBD",
  "PP - Principles of Pharmacology",
  "BC - Baath Crimes",
];

function seedStage2Course1(structure) {
  const stage2 = structure.stages.find((s) => s.id === "stage_2");
  const course1 = stage2?.courses.find((c) => c.id === "stage_2_course_1");
  if (course1 && course1.subjects.length === 0) {
    course1.subjects = STAGE2_COURSE1_SUBJECTS.map((name) => ({ id: uid(), name, lectures: [] }));
    return true;
  }
  return false;
}

// Migrates data saved by earlier versions of the app (course.lectures directly)
// into the new course -> subjects -> lectures shape, without losing any content
// or breaking already-generated MCQs (lecture ids are preserved).
function migrateOldSchema(structure) {
  let changed = false;
  structure.stages.forEach((stage) => {
    stage.courses.forEach((course) => {
      if (!course.subjects) {
        const oldLectures = course.lectures || [];
        course.subjects = oldLectures.map((l) => ({
          id: l.id,
          name: l.name,
          lectures: (l.text || l.file) ? [{ id: l.id, name: l.name, text: l.text || "", file: l.file || null }] : [],
        }));
        delete course.lectures;
        changed = true;
      }
    });
  });
  return changed;
}

const defaultStructure = () => ({
  stages: Array.from({ length: STAGE_COUNT }, (_, i) => ({
    id: `stage_${i + 1}`,
    name: `Stage ${i + 1}`,
    courses: Array.from({ length: COURSES_PER_STAGE }, (_, j) => ({
      id: `stage_${i + 1}_course_${j + 1}`,
      name: `Course ${j + 1}`,
      subjects: [],
    })),
  })),
});

// ---------- DNA Logo ----------
function Logo({ size = 34 }) {
  return (
    <svg width={size} height={size * 1.4} viewBox="0 0 30 42" fill="none">
      {[0, 1, 2, 3].map((i) => (
        <ellipse key={i} cx="15" cy={4 + i * 11} rx="10" ry="5" stroke="url(#lg)" strokeWidth="2" />
      ))}
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="30" y2="42">
          <stop offset="0%" stopColor="#FFD65A" />
          <stop offset="100%" stopColor="#B9791A" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function CapIcon({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 3L2 8l10 5 8-4v6" stroke="#F5C24C" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10.5v4c0 1.5 3 3 6 3s6-1.5 6-3v-4" stroke="#F5C24C" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="#F5C24C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- API Call Helper ----------
async function askClaude(content) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await response.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
  return text;
}

function extractJson(text) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("no json array found");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function generateMcqsForLecture(lecture, onProgress) {
  const { name: lectureName, text: lectureText, file } = lecture;
  const batches = 4;
  const perBatch = 8;
  let all = [];
  for (let b = 0; b < batches; b++) {
    const instructions = `أنت أستاذ طب تحضّر أسئلة اختيار من متعدد (MCQ) لطلاب الطب.
اسم المحاضرة: "${lectureName}"
${file ? "محتوى المحاضرة مرفق كملف (PDF أو صورة) مع هذه الرسالة." : `محتوى المحاضرة:\n"""\n${(lectureText || "").slice(0, 6000)}\n"""`}

أنشئ ${perBatch} سؤال اختيار من متعدد جديدة ومختلفة (الدفعة رقم ${b + 1} من ${batches}) تغطي المحاضرة أعلاه بشكل شامل، وتحاكي أسلوب أسئلة سنوات سابقة في كليات الطب (أسئلة سريرية وتطبيقية وليست مجرد حفظ). كل سؤال له 4 خيارات وخيار واحد صحيح فقط، مع شرح مختصر للإجابة.
أعد فقط مصفوفة JSON بدون أي نص إضافي وبدون Markdown، بهذا الشكل بالضبط:
[{"question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"..."}]`;

    const content = file
      ? [
          file.mediaType.startsWith("image/")
            ? { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } }
            : { type: "document", source: { type: "base64", media_type: file.mediaType, data: file.base64 } },
          { type: "text", text: instructions },
        ]
      : instructions;

    try {
      const text = await askClaude(content);
      const parsed = extractJson(text);
      all = all.concat(parsed);
    } catch (e) {
      // skip failed batch
    }
    onProgress && onProgress(all.length);
  }
  return all;
}

// ---------- Storage helpers ----------
async function loadStructure() {
  try {
    const res = await window.storage.get("structure", true);
    return res ? JSON.parse(res.value) : defaultStructure();
  } catch {
    return defaultStructure();
  }
}
async function saveStructure(struct) {
  await window.storage.set("structure", JSON.stringify(struct), true);
}
async function loadMcqs(lectureId) {
  try {
    const res = await window.storage.get(`mcqs:${lectureId}`, true);
    return res ? JSON.parse(res.value) : null;
  } catch {
    return null;
  }
}
async function saveMcqs(lectureId, mcqs) {
  await window.storage.set(`mcqs:${lectureId}`, JSON.stringify(mcqs), true);
}

// ---------- Main App ----------
export default function App() {
  const [structure, setStructure] = useState(null);
  const [view, setView] = useState({ level: "home" });
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);

  useEffect(() => {
    loadStructure().then(async (s) => {
      const migrated = migrateOldSchema(s);
      const seeded = seedStage2Course1(s);
      setStructure(s);
      setLoading(false);
      if (migrated || seeded) await saveStructure(s);
    });
  }, []);

  const persist = useCallback(async (next) => {
    setStructure(next);
    await saveStructure(next);
  }, []);

  if (loading || !structure) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <Logo size={44} />
          <p style={{ color: "#F5C24C", marginTop: 12, fontFamily: S.fontUtil, fontSize: 13 }}>Loading...</p>
        </div>
      </div>
    );
  }

  const stage = structure.stages.find((s) => s.id === view.stageId);
  const course = stage?.courses.find((c) => c.id === view.courseId);
  const subject = course?.subjects.find((sub) => sub.id === view.subjectId);
  const lecture = subject?.lectures.find((l) => l.id === view.lectureId);

  return (
    <div style={S.page}>
      <Header
        onHome={() => setView({ level: "home" })}
        isAdmin={isAdmin}
        onAdminClick={() => (isAdmin ? setIsAdmin(false) : setShowAdminModal(true))}
      />

      {showAdminModal && (
        <AdminModal
          onClose={() => setShowAdminModal(false)}
          onSubmit={(code) => {
            if (code === ADMIN_CODE) {
              setIsAdmin(true);
              setShowAdminModal(false);
            }
          }}
        />
      )}

      {view.level === "home" && (
        <HomeView structure={structure} onOpenStage={(stageId) => setView({ level: "stage", stageId })} />
      )}

      {view.level === "stage" && stage && (
        <StageView
          stage={stage}
          onBack={() => setView({ level: "home" })}
          onOpenCourse={(courseId) => setView({ level: "course", stageId: stage.id, courseId })}
        />
      )}

      {view.level === "course" && stage && course && (
        <CourseView
          course={course}
          isAdmin={isAdmin}
          onBack={() => setView({ level: "stage", stageId: stage.id })}
          onOpenSubject={(subjectId) => setView({ level: "subject", stageId: stage.id, courseId: course.id, subjectId })}
          onAddSubject={async (name) => {
            const next = structuredClone(structure);
            const c = next.stages.find((s) => s.id === stage.id).courses.find((c) => c.id === course.id);
            c.subjects.push({ id: uid(), name, lectures: [] });
            await persist(next);
          }}
          onDeleteSubject={async (subjectId) => {
            const next = structuredClone(structure);
            const c = next.stages.find((s) => s.id === stage.id).courses.find((c) => c.id === course.id);
            c.subjects = c.subjects.filter((sub) => sub.id !== subjectId);
            await persist(next);
          }}
        />
      )}

      {view.level === "subject" && stage && course && subject && (
        <SubjectView
          subject={subject}
          isAdmin={isAdmin}
          onBack={() => setView({ level: "course", stageId: stage.id, courseId: course.id })}
          onOpenLecture={(lectureId) =>
            setView({ level: "lecture", stageId: stage.id, courseId: course.id, subjectId: subject.id, lectureId })
          }
          onAddLecture={async (name, text, file) => {
            const next = structuredClone(structure);
            const c = next.stages.find((s) => s.id === stage.id).courses.find((c) => c.id === course.id);
            const sub = c.subjects.find((s2) => s2.id === subject.id);
            sub.lectures.push({ id: uid(), name, text: text || "", file: file || null });
            await persist(next);
          }}
          onDeleteLecture={async (lectureId) => {
            const next = structuredClone(structure);
            const c = next.stages.find((s) => s.id === stage.id).courses.find((c) => c.id === course.id);
            const sub = c.subjects.find((s2) => s2.id === subject.id);
            sub.lectures = sub.lectures.filter((l) => l.id !== lectureId);
            await persist(next);
          }}
        />
      )}

      {view.level === "lecture" && lecture && (
        <LectureView
          lecture={lecture}
          isAdmin={isAdmin}
          onBack={() => setView({ level: "subject", stageId: stage.id, courseId: course.id, subjectId: subject.id })}
        />
      )}
    </div>
  );
}

// ---------- Header ----------
function Header({ onHome, isAdmin, onAdminClick }) {
  return (
    <div style={S.header}>
      <div onClick={onHome} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
        <Logo size={30} />
        <span style={{ fontFamily: S.fontDisplay, fontSize: 22, fontWeight: 800, color: "#F2ECDD" }}>
          UOBCOM <span style={{ color: "#F5A623" }}>100</span>
        </span>
      </div>
      <button style={{ ...S.adminBtn, ...(isAdmin ? S.adminBtnActive : {}) }} onClick={onAdminClick}>
        🔒 {isAdmin ? "Admin ✓" : "Admin"}
      </button>
    </div>
  );
}

function AdminModal({ onClose, onSubmit }) {
  const [code, setCode] = useState("");
  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontFamily: S.fontDisplay, fontSize: 17, color: "#F2ECDD", marginBottom: 10 }}>Admin access</div>
        <input
          style={S.input}
          type="password"
          placeholder="Enter admin code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={S.primaryBtn} onClick={() => onSubmit(code)}>Unlock</button>
          <button style={S.ghostBtn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Home ----------
function HomeView({ structure, onOpenStage }) {
  return (
    <div style={S.container}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 22, marginBottom: 18 }}>
        <h1 style={S.h1}>Choose your Stage</h1>
        <span style={S.countBadge}>{structure.stages.length}</span>
      </div>
      <div style={S.grid}>
        {structure.stages.map((stage, i) => {
          const subjectCount = stage.courses.reduce((a, c) => a + c.subjects.length, 0);
          return (
            <div key={stage.id} style={S.card} onClick={() => onOpenStage(stage.id)}>
              <div style={S.cardGlow} />
              <div style={S.capBadge}><CapIcon /></div>
              <div style={S.cardTitle}>{stage.name}</div>
              <div style={S.cardSub}>
                {YEAR_WORDS[i]} year · {stage.courses.length} courses · {subjectCount} subjects
              </div>
              <div style={S.cardFooter}>
                <div style={S.progressTrack}><div style={S.progressFill} /></div>
                <div style={S.arrowBtn}><ArrowIcon /></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Stage ----------
function StageView({ stage, onBack, onOpenCourse }) {
  return (
    <div style={S.container}>
      <BackBtn onClick={onBack} label="Stages" />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, marginBottom: 18 }}>
        <h1 style={S.h1}>{stage.name}</h1>
        <span style={S.countBadge}>{stage.courses.length}</span>
      </div>
      <div style={S.grid}>
        {stage.courses.map((course) => (
          <div key={course.id} style={S.card} onClick={() => onOpenCourse(course.id)}>
            <div style={S.cardGlow} />
            <div style={S.capBadge}><CapIcon /></div>
            <div style={S.cardTitle}>{course.name}</div>
            <div style={S.cardSub}>{course.subjects.length} subjects</div>
            <div style={S.cardFooter}>
              <div style={S.progressTrack}><div style={S.progressFill} /></div>
              <div style={S.arrowBtn}><ArrowIcon /></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CourseView({ course, isAdmin, onBack, onOpenSubject, onAddSubject, onDeleteSubject }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await onAddSubject(name.trim());
    setSaving(false);
    setName("");
    setShowForm(false);
  };

  return (
    <div style={S.container}>
      <BackBtn onClick={onBack} label="Back" />
      <h1 style={{ ...S.h1, marginTop: 10, marginBottom: 18 }}>{course.name}</h1>

      {course.subjects.length === 0 && !showForm && (
        <p style={S.empty}>{isAdmin ? "No subjects yet. Add the first one." : "No subjects added yet."}</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {course.subjects.map((sub) => (
          <div key={sub.id} style={S.lectureRow}>
            <div onClick={() => onOpenSubject(sub.id)} style={{ flex: 1, cursor: "pointer" }}>
              <div style={S.lectureTitle}>{sub.name}</div>
              <div style={{ color: "#7a6f52", fontSize: 12, marginTop: 2 }}>{sub.lectures.length} lectures</div>
            </div>
            {isAdmin && (
              <button style={S.deleteBtn} onClick={() => onDeleteSubject(sub.id)}>Delete</button>
            )}
          </div>
        ))}
      </div>

      {isAdmin && (
        !showForm ? (
          <button style={S.primaryBtn} onClick={() => setShowForm(true)}>+ Add subject</button>
        ) : (
          <div style={S.formBox}>
            <input style={S.input} placeholder="Subject name" value={name} onChange={(e) => setName(e.target.value)} />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.primaryBtn} disabled={saving || !name.trim()} onClick={submit}>
                {saving ? "Saving..." : "Save subject"}
              </button>
              <button style={S.ghostBtn} onClick={() => { setShowForm(false); setName(""); }}>Cancel</button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ---------- Subject (holds many lectures) ----------
async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function SubjectView({ subject, isAdmin, onBack, onOpenLecture, onAddLecture, onDeleteLecture }) {
  const [showForm, setShowForm] = useState(false);
  const [mode, setMode] = useState("text"); // "text" | "file"
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [fileAttachment, setFileAttachment] = useState(null); // {mediaType, base64}
  const [fileName, setFileName] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setName("");
    setText("");
    setFileAttachment(null);
    setFileName("");
    setFileError("");
    setMode("text");
    setShowForm(false);
  };

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileError("");
    setFileName(file.name);
    setFileBusy(true);
    try {
      const lower = file.name.toLowerCase();
      if (file.type === "text/plain" || lower.endsWith(".txt")) {
        setText(await file.text());
        setFileAttachment(null);
      } else if (lower.endsWith(".docx")) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        setText(result.value);
        setFileAttachment(null);
      } else if (file.type === "application/pdf" || file.type.startsWith("image/")) {
        const base64 = await readFileAsBase64(file);
        setFileAttachment({ mediaType: file.type, base64 });
        setText("");
      } else {
        setFileError("نوع الملف غير مدعوم. استخدم PDF أو صورة أو DOCX أو TXT.");
        setFileName("");
      }
    } catch (err) {
      setFileError("تعذر قراءة الملف. حاول ملف آخر.");
    }
    setFileBusy(false);
  };

  const canSubmit = name.trim() && (mode === "text" ? text.trim() : fileAttachment || text.trim());

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    await onAddLecture(name.trim(), text.trim(), fileAttachment);
    setSaving(false);
    resetForm();
  };

  return (
    <div style={S.container}>
      <BackBtn onClick={onBack} label="Back" />
      <h1 style={{ ...S.h1, marginTop: 10, marginBottom: 18 }}>{subject.name}</h1>

      {subject.lectures.length === 0 && !showForm && (
        <p style={S.empty}>
          {isAdmin ? "لا اكو محاضرات بعد. أضف اسم المحاضرة وارفعلها ملف عشان يسوي لها أسئلة." : "No lectures added yet."}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {subject.lectures.map((l) => (
          <div key={l.id} style={S.lectureRow}>
            <div onClick={() => onOpenLecture(l.id)} style={{ flex: 1, cursor: "pointer" }}>
              <div style={S.lectureTitle}>{l.name}</div>
            </div>
            {isAdmin && (
              <button style={S.deleteBtn} onClick={() => onDeleteLecture(l.id)}>Delete</button>
            )}
          </div>
        ))}
      </div>

      {isAdmin && (
        !showForm ? (
          <button style={S.primaryBtn} onClick={() => setShowForm(true)}>+ إضافة محاضرة</button>
        ) : (
          <div style={S.formBox}>
            <input style={S.input} placeholder="اسم المحاضرة" value={name} onChange={(e) => setName(e.target.value)} />

            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={mode === "text" ? S.tabBtnActive : S.tabBtn}
                onClick={() => { setMode("text"); setFileAttachment(null); setFileName(""); }}
              >
                لصق نص
              </button>
              <button
                style={mode === "file" ? S.tabBtnActive : S.tabBtn}
                onClick={() => { setMode("file"); setText(""); }}
              >
                رفع ملف
              </button>
            </div>

            {mode === "text" ? (
              <textarea
                style={S.textarea}
                placeholder="الصق نص أو ملخص المحاضرة هنا..."
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  style={S.input}
                  type="file"
                  accept=".txt,.pdf,.docx,image/*"
                  onChange={handleFile}
                />
                {fileBusy && <p style={{ ...S.empty, margin: 0 }}>...جارِ قراءة الملف</p>}
                {fileName && !fileBusy && !fileError && (
                  <p style={{ ...S.empty, margin: 0, color: "#c9b567" }}>
                    ✓ {fileName}{fileAttachment ? " — بيرفع مباشرة للذكاء الاصطناعي" : " — تم استخراج النص"}
                  </p>
                )}
                {fileError && <p style={{ color: "#ff8a8a", fontSize: 12.5, margin: 0 }}>{fileError}</p>}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.primaryBtn} disabled={saving || !canSubmit} onClick={submit}>
                {saving ? "Saving..." : "حفظ المحاضرة"}
              </button>
              <button style={S.ghostBtn} onClick={resetForm}>إلغاء</button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ---------- Lecture ----------
function LectureView({ lecture, isAdmin, onBack }) {
  const [mcqs, setMcqs] = useState(null);
  const [loadingMcqs, setLoadingMcqs] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [answers, setAnswers] = useState({});
  const [showResults, setShowResults] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadingMcqs(true);
    loadMcqs(lecture.id).then((m) => {
      if (!cancelled) {
        setMcqs(m);
        setLoadingMcqs(false);
      }
    });
    return () => { cancelled = true; };
  }, [lecture.id]);

  const generate = async () => {
    setGenerating(true);
    setError("");
    setProgress(0);
    setAnswers({});
    setShowResults(false);
    try {
      const result = await generateMcqsForLecture(lecture, setProgress);
      if (result.length === 0) throw new Error("empty");
      setMcqs(result);
      await saveMcqs(lecture.id, result);
    } catch (e) {
      setError("Something went wrong generating the questions. Try again.");
    }
    setGenerating(false);
  };

  const score = mcqs ? mcqs.reduce((acc, q, i) => acc + (answers[i] === q.answerIndex ? 1 : 0), 0) : 0;

  return (
    <div style={S.container}>
      <BackBtn onClick={onBack} label="Back" />
      <h1 style={{ ...S.h1, marginTop: 10, marginBottom: 18, fontSize: 22 }}>{lecture.name}</h1>

      {loadingMcqs ? (
        <p style={S.empty}>Loading...</p>
      ) : (
        <>
          {isAdmin && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button style={S.primaryBtn} disabled={generating} onClick={generate}>
                {generating ? `Generating (${progress})...` : mcqs ? "Regenerate questions" : "Generate MCQs with AI"}
              </button>
            </div>
          )}
          {error && <p style={{ color: "#ff8a8a", fontFamily: S.fontUtil }}>{error}</p>}
          {!mcqs && !isAdmin && <p style={S.empty}>No quiz available for this lecture yet.</p>}

          {mcqs && mcqs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {mcqs.map((q, i) => (
                <div key={i} style={S.qCard}>
                  <div style={S.qText}>{i + 1}. {q.question}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    {q.options.map((opt, oi) => {
                      const chosen = answers[i] === oi;
                      const correct = showResults && oi === q.answerIndex;
                      const wrong = showResults && chosen && oi !== q.answerIndex;
                      return (
                        <div
                          key={oi}
                          onClick={() => !showResults && setAnswers((a) => ({ ...a, [i]: oi }))}
                          style={{
                            ...S.option,
                            borderColor: correct ? "#F5C24C" : wrong ? "#ff8a8a" : chosen ? "#7a6a2f" : "#2a2a2a",
                            background: chosen && !showResults ? "#241f0c" : "#141414",
                          }}
                        >
                          {opt}
                        </div>
                      );
                    })}
                  </div>
                  {showResults && <div style={S.explanation}>{q.explanation}</div>}
                </div>
              ))}
              {!showResults ? (
                <button style={S.primaryBtn} onClick={() => setShowResults(true)}>Show results</button>
              ) : (
                <div style={S.scoreBox}>Score: {score} / {mcqs.length}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BackBtn({ onClick, label }) {
  return <button style={S.backBtn} onClick={onClick}>‹ {label}</button>;
}

// ---------- Styles ----------
const S = {
  fontDisplay: "'Poppins', 'Segoe UI', system-ui, sans-serif",
  fontUtil: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  page: {
    minHeight: "100vh",
    background: "radial-gradient(circle at 50% -10%, #1a1206 0%, #0a0806 45%, #050403 100%)",
    color: "#F0EAD8",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh" },
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid #1e1a10",
    position: "sticky",
    top: 0,
    background: "#0a0806ee",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  adminBtn: {
    background: "#161208",
    border: "1px solid #3a2f14",
    color: "#c9b567",
    fontSize: 13,
    borderRadius: 10,
    padding: "8px 14px",
    cursor: "pointer",
  },
  adminBtnActive: { borderColor: "#F5A623", color: "#F5C24C" },
  modalOverlay: {
    position: "fixed", inset: 0, background: "#000000cc",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
  },
  modalBox: {
    background: "#141108", border: "1px solid #3a2f14", borderRadius: 14,
    padding: 20, width: "min(320px, 85vw)",
  },
  container: { padding: "18px 20px 40px", maxWidth: 900, margin: "0 auto" },
  h1: { fontFamily: "'Poppins', system-ui, sans-serif", fontSize: 24, fontWeight: 700, color: "#F5EFDD", margin: 0 },
  countBadge: {
    border: "1px solid #F5A62355", color: "#F5A623", background: "#2a1c07",
    borderRadius: 20, padding: "2px 12px", fontSize: 13, fontWeight: 700,
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 },
  card: {
    position: "relative",
    overflow: "hidden",
    background: "linear-gradient(160deg, #17130a 0%, #0d0b06 70%)",
    border: "1px solid #2b2313",
    borderRadius: 18,
    padding: "20px 18px 16px",
    cursor: "pointer",
  },
  cardGlow: {
    position: "absolute", top: -40, right: -40, width: 140, height: 140,
    background: "radial-gradient(circle, #F5A62333 0%, transparent 70%)",
  },
  capBadge: {
    width: 44, height: 44, borderRadius: 12,
    background: "#1c160a", border: "1px solid #4a3a17",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 14,
  },
  cardTitle: { color: "#F5EFDD", fontSize: 17, fontWeight: 700, marginBottom: 6 },
  cardSub: { color: "#8a7d57", fontSize: 12.5, lineHeight: 1.5, minHeight: 34 },
  cardFooter: { display: "flex", alignItems: "center", gap: 10, marginTop: 16 },
  progressTrack: { flex: 1, height: 4, background: "#241d0e", borderRadius: 4, overflow: "hidden" },
  progressFill: { width: "0%", height: "100%", background: "linear-gradient(90deg,#F5C24C,#B9791A)" },
  arrowBtn: {
    width: 30, height: 30, borderRadius: 9, border: "1px solid #4a3a17",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  backBtn: { background: "none", border: "none", color: "#c9b567", fontSize: 14, cursor: "pointer", padding: "6px 0" },
  empty: { color: "#7a6f52", fontSize: 13, marginTop: 12, lineHeight: 1.7 },
  lectureRow: {
    display: "flex", alignItems: "center", background: "#131108",
    border: "1px solid #232016", borderRadius: 10, padding: "12px 14px",
  },
  lectureTitle: { color: "#F0EAD8", fontSize: 14, fontWeight: 500 },
  deleteBtn: {
    background: "none", border: "1px solid #3a2a2a", color: "#c98080",
    fontSize: 12, borderRadius: 8, padding: "6px 10px", cursor: "pointer",
  },
  primaryBtn: {
    background: "linear-gradient(135deg,#FFD65A,#D99B12)", color: "#141200",
    border: "none", borderRadius: 10, padding: "12px 18px", fontWeight: 700,
    fontSize: 14, cursor: "pointer", marginTop: 14,
  },
  ghostBtn: {
    background: "none", border: "1px solid #333", color: "#c9c0a0",
    borderRadius: 10, padding: "12px 18px", fontSize: 14, cursor: "pointer", marginTop: 14,
  },
  formBox: { display: "flex", flexDirection: "column", gap: 10, marginTop: 16 },
  tabBtn: {
    background: "none", border: "1px solid #2a2a2a", color: "#9a8f6f",
    borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer",
  },
  tabBtnActive: {
    background: "#241f0c", border: "1px solid #F5A623", color: "#F5C24C",
    borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontWeight: 700,
  },
  input: {
    background: "#111", border: "1px solid #2a2a2a", borderRadius: 8,
    padding: "10px 12px", color: "#F0EAD8", fontSize: 14, width: "100%", boxSizing: "border-box",
  },
  textarea: {
    background: "#111", border: "1px solid #2a2a2a", borderRadius: 8,
    padding: "10px 12px", color: "#F0EAD8", fontSize: 13, lineHeight: 1.6, resize: "vertical",
  },
  qCard: { background: "#121008", border: "1px solid #242015", borderRadius: 12, padding: 14 },
  qText: { color: "#F5EFDD", fontSize: 14, fontWeight: 600, lineHeight: 1.6 },
  option: { border: "1px solid #2a2a2a", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#dcd3b8", cursor: "pointer" },
  explanation: {
    marginTop: 10, fontSize: 12.5, color: "#b6a35f", background: "#1a1608",
    borderRadius: 8, padding: "10px 12px", lineHeight: 1.6,
  },
  scoreBox: { textAlign: "center", fontFamily: "'Poppins', sans-serif", fontSize: 20, color: "#F5C24C", padding: "14px 0" },
};
