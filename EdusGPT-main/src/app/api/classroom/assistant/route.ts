import { NextResponse, type NextRequest } from "next/server";
import { resolveProvider } from "@/lib/ai/config";
import { credentialGate } from "@/lib/ai/readiness";
import { generateJson } from "@/lib/ai/llm";
import { clientKey, rateLimit, rejectRemote } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION_LENGTH = 1500;
const MAX_HISTORY_TURNS = 8;
const CHAT_TIMEOUT_MS = 22_000;
const CHAT_TOTAL_TIMEOUT_MS = 32_000;

function buildSystemPrompt(isEnglish: boolean): string {
  if (isEnglish) {
    return `You are a knowledgeable, supportive AI Teaching Assistant in an interactive classroom.
You are watching the lesson alongside the student.
Your responsibilities:
1. Answer the student's questions clearly based on the current slide, recent conversation history, and lesson context.
2. Keep replies concise, encouraging, and easy to understand in natural English.
3. For formulas or abstract ideas, include a brief real-world analogy when helpful.
4. Write math formulas using LaTeX: $...$ for inline math, $$...$$ for display math. Bold key points with **...**. Do not use markdown tables or code fences.
5. Stay grounded in the lesson content and prior chat turns. If something is not covered in the lesson, state that clearly instead of guessing.`;
  }

  return `Bạn là Trợ Giảng AI thông thái, tận tâm trong lớp học ảo.
Bạn đang cùng học sinh theo dõi bài giảng.
Nhiệm vụ của bạn:
1. Giải thích cặn kẽ thắc mắc của học sinh dựa trên bối cảnh cảnh học hiện tại, lịch sử trò chuyện và mạch bài giảng.
2. Trả lời súc tích, sinh động, dễ hiểu, dùng ngôn ngữ tiếng Việt thân thiện, khích lệ.
3. Nếu học sinh hỏi về công thức hay ví dụ, hãy đưa ra so sánh thực tế dễ hình dung.
4. Công thức toán viết bằng LaTeX: $...$ cho công thức trong dòng, $$...$$ cho công thức đứng một mình. In đậm ý chính bằng **...**. Không dùng markdown bảng hay code block.
5. Chỉ dựa vào nội dung bài giảng và lịch sử trao đổi. Phần nào tài liệu không nói tới thì nói thẳng là chưa có trong bài, đừng suy đoán rồi nói như chắc chắn.
6. Dùng từ tiếng Việt đã có sẵn ("hình chữ nhật", "diện tích", "phân hoạch", "giới hạn"), đừng dựng từ bằng cách dịch chữ từng chữ.`;
}

interface AssistantResponse {
  answer: string;
  suggestedQuestions?: string[];
}

interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

interface SceneContextPayload {
  title: string;
  subtitle?: string;
  kind: string;
  bullets?: string[];
  steps?: string[];
  formula?: string;
  table?: {
    caption?: string;
    columns?: string[];
    rows?: string[][];
  };
  data?: Array<{
    label: string;
    value: number;
    unit?: string;
    note?: string;
  }>;
  mindmap?: {
    center?: string;
    branches?: Array<{ label: string; items?: string[] }>;
  };
  quiz?: {
    question?: string;
    options?: Array<{ text: string; isCorrect?: boolean }>;
  };
  narration?: string;
}

function formatSceneContext(scene: SceneContextPayload | undefined): string {
  if (!scene) return "";
  const lines: string[] = [];
  if (scene.subtitle) lines.push(`Phụ đề cảnh: ${scene.subtitle}`);
  if (scene.bullets?.length) {
    lines.push("Nội dung chính:");
    scene.bullets.forEach((b) => lines.push(`- ${b}`));
  }
  if (scene.steps?.length) {
    lines.push("Các bước giải / quy trình:");
    scene.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (scene.formula) {
    lines.push(`Công thức: ${scene.formula}`);
  }
  if (scene.table?.columns?.length) {
    const caption = scene.table.caption ? ` (${scene.table.caption})` : "";
    lines.push(`Bảng dữ liệu${caption}: ${scene.table.columns.join(" | ")}`);
    (scene.table.rows ?? []).slice(0, 6).forEach((row) => {
      lines.push(`  - ${row.join(" | ")}`);
    });
  }
  if (scene.data?.length) {
    lines.push("Số liệu minh họa:");
    scene.data.slice(0, 8).forEach((d) => {
      lines.push(`- ${d.label}: ${d.value}${d.unit ? ` ${d.unit}` : ""}${d.note ? ` (${d.note})` : ""}`);
    });
  }
  if (scene.mindmap?.branches?.length) {
    lines.push(`Sơ đồ tóm tắt (${scene.mindmap.center ?? ""}):`);
    scene.mindmap.branches.forEach((b) => {
      lines.push(`- ${b.label}: ${(b.items ?? []).join(", ")}`);
    });
  }
  if (scene.quiz?.question) {
    lines.push(`Câu hỏi trắc nghiệm trên slide: ${scene.quiz.question}`);
    (scene.quiz.options ?? []).forEach((opt, idx) => {
      lines.push(`  ${String.fromCharCode(65 + idx)}. ${opt.text}`);
    });
  }
  if (scene.narration) {
    lines.push(`Lời giảng: ${scene.narration}`);
  }
  return lines.join("\n");
}

// Declared, not just described in prose: the Antigravity CLI path enforces this
// with --json-schema, so a model that drifts returns a shape error instead of a
// silently missing `answer`.
const ASSISTANT_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Answer for the student matching the requested language. Use LaTeX $...$ for inline math and $$...$$ for display math, bold key points with **...**, no markdown tables or code blocks.",
    },
    suggestedQuestions: {
      type: "array",
      description: "2-3 concise follow-up questions in the same language, grounded in the current lesson.",
      items: { type: "string" },
    },
  },
  required: ["answer", "suggestedQuestions"],
  additionalProperties: false,
} as const;

