import {
  buildExpenseParsePrompt,
  sanitizeExpenseParse,
} from './ai-expense-parse';

const M = [
  { id: 'u1', name: 'Cường' },
  { id: 'u2', name: 'Nhân Viết' },
  { id: 'u3', name: 'Nhân Hạnh' },
  { id: 'u4', name: 'Tuân' },
  { id: 'u5', name: 'Tiến' },
];

describe('ai-expense-parse', () => {
  it('prompt chứa id thành viên, câu đã trả lời và đoạn văn', () => {
    const p = buildExpenseParsePrompt('Cường trả xe 3tr', M, [
      { question: 'Nhân là ai?', answer: 'Nhân Viết' },
    ]);
    expect(p).toContain('- u4 | Tuân');
    expect(p).toContain('Đáp: Nhân Viết');
    expect(p).toContain('Cường trả xe 3tr');
  });

  it('có câu hỏi hợp lệ thì trả needs_input, bỏ câu thiếu lựa chọn', () => {
    const r = sanitizeExpenseParse(
      {
        questions: [
          { text: 'Nhân là ai?', options: [{ label: 'Nhân Viết' }, { label: 'Nhân Hạnh' }] },
          { text: 'Câu hỏng', options: [{ label: 'chỉ 1' }] },
        ],
        expenses: [{ description: 'x', amount: 1, paidById: 'u1', participantIds: ['u1'] }],
      },
      M,
    );
    expect(r.status).toBe('needs_input');
    if (r.status !== 'needs_input') return;
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0].id).toBe('q1');
  });

  it('nháp hợp lệ: làm tròn tiền, bỏ trùng người, danh mục lạ thành OTHER', () => {
    const r = sanitizeExpenseParse(
      {
        expenses: [
          {
            description: 'Tiền xe',
            amount: 3000000.4,
            category: 'TRANSPORT',
            paidById: 'u1',
            participantIds: ['u1', 'u2', 'u2', 'u4'],
          },
          { description: 'Hoa', amount: 400000, category: 'FLOWERS', paidById: 'u1', participantIds: ['u4'] },
        ],
      },
      M,
    );
    expect(r.status).toBe('draft');
    if (r.status !== 'draft') return;
    expect(r.expenses[0].amount).toBe(3000000);
    expect(r.expenses[0].participantNames).toEqual(['Cường', 'Nhân Viết', 'Tuân']);
    expect(r.expenses[1].category).toBe('OTHER');
    expect(r.total).toBe(3400000);
  });

  it('người trả lạ → hỏi lại, lựa chọn liệt kê ĐỦ thành viên', () => {
    const r = sanitizeExpenseParse(
      { expenses: [{ description: 'Kem', amount: 49000, paidById: 'hacker', participantIds: ['u1'] }] },
      M,
    );
    expect(r.status).toBe('needs_input');
    if (r.status !== 'needs_input') return;
    const labels = r.questions[0].options.map((o) => o.label);
    for (const m of M) expect(labels).toContain(m.name);
  });

  it('số tiền âm hoặc người tham gia ngoài chuyến → hỏi lại, không lưu', () => {
    const r = sanitizeExpenseParse(
      {
        expenses: [
          { description: 'A', amount: -5, paidById: 'u1', participantIds: ['u1'] },
          { description: 'B', amount: 5000, paidById: 'u1', participantIds: ['u1', 'x'] },
        ],
      },
      M,
    );
    expect(r.status).toBe('needs_input');
    if (r.status !== 'needs_input') return;
    expect(r.questions).toHaveLength(2);
  });

  it('rỗng / rác → câu hỏi yêu cầu mô tả rõ hơn', () => {
    expect(sanitizeExpenseParse(null, M).status).toBe('needs_input');
    expect(sanitizeExpenseParse('xyz', M).status).toBe('needs_input');
  });
});
