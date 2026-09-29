/**
 * Nhập chi tiêu bằng lời: người dùng gõ một đoạn kiểu "Cường trả tiền xe 3tr,
 * cà phê muối 15k/người…", AI tách thành các khoản chi nháp.
 *
 * Nguyên tắc: **AI không được đoán**. Chỗ nào mơ hồ (hai người cùng tên, số
 * tiền thiếu đơn vị, "phần chung" gồm những ai…) thì trả về câu hỏi kèm lựa
 * chọn; người dùng trả lời xong app gửi lại cả đoạn văn lẫn câu trả lời. Server
 * không lưu hội thoại — mỗi lượt tự đủ ngữ cảnh.
 *
 * File này chỉ có hàm thuần (dựng prompt + kiểm tra kết quả) để test được mà
 * không cần gọi Gemini.
 */
import { ExpenseCategory } from '@prisma/client';

export interface ParseMember {
  id: string;
  name: string;
}

export interface ParseAnswer {
  question: string;
  answer: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface ParseQuestion {
  id: string;
  text: string;
  options: QuestionOption[];
}

export interface DraftExpense {
  description: string;
  amount: number;
  category: ExpenseCategory;
  paidById: string;
  paidByName: string;
  participantIds: string[];
  participantNames: string[];
}

export type ParseResult =
  | { status: 'needs_input'; questions: ParseQuestion[] }
  | { status: 'draft'; expenses: DraftExpense[]; total: number };

/** Giới hạn để một đoạn văn lạ không đốt quota hay sinh hàng trăm dòng. */
export const MAX_TEXT = 4000;
export const MAX_EXPENSES = 60;
export const MAX_QUESTIONS = 4;
export const MAX_AMOUNT = 10_000_000_000;
/** Đủ chỗ cho lựa chọn "ai trả" liệt kê cả nhóm lớn (gói PLUS tới 30 người). */
export const MAX_OPTIONS = 32;

const CATEGORIES = new Set<string>(Object.values(ExpenseCategory));

export function buildExpenseParsePrompt(
  text: string,
  members: ParseMember[],
  answers: ParseAnswer[],
): string {
  const memberLines = members.map((m) => `- ${m.id} | ${m.name}`).join('\n');
  const answerLines = answers.length
    ? answers.map((a, i) => `${i + 1}. Hỏi: ${a.question}\n   Đáp: ${a.answer}`).join('\n')
    : '(chưa có)';
  return [
    'Bạn là trợ lý chia tiền của app TripMate. Nhiệm vụ: đọc mô tả chi tiêu của',
    'một nhóm du lịch và tách thành các khoản chi. Tiền tệ là VND.',
    '',
    'THÀNH VIÊN CHUYẾN (id | tên) — chỉ được dùng các id này:',
    memberLines,
    '',
    'QUY TẮC:',
    '1. KHÔNG ĐOÁN. Gặp chỗ mơ hồ thì hỏi lại, kèm 2-4 lựa chọn ngắn gọn. Các',
    '   trường hợp phải hỏi:',
    '   - Một tên khớp nhiều thành viên (vd "Nhân" khi có "Nhân Viết" và "Nhân Hạnh").',
    '   - Một tên không khớp thành viên nào. Lựa chọn: các thành viên gần giống,',
    '     và "Bỏ qua khoản này".',
    '   - Số tiền thiếu đơn vị và dưới 1000 (vd "hoa 400": 400.000đ hay 400đ?).',
    '   - "Phần chung"/"cả nhóm" mà đoạn văn cho thấy có thể không gồm hết',
    '     thành viên (vd có người chỉ tham gia vài khoản).',
    '   - "Xk/người" mà không rõ những ai tham gia.',
    '   - Cùng một người trả nhiều lần cho cùng một thứ: là cộng thêm hay nằm trong?',
    '2. Đơn vị: "k"=nghìn, "tr"/"m"/"triệu"=triệu. "15k/người" = 15.000 nhân số',
    '   người tham gia khoản đó.',
    '3. Tên khớp duy nhất (không phân biệt hoa thường, dấu, tiền tố "em/anh/chị")',
    '   thì dùng luôn, không hỏi.',
    `4. Tối đa ${MAX_QUESTIONS} câu hỏi mỗi lượt, ưu tiên câu ảnh hưởng nhiều tiền nhất.`,
    '   Lựa chọn nào là một nhóm người thì ghi ĐỦ TÊN từng người trong',
    '   description, không viết tắt kiểu "9 người" hay "mọi người trừ…".',
    '5. Câu đã được trả lời ở dưới thì áp dụng, KHÔNG hỏi lại.',
    '6. Chỉ trả "expenses" khi không còn câu hỏi nào. Còn câu hỏi thì expenses = [].',
    '7. category là một trong: ' + [...CATEGORIES].join(', ') + '.',
    '',
    'TRẢ VỀ JSON đúng khuôn:',
    '{"questions":[{"id":"q1","text":string,"options":[{"label":string,"description":string}]}],',
    ' "expenses":[{"description":string,"amount":number,"category":string,',
    '   "paidById":string,"participantIds":[string]}]}',
    '',
    'CÂU HỎI ĐÃ TRẢ LỜI:',
    answerLines,
    '',
    'MÔ TẢ CỦA NGƯỜI DÙNG:',
    '"""',
    text,
    '"""',
  ].join('\n');
}

/**
 * Kiểm tra kết quả AI, KHÔNG tin thẳng.
 *
 * AI có thể trả id không thuộc chuyến, số âm, người tham gia trùng lặp, hoặc
 * lẫn cả câu hỏi lẫn khoản chi. Mọi thứ không qua được kiểm tra ở đây sẽ thành
 * câu hỏi cho người dùng thay vì được lưu.
 */
export function sanitizeExpenseParse(
  raw: unknown,
  members: ParseMember[],
): ParseResult {
  const byId = new Map(members.map((m) => [m.id, m]));
  const obj = (raw ?? {}) as Record<string, unknown>;

  const questions: ParseQuestion[] = [];
  const rawQs = Array.isArray(obj.questions) ? obj.questions : [];
  for (const q of rawQs) {
    const r = (q ?? {}) as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    const options = (Array.isArray(r.options) ? r.options : [])
      .map((o) => {
        const x = (o ?? {}) as Record<string, unknown>;
        const label = typeof x.label === 'string' ? x.label.trim() : '';
        const description =
          typeof x.description === 'string' && x.description.trim()
            ? x.description.trim()
            : undefined;
        return { label, description };
      })
      .filter((o) => o.label)
      .slice(0, MAX_OPTIONS);
    if (text && options.length >= 2) {
      questions.push({ id: `q${questions.length + 1}`, text, options });
    }
  }
  if (questions.length) {
    return { status: 'needs_input', questions: questions.slice(0, MAX_QUESTIONS) };
  }

  const expenses: DraftExpense[] = [];
  const rawEs = Array.isArray(obj.expenses) ? obj.expenses : [];
  for (const e of rawEs.slice(0, MAX_EXPENSES)) {
    const r = (e ?? {}) as Record<string, unknown>;
    const description =
      typeof r.description === 'string' && r.description.trim()
        ? r.description.trim().slice(0, 200)
        : '';
    const amount = Math.round(Number(r.amount));
    const payer = byId.get(String(r.paidById ?? ''));
    const pIds = [
      ...new Set(
        (Array.isArray(r.participantIds) ? r.participantIds : []).map(String),
      ),
    ];
    const unknown = pIds.filter((id) => !byId.has(id));
    const label = description || `${amount}`;

    // Lỗi dữ liệu không tự sửa được thì hỏi lại người dùng, không lưu bừa.
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      questions.push(
        badQuestion(questions.length, `Số tiền của "${label}" là bao nhiêu?`),
      );
      continue;
    }
    if (!payer) {
      questions.push(
        whoQuestion(questions.length, `Ai đã trả "${label}"?`, members),
      );
      continue;
    }
    if (pIds.length === 0 || unknown.length) {
      questions.push(
        badQuestion(
          questions.length,
          `"${label}" chia cho những ai trong chuyến?`,
          members,
        ),
      );
      continue;
    }
    const category = CATEGORIES.has(String(r.category))
      ? (String(r.category) as ExpenseCategory)
      : ExpenseCategory.OTHER;
    expenses.push({
      description: description || 'Khoản chi',
      amount,
      category,
      paidById: payer.id,
      paidByName: payer.name,
      participantIds: pIds,
      participantNames: pIds.map((id) => byId.get(id)!.name),
    });
  }

