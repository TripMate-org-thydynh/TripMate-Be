import { placeKey } from './ai-embedding.service';

describe('placeKey', () => {
  it('coi cùng một quán là một dù tên đọc ra khác nhau', () => {
    // Đọc caption ra "Suối Mơ", nghe lời thuyết minh ra "Tiệm cà phê Suối Mơ".
    expect(placeKey('Suối Mơ', 'Đà Lạt')).toBe(
      placeKey('Tiệm cà phê Suối Mơ', 'Đà Lạt'),
    );
  });

  it('bỏ qua dấu và chữ hoa', () => {
    expect(placeKey('Quán Nướng Ngói Cu Đức', 'Đà Lạt')).toBe(
      placeKey('quan nuong ngoi cu duc', 'da lat'),
    );
  });

  it('không gộp nhầm hai quán khác nhau', () => {
    expect(placeKey('Thì Là', 'Đà Nẵng')).not.toBe(
      placeKey('Về Nhà Cafe', 'Đà Nẵng'),
    );
  });

  it('cùng tên nhưng khác thành phố vẫn là hai chỗ', () => {
    expect(placeKey('Cộng Cà Phê', 'Đà Lạt')).not.toBe(
      placeKey('Cộng Cà Phê', 'Hà Nội'),
    );
  });
});
