import { rankNameSuggestions, spacingOnlyMatch } from './doctor-name';

describe('rankNameSuggestions — typo-tolerant suggestions while typing', () => {
  const students = ['محمد خالد', 'محمد علي', 'أحمد سامي', 'منة الله حسن', 'خالد محمود'];

  it('finds the name behind a typo ("محمد حالد")', () => {
    expect(rankNameSuggestions('محمد حالد', students)[0]).toBe('محمد خالد');
  });

  it('finds the name behind a stray space ("م حمد خالد")', () => {
    expect(rankNameSuggestions('م حمد خالد', students)[0]).toBe('محمد خالد');
  });

  it('suggests while still typing ("محمد حا")', () => {
    expect(rankNameSuggestions('محمد حا', students)).toContain('محمد خالد');
  });

  it('plain substring matches come first', () => {
    expect(rankNameSuggestions('خالد', students).slice(0, 2)).toEqual(['خالد محمود', 'محمد خالد']);
  });

  it('ignores alef/ya/ta-marbuta spelling differences', () => {
    expect(rankNameSuggestions('احمد سامى', students)[0]).toBe('أحمد سامي');
  });

  it('does not suggest unrelated names', () => {
    expect(rankNameSuggestions('كريم منصور', students)).toEqual([]);
  });
});

describe('spacingOnlyMatch — auto-fix when the only difference is spaces', () => {
  const students = ['محمد خالد', 'عبدالرحمن علي'];

  it('returns the stored name when only spacing differs', () => {
    expect(spacingOnlyMatch('م حمد خالد', students)).toBe('محمد خالد');
    expect(spacingOnlyMatch('محمدخالد', students)).toBe('محمد خالد');
    expect(spacingOnlyMatch('عبد الرحمن علي', students)).toBe('عبدالرحمن علي');
  });

  it('returns null for a real letter difference or an exact match', () => {
    expect(spacingOnlyMatch('محمد حالد', students)).toBeNull();
    expect(spacingOnlyMatch('محمد خالد', students)).toBeNull();
  });
});