  if (questions.length) {
    return { status: 'needs_input', questions: questions.slice(0, MAX_QUESTIONS) };
  }
  if (!expenses.length) {
    return {
      status: 'needs_input',
      questions: [
        badQuestion(
          0,
          'Mình chưa tìm thấy khoản chi nào. Bạn mô tả rõ hơn: ai trả, bao nhiêu, cho những ai?',
        ),
      ],
    };
  }
  return {
    status: 'draft',
    expenses,
    total: expenses.reduce((s, e) => s + e.amount, 0),
  };
}

function whoQuestion(
  i: number,
  text: string,
  members: ParseMember[],
): ParseQuestion {
  return {
    id: `q${i + 1}`,
    text,
    options: [
      // Liệt kê đủ thành viên — rút gọn từng khiến người trả bị bỏ sót.
      ...members.map((m) => ({ label: m.name })),
      { label: 'Bỏ qua khoản này' },
    ],
  };
}

/** Câu hỏi tự do: vẫn có 2 lựa chọn để app hiển thị được, kèm ô "Khác". */
function badQuestion(
  i: number,
  text: string,
  members: ParseMember[] = [],
): ParseQuestion {
  return {
    id: `q${i + 1}`,
    text,
    options: members.length
      ? [
          { label: 'Cả nhóm', description: `${members.length} người` },
          { label: 'Bỏ qua khoản này' },
        ]
      : [{ label: 'Bỏ qua khoản này' }, { label: 'Để mình nhập lại' }],
  };
}