export async function POST(request: NextRequest) {
  const remote = rejectRemote(request);
  if (remote) return remote;

  // Chat turns are the easiest way to drain a quota, so they are capped hard.
  const limit = rateLimit(clientKey(request, "assistant"), 40, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Quá nhiều câu hỏi. Thử lại sau " + limit.retryAfterSeconds + "s." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const creds = await resolveProvider();
  const gate = await credentialGate(creds);
  if (gate) {
    return NextResponse.json({ error: gate }, { status: 428 });
  }

  let body: {
    question?: string;
    lang?: string;
    history?: ChatHistoryTurn[];
    lessonOutline?: string[];
    currentScene?: SceneContextPayload;
    lessonTitle?: string;
  } = {};

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const rawQuestion = typeof body.question === "string" ? body.question.trim() : "";
  if (!rawQuestion) {
    return NextResponse.json({ error: "Vui lòng nhập câu hỏi" }, { status: 400 });
  }
  if (rawQuestion.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json(
      { error: `Câu hỏi quá dài (tối đa ${MAX_QUESTION_LENGTH} ký tự).` },
      { status: 400 },
    );
  }

  const langTag = (body.lang ?? "vi").toLowerCase();
  const isEnglish = langTag.startsWith("en");

  const safeHistory = Array.isArray(body.history)
    ? body.history
        .filter(
          (m): m is ChatHistoryTurn =>
            Boolean(m) &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim().length > 0,
        )
        .slice(-MAX_HISTORY_TURNS)
    : [];

  const outlineBlock = Array.isArray(body.lessonOutline) && body.lessonOutline.length > 0
    ? body.lessonOutline.slice(0, 25).join(" | ")
    : "";

  const historyBlock = safeHistory.length > 0
    ? safeHistory
        .map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${m.content.trim().slice(0, 600)}`)
        .join("\n")
    : "";

  const sceneBlock = formatSceneContext(body.currentScene);

  const contextPrompt = `
Lesson: "${body.lessonTitle ?? "Current lesson"}"
${outlineBlock ? `Lesson outline: ${outlineBlock}\n` : ""}Current scene: "${body.currentScene?.title ?? "Unknown"}" (${body.currentScene?.kind ?? ""})
${sceneBlock}
${historyBlock ? `\nRecent conversation:\n${historyBlock}\n` : ""}
Student's question: "${rawQuestion}"

Reply in ${isEnglish ? "English" : "Vietnamese"} using this JSON format:
{
  "answer": "Clear, helpful answer for the student",
  "suggestedQuestions": ["Follow-up question 1", "Follow-up question 2"]
}
`;

  try {
    const result = await generateJson<AssistantResponse>(creds, {
      system: buildSystemPrompt(isEnglish),
      prompt: contextPrompt,
      schema: ASSISTANT_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.7,
      maxOutputTokens: 2048,
      timeoutMs: CHAT_TIMEOUT_MS,
      totalTimeoutMs: CHAT_TOTAL_TIMEOUT_MS,
    });

    const answer = typeof result.data?.answer === "string" ? result.data.answer.trim() : "";
    if (!answer) {
      throw new Error(
        isEnglish
          ? "The AI tutor returned an empty response. Please try again or switch providers in /setup."
          : "Trợ giảng AI không trả về nội dung. Thử lại, hoặc chọn provider khác ở /setup.",
      );
    }

    return NextResponse.json({
      ok: true,
      answer,
      suggestedQuestions: result.data.suggestedQuestions ?? [],
      model: result.model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lỗi khi gọi Trợ giảng AI";
    // A spent quota is the single most common reason this fails on a free
    // key; 429 + quota phrasing lets the UI show a specific hint instead of a
    // generic red error box.
    const quota = /quota|hết hạn mức|rate limit/i.test(message);
    return NextResponse.json({ error: message, quota }, { status: quota ? 429 : 500 });
  }
}
