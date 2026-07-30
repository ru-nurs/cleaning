export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function isStrongPassword(value: string) {
  const hasLatinLetter = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  return (
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH &&
    hasLatinLetter &&
    hasDigit
  );
}
